export interface RichMapBlock {
  type: 'rich-map'
  address: string
  label?: string
}

export interface RichProductBlock {
  type: 'rich-product'
  name: string
  price: number
  image?: string
  currency?: string
  url?: string
}

export interface RichImageBlock {
  type: 'rich-image'
  src: string
  alt?: string
}

export interface RichYoutubeBlock {
  type: 'rich-youtube'
  videoId: string
  title?: string
}

export interface RichHtmlBlock {
  type: 'rich-html'
  html: string
}

export type RichBlock =
  | RichMapBlock
  | RichProductBlock
  | RichImageBlock
  | RichYoutubeBlock
  | RichHtmlBlock

export type ParsedSegment = { type: 'text'; text: string } | RichBlock

const RICH_BLOCK_RE = /```rich-([\w-]+)\n([\s\S]*?)```/g

function extractYoutubeId(url: string): string | undefined {
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/,
  )
  return match?.[1]
}

function parseBlockData(blockType: string, raw: string): RichBlock | null {
  // HTML block: raw content, no JSON parsing
  if (blockType === 'html') {
    const trimmed = raw.trim()
    return trimmed ? { type: 'rich-html', html: trimmed } : null
  }

  try {
    const data = JSON.parse(raw.trim())

    switch (blockType) {
      case 'map':
        if (typeof data.address === 'string') {
          return { type: 'rich-map', address: data.address, label: data.label }
        }
        return null
      case 'product':
        if (typeof data.name === 'string' && typeof data.price === 'number') {
          return {
            type: 'rich-product',
            name: data.name,
            price: data.price,
            image: data.image,
            currency: data.currency,
            url: data.url,
          }
        }
        return null
      case 'image':
        if (typeof data.src === 'string') {
          return { type: 'rich-image', src: data.src, alt: data.alt }
        }
        return null
      case 'youtube': {
        let videoId: string | undefined = data.videoId
        if (!videoId && typeof data.url === 'string') {
          videoId = extractYoutubeId(data.url)
        }
        if (videoId) {
          return { type: 'rich-youtube', videoId, title: data.title }
        }
        return null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

export function parseRichBlocks(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(RICH_BLOCK_RE)) {
    const matchStart = match.index!
    const matchEnd = matchStart + match[0].length

    // Add preceding text
    if (matchStart > lastIndex) {
      const preceding = text.slice(lastIndex, matchStart)
      if (preceding.trim()) {
        segments.push({ type: 'text', text: preceding })
      }
    }

    const blockType = match[1]
    const blockBody = match[2]
    const parsed = parseBlockData(blockType, blockBody)

    if (parsed) {
      segments.push(parsed)
    } else {
      // Could not parse — keep as raw text
      segments.push({ type: 'text', text: match[0] })
    }

    lastIndex = matchEnd
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex)
    if (remaining.trim()) {
      segments.push({ type: 'text', text: remaining })
    }
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }]
}
