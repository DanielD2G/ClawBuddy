import { Outlet, Link, useLocation } from 'react-router-dom'
import { Settings, Puzzle, Clock, Database, Globe, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

const navGroups = [
  {
    title: 'Workspace',
    items: [
      { label: 'General', icon: Settings, href: '/settings/workspace/general' },
      { label: 'Capabilities', icon: Puzzle, href: '/settings/workspace/capabilities' },
      { label: 'Channels', icon: Send, href: '/settings/workspace/channels' },
    ],
  },
  {
    title: 'Globals',
    items: [
      { label: 'General', icon: Settings, href: '/settings/globals/general' },
      { label: 'Browser', icon: Globe, href: '/settings/globals/browser' },
    ],
  },
  {
    title: 'Data',
    items: [
      { label: 'Overview', icon: Database, href: '/settings/data/overview' },
      { label: 'Cron Jobs', icon: Clock, href: '/settings/data/cron' },
    ],
  },
]

export function SettingsLayout() {
  const { pathname } = useLocation()

  const isActive = (href: string) => pathname.startsWith(href)

  return (
    <div className="flex flex-col md:flex-row h-full">
      <div className="mb-4 flex flex-col gap-4 p-1 md:hidden">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-2">
            <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h2>
            <div className="flex overflow-x-auto gap-1 scrollbar-none">
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive(item.href)
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <item.icon className="size-3.5" />
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <nav className="hidden md:block w-[200px] shrink-0 border-r p-4">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">Settings</h2>
        <div className="space-y-5">
          {navGroups.map((group) => (
            <div key={group.title} className="space-y-1">
              <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      to={item.href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        'hover:bg-accent hover:text-accent-foreground',
                        isActive(item.href)
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <main className="flex-1 overflow-auto px-4 py-4 md:p-6">
        <Outlet />
      </main>
    </div>
  )
}
