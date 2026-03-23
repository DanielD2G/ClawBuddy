import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { getBuildInfo } from '../../lib/build-info.js'
import {
  getInstallSupport,
  pullImage,
  updateServiceImage,
  buildTargetImageReference,
  getServiceFailure,
  getServiceHealthSnapshot,
  getManagedServiceByRole,
  getObservedServiceState,
  observedImageMatchesTarget,
} from './update.swarm.js'
import type {
  ReleaseManifest,
  SerializedUpdateRun,
  UpdateEventStatus,
  UpdateRunStage,
  UpdateRunStatus,
} from './update.types.js'
import { normalizeVersion } from './update.manifest.js'

const ACTIVE_STATUSES: UpdateRunStatus[] = ['queued', 'running']
const LEASE_TTL_MS = 30_000
const LOOP_IDLE_MS = 2_000
const LOOP_ERROR_MS = 5_000
const VERIFY_TIMEOUT_MS = 5 * 60_000
const PRISMA_CLI_PATH = 'node_modules/prisma/build/index.js'
const ON_DEMAND_UPDATER = ['true', '1', 'yes'].includes(
  (process.env.CLAWBUDDY_UPDATER_ON_DEMAND ?? '').toLowerCase(),
)
const IDLE_EXIT_MS = 15_000

type AppUpdateRunRecord = Awaited<ReturnType<typeof prisma.appUpdateRun.findUniqueOrThrow>>

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isMissingTableError(error: unknown) {
  const message = toErrorMessage(error)
  return (
    message.includes('does not exist') ||
    message.includes('no such table') ||
    message.includes('P2021') ||
    message.includes('P2022')
  )
}

function parseManifestSnapshot(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const source = value as Record<string, unknown>
  if (typeof source.version !== 'string' || typeof source.appImage !== 'string') {
    return null
  }

  const migration =
    source.migration && typeof source.migration === 'object' && !Array.isArray(source.migration)
      ? (source.migration as Record<string, unknown>)
      : {}

  return {
    version: normalizeVersion(source.version) ?? source.version,
    appImage: source.appImage,
    imageDigest: typeof source.imageDigest === 'string' ? source.imageDigest : null,
    migration: {
      mode: migration.mode === 'prisma-db-push' ? 'prisma-db-push' : 'none',
      rollbackSafe: migration.rollbackSafe !== false,
    },
    deliveryMode:
      source.deliveryMode === 'maintenance-required' ? 'maintenance-required' : 'integrated',
    minUpdaterVersion:
      typeof source.minUpdaterVersion === 'string' ? source.minUpdaterVersion : null,
    notesUrl: typeof source.notesUrl === 'string' ? source.notesUrl : null,
  }
}

async function appendEvent(
  runId: string,
  step: string,
  status: UpdateEventStatus,
  message: string,
  details?: Record<string, unknown>,
) {
  await prisma.appUpdateEvent.create({
    data: {
      runId,
      step,
      status,
      message,
      ...(details ? { details: details as Prisma.InputJsonValue } : {}),
    },
  })
}

async function updateRun(
  runId: string,
  data: Partial<{
    status: UpdateRunStatus
    stage: UpdateRunStage
    message: string | null
    targetImage: string | null
    targetImageDigest: string | null
    observedVersion: string | null
    observedImage: string | null
    observedImageDigest: string | null
    rollbackReason: string | null
    error: string | null
    verificationDeadlineAt: Date | null
    completedAt: Date | null
    heartbeatAt: Date | null
    leaseOwner: string | null
    leaseExpiresAt: Date | null
    startedAt: Date | null
  }>,
) {
  return prisma.appUpdateRun.update({
    where: { id: runId },
    data,
  })
}

async function touchLease(runId: string, leaseOwner: string, message?: string | null) {
  const now = new Date()
  await updateRun(runId, {
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
    heartbeatAt: now,
    ...(message !== undefined ? { message } : {}),
  })
}

async function markTerminalRun(
  run: AppUpdateRunRecord,
  status: Extract<UpdateRunStatus, 'succeeded' | 'rolled_back' | 'failed'>,
  stage: Extract<UpdateRunStage, 'succeeded' | 'rolled_back' | 'failed'>,
  message: string,
  details?: {
    rollbackReason?: string | null
    error?: string | null
    observedVersion?: string | null
    observedImage?: string | null
    observedImageDigest?: string | null
  },
) {
  await updateRun(run.id, {
    status,
    stage,
    message,
    rollbackReason: details?.rollbackReason ?? null,
    error: details?.error ?? null,
    observedVersion: details?.observedVersion ?? run.observedVersion,
    observedImage: details?.observedImage ?? run.observedImage,
    observedImageDigest: details?.observedImageDigest ?? run.observedImageDigest,
    completedAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: new Date(),
  })

  await appendEvent(run.id, stage, status === 'succeeded' ? 'done' : 'error', message, {
    status,
    rollbackReason: details?.rollbackReason ?? null,
    error: details?.error ?? null,
  })
}

