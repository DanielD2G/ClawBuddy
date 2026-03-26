import { prisma } from '../../lib/prisma.js'
import type { Prisma } from '@prisma/client'
import type { ToolCall } from '../../providers/llm.interface.js'
import { cronService } from '../cron.service.js'
import { toolDiscoveryService } from '../tool-discovery.service.js'
import { subAgentService } from '../sub-agent.service.js'
import { SUB_AGENT_ROLES } from '../sub-agent-roles.js'
import type { SubAgentRole } from '../sub-agent.types.js'
import { secretRedactionService } from '../secret-redaction.service.js'
import { browserService } from '../browser.service.js'
import { DELEGATION_ONLY_TOOLS } from '../../constants.js'
import { logger } from '../../lib/logger.js'
import type { ExecutionContext, ExecutionResult } from './handler-utils.js'

/**
 * Create a cron job via agent tool call.
 */
export async function executeCreateCron(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>

  const job = await cronService.create({
    name: String(args.name ?? 'Unnamed cron'),
    schedule: String(args.schedule ?? '*/30 * * * *'),
    prompt: String(args.prompt ?? ''),
    type: 'agent',
    workspaceId: context.workspaceId,
    sessionId: context.chatSessionId,
  })

  return {
    output: `Cron job "${job.name}" created successfully (id: ${job.id}, schedule: ${job.schedule}). It will run in this conversation on the specified schedule.`,
    durationMs: Date.now() - startTime,
  }
}

/**
 * List all cron jobs.
 */
export async function executeListCrons(context: ExecutionContext): Promise<ExecutionResult> {
  const startTime = Date.now()
  const jobs = await cronService.list({
    workspaceId: context.workspaceId,
    sessionId: context.chatSessionId,
    includeGlobal: true,
    includeWorkspace: !!context.workspaceId,
    includeConversation: !!context.workspaceId,
  })

  if (!jobs.length) {
    return { output: 'No cron jobs configured.', durationMs: Date.now() - startTime }
  }

  const output = jobs
    .map((j: (typeof jobs)[number]) =>
      [
        `- **${j.name}** (id: ${j.id})`,
        `  Scope: ${j.scopeLabel}` +
          (j.workspaceName ? ` | Workspace: ${j.workspaceName}` : '') +
          (j.conversationTitle ? ` | Conversation: ${j.conversationTitle}` : ''),
        `  Schedule: ${j.schedule} | Type: ${j.type} | Enabled: ${j.enabled}`,
        `  Last run: ${j.lastRunAt?.toISOString() ?? 'never'} (${j.lastRunStatus ?? 'n/a'})`,
      ].join('\n'),
    )
    .join('\n\n')

  return { output, durationMs: Date.now() - startTime }
}

/**
 * Delete a cron job by ID.
 */
export async function executeDeleteCron(toolCall: ToolCall): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as Record<string, unknown>
  const id = String(args.id ?? '')

  try {
    await cronService.delete(id)
    return {
      output: `Cron job ${id} deleted successfully.`,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    return {
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    }
  }
}

/**
 * Discover tools via semantic search or list all available.
 */
export async function executeDiscoverTools(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as { query: string; list_all?: boolean; max_results?: number }

  // Get enabled capability slugs for this workspace, excluding tool-discovery itself
  const enabledCaps = await prisma.workspaceCapability.findMany({
    where: { workspaceId: context.workspaceId, enabled: true },
    include: { capability: { select: { slug: true } } },
  })
  const enabledSlugs = enabledCaps
    .map((wc: (typeof enabledCaps)[number]) => wc.capability.slug)
    .filter((slug: string) => slug !== 'tool-discovery')

  if (args.list_all) {
    const listing = await toolDiscoveryService.listAvailable(enabledSlugs)
    return {
      output: JSON.stringify({
        type: 'tool_listing',
        available: listing,
      }),
      durationMs: Date.now() - startTime,
    }
  }

  const discovered = await toolDiscoveryService.search(
    args.query,
    enabledSlugs,
    0.3,
    args.max_results,
  )

  if (!discovered.length) {
    return {
      output: JSON.stringify({
        type: 'discovery_result',
        discovered: [],
        hint: 'No matching tools found. Try calling discover_tools with list_all: true to see all available capabilities.',
      }),
      durationMs: Date.now() - startTime,
    }
  }

  // Mark delegation-only tools so the LLM knows to use delegate_task
  const annotatedDiscovered = discovered.map((cap) => ({
    slug: cap.slug,
    name: cap.name,
    tools: cap.tools.map((tool) =>
      DELEGATION_ONLY_TOOLS.has(tool.name)
        ? { ...tool, description: `[DELEGATION-ONLY — use delegate_task] ${tool.description}` }
        : tool,
    ),
    instructions: cap.instructions,
  }))

  return {
    output: JSON.stringify({
      type: 'discovery_result',
      discovered: annotatedDiscovered,
    }),
    durationMs: Date.now() - startTime,
  }
}

