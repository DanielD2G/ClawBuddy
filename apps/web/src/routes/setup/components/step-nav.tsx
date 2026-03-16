import { Check, ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface StepDefinition {
  label: string
  icon: LucideIcon
}

interface StepNavProps {
  visibleSteps: StepDefinition[]
  currentStep: number
}

export function StepNav({ visibleSteps, currentStep }: StepNavProps) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8">
      {visibleSteps.map((s, i) => {
        const Icon = s.icon
        const isActive = i === currentStep
        const isDone = i < currentStep
        return (
          <div key={s.label} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-brand text-brand-foreground'
                  : isDone
                    ? 'bg-brand/10 text-brand'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {isDone ? <Check className="size-3" /> : <Icon className="size-3" />}
              <span className="hidden sm:inline">{s.label}</span>
            </div>
            {i < visibleSteps.length - 1 && (
              <ChevronRight className="size-3 text-muted-foreground/50" />
            )}
          </div>
        )
      })}
    </div>
  )
}
