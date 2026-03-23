export type ReleaseDeliveryMode = 'integrated' | 'maintenance-required'

export type UpdateRunStage =
  | 'queued'
  | 'preparing'
  | 'pulling'
  | 'migrating'
  | 'deploying'
  | 'verifying'
  | 'succeeded'
  | 'rolled_back'
  | 'failed'

export type UpdateRunStatus = 'queued' | 'running' | 'succeeded' | 'rolled_back' | 'failed'

export type UpdateEventStatus = 'pending' | 'running' | 'done' | 'error'

export type MigrationMode = 'none' | 'prisma-db-push'

export interface ReleaseManifest {
  version: string
  appImage: string
  imageDigest: string | null
  migration: {
    mode: MigrationMode
    rollbackSafe: boolean
  }
  deliveryMode: ReleaseDeliveryMode
  minUpdaterVersion: string | null
  notesUrl: string | null
}

export interface LatestReleaseInfo {
  version: string
  name: string
  body: string
  url: string
  publishedAt: string
  manifest: ReleaseManifest
}

export interface UpdateEligibility {
  supported: boolean
  canUpdate: boolean
  reason: string | null
  deliveryMode: ReleaseDeliveryMode
  minUpdaterVersion: string | null
}

export interface SerializedUpdateEvent {
  id: string
  step: string
  status: UpdateEventStatus
  message: string
  details: Record<string, unknown> | null
  createdAt: Date
}

export interface SerializedUpdateRun {
  id: string
  status: UpdateRunStatus
  stage: UpdateRunStage
  message: string | null
  currentVersion: string | null
  targetVersion: string
  targetReleaseName: string | null
  targetReleaseUrl: string | null
  targetPublishedAt: Date | null
  targetReleaseNotes: string | null
  deliveryMode: ReleaseDeliveryMode
  serviceRole: string
  manifest: ReleaseManifest | null
  targetImage: string | null
  targetImageDigest: string | null
  observedVersion: string | null
  observedImage: string | null
  observedImageDigest: string | null
  rollbackReason: string | null
  error: string | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  heartbeatAt: Date | null
  verificationDeadlineAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  events: SerializedUpdateEvent[]
}
