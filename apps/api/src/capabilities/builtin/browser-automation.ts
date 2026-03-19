import type { CapabilityDefinition } from '../types.js'

export const browserAutomation: CapabilityDefinition = {
  slug: 'browser-automation',
  name: 'Browser Automation',
  description: 'Browse and interact with web pages using Playwright scripts via BrowserGrid.',
  icon: 'Globe',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'run_browser_script',
      description: `Execute ONE small action in the browser per call. The session persists between calls — do not repeat previous steps.

Available globals:
- \`page\` — Playwright Page object (already connected, keeps state between calls)
- \`getInteractiveElements()\` — Returns visible buttons, inputs, links with reliable selectors [{tag, text, selector, type?, placeholder?, role?, value?}]
- \`getPageSnapshot()\` — Quick page overview: title, URL, and all interactive elements
- \`getReadableContent()\` — Extract clean text from current page (max 50KB)
- \`getLinks()\` — Get top 30 links as [{text, href}]

RULES:
1. ONE action per call. Navigate OR discover OR fill OR click — never combine them.
2. NEVER guess selectors. Call getPageSnapshot() or getInteractiveElements() first to discover them.
3. ALWAYS return an observation (getPageSnapshot, getReadableContent, or getLinks) so you can see what happened.
4. After page.goto(), ONLY return getPageSnapshot() — do NOT try to interact in the same call.
5. After filling/clicking, return getPageSnapshot() or getReadableContent() to verify the result.

Example — searching on a site takes 3+ separate calls:
  Call 1: await page.goto(url); return await getPageSnapshot();
  Call 2: const els = await getInteractiveElements(); const input = els.find(...); await page.fill(input.selector, 'query'); return await getPageSnapshot();
  Call 3: const els = await getInteractiveElements(); const btn = els.find(...); await page.click(btn.selector); return await getPageSnapshot();
  Call 4: return await getReadableContent();`,
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'Playwright script with access to page object. Use await for async ops. Return results.',
          },
          timeout: {
            type: 'number',
            description: 'Max execution time in seconds (default: 30, max: 120)',
          },
        },
        required: ['script'],
      },
    },
  ],
  systemPrompt: `You have browser automation via run_browser_script. You MUST work step-by-step: one action per call, observe, then decide the next action.

## When to use (and when NOT to)
- **DO NOT use for searching/finding information** — use web_search instead, it's faster and cheaper.
- **DO use for**: interacting with specific websites (fill forms, click buttons, log in, scrape dynamic content, take screenshots, navigate multi-page flows).

## CRITICAL: Step-by-step workflow
Each run_browser_script call must do exactly ONE of these:
1. **Navigate**: \`await page.goto(url); return await getPageSnapshot();\`
2. **Discover**: \`return await getPageSnapshot();\` or \`return await getInteractiveElements();\`
3. **Interact**: Find element + fill/click ONE thing, then \`return await getPageSnapshot();\`
4. **Read**: \`return await getReadableContent();\` or \`return await getLinks();\`
5. **Screenshot**: \`const s = await page.screenshot({ encoding: 'base64' }); return { screenshot: s, description: '...' };\`

NEVER combine navigate + interact in one call. NEVER guess selectors — discover first, interact in the next call.

## Why step-by-step?
- Pages load dynamically — you can't know what elements exist until you look
- Selectors change between pages — you must discover them fresh each time
- If something fails, you'll know exactly which step broke

## Session persistence
The browser session persists between calls. Cookies, login state, current URL, and page content all carry over. Do NOT re-navigate or re-login if you're already on the right page.

## Example: searching on a website
\`\`\`
Call 1: await page.goto('https://example.com'); return await getPageSnapshot();
→ You see the page with a search input at selector '#search-box'

Call 2: await page.fill('#search-box', 'my query'); await page.keyboard.press('Enter'); return await getPageSnapshot();
→ You see search results loaded

Call 3: return await getReadableContent();
→ You read the actual content
\`\`\`

## Rules
- Always use the \`selector\` field from getInteractiveElements/getPageSnapshot results
- After any navigation or click that loads new content, call getPageSnapshot() to see the new state
- Use page.waitForTimeout(1000-2000) after clicks that trigger page loads before reading`,
  sandbox: {},
}
