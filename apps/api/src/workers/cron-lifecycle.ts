/**
 * Generic lifecycle hooks for cron job execution.
 *
 * Modules (e.g. dashboards) register hooks here so the cron worker
 * stays decoupled — it never imports domain-specific code directly.
 */

export interface CronLifecycleContext {
  cronJobId: string
  cronJobName: string
  workspaceId: string
  sessionId: string
}

export interface CronLifecycleHook {
  /**
   * Return true if this hook should handle the given cron job.
   * Called once per execution — the result is cached for subsequent phases.
   */
  matches(cronJobId: string): Promise<boolean>

  /** Called before the agent loop starts. Use for status updates, etc. */
  onBefore?(ctx: CronLifecycleContext): Promise<void>

  /**
   * Optionally override the agent prompt.
   * Return a string to replace it, or undefined to keep the original.
   */
  buildPrompt?(ctx: CronLifecycleContext): Promise<string | undefined>

  /**
   * Called when a new session is created for this cron execution.
   * Use to tag the session or link it to the owning entity.
   */
  onSessionCreated?(ctx: CronLifecycleContext): Promise<{ source?: string }>

  /** Called when the cron execution completes successfully. */
  onSuccess?(ctx: CronLifecycleContext): Promise<void>

  /** Called when the cron execution fails. */
  onError?(ctx: CronLifecycleContext, error: unknown): Promise<void>
}

const hooks: CronLifecycleHook[] = []

export function registerCronLifecycleHook(hook: CronLifecycleHook) {
  hooks.push(hook)
}

/**
 * Find the first matching hook for a cron job.
 * Returns undefined if no hook matches (i.e. a plain cron).
 */
export async function findCronHook(cronJobId: string): Promise<CronLifecycleHook | undefined> {
  for (const hook of hooks) {
    if (await hook.matches(cronJobId)) {
      return hook
    }
  }
  return undefined
}
