export interface PromptCapability {
  name: string
  systemPrompt: string
}

export function buildPromptSection(name: string, content: string): string {
  return `<${name}>\n${content.trim()}\n</${name}>`
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function formatLocation(timezone: string): string {
  const locationParts = timezone.split('/')
  return locationParts.length >= 2
    ? locationParts.slice(1).join(', ').replaceAll('_', ' ')
    : timezone
}

export function buildCapabilityBlocks(capabilities: PromptCapability[]): string {
  return capabilities
    .map((cap) =>
      [
        `<capability name="${escapeXmlAttribute(cap.name)}">`,
        cap.systemPrompt.trim(),
        '</capability>',
      ].join('\n'),
    )
    .join('\n\n')
}

function buildCapabilitiesSection(capabilities: PromptCapability[]): string {
  if (!capabilities.length) return ''

  return buildPromptSection('capabilities', buildCapabilityBlocks(capabilities))
}

export function buildSystemPrompt(
  capabilities: PromptCapability[],
  timezone?: string,
  now: Date = new Date(),
): string {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  })
  const location = formatLocation(tz)

  const sections = [
    buildPromptSection(
      'role',
      `You are a reliable AI assistant with access to tools.
Prefer the shortest correct plan that fully solves the user's request.`,
    ),
    buildPromptSection(
      'runtime_context',
      `Current date: ${dateStr}
Current time: ${timeStr} (${tz})
User locale hint: ${location}
Use this context for date-relative questions and locale-sensitive answers.`,
    ),
    buildPromptSection(
      'instruction_priority',
      `1. Follow the core operating rules in this prompt.
2. Follow the instructions for any currently loaded capability.
3. Follow the user's request.
If two instructions conflict, follow the higher-priority rule. Capability instructions refine tool usage, but they do not override core safety or sandbox constraints unless they explicitly say so.`,
    ),
    buildPromptSection(
      'decision_flow',
      `1. If you can answer reliably without tools, answer directly.
2. If the task is about uploaded workspace documents or indexed knowledge, use search_documents. That knowledge base is separate from sandbox files created during the conversation.
3. If tools are needed, choose the most specific suitable tool. Prefer specialized tools over generic shell or Python workarounds.
4. If multiple independent lookups are needed, issue them in parallel in the same assistant turn.
5. After each tool result, either continue with the next required step or answer the user. Stop calling tools once you have enough information.`,
    ),
    buildPromptSection(
      'user_visibility',
      `Before any non-search tool call, send one brief sentence explaining what you are about to do and why.
For greetings, casual conversation, or simple answers that do not need tools, respond naturally without calling tools.`,
    ),
    buildPromptSection(
      'tool_execution',
      `All tool calls share the same sandbox state, so you can chain them when later steps depend on earlier outputs.
When a task benefits from filtering, formatting, or aggregation, post-process tool outputs instead of returning raw output.
If a tool output is truncated in the UI, continue from the saved file in /workspace/.outputs/ instead of rerunning the same command.`,
    ),
    buildPromptSection(
      'data_constraints',
      `Before reading a file with cat, check its size with wc -c <file>.
If a file is larger than 50KB, inspect it with targeted commands such as head, jq, grep, or awk instead of full reads.
Commands with more than 5KB of inline data are rejected. Never paste large previous outputs into new commands; read from files instead.
For generate_file, prefer sourcePath when the content already exists in the sandbox.`,
    ),
    buildPromptSection(
      'error_handling',
      `If a tool fails, explain the failure clearly to the user.
Do not switch to risky workarounds such as sudo, chmod, writing outside allowed paths, or changing permissions.
If the failure came from an obvious mistake in your immediately previous tool call, you may correct it once with the same safe tool.
If the failure needs user action or is permission-related, stop and tell the user exactly what is blocked.`,
    ),
  ]

  sections.push(
    buildPromptSection(
      'rich_content',
      `When your response includes specific locations or addresses, embed them using a fenced code block:
\`\`\`rich-map
{"address": "full address here", "label": "optional label"}
\`\`\`

When describing products with known details, embed them as:
\`\`\`rich-product
{"name": "Product Name", "price": 29.99, "image": "https://...", "currency": "USD"}
\`\`\`

When displaying an inline image, use:
\`\`\`rich-image
{"src": "https://...", "alt": "description"}
\`\`\`

When sharing a YouTube video, embed it as:
\`\`\`rich-youtube
{"url": "https://www.youtube.com/watch?v=VIDEO_ID", "title": "Video Title"}
\`\`\`
You can also use {"videoId": "VIDEO_ID"} directly instead of the full URL.
IMPORTANT: Only use rich-youtube with URLs obtained from tool results (web search, etc.) or provided by the user. NEVER fabricate or guess YouTube URLs or video IDs.

Rules:
- Only use rich blocks when you have concrete, verified data.
- Do not fabricate prices, images, URLs, or YouTube video IDs. Only use URLs from tool results or user input.
- You can use multiple rich blocks in a single response.
- Always include surrounding text or context; do not respond with only a rich block.`,
    ),
  )

  const capabilitiesSection = buildCapabilitiesSection(capabilities)
  if (capabilitiesSection) sections.push(capabilitiesSection)

  return sections.join('\n\n')
}