async function transitionStage(
  runId: string,
  stage: Exclude<UpdateRunStage, 'succeeded' | 'rolled_back' | 'failed'>,
  message: string,
  leaseOwner: string,
  extra?: Partial<{
    targetImage: string | null
    targetImageDigest: string | null
    verificationDeadlineAt: Date | null
  }>,
) {
  const now = new Date()
  await updateRun(runId, {
    status: 'running',
    stage,
    message,
    heartbeatAt: now,
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
    ...(extra?.targetImage !== undefined ? { targetImage: extra.targetImage } : {}),
    ...(extra?.targetImageDigest !== undefined
      ? { targetImageDigest: extra.targetImageDigest }
      : {}),
    ...(extra?.verificationDeadlineAt !== undefined
      ? { verificationDeadlineAt: extra.verificationDeadlineAt }
      : {}),
  })
}

function createPrismaDbPushCommand() {
  if (!existsSync(PRISMA_CLI_PATH)) {
    throw new Error(`Prisma CLI was not found at ${PRISMA_CLI_PATH}`)
  }

  return [
    process.execPath,
    PRISMA_CLI_PATH,
    'db',
    'push',
    '--schema=apps/api/prisma/schema.prisma',
    '--skip-generate',
  ]
}

async function runPrismaDbPush() {
  const command = createPrismaDbPushCommand()

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Prisma db push timed out'))
    }, 120_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error((stderr || stdout || `Prisma db push failed with exit code ${code}`).trim()))
    })
  })
}

async function ensureSchemaInitialized() {
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    await prisma.appUpdateRun.findFirst({ select: { id: true } })
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }

    console.warn('[Updater] Update tables were not found. Initializing schema with prisma db push.')
    await runPrismaDbPush()
  }
}

