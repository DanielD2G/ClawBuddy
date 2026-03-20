import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAdminSettings } from '@/hooks/use-admin-settings'
import { ProviderConnectionRow } from '@/components/provider-connection-row'

export function ApiKeysSection() {
  const {
    query: { data, isPending },
    setProviderConnection,
    removeProviderConnection,
  } = useAdminSettings()

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider Connections</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const { providers } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Connections</CardTitle>
        <CardDescription>
          Manage provider credentials and local base URLs. Environment values take priority over
          database values.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Object.entries(providers.metadata).map(([provider, metadata]) => (
          <ProviderConnectionRow
            key={provider}
            provider={provider}
            metadata={metadata}
            info={providers.connections[provider]}
            onSave={(value) => setProviderConnection.mutate({ provider, value })}
            onRemove={() => removeProviderConnection.mutate(provider)}
            isSaving={setProviderConnection.isPending}
            isRemoving={removeProviderConnection.isPending}
            basePath="/admin"
            variant="settings"
          />
        ))}
      </CardContent>
    </Card>
  )
}
