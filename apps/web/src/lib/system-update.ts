export type SystemUpdateStateStatus =
  | 'idle'
  | 'available'
  | 'queued'
  | 'pulling'
  | 'replacing_api'
  | 'waiting_api'
  | 'replacing_web'
  | 'succeeded'
  | 'failed'

export function isSystemUpdateInProgress(status: SystemUpdateStateStatus): boolean {
  return (
    status === 'queued' ||
    status === 'pulling' ||
    status === 'replacing_api' ||
    status === 'waiting_api' ||
    status === 'replacing_web'
  )
}

export function getSystemUpdatePollInterval(status: SystemUpdateStateStatus): number {
  return isSystemUpdateInProgress(status) ? 3000 : 5 * 60_000
}

export function getSystemUpdateToastMessage(status: SystemUpdateStateStatus): string {
  switch (status) {
    case 'queued':
      return 'Update queued.'
    case 'pulling':
      return 'Pulling updated images...'
    case 'replacing_api':
      return 'Recreating the API container...'
    case 'waiting_api':
      return 'Waiting for the updated API to become healthy...'
    case 'replacing_web':
      return 'Recreating the web container...'
    case 'succeeded':
      return 'ClawBuddy updated successfully.'
    case 'failed':
      return 'The update failed.'
    default:
      return ''
  }
}
