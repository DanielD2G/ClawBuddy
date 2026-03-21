import { env } from '../env.js'

export interface BuildInfo {
  version: string
  commitSha: string
  builtAt: string | null
}

export function getBuildInfo(): BuildInfo {
  return {
    version: env.CLAWBUDDY_VERSION || 'dev',
    commitSha: env.CLAWBUDDY_COMMIT_SHA || 'local',
    builtAt: env.CLAWBUDDY_BUILD_TIME || null,
  }
}
