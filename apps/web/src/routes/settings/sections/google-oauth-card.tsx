import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useQuery, useMutation } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Mail, ExternalLink, ChevronDown, ChevronRight, Info, CheckCircle2, XCircle, Zap, Loader2 } from 'lucide-react'

export function GoogleOAuthCard() {
  const [showGuide, setShowGuide] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['google-oauth-config'],
    queryFn: () => apiClient.get<{ configured: boolean }>('/setup/google-oauth'),
  })

  const testMutation = useMutation({
    mutationFn: () => apiClient.post<{
      valid: boolean
      message?: string
      apis?: { gmail: boolean; calendar: boolean; drive: boolean }
      connectedEmail?: string | null
    }>('/setup/google-oauth/test', {}),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-5" />
          Google OAuth
        </CardTitle>
        <CardDescription>
          Google Workspace integration (Gmail, Calendar, Drive). Configured via environment variables.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Step-by-step setup guide */}
        <div className="rounded-lg border bg-muted/30">
          <button
            type="button"
            onClick={() => setShowGuide(!showGuide)}
            className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-left hover:bg-muted/50 transition-colors rounded-lg"
          >
            <Info className="size-4 text-brand shrink-0" />
            How to create Google OAuth credentials
            {showGuide ? <ChevronDown className="size-4 ml-auto text-muted-foreground" /> : <ChevronRight className="size-4 ml-auto text-muted-foreground" />}
          </button>
          {showGuide && (
            <div className="px-4 pb-4 space-y-3">
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>
                  Go to the{' '}
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    Google Cloud Console &gt; Credentials
                    <ExternalLink className="inline size-3 ml-0.5" />
                  </a>
                </li>
                <li>Click <strong className="text-foreground">Create Credentials</strong> &gt; <strong className="text-foreground">OAuth client ID</strong> and select <strong className="text-foreground">Web application</strong> as the application type</li>
                <li>
                  If prompted, configure the <strong className="text-foreground">OAuth consent screen</strong> first:
                  <ul className="list-disc list-inside ml-4 mt-1 space-y-1 text-xs">
                    <li>Choose <strong className="text-foreground">External</strong> user type (or Internal for Google Workspace orgs)</li>
                    <li>Fill in app name, support email, and authorized domains</li>
                    <li>Add scopes: <code className="bg-muted px-1 rounded">Gmail API</code>, <code className="bg-muted px-1 rounded">Calendar API</code>, <code className="bg-muted px-1 rounded">Drive API</code></li>
                    <li>Add your email as a test user (required while app is in "Testing" status)</li>
                  </ul>
                </li>
                <li>
                  Under <strong className="text-foreground">Authorized redirect URIs</strong>, add:
                  <code className="block mt-1 bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                    {window.location.origin}/api/oauth/google/callback
                  </code>
                </li>
                <li>
                  Set the environment variables <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> and restart the server
                </li>
              </ol>
              <p className="text-xs text-muted-foreground/70">
                Make sure these APIs are enabled in your project:{' '}
                <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  Gmail API
                  <ExternalLink className="inline size-3 ml-0.5" />
                </a>
                {', '}
                <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  Calendar API
                  <ExternalLink className="inline size-3 ml-0.5" />
                </a>
                {', '}
                <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  Drive API
                  <ExternalLink className="inline size-3 ml-0.5" />
                </a>
              </p>
            </div>
          )}
        </div>
        {isLoading && <div className="text-sm text-muted-foreground">Loading...</div>}

        {data && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={data.configured ? 'default' : 'secondary'} className="text-xs">
                {data.configured ? 'Configured' : 'Not configured'}
              </Badge>
              {data.configured && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => testMutation.mutate()}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? (
                    <Loader2 className="size-3 mr-1 animate-spin" />
                  ) : (
                    <Zap className="size-3 mr-1" />
                  )}
                  Test Connection
                </Button>
              )}
              {testMutation.isError && (
                <span className="inline-flex items-center gap-1 text-xs text-destructive">
                  <XCircle className="size-3.5" />
                  Connection test failed
                </span>
              )}
            </div>

            {/* Test results */}
            {testMutation.isSuccess && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  {testMutation.data.valid ? (
                    <CheckCircle2 className="size-4 text-green-600 shrink-0" />
                  ) : (
                    <XCircle className="size-4 text-destructive shrink-0" />
                  )}
                  <span className="text-sm font-medium">
                    {testMutation.data.valid ? 'Client credentials are valid' : (testMutation.data.message || 'Invalid credentials')}
                  </span>
                </div>

                {testMutation.data.connectedEmail && (
                  <p className="text-xs text-muted-foreground ml-6">
                    Testing with connected account: <strong>{testMutation.data.connectedEmail}</strong>
                  </p>
                )}

                {testMutation.data.apis && (
                  <div className="ml-6 space-y-1">
                    {Object.entries(testMutation.data.apis).map(([api, ok]) => (
                      <div key={api} className="flex items-center gap-2 text-xs">
                        {ok ? (
                          <CheckCircle2 className="size-3.5 text-green-600" />
                        ) : (
                          <XCircle className="size-3.5 text-destructive" />
                        )}
                        <span className={ok ? 'text-muted-foreground' : 'text-destructive'}>
                          {api === 'gmail' ? 'Gmail API' : api === 'calendar' ? 'Calendar API' : 'Drive API'}
                        </span>
                        {!ok && (
                          <a
                            href={`https://console.cloud.google.com/apis/library/${api === 'gmail' ? 'gmail.googleapis.com' : api === 'calendar' ? 'calendar-json.googleapis.com' : 'drive.googleapis.com'}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand hover:underline"
                          >
                            Enable
                            <ExternalLink className="inline size-3 ml-0.5" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {testMutation.data.valid && !testMutation.data.apis && (
                  <p className="text-xs text-muted-foreground ml-6">
                    Connect a Google account on a workspace to test API access.
                  </p>
                )}
              </div>
            )}

            {!data.configured && (
              <p className="text-xs text-muted-foreground">
                Set <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> environment variables to enable Google Workspace integration.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
