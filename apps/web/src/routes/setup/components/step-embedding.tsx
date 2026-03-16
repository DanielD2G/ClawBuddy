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

interface StepEmbeddingProps {
  providers: any
  onUpdate: (data: any) => void
  isUpdating: boolean
  onBack: () => void
  onNext: () => void
}

export function StepEmbedding({
  providers,
  onUpdate,
  isUpdating,
  onBack,
  onNext,
}: StepEmbeddingProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedding Model</CardTitle>
        <CardDescription>
          Choose the provider and model for document embeddings. This setting is <strong>permanent</strong> and cannot be changed later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-sm font-medium">Provider</label>
            <Select
              value={providers.active.embedding}
              onValueChange={(value) => {
                const defaultModel = providers.models.embedding[value]?.[0]
                onUpdate({ embedding: value, embeddingModel: defaultModel })
              }}
              disabled={isUpdating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.available.embedding.map((p: string) => (
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
              value={providers.active.embeddingModel ?? ''}
              onValueChange={(value) => onUpdate({ embeddingModel: value })}
              disabled={isUpdating}
            >
              <SelectTrigger>
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                {(providers.models.embedding[providers.active.embedding] ?? []).map((m: string) => (
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
