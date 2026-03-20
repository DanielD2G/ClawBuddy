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
  const progress = visibleSteps.length > 1 ? (currentStep / (visibleSteps.length - 1)) * 100 : 0

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">
          Step {currentStep + 1} of {visibleSteps.length}
        </span>
        <span className="text-sm font-medium">{visibleSteps[currentStep]?.label}</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-brand transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
