export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; mediaType: string; data: string }
}

export type ContentBlock = TextBlock | ImageBlock

export type MessageContent = string | ContentBlock[]

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: MessageContent
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface LLMOptions {
  temperature?: number
  maxTokens?: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  _rawParts?: unknown
}

export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

export interface LLMToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length'
  usage?: TokenUsage
}

/** Extract plain text from a MessageContent value */
export function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export interface LLMProvider {
  readonly modelId: string
  readonly providerId: string
  chat(messages: ChatMessage[], options?: LLMOptions): Promise<string>
  chatWithTools(
    messages: ChatMessage[],
    options?: LLMOptions & { tools?: LLMToolDefinition[] },
  ): Promise<LLMResponse>
  stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string>
}
