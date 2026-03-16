import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { PROVIDER_LABELS } from '@/constants'

interface StepChatModelProps {
  providers: any
  onUpdate: (data: any) => void
  isUpdating: boolean
  onBack: () => void
  onNext: () => void
}

export function StepChatModel({
  providers,
  onUpdate,
  isUpdating,
  onBack,
  onNext,
}: StepChatModelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Model</CardTitle>
        <CardDescription>
          Choose the AI provider and model for chat conversations. You can change this later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-sm font-medium">Provider</label>
            <Select
              value={providers.active.llm}
              onValueChange={(value) => {
                const defaultModel = providers.models.llm[value]?.[0]
                onUpdate({ llm: value, llmModel: defaultModel })
              }}
              disabled={isUpdating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.available.llm.map((p: string) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABELS[p] ?? p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-sm font-medium">Model</label>
            <Select
              value={providers.active.llmModel ?? ''}
              onValueChange={(value) => onUpdate({ llmModel: value })}
              disabled={isUpdating}
            >
              <SelectTrigger>
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                {(providers.models.llm[providers.active.llm] ?? []).map((m: string) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
