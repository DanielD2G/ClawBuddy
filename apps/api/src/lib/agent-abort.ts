/**
 * In-memory registry of active agent loops, keyed by session ID.
 * Allows the abort API endpoint to signal a running agent loop to stop.
 */

const activeLoops = new Map<string, AbortController>()

/** Register a new agent loop and return its AbortController. */
export function registerAgentLoop(sessionId: string): AbortController {
  // Abort any stale loop for the same session
  const existing = activeLoops.get(sessionId)
  if (existing) existing.abort()

  const controller = new AbortController()
  activeLoops.set(sessionId, controller)
  return controller
}

/** Abort a running agent loop. Returns true if one was found. */
export function abortAgentLoop(sessionId: string): boolean {
  const controller = activeLoops.get(sessionId)
  if (!controller) return false
  controller.abort()
  activeLoops.delete(sessionId)
  return true
}

/** Remove the registry entry on normal completion. */
export function unregisterAgentLoop(sessionId: string): void {
  activeLoops.delete(sessionId)
}

/** Check if a loop is currently registered for a session. */
export function isAgentLoopRunning(sessionId: string): boolean {
  return activeLoops.has(sessionId)
}
