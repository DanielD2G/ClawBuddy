const MENTION_REGEX = /(?<=^|\s)\/([a-z0-9-]+)/g

interface ParseResult {
  cleanedContent: string
  mentionedSlugs: string[]
}

export const mentionParserService = {
  /**
   * Extract /mentions from message content and return cleaned text + slugs.
   */
  parse(content: string): ParseResult {
    const mentionedSlugs: string[] = []
    let match: RegExpExecArray | null

    while ((match = MENTION_REGEX.exec(content)) !== null) {
      const slug = match[1]
      if (!mentionedSlugs.includes(slug)) {
        mentionedSlugs.push(slug)
      }
    }

    // Remove /mentions from content for cleaner LLM input
    const cleanedContent = content.replace(MENTION_REGEX, '').replace(/\s{2,}/g, ' ').trim()

    return { cleanedContent, mentionedSlugs }
  },

  /**
   * Resolve mentioned slugs against available capabilities.
   * Returns valid capability slugs that are actually enabled.
   */
  resolveMentions(
    mentionedSlugs: string[],
    enabledCapabilities: Array<{ slug: string }>,
  ): string[] {
    const enabledSlugs = new Set(enabledCapabilities.map((c) => c.slug))
    return mentionedSlugs.filter((slug) => enabledSlugs.has(slug))
  },
}
