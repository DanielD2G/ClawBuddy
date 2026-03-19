import { useState } from 'react'
import { ImageOff } from 'lucide-react'

interface ImageBlockProps {
  src: string
  alt?: string
}

export function ImageBlock({ src, alt }: ImageBlockProps) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  if (error) {
    return (
      <div className="my-3 flex h-40 items-center justify-center rounded-lg border border-border bg-muted/20">
        <div className="flex flex-col items-center gap-1 text-muted-foreground/50">
          <ImageOff className="size-6" />
          <span className="text-xs">Failed to load image</span>
        </div>
      </div>
    )
  }

  return (
    <div className="my-3">
      {!loaded && (
        <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
      )}
      <img
        src={src}
        alt={alt ?? ''}
        className={`max-w-full rounded-lg border border-border ${loaded ? '' : 'hidden'}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {alt && loaded && (
        <p className="mt-1 text-xs text-muted-foreground">{alt}</p>
      )}
    </div>
  )
}
