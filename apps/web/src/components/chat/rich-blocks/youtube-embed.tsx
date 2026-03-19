import { Play } from 'lucide-react'

interface YoutubeEmbedProps {
  videoId: string
  title?: string
}

export function YoutubeEmbed({ videoId, title }: YoutubeEmbedProps) {
  const embedUrl = `https://www.youtube.com/embed/${videoId}`
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <div className="relative aspect-video w-full">
        <iframe
          title={title ?? 'YouTube video'}
          src={embedUrl}
          className="absolute inset-0 h-full w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
      {title && (
        <a
          href={watchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors !no-underline"
        >
          <Play className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </a>
      )}
    </div>
  )
}