async function claimNextRun(instanceId: string) {
  const now = new Date()
  const candidate = await prisma.appUpdateRun.findFirst({
    where: {
      status: { in: ACTIVE_STATUSES },
      OR: [{ leaseOwner: instanceId }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }],
  })

  if (!candidate) {
    return null
  }

  const updated = await prisma.appUpdateRun.updateMany({
    where: {
      id: candidate.id,
      OR: [{ leaseOwner: instanceId }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      leaseOwner: instanceId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
      heartbeatAt: now,
      status: candidate.status === 'queued' ? 'running' : candidate.status,
      startedAt: candidate.startedAt ?? now,
    },
  })

  if (updated.count === 0) {
    return null
  }

  return prisma.appUpdateRun.findUniqueOrThrow({ where: { id: candidate.id } })
}

async function handlePreparing(run: AppUpdateRunRecord, instanceId: string) {
  const manifest = parseManifestSnapshot(run.manifest)
  if (!manifest) {
    await markTerminalRun(run, 'failed', 'failed', 'Update manifest snapshot is missing', {
      error: 'Update manifest snapshot is missing',
    })
    return
  }

  const support = await getInstallSupport()
  if (!support.supported) {
    await markTerminalRun(
      run,
      'failed',
      'failed',
      support.reason || 'Docker Swarm is unavailable',
      {
        error: support.reason || 'Docker Swarm is unavailable',
      },
    )
    return
  }

  if (manifest.deliveryMode !== 'integrated') {
    await markTerminalRun(
      run,
      'failed',
      'failed',
      'This release requires a maintenance update path',
      { error: 'This release requires a maintenance update path' },
    )
    return
  }

  const targetImage = buildTargetImageReference(manifest)
  await appendEvent(
    run.id,
    'preparing',
    'done',
    `Prepared durable update for ${run.targetVersion}`,
    {
      targetImage,
    },
  )
  await transitionStage(run.id, 'pulling', `Pulling ${targetImage}`, instanceId, {
    targetImage,
    targetImageDigest: manifest.imageDigest,
  })
}

async function handlePulling(run: AppUpdateRunRecord, instanceId: string) {
  if (!run.targetImage) {
    await markTerminalRun(run, 'failed', 'failed', 'Target image is missing from the update run', {
      error: 'Target image is missing from the update run',
    })
    return
  }

  let lastPersistedAt = 0
  await pullImage(run.targetImage, async (message) => {
    const now = Date.now()
    if (now - lastPersistedAt < 1_000) {
      return
    }

    lastPersistedAt = now
    await touchLease(run.id, instanceId, message)
  })

  await appendEvent(run.id, 'pulling', 'done', `Release image is ready (${run.targetVersion})`)
  await transitionStage(run.id, 'migrating', 'Preparing rollback-safe migrations', instanceId)
}

async function handleMigrating(run: AppUpdateRunRecord, instanceId: string) {
  const manifest = parseManifestSnapshot(run.manifest)
  if (!manifest) {
    await markTerminalRun(run, 'failed', 'failed', 'Update manifest snapshot is missing', {
      error: 'Update manifest snapshot is missing',
    })
    return
  }

  if (manifest.migration.mode === 'none') {
    await appendEvent(run.id, 'migrating', 'done', 'No schema migration is required')
    await transitionStage(
      run.id,
      'deploying',
      `Deploying ClawBuddy ${run.targetVersion}`,
      instanceId,
    )
    return
  }

  if (!manifest.migration.rollbackSafe) {
    await markTerminalRun(
      run,
      'failed',
      'failed',
      'This release declares a non-rollback-safe migration and cannot run as an integrated update',
      {
        error:
          'This release declares a non-rollback-safe migration and cannot run as an integrated update',
      },
    )
    return
  }

  await touchLease(run.id, instanceId, 'Applying rollback-safe schema migration')
  await runPrismaDbPush()
  await appendEvent(run.id, 'migrating', 'done', 'Rollback-safe schema migration completed')
  await transitionStage(run.id, 'deploying', `Deploying ClawBuddy ${run.targetVersion}`, instanceId)
}

async function handleDeploying(run: AppUpdateRunRecord, instanceId: string) {
  const manifest = parseManifestSnapshot(run.manifest)
  if (!manifest || !run.targetImage) {
    await markTerminalRun(run, 'failed', 'failed', 'Update manifest snapshot is missing', {
      error: 'Update manifest snapshot is missing',
    })
    return
  }

  const appService = await getManagedServiceByRole('app')
  if (!appService) {
    await markTerminalRun(run, 'failed', 'failed', 'Managed ClawBuddy app service was not found', {
      error: 'Managed ClawBuddy app service was not found',
    })
    return
  }

  const observed = await getObservedServiceState(appService)
  if (!observedImageMatchesTarget(observed.image, manifest)) {
    await updateServiceImage(appService, run.targetImage)
    await appendEvent(
      run.id,
      'deploying',
      'running',
      `Requested Swarm rollout for ${run.targetVersion}`,
      {
        targetImage: run.targetImage,
      },
    )
  } else {
    await appendEvent(run.id, 'deploying', 'done', 'Swarm already points at the requested image')
  }

  await transitionStage(
    run.id,
    'verifying',
    'Waiting for the new service task to become healthy',
    instanceId,
    { verificationDeadlineAt: new Date(Date.now() + VERIFY_TIMEOUT_MS) },
  )
}

async function handleVerifying(run: AppUpdateRunRecord, instanceId: string) {
  const manifest = parseManifestSnapshot(run.manifest)
  if (!manifest) {
    await markTerminalRun(run, 'failed', 'failed', 'Update manifest snapshot is missing', {
      error: 'Update manifest snapshot is missing',
    })
    return
  }

  const appService = await getManagedServiceByRole('app')
  const observed = await getObservedServiceState(appService)
  const health = await getServiceHealthSnapshot(appService)
  const failure = getServiceFailure(appService)

  await touchLease(
    run.id,
    instanceId,
    observed.updateState
      ? `Swarm rollout in progress (${observed.updateState}). ${health.message}`
      : health.message,
  )
  await updateRun(run.id, {
    observedVersion: observed.version,
    observedImage: observed.image,
    observedImageDigest: observed.digest,
  })

  if (failure) {
    const rolledBack = appService?.UpdateStatus?.State?.startsWith('rollback') ?? false
    await markTerminalRun(
      run,
      rolledBack ? 'rolled_back' : 'failed',
      rolledBack ? 'rolled_back' : 'failed',
      failure,
      {
        rollbackReason: rolledBack ? failure : null,
        error: rolledBack ? null : failure,
        observedVersion: observed.version,
        observedImage: observed.image,
        observedImageDigest: observed.digest,
      },
    )
    return
  }

  const updateState = observed.updateState
  const rolloutComplete = updateState === null || updateState === 'completed'
  const versionMatches = observed.version === run.targetVersion
  const imageMatches = observedImageMatchesTarget(observed.image, manifest)

  if (health.allHealthy && rolloutComplete && versionMatches && imageMatches) {
    await markTerminalRun(
      run,
      'succeeded',
      'succeeded',
      `ClawBuddy ${run.targetVersion} is ready`,
      {
        observedVersion: observed.version,
        observedImage: observed.image,
        observedImageDigest: observed.digest,
      },
    )
    return
  }

  if (run.verificationDeadlineAt && run.verificationDeadlineAt.getTime() <= Date.now()) {
    const reason = [
      rolloutComplete ? null : `Swarm state is ${updateState ?? 'unknown'}`,
      imageMatches ? null : 'service image does not match the requested release',
      versionMatches ? null : `service reports ${observed.version ?? 'unknown version'}`,
      health.allHealthy ? null : health.message,
    ]
      .filter(Boolean)
      .join('; ')

    await markTerminalRun(
      run,
      'failed',
      'failed',
      `Verification deadline exceeded${reason ? `: ${reason}` : ''}`,
      {
        error: `Verification deadline exceeded${reason ? `: ${reason}` : ''}`,
        observedVersion: observed.version,
        observedImage: observed.image,
        observedImageDigest: observed.digest,
      },
    )
  }
}

async function processRun(run: AppUpdateRunRecord, instanceId: string) {
  switch (run.stage as UpdateRunStage) {
    case 'queued':
      await handlePreparing(run, instanceId)
      return
    case 'preparing':
      await handlePreparing(run, instanceId)
      return
    case 'pulling':
      await handlePulling(run, instanceId)
      return
    case 'migrating':
      await handleMigrating(run, instanceId)
      return
    case 'deploying':
      await handleDeploying(run, instanceId)
      return
    case 'verifying':
      await handleVerifying(run, instanceId)
      return
    case 'succeeded':
    case 'rolled_back':
    case 'failed':
      await updateRun(run.id, {
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(),
      })
      return
    default:
      await markTerminalRun(run, 'failed', 'failed', `Unknown update stage: ${run.stage}`, {
        error: `Unknown update stage: ${run.stage}`,
      })
  }
}

let controllerPromise: Promise<void> | null = null

export const updateControllerService = {
  async start() {
    if (controllerPromise) {
      return controllerPromise
    }

    controllerPromise = (async () => {
      const instanceId = process.env.CLAWBUDDY_UPDATER_ID || process.env.HOSTNAME || randomUUID()
      let lastWorkAt = Date.now()
      console.log(
        `[Updater] Durable controller ${instanceId} starting (version ${getBuildInfo().version})`,
      )

      await ensureSchemaInitialized()

      while (true) {
        try {
          const run = await claimNextRun(instanceId)
          if (!run) {
            if (ON_DEMAND_UPDATER && Date.now() - lastWorkAt >= IDLE_EXIT_MS) {
              console.log('[Updater] No active update runs remain. Exiting on-demand controller.')
              return
            }

            await delay(LOOP_IDLE_MS)
            continue
          }

          lastWorkAt = Date.now()
          await processRun(run, instanceId)
          await delay(500)
        } catch (error) {
          console.error('[Updater] Controller loop failed:', toErrorMessage(error))
          await delay(LOOP_ERROR_MS)
        }
      }
    })()

    return controllerPromise
  },
}

export function serializeControllerRun(
  run: AppUpdateRunRecord & {
    events?: Array<{
      id: string
      step: string
      status: string
      message: string
      details: unknown
      createdAt: Date
    }>
  },
): SerializedUpdateRun {
  const manifest = parseManifestSnapshot(run.manifest)

  return {
    id: run.id,
    status: run.status as UpdateRunStatus,
    stage: run.stage as UpdateRunStage,
    message: run.message,
    currentVersion: run.currentVersion,
    targetVersion: run.targetVersion,
    targetReleaseName: run.targetReleaseName,
    targetReleaseUrl: run.targetReleaseUrl,
    targetPublishedAt: run.targetPublishedAt,
    targetReleaseNotes: run.targetReleaseNotes,
    deliveryMode: run.deliveryMode as SerializedUpdateRun['deliveryMode'],
    serviceRole: run.serviceRole,
    manifest,
    targetImage: run.targetImage,
    targetImageDigest: run.targetImageDigest,
    observedVersion: run.observedVersion,
    observedImage: run.observedImage,
    observedImageDigest: run.observedImageDigest,
    rollbackReason: run.rollbackReason,
    error: run.error,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    heartbeatAt: run.heartbeatAt,
    verificationDeadlineAt: run.verificationDeadlineAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    events:
      run.events?.map((event) => ({
        id: event.id,
        step: event.step,
        status: event.status as UpdateEventStatus,
        message: event.message,
        details:
          event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? (event.details as Record<string, unknown>)
            : null,
        createdAt: event.createdAt,
      })) ?? [],
  }
}
