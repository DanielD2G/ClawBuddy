import { prisma } from '../lib/prisma.js'
import { cronService } from './cron.service.js'

interface ComponentInput {
  type: string
  title?: string
  config?: Record<string, unknown>
  data?: Record<string, unknown>
  position?: { x: number; y: number; w: number; h: number }
  order?: number
  prompt?: string
  script?: string
  scriptLanguage?: string
  notes?: string
}

interface CreateDashboardInput {
  workspaceId: string
  title: string
  description?: string
  layout?: Record<string, unknown>
  components?: ComponentInput[]
  cronSchedule?: string
  /** Chat session that created the dashboard — used for the refresh cron job */
  sessionId?: string
}

interface UpdateDashboardInput {
  title?: string
  description?: string
  layout?: Record<string, unknown>
}

interface ComponentDataUpdate {
  componentId: string
  data?: Record<string, unknown>
  insight?: string
}

function buildRefreshPrompt(
  dashboard: { id: string; title: string },
  components: Array<{ id: string; type: string; title: string | null; prompt: string | null }>,
): string {
  const componentList = components
    .map((c) => {
      let desc = `  - ${c.id} (${c.type}${c.title ? `: ${c.title}` : ''})`
      if (c.prompt) {
        desc += `\n    Prompt: "${c.prompt}"`
      }
      return desc
    })
    .join('\n')

  return [
    `Refresh dashboard "${dashboard.title}" (id: ${dashboard.id}).`,
    `Fetch updated data for each component and call update_dashboard_data with the dashboard ID and an updates array.`,
    `Each component has a "Prompt" that tells you exactly what data to fetch or what analysis to perform. Follow the prompt instructions.`,
    ``,
    `DATA FETCHING PRIORITY (follow this order):`,
    `1. **web_fetch** → If the prompt mentions a specific URL or website (e.g. "dolarhoy.com", "https://..."), use web_fetch to fetch that page directly and parse the data from the HTML. Do NOT use web_search as a shortcut when a specific source is given.`,
    `2. **web_search** → Only use web_search when no specific URL/site is mentioned, or when web_fetch fails.`,
    ``,
    `MANDATORY: Every data payload MUST include a "sources" array: [{label: "Human-readable name", url: "https://exact-page-url"}]. Sources must link to the EXACT page where the data was obtained — never a homepage, never an invented URL. NO EXCEPTIONS.`,
    ``,
    `Instructions per component type:`,
    `- **kpi / stats_group**: Fetch fresh metrics as described in the component prompt. Include sources.`,
    `- **chart**: Fetch fresh data series as described in the component prompt. Include sources.`,
    `- **table**: Fetch data as described in the component prompt. Include data: {rows: [{key: value, ...}], sources: [{label, url}]}. Use descriptive key names (they become column headers automatically).`,
    `- **ai_insights**: Generate fresh insights based on the component prompt and include the "insight" field (markdown) in the update. Include data: {sources: [{label, url}]}.`,
    `- **links**: Use web_search to find real, current articles/news as described in the component prompt. Include data: {items: [{title, url, description, source, date, tag}]}. Each item MUST have a direct URL — NEVER a homepage.`,
    ``,
    `Components:`,
    componentList,
  ].join('\n')
}

/** Truncate a JSON value to a max character length for prompt inclusion */
function truncateJson(value: unknown, maxChars = 1500): string {
  const json = JSON.stringify(value)
  if (json.length <= maxChars) return json
  return json.slice(0, maxChars) + '…(truncated)'
}

