import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Sun, Moon } from 'lucide-react'
import { useTheme } from '@/providers/theme-provider'

export function Header() {
  const { theme, setTheme } = useTheme()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <>
      {/* Mobile: solo el trigger flotante */}
      <div className="sticky top-0 z-20 p-2 md:hidden">
        <SidebarTrigger />
      </div>

      {/* Desktop: header completo */}
      <header className="sticky top-0 z-20 hidden h-14 items-center gap-3 border-b bg-background/80 backdrop-blur-sm px-4 md:flex">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={() => setTheme(isDark ? 'light' : 'dark')}>
          {isDark ? <Sun data-icon /> : <Moon data-icon />}
        </Button>
      </header>
    </>
  )
}
