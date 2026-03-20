import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Sun, Moon } from 'lucide-react'
import { useTheme } from '@/providers/theme-provider'

export function Header() {
  const { theme, setTheme } = useTheme()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none">
      <SidebarTrigger className="pointer-events-auto size-9 rounded-full border border-border/50 bg-background shadow-sm dark:bg-muted dark:border-border/30" />
      <Button
        variant="ghost"
        size="icon"
        className="pointer-events-auto size-9 rounded-full border border-border/50 bg-background shadow-sm dark:bg-muted dark:border-border/30"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
      >
        {isDark ? <Sun data-icon /> : <Moon data-icon />}
      </Button>
    </div>
  )
}
