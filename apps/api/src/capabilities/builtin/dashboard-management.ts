import type { CapabilityDefinition } from '../types.js'

export const dashboardManagement: CapabilityDefinition = {
  slug: 'dashboard-management',
  name: 'Dashboard Management',
  description:
    'Create and manage data dashboards with KPIs, charts, tables, and AI insights. Use this when the user asks to visualize data, create a dashboard, or display metrics.',
  icon: 'LayoutDashboard',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'create_dashboard',
      description:
        'Create a dashboard with components inline. Supports KPI cards, charts (line/bar/pie/area), stats groups, tables, and AI insight panels. Returns the created dashboard with component IDs.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Dashboard title' },
          description: { type: 'string', description: 'Optional dashboard description' },
          components: {
            type: 'array',
            description: 'Components to place on the dashboard',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['kpi', 'stats_group', 'chart', 'ai_insights', 'table', 'links'],
                  description: 'Component type',
                },
                title: { type: 'string', description: 'Component heading / name' },
                prompt: {
                  type: 'string',
                  description:
                    'Instructions for what data to fetch/show for this component. Every component has a prompt that tells the agent what to populate on refresh.',
                },
                config: {
                  type: 'object',
                  description:
                    'Type-specific config. kpi: {prefix?, suffix?, trendDirection?: "up-good"|"up-bad"}. chart: {chartType: "line"|"bar"|"pie"|"area", xKey, yKey}. stats_group: {columns?}. table: {columns: [{key, label}]}. ai_insights: {}. links: {columns?: 2|3}.',
                },
                data: {
                  type: 'object',
                  description:
                    'Initial data payload. kpi: {value, label, change?, changeLabel?}. chart: {series: [{name, data: [{x,y,...}]}]}. stats_group: {stats: [{label, value, change?}]}. table: {rows: [{}]}. links: {items: [{title, url, description?, imageUrl?, source?, date?, tag?}]}. ai_insights: omit (generated).',
                },
                position: {
                  type: 'object',
                  description:
                    'Grid position {x, y, w, h}. w=1 is one column. Omit for auto-layout.',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                  },
                },
              },
              required: ['type'],
            },
          },
          cronSchedule: {
            type: 'string',
            description:
              'Cron expression for automatic refresh (e.g. "0 9 * * *" for daily at 9am). Omit for manual-only dashboards.',
          },
        },
        required: ['title', 'components'],
      },
    },
    {
      name: 'update_dashboard_data',
      description:
        'Bulk-update data for one or more components on a dashboard. Use after fetching fresh metrics or generating insights.',
      parameters: {
        type: 'object',
        properties: {
          dashboardId: { type: 'string', description: 'Dashboard ID' },
          updates: {
            type: 'array',
            description: 'Array of component updates',
            items: {
              type: 'object',
              properties: {
                componentId: { type: 'string', description: 'Component ID to update' },
                data: { type: 'object', description: 'New data payload (same shape as create)' },
                insight: {
                  type: 'string',
                  description: 'For ai_insights: the generated insight text (markdown)',
                },
              },
              required: ['componentId'],
            },
          },
        },
        required: ['dashboardId', 'updates'],
      },
    },
    {
      name: 'list_dashboards',
      description: 'List all dashboards in the current workspace.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_dashboard',
      description:
        'Get full details of a dashboard including all component IDs, types, titles, prompts, and configs. Use this to find component IDs before removing or reordering components.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Dashboard ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'reorder_dashboard_components',
      description:
        'Reorder components on a dashboard. Pass the component IDs in the desired display order.',
      parameters: {
        type: 'object',
        properties: {
          dashboardId: { type: 'string', description: 'Dashboard ID' },
          componentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Component IDs in the desired order (first = top)',
          },
        },
        required: ['dashboardId', 'componentIds'],
      },
    },
    {
      name: 'add_dashboard_components',
      description:
        'Add one or more components to an existing dashboard. Use this to update/extend a dashboard without recreating it.',
      parameters: {
        type: 'object',
        properties: {
          dashboardId: { type: 'string', description: 'Dashboard ID to add components to' },
          components: {
            type: 'array',
            description: 'Components to add (same shape as create_dashboard components)',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['kpi', 'stats_group', 'chart', 'ai_insights', 'table', 'links'],
                },
                title: { type: 'string' },
                prompt: { type: 'string' },
                config: { type: 'object' },
                data: { type: 'object' },
                position: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                  },
                },
              },
              required: ['type'],
            },
          },
        },
        required: ['dashboardId', 'components'],
      },
    },
    {
      name: 'remove_dashboard_components',
      description: 'Remove one or more components from a dashboard by their IDs.',
      parameters: {
        type: 'object',
        properties: {
          componentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of component IDs to remove',
          },
        },
        required: ['componentIds'],
      },
    },
    {
      name: 'update_dashboard_component',
      description:
        'Update a single dashboard component\'s metadata: title, prompt, script, scriptLanguage, notes, or config. Use this to attach regeneration scripts, update prompts, or add agent notes/context to a component. The script will be executed (or its logic followed) on future refreshes.',
      parameters: {
        type: 'object',
        properties: {
          componentId: { type: 'string', description: 'Component ID to update' },
          title: { type: 'string', description: 'New title for the component' },
          prompt: { type: 'string', description: 'New prompt / data-fetching instructions' },
          script: {
            type: 'string',
            description:
              'A script (python/bash/javascript/sql/curl) that the agent should execute to regenerate this component\'s data. Set to empty string to clear.',
          },
          scriptLanguage: {
            type: 'string',
            enum: ['python', 'bash', 'javascript', 'sql', 'curl'],
            description: 'Language of the script',
          },
          notes: {
            type: 'string',
            description:
              'Free-form notes, context, or knowledge for the agent to reference during regeneration. Can include API endpoints, data schemas, business rules, etc. Set to empty string to clear.',
          },
          config: { type: 'object', description: 'Updated type-specific config' },
        },
        required: ['componentId'],
      },
    },
    {
      name: 'delete_dashboard',
      description: 'Delete a dashboard and its linked cron job by ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Dashboard ID to delete' },
        },
        required: ['id'],
      },
    },
  ],
  systemPrompt: `You can create and manage data dashboards that users can view in the Dashboards section of the app.

**Creating dashboards**: Use create_dashboard with all components inline — one tool call builds the entire dashboard. Each component has a "prompt" field that describes what data to fetch/show.

**Component types & data shapes**:
- **kpi**: Single metric card. config: {prefix?, suffix?, trendDirection?: "up-good"|"up-bad"}. data: {value, label, change?, changeLabel?, sources: [{label, url}]}
- **stats_group**: Row of stats. config: {columns?}. data: {stats: [{label, value, change?, changeLabel?}], sources: [{label, url}]}
- **chart**: Recharts visualization. config: {chartType: "line"|"bar"|"pie"|"area", xKey, yKey}. data: {series: [{name, data: [{...}]}], sources: [{label, url}]}
- **table**: Data table. config: {columns: [{key, label, align?}]}. data: {rows: [{...}], sources: [{label, url}]}
- **links**: News/article cards. config: {columns?: 2|3}. data: {items: [{title, url, description?, imageUrl?, source?, date?, tag?}], sources?: [{label, url}]}. IMPORTANT: "url" MUST be a direct link — NEVER a homepage or domain root.
- **ai_insights**: AI-generated analysis. The "prompt" field defines what to analyze. CRITICAL: When updating ai_insights components, you MUST include the "insight" field (markdown string) in the update_dashboard_data call — this is SEPARATE from "data". The "insight" field is what gets displayed. If you only send "data" without "insight", the card will show "Insights will appear here after the first dashboard refresh" forever. Correct format: {componentId: "...", insight: "## Your markdown insight here...", data: {sources: [{label, url}]}}

**Component prompts**: Every component has a "prompt" field that tells the agent what data to fetch or what analysis to perform during refresh. When refreshing, follow each component's prompt to know what to populate.

**Scripts & Notes (regeneration knowledge)**:
Components can have attached scripts and notes that persist across refreshes:
- **script** + **scriptLanguage**: A user-defined script (python/bash/javascript/sql/curl) that should be executed to regenerate the component's data. Scripts take priority over generic fetching. Use update_dashboard_component to set or update scripts.
- **notes**: Free-form context, business rules, API docs, data schemas, or any knowledge the agent needs during regeneration. Use update_dashboard_component to set or update notes.
- BEST PRACTICE: When you discover a reliable way to fetch data for a component (e.g. a specific API call, a web scraping pattern, or a SQL query), save it as a script so future refreshes can reproduce it exactly. Also save any relevant context as notes.
- Scripts and notes are shown to the agent during refresh and should be followed/referenced.

**MANDATORY: Always populate notes on first interaction**
After creating a dashboard or refreshing one, you MUST call update_dashboard_component to set "notes" on EVERY component that doesn't have them yet. This is NOT optional — do it in the same run, right after populating data. Notes should capture:
- What data source was used (API, website, search query, etc.)
- How the data was obtained (specific URL, search terms, API endpoint)
- Any business context or interpretation rules
- Data format quirks or caveats
Think of notes as your memory for the next run.

**Scripts** — OPTIONAL. Only save a script if you actually used a script/code to obtain the data during this run. Do NOT invent a script for data you obtained through web_search or other non-script methods.

Rules:
1. If you obtained data via web_search, browsing, or any non-programmatic method → do NOT save a script. Just save good notes describing your process.
2. If you actually wrote and executed code (API call, scraping, parsing, calculation) to get the data → save that exact working code as a script.
3. NEVER fabricate a script you didn't actually run. NEVER save placeholder scripts, pseudo-code, or comments pretending to be code.
4. NEVER hardcode fallback values in scripts (e.g. \`else: print('1425')\`). If the script fails, it should fail visibly — not silently return stale data.

Example — data obtained via web_search (NO script, just notes):
\`\`\`
update_dashboard_component({
  componentId: "abc123",
  notes: "Blue dollar rate. Search 'dolar blue cotizacion hoy site:dolarhoy.com'. Look for 'Venta' value. Format: $X.XXX (ARS). Source: dolarhoy.com/cotizaciondolarblue"
})
\`\`\`

Example — data obtained by actually running a scraping script:
\`\`\`
update_dashboard_component({
  componentId: "abc123",
  notes: "Blue dollar rate scraped from dolarhoy.com. Uses .tile.is-child div containing 'dólar blue', extracts 'Venta $X' value.",
  script: "import requests\\nfrom bs4 import BeautifulSoup\\nimport re\\nhtml = requests.get('https://dolarhoy.com/', headers={'User-Agent': 'Mozilla/5.0'}).text\\nsoup = BeautifulSoup(html, 'html.parser')\\nfor tile in soup.select('.tile.is-child'):\\n    text = tile.get_text(' ', strip=True)\\n    if 'dólar blue' in text.lower():\\n        m = re.search(r'Venta\\\\s+\\\\$\\\\s?([0-9.,]+)', text)\\n        if m: print(m.group(1)); break",
  scriptLanguage: "python"
})
\`\`\`

**Previous data**: The system automatically snapshots old data before each refresh. The previous values are available for comparison and trend detection.

**MANDATORY: Sources on every component data update**
Every data payload MUST include a "sources" array: [{label: "Human-readable name", url: "https://..."}]. Sources must link to the EXACT page where the data was obtained — never a homepage, never an invented URL. NO EXCEPTIONS.

**Modifying dashboards**: Use add_dashboard_components to add new components. Use remove_dashboard_components to remove by ID. Use reorder_dashboard_components to change display order. Use update_dashboard_component to update a component's title, prompt, script, notes, or config.

**Inspecting dashboards**: Use get_dashboard to see all components with their IDs. ALWAYS call get_dashboard first when you need to remove, reorder, or modify specific components.

**Refreshing data**: Use update_dashboard_data to push new data. For ai_insights, you MUST include the "insight" field with markdown text — this is the displayed content, NOT the "data" field. ALWAYS include sources in the "data" field.

**Scheduling**: Pass cronSchedule (cron expression) to create_dashboard for automatic refresh.`,
  sandbox: {},
}
