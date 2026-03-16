import { BrowserGrid } from 'browser-grid'
import type { Page, BrowserContext } from 'playwright-core'
import { settingsService } from './settings.service.js'
import {
  BROWSER_IDLE_TIMEOUT_MS,
  MAX_READABLE_CONTENT_BYTES,
  BROWSER_HEALTH_TIMEOUT_MS,
  BROWSER_SCRIPT_DEFAULT_TIMEOUT_S,
  BROWSER_SCRIPT_MIN_TIMEOUT_S,
  BROWSER_SCRIPT_MAX_TIMEOUT_S,
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_NAV_TIMEOUT_MS,
  MAX_LINKS,
  MAX_INTERACTIVE_ELEMENTS,
  LINK_TEXT_MAX_LEN,
  ELEMENT_TEXT_MAX_LEN,
  SELECTOR_TEXT_MAX_LEN,
  SCREENSHOT_JPEG_QUALITY,
} from '../constants.js'

interface BrowserSession {
  grid: BrowserGrid
  context: BrowserContext
  page: Page
  chatSessionId: string
  lastActivityAt: Date
  closeFn: () => Promise<void>
}

interface ScriptResult {
  success: boolean
  result?: string
  error?: string
  screenshotBase64?: string
}

const sessions = new Map<string, BrowserSession>()

/**
 * Capture a JPEG screenshot optimized for LLM consumption.
 */
async function captureOptimizedScreenshot(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_JPEG_QUALITY, scale: 'css' })
    return buf.toString('base64')
  } catch {
    return undefined
  }
}

/**
 * Helper injected into script scope: extract clean text from the page.
 */
async function getReadableContent(page: Page): Promise<string> {
  const text: string = await page.evaluate(`
    (() => {
      const clone = document.body.cloneNode(true);
      const removeSelectors = 'script, style, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], noscript, svg';
      clone.querySelectorAll(removeSelectors).forEach(el => el.remove());
      return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
    })()
  `)
  return text.slice(0, MAX_READABLE_CONTENT_BYTES)
}

/**
 * Helper injected into script scope: get top 30 links.
 */
async function getLinks(page: Page): Promise<Array<{ text: string; href: string }>> {
  return page.evaluate(`
    (() => {
      const links = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        const text = (a.textContent || '').trim();
        if (href && text && !href.startsWith('javascript:')) {
          links.push({ text: text.slice(0, ${LINK_TEXT_MAX_LEN}), href });
        }
        if (links.length >= ${MAX_LINKS}) break;
      }
      return links;
    })()
  `)
}

interface InteractiveElement {
  tag: string
  type?: string
  text: string
  placeholder?: string
  selector: string
  role?: string
  value?: string
}

/**
 * Helper injected into script scope: discover all interactive elements with reliable selectors.
 */
async function getInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  return page.evaluate(`
    (() => {
      const results = [];
      const seen = new Set();
      const selectors = 'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="tab"], [role="menuitem"]';

      for (const el of document.querySelectorAll(selectors)) {
        if (results.length >= ${MAX_INTERACTIVE_ELEMENTS}) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (el.offsetParent === null && el.tagName !== 'BODY') continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${ELEMENT_TEXT_MAX_LEN});
        const ariaLabel = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const role = el.getAttribute('role') || '';
        const type = el.getAttribute('type') || '';
        const id = el.getAttribute('id') || '';
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
        const name = el.getAttribute('name') || '';

        // Build a reliable selector in priority order
        let selector = '';
        if (testId) {
          selector = '[data-testid="' + testId + '"]';
        } else if (id && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
          selector = '#' + CSS.escape(id);
        } else if (ariaLabel) {
          selector = tag + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
        } else if (name && tag === 'input') {
          selector = 'input[name="' + name.replace(/"/g, '\\\\"') + '"]';
        } else if (placeholder) {
          selector = tag + '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
        } else if (text && (tag === 'button' || tag === 'a')) {
          selector = 'text=' + text.slice(0, ${SELECTOR_TEXT_MAX_LEN});
        } else {
          // CSS path fallback
          const path = [];
          let node = el;
          while (node && node !== document.body) {
            const t = node.tagName.toLowerCase();
            const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName) : [];
            if (siblings.length > 1) {
              path.unshift(t + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
            } else {
              path.unshift(t);
            }
            node = node.parentElement;
          }
          selector = path.join(' > ');
        }

        const key = selector + '|' + tag;
        if (seen.has(key)) continue;
        seen.add(key);

        const entry = { tag, text: text || ariaLabel || placeholder, selector };
        if (type) entry.type = type;
        if (placeholder) entry.placeholder = placeholder;
        if (role) entry.role = role;
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          entry.value = (el.value || '').slice(0, 100);
        }
        results.push(entry);
      }
      return results;
    })()
  `) as Promise<InteractiveElement[]>
}

