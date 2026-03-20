
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ChevronRight, ChevronLeft, Send, ExternalLink, CheckCircle2, Loader2 } from 'lucide-react'
import { useTestBotToken } from '@/hooks/use-channels'

interface StepChannelsProps {
  telegramEnabled: boolean
  telegramToken: string
  telegramTokenTested: boolean
  onTelegramEnabledChange: (enabled: boolean) => void
  onTelegramTokenChange: (token: string) => void
  onTokenTested: (tested: boolean) => void
  onBack: () => void
  onNext: () => void
}

export function StepChannels({
  telegramEnabled,
  telegramToken,
  telegramTokenTested,
  onTelegramEnabledChange,
  onTelegramTokenChange,
  onTokenTested,
  onBack,
  onNext,
}: StepChannelsProps) {
  const testToken = useTestBotToken()

  const handleTest = () => {
    if (telegramToken.trim()) {
      testToken.mutate(telegramToken.trim(), {
        onSuccess: () => onTokenTested(true),
      })
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Channels</h2>
        <p className="text-muted-foreground mt-1">
          Connect external messaging platforms to interact with the assistant outside the web
          interface.
        </p>
      </div>
      <div className="flex flex-col gap-4">
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
            <Switch checked={telegramEnabled} onCheckedChange={onTelegramEnabledChange} />
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
                  and paste the token below.{' '}
                  {telegramTokenTested
                    ? 'The channel will be activated automatically when setup completes.'
                    : 'You can enable it later from Settings.'}
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
                  <p className="text-xs text-green-600">Connected to @{testToken.data.username}</p>
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

        <div className="flex justify-between mt-8 pt-6 border-t border-border/50">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext}>
            {telegramEnabled && !telegramToken.trim() ? 'Skip' : 'Next'}
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  )
}
