import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronRight } from 'lucide-react'

interface StepWelcomeProps {
  onNext: () => void
}

export function StepWelcome({ onNext }: StepWelcomeProps) {
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Welcome to AgentBuddy</CardTitle>
        <CardDescription>
          Let's configure your instance. This will only take a minute.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>We'll set up:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>API keys for your AI providers</li>
            <li>Embedding model for document search</li>
            <li>Chat model for conversations</li>
            <li>Agent capabilities</li>
          </ul>
        </div>
        <div className="flex justify-end mt-2">
          <Button onClick={onNext} className="bg-brand text-brand-foreground hover:bg-brand/90">
            Get started
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
