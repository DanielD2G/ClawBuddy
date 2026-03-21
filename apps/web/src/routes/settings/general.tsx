import { useTheme } from '@/providers/theme-provider'
import { AppearanceCard } from './sections/appearance-card'
import { TimezoneCard } from './sections/timezone-card'
import { ModelConfigCard } from './sections/model-config-card'
import { ApiKeysSection } from './sections/api-keys-section'
import { GoogleOAuthCard } from './sections/google-oauth-card'
import { AutoExecuteCard } from './sections/auto-execute-card'
import { SecretRedactionCard } from './sections/secret-redaction-card'
import { TokenUsageCard } from './sections/token-usage-card'
import { UpdateCard } from './sections/update-card'

export function GeneralSettingsPage() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex flex-col gap-4 md:gap-6 max-w-2xl">
      <UpdateCard />
      <AppearanceCard theme={theme} setTheme={setTheme} />
      <TimezoneCard />
      <ModelConfigCard />
      <ApiKeysSection />
      <GoogleOAuthCard />
      <AutoExecuteCard />
      <SecretRedactionCard />
      <TokenUsageCard />
    </div>
  )
}
