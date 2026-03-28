import type { CapabilityDefinition } from '../types.js'

export const webFetch: CapabilityDefinition = {
  slug: 'web-fetch',
  name: 'Web Fetch',
  description:
    'Fetch and read web pages, APIs, and online resources. Converts HTML to readable Markdown automatically.',
  icon: 'Globe',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its content. HTML pages are automatically converted to Markdown for readability. Use this to read documentation, API responses, web pages, or any online resource when you already have a specific URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (http or https)',
          },
          format: {
            type: 'string',
            description:
              'Output format: "markdown" (default — converts HTML to Markdown), "text" (strips all tags), "html" (raw HTML)',
          },
          method: {
            type: 'string',
            description: 'HTTP method (default: GET)',
          },
          headers: {
            type: 'object',
            description: 'Custom request headers as key-value pairs',
          },
          body: {
            type: 'string',
            description: 'Request body for POST/PUT/PATCH requests',
          },
          maxKb: {
            type: 'number',
            description: 'Max response size in KB (default: 100, max: 5000)',
          },
        },
        required: ['url'],
      },
    },
  ],
  systemPrompt: `You have access to web_fetch for downloading and reading web content directly.

**IMPORTANT: web_fetch FIRST principle**
Whenever a URL or domain is known — from the user's request, a component prompt, notes, or any prior context — ALWAYS use web_fetch to go directly to that page. Do NOT use web_search to look up information that's available at a known URL. web_search is for discovery (finding URLs you don't have); web_fetch is for retrieval (reading pages you already know about).

**When to use each web tool:**
- **web_fetch**: When you have a specific URL or website domain to read. This includes when someone says "get data from example.com" — construct the URL and fetch it directly.
- **web_search**: ONLY when you need to DISCOVER/FIND pages and you don't have a URL or domain. Never use web_search as a lazy shortcut to avoid parsing HTML from web_fetch.
- **run_browser_script**: Only when you need to INTERACT with a page (login, fill forms, click buttons, JavaScript-rendered content)

web_fetch returns the full page content converted to Markdown by default. For JSON APIs, the raw JSON is returned as-is.
If a web_fetch result is too large or doesn't contain the data you need, try fetching a more specific sub-page URL rather than falling back to web_search.`,
  sandbox: {},
}
