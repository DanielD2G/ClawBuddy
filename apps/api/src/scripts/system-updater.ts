import { systemUpdateService } from '../services/system-update.service.js'

try {
  await systemUpdateService.runDetachedUpdateJob()
  process.exit(0)
} catch (error) {
  console.error('[SystemUpdate] Detached updater failed:', error)
  process.exit(1)
}
