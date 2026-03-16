import { CHUNK_SIZE, CHUNK_OVERLAP } from '@agentbuddy/shared'

export const chunkingService = {
  async splitText(text: string, options?: { chunkSize?: number; overlap?: number }) {
    const chunkSize = options?.chunkSize ?? CHUNK_SIZE
    const overlap = options?.overlap ?? CHUNK_OVERLAP
    const chunks: string[] = []

    let start = 0
    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize))
      start += chunkSize - overlap
    }

    return chunks
  },
}