/**
 * Delegate a task to a sub-agent.
 */
export async function executeDelegateTask(
  toolCall: ToolCall,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const args = toolCall.arguments as { role: string; task: string; context?: string }

  if (!args.role || !args.task) {
    return {
      output: '',
      error: 'Both role and task are required',
      durationMs: Date.now() - startTime,
    }
  }

  if (!(args.role in SUB_AGENT_ROLES)) {
    const validRoles = Object.keys(SUB_AGENT_ROLES).join(', ')
    return {
      output: '',
      error: `Invalid role: "${args.role}". Must be one of: ${validRoles}`,
      durationMs: Date.now() - startTime,
    }
  }

  const inventory =
    context.secretInventory ??
    (await secretRedactionService.buildSecretInventory(context.workspaceId))

  // Each sub-agent gets its own browser session to avoid page collisions during parallel execution
  const browserSessionId = `sub-${toolCall.id}`

  // Resolve user-mentioned capability slugs to tool names for sub-agent preference
  let preferredTools: string[] | undefined
  if (context.mentionedSlugs?.length && context.capabilities) {
    const mentionedSet = new Set(context.mentionedSlugs)
    preferredTools = context.capabilities
      .filter((cap) => mentionedSet.has(cap.slug))
      .flatMap((cap) => {
        const defs = cap.toolDefinitions as Array<{ name: string }>
        return defs?.map((t) => t.name) ?? []
      })
    if (!preferredTools.length) preferredTools = undefined
  }

  const subResult = await subAgentService.runSubAgent(
    {
      role: args.role as SubAgentRole,
      task: args.task,
      context: args.context,
    },
    {
      workspaceId: context.workspaceId,
      sessionId: context.chatSessionId,
      secretInventory: inventory,
      emit: context.emit,
      capabilities: context.capabilities,
      subAgentId: toolCall.id,
      browserSessionId,
      preferredTools,
      signal: context.signal,
    },
  )

  // Cleanup: close sub-agent's isolated browser session (if one was created)
  await browserService.closeSession(browserSessionId).catch((err) =>
    logger.warn('[ToolExecutor] Failed to close sub-agent browser session', {
      browserSessionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  )

  // Persist sub-agent tool executions to DB (batched in a transaction)
  let subAgentExecutionIds: string[] = []
  if (subResult.toolExecutions.length) {
    const executions = await prisma.$transaction(
      subResult.toolExecutions.map((te) =>
        prisma.toolExecution.create({
          data: {
            capabilitySlug: te.capabilitySlug,
            toolName: te.toolName,
            input: te.input as Prisma.InputJsonValue,
            output: te.output ?? null,
            error: te.error ?? null,
            durationMs: te.durationMs,
            status: te.error ? 'failed' : 'completed',
          },
        }),
      ),
    )
    subAgentExecutionIds = executions.map((e: (typeof executions)[number]) => e.id)
  }

  const output = [
    `## Sub-Agent Result (${subResult.role})`,
    '',
    subResult.result,
    '',
    `---`,
    `Iterations: ${subResult.iterationsUsed} | Tools used: ${subResult.toolExecutions.length} | Success: ${subResult.success}`,
    subResult.tokenUsage
      ? `Tokens: ${subResult.tokenUsage.inputTokens} in / ${subResult.tokenUsage.outputTokens} out`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    output,
    error: subResult.success ? undefined : 'Sub-agent did not complete successfully',
    durationMs: Date.now() - startTime,
    subAgentExecutionIds,
  }
}
