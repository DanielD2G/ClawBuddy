import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor } from 'lucide-react'

interface AppearanceCardProps {
  theme: string
  setTheme: (theme: 'light' | 'dark' | 'system') => void
}

export function AppearanceCard({ theme, setTheme }: AppearanceCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize how ClawBuddy looks.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Theme</label>
          <div className="flex gap-2">
            <Button
              variant={theme === 'light' ? 'default' : 'outline'}

              onClick={() => setTheme('light')}
            >
              <Sun data-icon="inline-start" /> Light
            </Button>
            <Button
              variant={theme === 'dark' ? 'default' : 'outline'}

              onClick={() => setTheme('dark')}
            >
              <Moon data-icon="inline-start" /> Dark
            </Button>
            <Button
              variant={theme === 'system' ? 'default' : 'outline'}

              onClick={() => setTheme('system')}
            >
              <Monitor data-icon="inline-start" /> System
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
