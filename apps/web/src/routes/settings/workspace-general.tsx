import { useTheme } from '@/providers/theme-provider'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { AppearanceCard } from './sections/appearance-card'
import { WorkspaceColorCard } from './sections/workspace-color-card'
import { AutoExecuteCard } from './sections/auto-execute-card'
import { SecretRedactionCard } from './sections/secret-redaction-card'
import { WorkspacePermissionsCard } from './sections/workspace-permissions-card'

export function WorkspaceGeneralSettingsPage() {
  const { theme, setTheme } = useTheme()
  const { activeWorkspaceId } = useActiveWorkspace()

  return (
    <div className="flex max-w-2xl flex-col gap-4 md:gap-6">
      <AppearanceCard theme={theme} setTheme={setTheme} />
      <WorkspaceColorCard />
      {!activeWorkspaceId ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Select a workspace to manage workspace-specific settings.
        </div>
      ) : null}
      <AutoExecuteCard />
      <SecretRedactionCard />
      <WorkspacePermissionsCard />
    </div>
  )
}
