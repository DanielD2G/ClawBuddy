import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { WORKSPACE_COLORS } from '@/constants'

interface StepWorkspaceProps {
  name: string
  color: string
  onNameChange: (name: string) => void
  onColorChange: (color: string) => void
  onBack: () => void
  onNext: () => void
}

export function StepWorkspace({
  name,
  color,
  onNameChange,
  onColorChange,
  onBack,
  onNext,
}: StepWorkspaceProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Workspace</CardTitle>
        <CardDescription>
          Everything in AgentBuddy lives inside a workspace — documents, chats, and capabilities.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Workspace name</label>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. My Project, Research, Team Docs"
            className="text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Color</label>
          <div className="flex gap-2 flex-wrap">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onColorChange(c)}
                className={`size-8 rounded-full transition-all ${
                  color === c ? 'ring-2 ring-offset-2 ring-brand scale-110' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext} disabled={!name.trim()}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
