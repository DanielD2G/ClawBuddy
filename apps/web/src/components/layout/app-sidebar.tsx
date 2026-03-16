import { useState, useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Settings,
  SquarePen,
  MessageSquare,
  FolderOpen,
  Trash2,
  ChevronsUpDown,
  Check,
  Play,
  Square,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useChatSessions, useDeleteChatSession } from '@/hooks/use-chat-sessions'
import {
  useWorkspaces,
  useWorkspaceContainerStatus,
  useStartWorkspaceContainer,
  useStopWorkspaceContainer,
} from '@/hooks/use-workspaces'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

function TypingTitle({ title }: { title: string | null }) {
  const [displayed, setDisplayed] = useState(title ?? '')
  const [isTyping, setIsTyping] = useState(false)
  const prevTitle = useRef(title)

  useEffect(() => {
    // Only animate when transitioning from null/empty to a real title
    if (!prevTitle.current && title) {
      setIsTyping(true)
      setDisplayed('')
      let i = 0
      const interval = setInterval(() => {
        i++
        setDisplayed(title.slice(0, i))
        if (i >= title.length) {
          clearInterval(interval)
          setIsTyping(false)
        }
      }, 30)
      prevTitle.current = title
      return () => clearInterval(interval)
    }
    prevTitle.current = title
    setDisplayed(title ?? '')
  }, [title])

  if (!title && !isTyping) return <span>Untitled chat</span>
  return <>{displayed}</>
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const { data: sessions } = useChatSessions()
  const { data: workspaces } = useWorkspaces()
  const deleteSession = useDeleteChatSession()
  const { activeWorkspace, setActiveWorkspace } = useActiveWorkspace()
  const { data: containerStatus } = useWorkspaceContainerStatus(activeWorkspace?.id ?? '')
  const startContainer = useStartWorkspaceContainer()
  const stopContainer = useStopWorkspaceContainer()

  const isRunning = containerStatus?.status === 'running'

  const filteredSessions = sessions?.filter(
    (s) => activeWorkspace && s.workspaceId === activeWorkspace.id,
  )

  // On mobile, close the drawer when navigating
  const closeMobileDrawer = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar>
      <SidebarHeader>
        {/* Workspace Switcher */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent">
              {activeWorkspace?.color ? (
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: activeWorkspace.color }}
                />
              ) : (
                <span className="size-3 shrink-0 rounded-full bg-brand" />
              )}
              <span className="flex-1 truncate text-sm font-semibold">
                {activeWorkspace?.name ?? 'AgentBuddy'}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
            {workspaces && workspaces.length > 0 ? (
              <>
                {workspaces.map((ws) => (
                  <DropdownMenuItem
                    key={ws.id}
                    onClick={() => setActiveWorkspace(ws)}
                    className="gap-2"
                  >
                    {ws.color ? (
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: ws.color }}
                      />
                    ) : (
                      <span className="size-3 shrink-0 rounded-full bg-muted-foreground/30" />
                    )}
                    <span className="flex-1 truncate">{ws.name}</span>
                    {activeWorkspace?.id === ws.id && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </>
            ) : (
              <DropdownMenuItem disabled className="text-muted-foreground">
                No workspaces
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/workspaces" className="gap-2">
                <Settings className="size-3 text-muted-foreground" />
                <span>Manage workspaces</span>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* New chat + Files */}
        <ul className="flex flex-col gap-0.5">
          <li>
            <Link
              to="/"
              onClick={closeMobileDrawer}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent',
                pathname === '/' && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
              )}
            >
              <SquarePen className="size-4 shrink-0" />
              <span>New chat</span>
            </Link>
          </li>
          {activeWorkspace && (
            <li>
              <Link
                to={`/workspaces/${activeWorkspace.id}`}
                onClick={closeMobileDrawer}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent',
                  pathname.startsWith(`/workspaces/${activeWorkspace.id}`) &&
                    'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                )}
              >
                <FolderOpen className="size-4 shrink-0" />
                <span>Files</span>
              </Link>
            </li>
          )}
        </ul>
      </SidebarHeader>

      {/* Chat label */}
      {filteredSessions && filteredSessions.length > 0 && (
        <div className="flex h-8 shrink-0 items-center px-4 text-xs font-medium text-sidebar-foreground/70">
          Your chats
        </div>
      )}

      {/* Chat history — scrollable */}
      <SidebarContent>
        {filteredSessions && filteredSessions.length > 0 && (
          <ul className="flex flex-col gap-0.5 px-2">
            {filteredSessions.map((session) => (
              <li key={session.id} className="group/chat relative">
                <Link
                  to={`/chat/${session.id}`}
                  onClick={closeMobileDrawer}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent',
                    pathname === `/chat/${session.id}` &&
                      'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                    session.activeSandbox && 'ring-1 ring-brand',
                  )}
                >
                  <MessageSquare className="size-4 shrink-0 opacity-60" />
                  <span className="truncate group-hover/chat:mr-5">
                    <TypingTitle title={session.title} />
                  </span>
                  {session.unreadCount > 0 && pathname !== `/chat/${session.id}` && (
                    <span className="ml-auto size-2 shrink-0 rounded-full bg-brand/70" />
                  )}
                </Link>
                <button
                  onClick={() => deleteSession.mutate(session.id)}
                  title="Delete chat"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden size-5 items-center justify-center rounded-md text-sidebar-foreground/40 hover:text-destructive group-hover/chat:flex"
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SidebarContent>

      {/* Footer: Settings + Container status */}
      <SidebarFooter className="p-2">
        <div className="mx-2 h-px bg-sidebar-border mb-1" />

        <ul className="flex flex-col gap-0.5">
          <li>
            <Link
              to="/settings"
              onClick={closeMobileDrawer}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent',
                pathname.startsWith('/settings') &&
                  'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
              )}
            >
              <Settings className="size-4 shrink-0" />
              <span>Settings</span>
            </Link>
          </li>
        </ul>

        {activeWorkspace ? (
          <div className="flex items-center justify-between px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block size-2 rounded-full',
                  isRunning ? 'bg-green-500' : 'bg-muted-foreground/40',
                )}
              />
              <span className="text-sm font-medium text-muted-foreground">
                {containerStatus?.status === 'running' ? 'Running' : 'Stopped'}
              </span>
            </div>
            {isRunning ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  stopContainer.mutate(activeWorkspace.id, {
                    onSuccess: () => toast.success('Container stopped'),
                    onError: () => toast.error('Failed to stop container'),
                  })
                }}
                disabled={stopContainer.isPending}
              >
                {stopContainer.isPending ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-green-500"
                onClick={() => {
                  startContainer.mutate(activeWorkspace.id, {
                    onSuccess: () => toast.success('Container started'),
                    onError: () => toast.error('Failed to start container'),
                  })
                }}
                disabled={startContainer.isPending}
              >
                {startContainer.isPending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="text-sm font-medium text-muted-foreground">AgentBuddy</span>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
