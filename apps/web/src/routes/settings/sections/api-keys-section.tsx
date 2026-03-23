import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  useGlobalProviders,
  useSetGlobalProviderConnection,
  useRemoveGlobalProviderConnection,
} from '@/hooks/use-providers'
import { ProviderConnectionRow } from '@/components/provider-connection-row'

export function ApiKeysSection() {
  const { data, isPending } = useGlobalProviders()
  const setProviderConnection = useSetGlobalProviderConnection()
  const removeProviderConnection = useRemoveGlobalProviderConnection()

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
        {Object.entries(data.metadata).map(([provider, metadata]) => (
          <ProviderConnectionRow
            key={provider}
            provider={provider}
            metadata={metadata}
            info={data.connections[provider]}
            onSave={(value) => setProviderConnection.mutate({ provider, value })}
            onRemove={() => removeProviderConnection.mutate(provider)}
            isSaving={setProviderConnection.isPending}
            isRemoving={removeProviderConnection.isPending}
            basePath="/global-settings"
            variant="settings"
          />
        ))}
      </CardContent>
    </Card>
  )
}
