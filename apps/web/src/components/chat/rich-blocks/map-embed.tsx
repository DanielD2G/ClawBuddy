import { MapPin } from 'lucide-react'

interface MapEmbedProps {
  address: string
  label?: string
}

export function MapEmbed({ address, label }: MapEmbedProps) {
  const encodedAddress = encodeURIComponent(address)
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`
  const embedUrl = `https://maps.google.com/maps?q=${encodedAddress}&output=embed&z=15`

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <iframe
        title={label ?? address}
        src={embedUrl}
        className="h-[250px] w-full border-0"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
      />
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <MapPin className="size-3.5 shrink-0" />
        <span className="truncate">{label ?? address}</span>
      </a>
    </div>
  )
}
