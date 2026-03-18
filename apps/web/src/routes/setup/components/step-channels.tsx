import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ChevronRight, ChevronLeft, Send, ExternalLink, CheckCircle2, Loader2 } from 'lucide-react'
import { useTestBotToken } from '@/hooks/use-channels'

interface StepChannelsProps {
  telegramEnabled: boolean
  telegramToken: string
  onTelegramEnabledChange: (enabled: boolean) => void
  onTelegramTokenChange: (token: string) => void
  onBack: () => void
  onNext: () => void
}

export function StepChannels({
  telegramEnabled,
  telegramToken,
  onTelegramEnabledChange,
  onTelegramTokenChange,
  onBack,
  onNext,
}: StepChannelsProps) {
  const testToken = useTestBotToken()

  const handleTest = () => {
    if (telegramToken.trim()) {
      testToken.mutate(telegramToken.trim())
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channels</CardTitle>
        <CardDescription>
          Connect external messaging platforms to interact with the assistant outside the web interface.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Telegram Card */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Send className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Telegram</p>
                <p className="text-xs text-muted-foreground">Chat via Telegram bot</p>
              </div>
            </div>
            <Switch
              checked={telegramEnabled}
              onCheckedChange={onTelegramEnabledChange}
            />
          </div>

          {telegramEnabled && (
            <div className="space-y-3 pt-2 border-t">
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">
                  Create a bot via{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline underline-offset-4 inline-flex items-center gap-0.5"
                  >
                    @BotFather <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  and paste the token below. You can enable it later from Settings.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Bot Token</label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={telegramToken}
                    onChange={(e) => onTelegramTokenChange(e.target.value)}
                    placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                    className="text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTest}
                    disabled={!telegramToken.trim() || testToken.isPending}
                  >
                    {testToken.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : testToken.isSuccess ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      'Test'
                    )}
                  </Button>
                </div>
                {testToken.isSuccess && (
                  <p className="text-xs text-green-600">
                    Connected to @{testToken.data.username}
                  </p>
                )}
                {testToken.isError && (
                  <p className="text-xs text-destructive">
                    Invalid token. Please check and try again.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext}>
            {telegramEnabled && !telegramToken.trim() ? 'Skip' : 'Next'}
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
