import { sandboxService } from '../services/sandbox.service.js'

export const CRON_HANDLERS: Record<string, () => Promise<void>> = {
  cleanupIdleContainers: () => sandboxService.cleanupIdleContainers(),
}
