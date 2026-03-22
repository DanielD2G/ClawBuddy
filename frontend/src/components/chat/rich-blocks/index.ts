import { MapEmbed } from './map-embed'
import { ProductCard } from './product-card'
import { ImageBlock } from './image-block'
import { YoutubeEmbed } from './youtube-embed'
import { HtmlPreview } from './html-preview'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const richBlockRenderers: Record<string, React.ComponentType<any>> = {
  'rich-map': MapEmbed,
  'rich-product': ProductCard,
  'rich-image': ImageBlock,
  'rich-youtube': YoutubeEmbed,
  'rich-html': HtmlPreview,
}