/**
 * Helper injected into script scope: quick page overview.
 */
async function getPageSnapshot(page: Page): Promise<string> {
  const title = await page.title()
  const url = page.url()
  const elements = await getInteractiveElements(page)

  const lines = [`Page: ${title}`, `URL: ${url}`, `\nInteractive elements (${elements.length}):`]

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    let desc = `  [${i}] <${el.tag}>`
    if (el.type) desc += ` type="${el.type}"`
    if (el.role) desc += ` role="${el.role}"`
    if (el.text) desc += ` "${el.text}"`
    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`
    desc += ` → selector: ${el.selector}`
    lines.push(desc)
  }

  return lines.join('\n')
}

export const browserService = {
  /**
   * Check if the BrowserGrid is healthy.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = await settingsService.getBrowserGridUrl()
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(BROWSER_HEALTH_TIMEOUT_MS),
      })
      return res.ok
    } catch {
      return false
    }
  },

  /**
   * Get or create a browser session for a chat session.
   */
  async getOrCreateSession(chatSessionId: string): Promise<BrowserSession> {
    const existing = sessions.get(chatSessionId)
    if (existing) {
      // Verify the connection is still alive
      try {
        await existing.page.evaluate('1')
        existing.lastActivityAt = new Date()
        return existing
      } catch {
        // Connection is dead — clean up and create a new session
        console.log(`[Browser] Stale session detected for ${chatSessionId}, reconnecting...`)
        try { await existing.closeFn() } catch { /* best effort */ }
        sessions.delete(chatSessionId)
      }
    }

    const url = await settingsService.getBrowserGridUrl()
    const apiKey = await settingsService.getBrowserGridApiKey()
    const browserType = await settingsService.getBrowserGridBrowser()

    const grid = new BrowserGrid(url, apiKey || undefined)
    const conn = await grid.configure({
      browserType: browserType as 'chromium' | 'firefox' | 'camoufox',
      contextKey: `agentbuddy-${chatSessionId}`,
    }).connect()

    const page = await conn.context.newPage()
    page.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(BROWSER_NAV_TIMEOUT_MS)

    const session: BrowserSession = {
      grid,
      context: conn.context,
      page,
      chatSessionId,
      lastActivityAt: new Date(),
      closeFn: conn.close,
    }
    sessions.set(chatSessionId, session)
    return session
  },

  /**
   * Execute a Playwright script from the agent.
   */
  async executeScript(chatSessionId: string, script: string, timeout = BROWSER_SCRIPT_DEFAULT_TIMEOUT_S): Promise<ScriptResult> {
    // Security: block dangerous URL schemes
    if (/\b(file|javascript):\/\//i.test(script)) {
      return { success: false, error: 'Scripts cannot use file:// or javascript:// URLs' }
    }

    const clampedTimeout = Math.min(Math.max(timeout, BROWSER_SCRIPT_MIN_TIMEOUT_S), BROWSER_SCRIPT_MAX_TIMEOUT_S)

    let session: BrowserSession
    try {
      session = await this.getOrCreateSession(chatSessionId)
    } catch (err) {
      return {
        success: false,
        error: `Failed to create browser session: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const { page } = session

    // Build injectable helpers
    const boundGetReadableContent = () => getReadableContent(page)
    const boundGetLinks = () => getLinks(page)
    const boundGetInteractiveElements = () => getInteractiveElements(page)
    const boundGetPageSnapshot = () => getPageSnapshot(page)

    try {
      // Execute the script with page and helpers available
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('page', 'getReadableContent', 'getLinks', 'getInteractiveElements', 'getPageSnapshot', script)

      const result = await Promise.race([
        fn(page, boundGetReadableContent, boundGetLinks, boundGetInteractiveElements, boundGetPageSnapshot),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Script timed out after ${clampedTimeout}s`)), clampedTimeout * 1000),
        ),
      ])

      // Format the result
      let output: string
      if (result === undefined || result === null) {
        output = 'Script completed successfully (no return value)'
      } else if (typeof result === 'string') {
        output = result
      } else {
        // If result contains a screenshot, replace with a resized optimized JPEG
        if (typeof result === 'object' && result !== null && (Buffer.isBuffer(result.screenshot) || typeof result.screenshot === 'string')) {
          const resized = await captureOptimizedScreenshot(page)
          if (resized) {
            result.screenshot = resized
          } else if (Buffer.isBuffer(result.screenshot)) {
            result.screenshot = result.screenshot.toString('base64')
          }
        }
        // Convert any remaining Buffer fields to base64
        if (typeof result === 'object' && result !== null) {
          for (const key of Object.keys(result)) {
            if (Buffer.isBuffer(result[key])) {
              result[key] = result[key].toString('base64')
            }
          }
        }
        output = JSON.stringify(result, null, 2)
      }

      return { success: true, result: output }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      // If the connection died, clean up the stale session so next call creates a fresh one
      const isConnectionError = errorMessage.includes('Connection ended') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('Target closed') ||
        errorMessage.includes('Browser has been closed')
      if (isConnectionError) {
        console.log(`[Browser] Connection lost for ${chatSessionId}, cleaning up stale session`)
        await this.closeSession(chatSessionId)
        return { success: false, error: `${errorMessage}. The browser session was lost — please retry.` }
      }

      // Auto-screenshot on error for visual context (resized JPEG for smaller token cost)
      const screenshotBase64 = await captureOptimizedScreenshot(page)

      return {
        success: false,
        error: errorMessage,
        screenshotBase64,
      }
    }
  },

  /**
   * Close a specific browser session.
   */
  async closeSession(chatSessionId: string): Promise<void> {
    const session = sessions.get(chatSessionId)
    if (!session) return

    try {
      await session.closeFn()
    } catch {
      // Best-effort cleanup
    }
    sessions.delete(chatSessionId)
  },

  /**
   * Clean up sessions idle for longer than IDLE_TIMEOUT_MS.
   */
  async cleanupIdleSessions(): Promise<void> {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt.getTime() > BROWSER_IDLE_TIMEOUT_MS) {
        console.log(`[Browser] Cleaning up idle session: ${id}`)
        await this.closeSession(id)
      }
    }
  },

  /**
   * Get active sessions info for the admin API.
   */
  getActiveSessions(): Array<{ chatSessionId: string; lastActivityAt: string }> {
    return Array.from(sessions.entries()).map(([id, s]) => ({
      chatSessionId: id,
      lastActivityAt: s.lastActivityAt.toISOString(),
    }))
  },

  /**
   * Shutdown all sessions (for graceful server shutdown).
   */
  async shutdown(): Promise<void> {
    const ids = Array.from(sessions.keys())
    await Promise.allSettled(ids.map((id) => this.closeSession(id)))
  },
}
