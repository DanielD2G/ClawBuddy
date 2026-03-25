import type { CapabilityDefinition } from '../types.js'

export const webSearch: CapabilityDefinition = {
  slug: 'web-search',
  name: 'Web Search (Gemini)',
  description:
    'Search the web for current information using Google Search via Gemini. Requires a Gemini API key.',
  icon: 'Search',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'web_search',
      description:
        'Search the web for current, real-time information. Use this when the user asks about recent events, live data, current prices, news, or anything that requires up-to-date information not in your training data.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up on the web',
          },
        },
        required: ['query'],
      },
    },
  ],
  systemPrompt:
    'You have access to web_search for real-time web information. Use it when the user asks about current events, live data, recent news, prices, weather, or anything that needs up-to-date information. Do NOT use it for general knowledge questions you can already answer.\n\n**IMPORTANT: If you already have a specific URL or domain**, use web_fetch instead — web_search is for DISCOVERING pages, not for reading pages you already know about. For example, if the user says "get data from dolarhoy.com", use web_fetch("https://dolarhoy.com/...") directly, do NOT search for "dolarhoy.com dolar price".\n\n**web_search vs browser automation:** web_search is preferred over browser automation for finding information. Only use browser automation (run_browser_script) when you need to interact with a specific website (fill forms, click buttons, log in).',
  sandbox: {},
}
