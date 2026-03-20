import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSearchable,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronsUpDown, Check } from 'lucide-react'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { PROVIDER_LABELS } from '@/constants'
import type { ProvidersData } from '@/hooks/use-providers'

interface StepEmbeddingProps {
  providers: ProvidersData
  onUpdate: (data: { embedding?: string; embeddingModel?: string }) => void
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
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Embedding Model</h2>
        <p className="text-muted-foreground mt-1">
          Choose the provider and model for document embeddings. This setting is{' '}
          <strong>permanent</strong> and cannot be changed later.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-sm font-medium">Provider</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button disabled={isUpdating} className="flex h-(--control) w-full items-center justify-between rounded-md border border-border bg-muted/40 px-3 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50">
                  <span>{PROVIDER_LABELS[providers.active.embedding] ?? providers.active.embedding}</span>
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {providers.available.embedding.map((p: string) => (
                  <DropdownMenuItem
                    key={p}
                    onClick={() => {
                      const defaultModel = providers.models.embedding[p]?.[0]
                      onUpdate({ embedding: p, embeddingModel: defaultModel })
                    }}
                    className="gap-2"
                  >
                    <span className="flex-1">{PROVIDER_LABELS[p] ?? p}</span>
                    {providers.active.embedding === p && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-sm font-medium">Model</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button disabled={isUpdating} className="flex h-(--control) w-full items-center justify-between rounded-md border border-border bg-muted/40 px-3 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50">
                  <span>{providers.active.embeddingModel || 'Default'}</span>
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuSearchable placeholder="Search models...">
                {(providers.models.embedding[providers.active.embedding] ?? []).map((m: string) => (
                  <DropdownMenuItem
                    key={m}
                    onClick={() => onUpdate({ embeddingModel: m })}
                    className="gap-2"
                  >
                    <span className="flex-1">{m}</span>
                    {providers.active.embeddingModel === m && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSearchable>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex justify-between mt-8 pt-6 border-t border-border/50">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  )
}
