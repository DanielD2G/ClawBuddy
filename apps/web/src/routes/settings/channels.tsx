import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import {
  useChannels,
  useCreateChannel,
  useToggleChannel,
  useTestChannel,
  useUpdateChannel,
  useDeleteChannel,
} from '@/hooks/use-channels'
import { Send, Loader2, CheckCircle2, XCircle, Trash2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

export function ChannelsSettingsPage() {
  const { activeWorkspace } = useActiveWorkspace()
  const { data: channels, isLoading } = useChannels(activeWorkspace?.id)
  const createChannel = useCreateChannel()
  const toggleChannel = useToggleChannel()
  const testChannel = useTestChannel()
  const updateChannel = useUpdateChannel()
  const deleteChannel = useDeleteChannel()

  const [botToken, setBotToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [newBotToken, setNewBotToken] = useState('')

  const telegramChannel = channels?.find((ch) => ch.type === 'telegram')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const handleCreate = async () => {
    if (!activeWorkspace || !botToken.trim()) return
    try {
      await createChannel.mutateAsync({
        workspaceId: activeWorkspace.id,
        type: 'telegram',
        name: 'Telegram',
        config: { botToken: botToken.trim() },
      })
      setBotToken('')
      toast.success('Telegram channel created')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create channel')
    }
  }

  const handleToggle = async (enabled: boolean) => {
    if (!telegramChannel) return
    try {
      await toggleChannel.mutateAsync({ id: telegramChannel.id, enabled })
      toast.success(enabled ? 'Telegram bot started' : 'Telegram bot stopped')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle channel')
    }
  }

  const handleTest = async () => {
    if (!telegramChannel) return
    try {
      const result = await testChannel.mutateAsync(telegramChannel.id)
      toast.success(`Connected to @${result.username}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection test failed')
    }
  }

  const handleUpdateToken = async () => {
    if (!telegramChannel || !newBotToken.trim()) return
    try {
      // If bot is running, stop it first
      if (telegramChannel.enabled) {
        await toggleChannel.mutateAsync({ id: telegramChannel.id, enabled: false })
      }
      await updateChannel.mutateAsync({
        id: telegramChannel.id,
        config: { botToken: newBotToken.trim() },
      })
      setNewBotToken('')
      toast.success('Bot token updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update token')
    }
  }

  const handleDelete = async () => {
    if (!telegramChannel) return
    try {
      await deleteChannel.mutateAsync(telegramChannel.id)
      toast.success('Telegram channel removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete channel')
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Channels</h2>
        <p className="text-muted-foreground">
          Connect external messaging platforms to this workspace.
        </p>
      </div>

      {/* Telegram Channel */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              <CardTitle className="text-base">Telegram</CardTitle>
            </div>
            {telegramChannel && (
              <div className="flex items-center gap-2">
                <Badge variant={telegramChannel.running ? 'default' : 'secondary'}>
                  {telegramChannel.running ? (
                    <>
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Running
                    </>
                  ) : (
                    <>
                      <XCircle className="mr-1 h-3 w-3" /> Stopped
                    </>
                  )}
                </Badge>
                <Switch
                  checked={telegramChannel.enabled}
                  onCheckedChange={handleToggle}
                  disabled={toggleChannel.isPending}
                />
              </div>
            )}
          </div>
          <CardDescription>
            Chat with the AI assistant from Telegram. Messages create conversations visible in the
            web interface.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!telegramChannel ? (
            // Setup form
            <>
              <div className="rounded-md bg-muted p-3">
                <p className="text-sm text-muted-foreground">
                  To set up Telegram, create a bot via{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline underline-offset-4 inline-flex items-center gap-0.5"
                  >
                    @BotFather <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  and paste the bot token below.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Bot Token</label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                  />
                  <Button
                    onClick={handleCreate}
                    disabled={!botToken.trim() || createChannel.isPending}
                  >
                    {createChannel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Connect
                  </Button>
                </div>
              </div>
            </>
          ) : (
            // Existing channel management
            <>
              {telegramChannel.config.botUsername && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Bot:</span>
                  <a
                    href={`https://t.me/${telegramChannel.config.botUsername}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium underline underline-offset-4 inline-flex items-center gap-0.5"
                  >
                    @{telegramChannel.config.botUsername} <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}

              {/* Token display */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Bot Token</label>
                <div className="flex gap-2">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={telegramChannel.config.botToken}
                    readOnly
                  />
                  <Button variant="outline" onClick={() => setShowToken(!showToken)}>
                    {showToken ? 'Hide' : 'Show'}
                  </Button>
                </div>
              </div>

              {/* Update token */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Update Token</label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={newBotToken}
                    onChange={(e) => setNewBotToken(e.target.value)}
                    placeholder="Paste new bot token"
                  />
                  <Button
                    variant="outline"
                    onClick={handleUpdateToken}
                    disabled={!newBotToken.trim() || updateChannel.isPending}
                  >
                    Update
                  </Button>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleTest} disabled={testChannel.isPending}>
                  {testChannel.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : testChannel.isSuccess ? (
                    <CheckCircle2 className="mr-2 h-4 w-4 text-green-500" />
                  ) : testChannel.isError ? (
                    <XCircle className="mr-2 h-4 w-4 text-red-500" />
                  ) : null}
                  Test Connection
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteChannel.isPending}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Usage info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>Send any message to your bot to start a conversation</li>
            <li>
              Use <code className="rounded bg-muted px-1 py-0.5">/new</code> to start a fresh
              conversation
            </li>
            <li>
              Use <code className="rounded bg-muted px-1 py-0.5">/help</code> to see available
              commands
            </li>
            <li>
              All conversations appear in the chat sidebar and are fully accessible from the web
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
