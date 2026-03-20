import { useState, useCallback } from 'react'
import { ImageOff, Download } from 'lucide-react'

interface ImageBlockProps {
  src: string
  alt?: string
}

export function ImageBlock({ src, alt }: ImageBlockProps) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(src)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      // Extract filename from URL or use a default
      const urlPath = new URL(src, window.location.origin).pathname
      const filename = urlPath.split('/').pop() || 'image.png'
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch {
      // Fallback: open in new tab
      window.open(src, '_blank')
    }
  }, [src])

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
      {!loaded && <div className="h-40 animate-pulse rounded-lg bg-muted/40" />}
      <div className={`group relative inline-block ${loaded ? '' : 'hidden'}`}>
        <img
          src={src}
          alt={alt ?? ''}
          className="max-w-full rounded-lg border border-border"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
        <button
          onClick={handleDownload}
          className="absolute right-2 top-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 group-hover:opacity-100"
          title="Download image"
        >
          <Download className="size-3.5" />
          Download
        </button>
      </div>
      {alt && loaded && <p className="mt-1 text-xs text-muted-foreground">{alt}</p>}
    </div>
  )
}
