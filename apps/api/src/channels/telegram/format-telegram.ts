/**
 * Convert Markdown (as typically produced by LLMs) to Telegram-compatible HTML.
 */

const PLACEHOLDER_PREFIX = '\x00'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function markdownToTelegramHtml(md: string): string {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // 1. Extract fenced code blocks
  let text = md.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, content) => {
    const idx = codeBlocks.length
    codeBlocks.push(escapeHtml(content.replace(/\n$/, '')))
    return `${PLACEHOLDER_PREFIX}CODEBLOCK_${idx}${PLACEHOLDER_PREFIX}`
  })

  // 2. Extract inline code
  text = text.replace(/`([^`\n]+)`/g, (_, content) => {
    const idx = inlineCodes.length
    inlineCodes.push(escapeHtml(content))
    return `${PLACEHOLDER_PREFIX}INLINECODE_${idx}${PLACEHOLDER_PREFIX}`
  })

  // 3. Escape HTML in remaining text
  text = escapeHtml(text)

  // 4. Headings → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // 5. Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // 6. Bullets (before italic so `* item` isn't confused)
  text = text.replace(/^[*\-]\s+/gm, '• ')

  // 7. Italic *text* — require non-space after opening * and before closing *
  text = text.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, '<i>$1</i>')

  // 8. Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 9. Restore placeholders
  text = text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}CODEBLOCK_(\\d+)${PLACEHOLDER_PREFIX}`, 'g'),
    (_, idx) => `<pre>${codeBlocks[Number(idx)]}</pre>`,
  )
  text = text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}INLINECODE_(\\d+)${PLACEHOLDER_PREFIX}`, 'g'),
    (_, idx) => `<code>${inlineCodes[Number(idx)]}</code>`,
  )

  return text
}

/**
 * Split an HTML message respecting the Telegram 4096-char limit,
 * closing and reopening any open tags at split boundaries.
 */
export function splitHtmlMessage(html: string, maxLength: number): string[] {
  if (html.length <= maxLength) return [html]

  const parts: string[] = []
  let remaining = html

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining)
      break
    }

    // Find a split point at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength)
    if (splitIdx <= 0) splitIdx = maxLength

    let chunk = remaining.slice(0, splitIdx)
    remaining = remaining.slice(splitIdx).trimStart()

    // Repair unclosed tags
    const openTags = getUnclosedTags(chunk)
    if (openTags.length > 0) {
      // Close tags in reverse order at end of chunk
      chunk += openTags
        .slice()
        .reverse()
        .map((t) => `</${t}>`)
        .join('')
      // Reopen tags at start of next chunk
      remaining = openTags.map((t) => `<${t}>`).join('') + remaining
    }

    parts.push(chunk)
  }

  return parts
}

/** Return the stack of tag names that are opened but not closed. */
function getUnclosedTags(html: string): string[] {
  const stack: string[] = []
  const tagRegex = /<\/?([a-z]+)[^>]*>/gi

  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(html)) !== null) {
    const full = match[0]
    const tagName = match[1].toLowerCase()

    if (full.startsWith('</')) {
      // Closing tag — pop from stack if it matches
      const last = stack.lastIndexOf(tagName)
      if (last !== -1) stack.splice(last, 1)
    } else {
      stack.push(tagName)
    }
  }

  return stack
}
