import { describe, expect, test } from 'bun:test'
import { buildConversationMessages } from './agent-message-builder.js'

describe('buildConversationMessages', () => {
  test('does not append the current user message twice when it is already in history', () => {
    const messages = buildConversationMessages({
      systemPrompt: 'system',
      recentMessages: [{ role: 'user', content: 'Ejecuta `echo $GH_TOKEN`' }],
      currentUserContent: 'Ejecuta `echo $GH_TOKEN`',
      historyIncludesCurrentUserMessage: true,
    })

    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Ejecuta `echo $GH_TOKEN`' },
    ])
  })

  test('still appends the current user message when history does not include it', () => {
    const messages = buildConversationMessages({
      systemPrompt: 'system',
      recentMessages: [{ role: 'assistant', content: 'Respuesta previa' }],
      currentUserContent: 'Mensaje nuevo',
    })

    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'Respuesta previa' },
      { role: 'user', content: 'Mensaje nuevo' },
    ])
  })
})
