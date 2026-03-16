import { Outlet, Link, useLocation } from 'react-router-dom'
import { Settings, Puzzle, Clock, Database, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  {
    label: 'General',
    icon: Settings,
    href: '/settings/general',
  },
  {
    label: 'Capabilities',
    icon: Puzzle,
    href: '/settings/capabilities',
  },
  {
    label: 'Cron Jobs',
    icon: Clock,
    href: '/settings/cron',
  },
  {
    label: 'Data',
    icon: Database,
    href: '/settings/data',
  },
  {
    label: 'Browser',
    icon: Globe,
    href: '/settings/browser',
  },
]

export function SettingsLayout() {
  const { pathname } = useLocation()

  const isActive = (href: string) => pathname.startsWith(href)

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Mobile tabs (shown below md breakpoint) */}
      <div className="flex overflow-x-auto gap-1 p-1 mb-4 md:hidden scrollbar-none">
        {navItems.map((item) => (
          <Link
            key={item.href}
            to={item.href}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
              isActive(item.href)
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            <item.icon className="size-3.5" />
            {item.label}
          </Link>
        ))}
      </div>

      {/* Desktop nav (hidden below md) */}
      <nav className="hidden md:block w-[200px] shrink-0 border-r p-4">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">Settings</h2>
        <ul className="flex flex-col gap-1">
          {navItems.map((item) => (
            <li key={item.href}>
              <Link
                to={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  isActive(item.href)
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground'
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <main className="flex-1 overflow-auto px-4 py-4 md:p-6">
        <Outlet />
      </main>
    </div>
  )
}
