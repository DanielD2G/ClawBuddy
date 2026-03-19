import { useState } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'

interface ProductCardProps {
  name: string
  price: number
  image?: string
  currency?: string
  url?: string
}

export function ProductCard({ name, price, image, currency, url }: ProductCardProps) {
  const [imgError, setImgError] = useState(false)

  const formattedPrice = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(price)

  const content = (
    <div className="my-3 flex overflow-hidden rounded-lg border border-border bg-background transition-colors hover:bg-muted/30">
      {image && !imgError ? (
        <div className="flex h-28 w-28 shrink-0 items-center justify-center border-r border-border bg-muted/20">
          <img
            src={image}
            alt={name}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      ) : image && imgError ? (
        <div className="flex h-28 w-28 shrink-0 items-center justify-center border-r border-border bg-muted/20">
          <ImageOff className="size-6 text-muted-foreground/50" />
        </div>
      ) : null}
      <div className="flex flex-1 flex-col justify-center gap-1 px-4 py-3">
        <span className="text-sm font-medium leading-tight text-foreground">{name}</span>
        <span className="text-lg font-semibold text-foreground">{formattedPrice}</span>
        {url && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ExternalLink className="size-3" />
            Ver producto
          </span>
        )}
      </div>
    </div>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block !no-underline [&_*]:!no-underline"
      >
        {content}
      </a>
    )
  }

  return content
}
