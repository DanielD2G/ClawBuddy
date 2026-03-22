import { useState } from 'react'
import {
  FolderOpen,
  FileText,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  Search,
  ChevronsUpDown,
  Check,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useDataStats,
  useDataWorkspaces,
  useDataDocuments,
  useDataConversations,
} from '@/hooks/use-data-overview'
import { DEFAULT_PAGE_SIZE } from '@/constants'

const STATUS_COLORS: Record<string, string> = {
  READY: 'bg-green-500/10 text-green-700 dark:text-green-400',
  PENDING: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  PROCESSING: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  FAILED: 'bg-red-500/10 text-red-700 dark:text-red-400',
}

export function DataOverviewPage() {
  return (
    <div className="space-y-8">
      <StatsCards />
      <WorkspacesSection />
      <DocumentsSection />
      <ConversationsSection />
    </div>
  )
}

function StatsCards() {
  const { data, isLoading } = useDataStats()

  const cards = [
    { label: 'Workspaces', value: data?.workspaces, icon: FolderOpen },
    { label: 'Documents', value: data?.documents, icon: FileText },
    { label: 'Conversations', value: data?.conversations, icon: MessageSquare },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <Icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-3xl font-bold">{card.value ?? 0}</p>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function WorkspacesSection() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading } = useDataWorkspaces({ page, limit: DEFAULT_PAGE_SIZE, search })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Workspaces</h2>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search workspaces..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="pl-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Documents</TableHead>
              <TableHead>Conversations</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.workspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No workspaces found
                </TableCell>
              </TableRow>
            ) : (
              data?.workspaces.map((ws) => (
                <TableRow key={ws.id}>
                  <TableCell className="font-medium">{ws.name}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">
                    {ws.description || '\u2014'}
                  </TableCell>
                  <TableCell>{ws._count.documents}</TableCell>
                  <TableCell>{ws._count.chatSessions}</TableCell>
                  <TableCell>{new Date(ws.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {data?.total} workspace{data?.total !== 1 ? 's' : ''} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function DocumentsSection() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading } = useDataDocuments({
    page,
    limit: DEFAULT_PAGE_SIZE,
    search,
    status,
  })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Documents</h2>

      <div className="flex gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search documents..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-[140px] items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
              <span>
                {status === ''
                  ? 'All statuses'
                  : status === 'READY'
                    ? 'Ready'
                    : status === 'PENDING'
                      ? 'Pending'
                      : status === 'PROCESSING'
                        ? 'Processing'
                        : 'Failed'}
              </span>
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {[
              { value: '', label: 'All statuses' },
              { value: 'READY', label: 'Ready' },
              { value: 'PENDING', label: 'Pending' },
              { value: 'PROCESSING', label: 'Processing' },
              { value: 'FAILED', label: 'Failed' },
            ].map((opt) => (
              <DropdownMenuItem
                key={opt.value || 'all'}
                onClick={() => {
                  setStatus(opt.value)
                  setPage(1)
                }}
                className="gap-2"
              >
                <span className="flex-1">{opt.label}</span>
                {status === opt.value && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Chunks</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.documents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No documents found
                </TableCell>
              </TableRow>
            ) : (
              data?.documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium max-w-[200px] truncate">{doc.title}</TableCell>
                  <TableCell>{doc.workspace.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={STATUS_COLORS[doc.status] ?? ''}>
                      {doc.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{doc.type}</TableCell>
                  <TableCell>{doc.chunkCount}</TableCell>
                  <TableCell>{new Date(doc.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {data?.total} document{data?.total !== 1 ? 's' : ''} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ConversationsSection() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading } = useDataConversations({ page, limit: DEFAULT_PAGE_SIZE, search })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Conversations</h2>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search conversations..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="pl-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.conversations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  No conversations found
                </TableCell>
              </TableRow>
            ) : (
              data?.conversations.map((conv) => (
                <TableRow key={conv.id}>
                  <TableCell className="font-medium max-w-[200px] truncate">
                    {conv.title || 'Untitled'}
                  </TableCell>
                  <TableCell>{conv.workspace?.name ?? '\u2014'}</TableCell>
                  <TableCell>{conv._count.messages}</TableCell>
                  <TableCell>{new Date(conv.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {data?.total} conversation{data?.total !== 1 ? 's' : ''} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
