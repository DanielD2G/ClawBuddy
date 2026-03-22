export interface WebBuildInfo {
  version: string
  commitSha: string
  builtAt: string | null
}

export const webBuildInfo: WebBuildInfo = {
  version: __CLAWBUDDY_BUILD_INFO__.version || 'dev',
  commitSha: __CLAWBUDDY_BUILD_INFO__.commitSha || 'local',
  builtAt: __CLAWBUDDY_BUILD_INFO__.builtAt || null,
}