export const dashboardService = {
  /**
   * Build a refresh prompt dynamically at cron execution time.
   * Includes current component data so the agent can do comparisons / deltas.
   */
  buildDynamicRefreshPrompt(
    dashboard: Awaited<ReturnType<typeof dashboardService.getById>>,
  ): string {
    const componentList = dashboard.components
      .map((c) => {
        let desc = `  - ${c.id} (${c.type}${c.title ? `: ${c.title}` : ''})`
        if (c.prompt) {
          desc += `\n    Prompt: "${c.prompt}"`
        }
        // Include user-authored notes as extra context
        if (c.notes) {
          desc += `\n    Notes: "${c.notes.slice(0, 800)}${c.notes.length > 800 ? '...' : ''}"`
        }
        // Include user-authored script — agent should execute or follow it
        if (c.script) {
          desc += `\n    Script (${c.scriptLanguage ?? 'unknown'}):\n\`\`\`\n${c.script.slice(0, 2000)}${c.script.length > 2000 ? '\n...(truncated)' : ''}\n\`\`\``
          desc += `\n    IMPORTANT: If a script is provided, execute it (or use its logic) to obtain the data for this component. The script takes priority over generic fetching.`
        }
        if (c.type === 'ai_insights' && c.lastInsight) {
          desc += `\n    Previous insight: "${c.lastInsight.slice(0, 500)}${c.lastInsight.length > 500 ? '...' : ''}"`
        }
        // Include current data for data-bearing components so agent can compare/diff
        if (c.data && ['kpi', 'stats_group', 'chart', 'table'].includes(c.type)) {
          desc += `\n    Current data: ${truncateJson(c.data)}`
        }
        return desc
      })
      .join('\n')

    return [
      `Refresh dashboard "${dashboard.title}" (id: ${dashboard.id}).`,
      `Fetch updated data for each component and call update_dashboard_data with the dashboard ID and an updates array.`,
      `Each component has a "Prompt" that tells you exactly what data to fetch or what analysis to perform. Follow the prompt instructions.`,
      `If a component has a "Script", execute it (or follow its logic closely) to obtain the data. Scripts take priority over generic fetching.`,
      `If a component has "Notes", use them as additional context for data collection and analysis.`,
      `The previous data for each component is included below — use it for comparisons, deltas, and trend detection. Do NOT simply repeat the same data; fetch fresh values.`,
      ``,
      `DATA FETCHING PRIORITY (follow this order):`,
      `1. **Script** → If the component has a script, EXECUTE it to get data.`,
      `2. **web_fetch** → If the prompt mentions a specific URL or website (e.g. "dolarhoy.com", "https://..."), use web_fetch to fetch that page directly and parse the data from the HTML. Do NOT use web_search as a shortcut when a specific source is given — go directly to the page.`,
      `3. **web_search** → Only use web_search when no specific URL/site is mentioned, or when web_fetch fails and you need to find an alternative source.`,
      ``,
      `MANDATORY: Every data payload MUST include a "sources" array: [{label: "Human-readable name", url: "https://exact-page-url"}]. Sources must link to the EXACT page where the data was obtained — never a homepage, never an invented URL. NO EXCEPTIONS.`,
      ``,
      `Instructions per component type:`,
      `- **kpi / stats_group**: Fetch fresh metrics as described in the component prompt. Compare with previous values. Include sources.`,
      `- **chart**: Fetch fresh data series as described in the component prompt. Include sources.`,
      `- **table**: Fetch data as described in the component prompt. Include data: {rows: [{key: value, ...}], sources: [{label, url}]}.`,
      `- **ai_insights**: CRITICAL — you MUST include BOTH fields in the update: "insight" (markdown string with the actual analysis text) AND "data" ({sources: [{label, url}]}). The "insight" field is what gets displayed to the user. If you omit it, the card will remain empty. Example: {componentId: "...", insight: "## Key Findings\\n- Point 1\\n- Point 2", data: {sources: [{label: "Source", url: "https://..."}]}}`,
      `- **links**: Use web_search to find articles/news as described in the component prompt. Each item MUST have a direct URL — NEVER a homepage.`,
      ``,
      `MANDATORY: After refreshing data:`,
      `- Set "notes" (via update_dashboard_component) on any component that doesn't have notes yet — document what source was used, how data was fetched, any caveats.`,
      `- Only set a "script" if you actually ran code to obtain the data. Do NOT fabricate scripts for data obtained via web_search or other non-script methods.`,
      `- If a component already has a script, EXECUTE it (or follow its logic) instead of re-inventing the data fetch.`,
      ``,
      `Components:`,
      componentList,
    ].join('\n')
  },

  /** List dashboards for a workspace (without component data for perf) */
  async list(workspaceId: string) {
    return prisma.dashboard.findMany({
      where: { workspaceId },
      include: {
        components: {
          select: { id: true, type: true, title: true, order: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  /** Get a single dashboard with full component data */
  async getById(id: string) {
    return prisma.dashboard.findUniqueOrThrow({
      where: { id },
      include: {
        components: {
          orderBy: { order: 'asc' },
        },
      },
    })
  },

  /** Create a dashboard, optionally with inline components and a cron schedule */
  async create(input: CreateDashboardInput) {
    const { components = [], cronSchedule, sessionId, ...rest } = input

    const dashboard = await prisma.dashboard.create({
      data: {
        ...rest,
        sessionId,
        layout: rest.layout ?? undefined,
        components: {
          create: components.map((c, i) => ({
            type: c.type,
            title: c.title,
            config: c.config ?? {},
            data: c.data ?? undefined,
            position: c.position ?? undefined,
            order: c.order ?? i,
            prompt: c.prompt,
            script: c.script,
            scriptLanguage: c.scriptLanguage,
            notes: c.notes,
          })),
        },
      },
      include: {
        components: { orderBy: { order: 'asc' } },
      },
    })

    // Mark the originating session as dashboard-internal so it doesn't appear in "Your chats"
    if (sessionId) {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { source: 'dashboard' },
      }).catch(() => {})
    }

    // If a cron schedule was requested, create a CronJob linked to this dashboard
    if (cronSchedule) {
      const cronJob = await cronService.create({
        name: `Dashboard refresh: ${dashboard.title}`,
        description: `Auto-refresh dashboard "${dashboard.title}"`,
        schedule: cronSchedule,
        type: 'agent',
        prompt: buildRefreshPrompt(dashboard, dashboard.components),
        workspaceId: input.workspaceId,
        sessionId,
      })

      await prisma.dashboard.update({
        where: { id: dashboard.id },
        data: { cronJobId: cronJob.id },
      })

      dashboard.cronJobId = cronJob.id
    }

    return dashboard
  },

  /** Update dashboard metadata */
  async update(id: string, data: UpdateDashboardInput) {
    return prisma.dashboard.update({
      where: { id },
      data,
      include: {
        components: { orderBy: { order: 'asc' } },
      },
    })
  },

  /** Delete a dashboard and its linked cron job */
  async delete(id: string) {
    const dashboard = await prisma.dashboard.findUniqueOrThrow({ where: { id } })

    // Clean up linked cron job
    if (dashboard.cronJobId) {
      try {
        await cronService.delete(dashboard.cronJobId)
      } catch {
        // Cron job may already be deleted
      }
    }

    // Components cascade-delete via Prisma
    await prisma.dashboard.delete({ where: { id } })
  },

  /** Add a component to an existing dashboard */
  async addComponent(dashboardId: string, input: ComponentInput) {
    // Get max order
    const last = await prisma.dashboardComponent.findFirst({
      where: { dashboardId },
      orderBy: { order: 'desc' },
      select: { order: true },
    })

    return prisma.dashboardComponent.create({
      data: {
        dashboardId,
        type: input.type,
        title: input.title,
        config: input.config ?? {},
        data: input.data ?? undefined,
        position: input.position ?? undefined,
        order: input.order ?? (last ? last.order + 1 : 0),
        prompt: input.prompt,
        script: input.script,
        scriptLanguage: input.scriptLanguage,
        notes: input.notes,
      },
    })
  },

  /** Update a component's config or data */
  async updateComponent(
    componentId: string,
    data: Partial<Pick<ComponentInput, 'title' | 'config' | 'data' | 'position' | 'order' | 'prompt' | 'script' | 'scriptLanguage' | 'notes'>>,
  ) {
    return prisma.dashboardComponent.update({
      where: { id: componentId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.config !== undefined && { config: data.config }),
        ...(data.data !== undefined && { data: data.data }),
        ...(data.position !== undefined && { position: data.position }),
        ...(data.order !== undefined && { order: data.order }),
        ...(data.prompt !== undefined && { prompt: data.prompt }),
        ...(data.script !== undefined && { script: data.script }),
        ...(data.scriptLanguage !== undefined && { scriptLanguage: data.scriptLanguage }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    })
  },

  /** Delete a component */
  async deleteComponent(componentId: string) {
    await prisma.dashboardComponent.delete({ where: { id: componentId } })
  },

  /** Reorder components by setting their order field */
  async reorderComponents(dashboardId: string, componentIds: string[]) {
    const ops = componentIds.map((id, i) =>
      prisma.dashboardComponent.update({
        where: { id },
        data: { order: i },
      }),
    )
    await prisma.$transaction(ops)
    return this.getById(dashboardId)
  },

  /** Bulk update data for multiple components (used after cron refresh) */
  async updateDashboardData(dashboardId: string, updates: ComponentDataUpdate[]) {
    // Fetch current data so we can snapshot it as previousData before overwriting
    const currentComponents = await prisma.dashboardComponent.findMany({
      where: { dashboardId },
      select: { id: true, data: true },
    })
    const currentDataMap = new Map(currentComponents.map((c) => [c.id, c.data]))

    const ops = updates.map((u) => {
      const prev = currentDataMap.get(u.componentId)
      return prisma.dashboardComponent.update({
        where: { id: u.componentId },
        data: {
          // Snapshot old data before overwriting
          ...(u.data !== undefined && prev !== undefined && { previousData: prev }),
          ...(u.data !== undefined && { data: u.data }),
          ...(u.insight !== undefined && {
            lastInsight: u.insight,
            lastInsightAt: new Date(),
          }),
          updatedAt: new Date(),
        },
      })
    })

    await prisma.$transaction(ops)

    // Update dashboard lastRefreshAt and reset refreshing status
    await prisma.dashboard.update({
      where: { id: dashboardId },
      data: { lastRefreshAt: new Date(), refreshStatus: 'idle' },
    })

    return this.getById(dashboardId)
  },
}
