import { ExternalLink } from 'lucide-react'

export interface Source {
  label: string
  url: string
}

interface SourcesFooterProps {
  sources?: Source[]
}

export function SourcesFooter({ sources }: SourcesFooterProps) {
  if (!sources?.length) return null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Sources
      </span>
      {sources.map((src, i) => (
        <a
          key={i}
          href={src.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-brand"
        >
          {src.label}
          <ExternalLink className="size-2.5" />
        </a>
      ))}
    </div>
  )
}
