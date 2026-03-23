import { TimezoneCard } from './sections/timezone-card'
import { ModelConfigCard } from './sections/model-config-card'
import { ApiKeysSection } from './sections/api-keys-section'
import { GoogleOAuthCard } from './sections/google-oauth-card'
import { TokenUsageCard } from './sections/token-usage-card'
import { UpdateCard } from './sections/update-card'

export function GlobalGeneralSettingsPage() {
  return (
    <div className="flex flex-col gap-4 md:gap-6 max-w-2xl">
      <UpdateCard />
      <TimezoneCard />
      <ModelConfigCard />
      <ApiKeysSection />
      <GoogleOAuthCard />
      <TokenUsageCard />
    </div>
  )
}
