import { ExternalLink } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SourcesFooter, type Source } from './sources-footer'

interface LinkItem {
  title: string
  url: string
  description?: string
  imageUrl?: string
  source?: string
  date?: string
  tag?: string
}

interface LinksCardProps {
  title?: string | null
  config: {
    columns?: number
  }
  data: {
    items: LinkItem[]
    sources?: Source[]
  } | null
}

export function LinksCard({ title, config, data }: LinksCardProps) {
  const items = data?.items ?? []
  const columns = config.columns ?? 2

  return (
    <Card className="h-full py-5 md:py-6">
      {title && (
        <CardHeader className="px-5 md:px-6">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="px-5 md:px-6">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No links available</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {items.map((item, i) => (
              <a
                key={i}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-all hover:ring-1 hover:ring-brand/30 hover:shadow-md"
              >
                {/* Image */}
                {item.imageUrl && (
                  <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="size-full object-cover transition-transform group-hover:scale-105"
                      loading="lazy"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                    {item.tag && (
                      <Badge
                        variant="default"
                        className="absolute left-2.5 top-2.5 text-[10px] uppercase tracking-wider"
                      >
                        {item.tag}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Content */}
                <div className="flex flex-1 flex-col gap-2 p-4 md:p-5">
                  {/* Tag (when no image) */}
                  {!item.imageUrl && item.tag && (
                    <Badge variant="secondary" className="w-fit text-[11px] uppercase tracking-wider">
                      {item.tag}
                    </Badge>
                  )}

                  {/* Meta line */}
                  {(item.date || item.source) && (
                    <p className="text-xs text-muted-foreground">
                      {item.date && <span>{item.date}</span>}
                      {item.date && item.source && <span> / </span>}
                      {item.source && <span>{item.source}</span>}
                    </p>
                  )}

                  {/* Title */}
                  <h3 className="text-base font-semibold leading-snug line-clamp-2 group-hover:text-brand transition-colors">
                    {item.title}
                  </h3>

                  {/* Description */}
                  {item.description && (
                    <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
                      {item.description}
                    </p>
                  )}

                  {/* Read more */}
                  <div className="mt-auto flex items-center gap-1.5 pt-3 text-sm font-medium text-brand/80 group-hover:text-brand transition-colors">
                    Read more
                    <ExternalLink className="size-3.5" />
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
        <SourcesFooter sources={data?.sources} />
      </CardContent>
    </Card>
  )
}
