import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { WORKSPACE_COLORS } from '@/constants'
import { TimezoneSelect } from '@/components/timezone-select'

interface StepWorkspaceProps {
  name: string
  color: string
  timezone: string
  onNameChange: (name: string) => void
  onColorChange: (color: string) => void
  onTimezoneChange: (tz: string) => void
  onBack: () => void
  onNext: () => void
}

export function StepWorkspace({
  name,
  color,
  timezone,
  onNameChange,
  onColorChange,
  onTimezoneChange,
  onBack,
  onNext,
}: StepWorkspaceProps) {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Create Workspace</h2>
        <p className="text-muted-foreground mt-1">
          Everything in ClawBuddy lives inside a workspace — documents, chats, and capabilities.
        </p>
      </div>
      <div className="flex flex-col gap-4">
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
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Timezone</label>
          <TimezoneSelect value={timezone} onChange={onTimezoneChange} />
          <p className="text-xs text-muted-foreground">
            Auto-detected from your browser. Change if needed.
          </p>
        </div>
        <div className="flex justify-between mt-8 pt-6 border-t border-border/50">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext} disabled={!name.trim()}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  )
}
