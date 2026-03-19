How the Sub-Agent System Works

  General Architecture

  ┌─────────────────────────────────────────────────────────┐
  │                     USER (Frontend)                      │
  │                    sends a message                       │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │              MAIN AGENT (agent.service.ts)               │
  │                                                         │
  │  ┌─────────────────────────────────────────────────┐    │
  │  │  Agent Loop (max 50 iterations)                 │    │
  │  │                                                  │    │
  │  │  1. Builds system prompt + tools                 │    │
  │  │  2. Calls the LLM (primary model)               │    │
  │  │  3. LLM responds with tool calls                 │    │
  │  │  4. Executes tools via toolExecutorService       │    │
  │  │  5. Result goes back to LLM → repeats            │    │
  │  │                                                  │    │
  │  │  Available tools:                                │    │
  │  │  ├── run_bash, run_python, web_search...        │    │
  │  │  ├── search_documents, discover_tools...         │    │
  │  │  └── delegate_task  ◄── NEW                      │    │
  │  └─────────────────────────────────────────────────┘    │
  └──────────────────────┬──────────────────────────────────┘
                         │
            When the LLM decides to call
                delegate_task(...)
                         │
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │           toolExecutorService.executeDelegateTask()      │
  │                                                         │
  │  Receives: { role: "explore", task: "search for X",     │
  │              context: "we are working on Y" }           │
  │                                                         │
  │  Calls: subAgentService.runSubAgent(request, ctx)       │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │              SUB-AGENT (sub-agent.service.ts)            │
  │                                                         │
  │  ┌─────────────────────────────────────────────────┐    │
  │  │  Simplified loop (max depends on role)          │    │
  │  │                                                  │    │
  │  │  • Fresh context (only system + task)            │    │
  │  │  • No message persistence in DB                  │    │
  │  │  • No approval flow                              │    │
  │  │  • No context compression                        │    │
  │  │  • Tools filtered by role                        │    │
  │  │  • Model based on role tier                      │    │
  │  └─────────────────────────────────────────────────┘    │
  │                                                         │
  │  Returns: SubAgentResult { result, toolExecutions,      │
  │           iterationsUsed, tokenUsage, success }         │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
          The result returns as a tool_result
          to the main agent, which continues its loop

  The 3 Roles

  ┌──────────────────────────────────────────────────────────────────┐
  │                        SUB-AGENT ROLES                          │
  ├────────────┬─────────────────┬───────────────┬──────────────────┤
  │            │    EXPLORE      │   ANALYZE     │    EXECUTE       │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Model      │ Light           │ Compact       │ Primary          │
  │            │ (Haiku/Flash-   │ (Haiku/Flash/ │ (same as         │
  │            │  Lite/nano)     │  nano)        │  workspace)      │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Max Iter   │ 15              │ 10            │ 25               │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Read-Only  │ Yes             │ Yes           │ No               │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Tools      │ search_documents│ search_docs   │ ALL except       │
  │            │ web_search      │ run_bash      │ delegate_task    │
  │            │ run_bash        │ run_python    │ (no nesting)     │
  │            │ run_browser_    │               │                  │
  │            │   script        │               │                  │
  │            │ discover_tools  │               │                  │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Use case   │ Search info,    │ Analyze       │ Multi-step       │
  │            │ read docs,      │ data, parse,  │ tasks that       │
  │            │ browse web      │ summarize     │ modify things    │
  ├────────────┼─────────────────┼───────────────┼──────────────────┤
  │ Cost       │ Cheap           │ Cheap         │ Expensive        │
  └────────────┴─────────────────┴───────────────┴──────────────────┘

  Complete Delegation Flow

   TIME
     │
     │  User: "Research what weather APIs are available
     │         and then write a script that uses the best one"
     │
     ▼
     ┌──────────────────────────────────────┐
     │  MAIN AGENT (primary model)         │
     │                                      │
     │  Thinks: "I need to research         │
     │  first. I can delegate that to an    │
     │  explore and save tokens"            │
     │                                      │
     │  Calls: delegate_task({              │
     │    role: "explore",                  │
     │    task: "Search for free weather    │
     │     APIs, compare features           │
     │     and pricing",                    │
     │    context: "We are going to write   │
     │     a Python script afterwards"      │
     │  })                                  │
     └──────────┬───────────────────────────┘
                │
                ▼
     ┌──────────────────────────────────────┐
     │  SUB-AGENT EXPLORE (light model)    │
     │  Fresh context, isolated            │
     │                                      │
     │  Iter 1: web_search("free weather    │  ◄── SSE: sub_agent_start
     │          APIs comparison")            │  ◄── SSE: tool_start {subAgent: "explore"}
     │          → Google results             │  ◄── SSE: tool_result {subAgent: "explore"}
     │                                      │
     │  Iter 2: web_search("openweathermap  │
     │          vs weatherapi pricing")      │
     │          → more results              │
     │                                      │
     │  Iter 3: Synthesizes and responds:   │
     │  "Found 3 APIs: OpenWeatherMap       │
     │   (free up to 1000 calls/day),       │
     │   WeatherAPI (free 1M calls/month),  │  ◄── SSE: sub_agent_done
     │   VisualCrossing (free 1000/day)"    │
     └──────────┬───────────────────────────┘
                │
                │  SubAgentResult returns as
                │  tool_result to the main agent
                ▼
     ┌──────────────────────────────────────┐
     │  MAIN AGENT (continues)             │
     │                                      │
     │  Receives the explore result.        │
     │  Now has the info without having     │
     │  "spent" its context on searches.    │
     │                                      │
     │  Calls: run_python({                 │
     │    code: "import requests\n..."      │
     │  })                                  │
     │  → Writes the script using           │
     │    WeatherAPI (the best option)      │
     │                                      │
     │  Responds to the user with the       │
     │  script + explanation                │
     └──────────────────────────────────────┘

  Context Isolation

  This is the key benefit. Without sub-agents vs with sub-agents:

   WITHOUT SUB-AGENTS                      WITH SUB-AGENTS
   ────────────────────                     ──────────────────

   ┌─ Agent context ───────┐              ┌─ Main context ──────────┐
   │                         │              │                       │
   │ system prompt           │              │ system prompt         │
   │ full history            │              │ full history          │
   │ tool_call: web_search   │              │                       │
   │ tool_result: 5KB        │              │ tool_call:            │
   │ tool_call: web_search   │              │   delegate_task(...)  │
   │ tool_result: 5KB        │              │ tool_result:          │
   │ tool_call: web_search   │              │   "Summary: the top   │
   │ tool_result: 5KB        │              │    3 APIs             │
   │ tool_call: run_python   │              │    are..."  (1KB)     │
   │ tool_result: 2KB        │              │ tool_call: run_python │
   │                         │              │ tool_result: 2KB      │
   │ TOTAL: ~22KB in context │              │                       │
   │ Everything on EXPENSIVE │              │ TOTAL: ~8KB context   │
   │ model                   │              │ Searches on CHEAP     │
   └─────────────────────────┘              │ model                 │
                                            └───────────────────────┘

                                            ┌─ Sub-agent context ───┐
                                            │ (ephemeral, discarded)│
                                            │                       │
                                            │ task + 3 web_search   │
                                            │ ~15KB on LIGHT model  │
                                            │                       │
                                            │ Discarded at the end  │
                                            └───────────────────────┘

  File Structure

                            FILES
                            ─────

    sub-agent.types.ts          Pure types (SubAgentRole, SubAgentRequest, etc.)
          │
          ▼
    sub-agent-roles.ts          Static registry: config for the 3 roles
          │
          ▼
    sub-agent.service.ts        Core: runSubAgent() — simplified loop
          │                     Uses: createLLMForTier(), filterTools()
          │                     Reuses: toolExecutorService, recordTokenUsage
          │
          ├──────────────────── tool-executor.service.ts
          │                     Adds delegate_task to NON_SANDBOX_TOOLS
          │                     executeDelegateTask() → calls subAgentService
          │
          ├──────────────────── agent.service.ts
          │                     Passes emit to toolExecutor so that
          │                     delegate_task can emit SSE events
          │
          ├──────────────────── builtin/sub-agent-delegation.ts
          │                     Defines the capability + tool definition
          │                     for delegate_task
          │
          ├──────────────────── builtin/index.ts
          │                     Registers subAgentDelegation in BUILTIN_CAPABILITIES
          │
          ├──────────────────── constants.ts
          │                     'sub-agent-delegation' in ALWAYS_ON_CAPABILITY_SLUGS
          │
          └──────────────────── lib/sse.ts
                                New event types: sub_agent_start, sub_agent_done

  Security Constraints

    ┌─────────────────────────────────────┐
    │         CONSTRAINTS                 │
    ├─────────────────────────────────────┤
    │                                     │
    │  No nesting                         │
    │     execute does not have           │
    │     delegate_task                   │
    │     → impossible to create          │
    │       sub-sub-agents                │
    │                                     │
    │  No internal approval flow          │
    │     The parent already approved     │
    │     delegate_task                   │
    │     → sub-agent auto-executes all   │
    │                                     │
    │  Shared sandbox                     │
    │     Same workspace, same user       │
    │     → no 2-5s extra startup         │
    │                                     │
    │  Secret redaction active            │
    │     Inherits secrets inventory      │
    │     from parent                     │
    │                                     │
    │  Shared token tracking              │
    │     Sub-agent tokens are recorded   │
    │     under the same sessionId        │
    │                                     │
    │  Ephemeral context                  │
    │     Sub-agent messages are NOT      │
    │     saved to DB, only the result    │
    └─────────────────────────────────────┘

  In summary: the main LLM has a new delegate_task tool it can use whenever it wants. When called,
  a simplified loop is spawned with fresh context, an appropriate model, and filtered tools. The
  result returns as a string to the main agent. The frontend receives SSE events with a subAgent tag
  so it can display sub-agent activity in a collapsible section.
