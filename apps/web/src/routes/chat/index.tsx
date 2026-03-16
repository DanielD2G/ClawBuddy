import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { MessageSquare } from 'lucide-react'
import { useWorkspaces } from '@/hooks/use-workspaces'

export function ChatIndexPage() {
  const navigate = useNavigate()
  const { data: workspaces, isLoading } = useWorkspaces()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Chat</h1>
        <p className="text-muted-foreground">Select a workspace to start chatting with your documents.</p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading workspaces...</p>}

      {!isLoading && (!workspaces || workspaces.length === 0) && (
        <div className="flex flex-col items-center py-16">
          <MessageSquare className="size-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium">No workspaces yet</p>
          <p className="text-sm text-muted-foreground">Create a workspace first to start chatting.</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces?.map((ws) => (
          <Card
            key={ws.id}
            className="cursor-pointer hover:border-brand transition-colors"
            onClick={() => navigate(`/workspaces/${ws.id}/chat`)}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <MessageSquare className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">{ws.name}</p>
                {ws.description && (
                  <p className="text-xs text-muted-foreground">{ws.description}</p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
