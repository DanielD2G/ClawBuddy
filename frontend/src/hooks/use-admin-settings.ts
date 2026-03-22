import { createSettingsHook } from './use-settings-base'

export const useAdminSettings = createSettingsHook({
  queryKey: 'admin-settings',
  basePath: '/admin',
})
