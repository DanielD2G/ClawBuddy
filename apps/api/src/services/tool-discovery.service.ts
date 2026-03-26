import { prisma } from '../lib/prisma.js'
import { qdrant } from '../lib/qdrant.js'
import { embeddingService } from './embedding.service.js'
import { capabilityService } from './capability.service.js'
import type { LLMToolDefinition } from '../providers/llm.interface.js'
import type { ToolDefinition } from '../capabilities/types.js'
import { toolDiscovery } from '../capabilities/builtin/tool-discovery.js'
import {
  TOOL_DISCOVERY_COLLECTION,
  TOOL_DISCOVERY_TOP_K,
  TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT,
} from '../constants.js'
import { logger } from '../lib/logger.js'

/**
 * Generate a deterministic UUID from a slug string.
 * Qdrant requires UUID or integer IDs — not arbitrary strings.
 */
function slugToUUID(slug: string): string {
  const hash = Bun.hash(slug).toString(16).padStart(32, '0')
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-')
}

interface CapabilityPayload {
  slug: string
  name: string
  description: string
  toolDefinitions: ToolDefinition[]
  systemPrompt: string
  networkAccess: boolean
  skillType: string | null
  category: string
}

interface DiscoveryContext {
  systemPrompt: string
  tools: LLMToolDefinition[]
}

interface DiscoveredCapability {
  slug: string
  name: string
  tools: ToolDefinition[]
  instructions: string
  networkAccess: boolean
  skillType: string | null
}

type CapabilityListRow = {
  slug: string
  name: string
  description: string
  toolDefinitions: unknown
}

export const toolDiscoveryService = {
  /**
   * Index all capabilities into Qdrant for semantic search.
   * Called on server startup after capabilities and skills are synced.
   */
  async indexCapabilities() {
    const capabilities = await prisma.capability.findMany()

    if (!capabilities.length) return

    // Build embedding texts
    const embeddingTexts: string[] = []
    const payloads: CapabilityPayload[] = []
    const ids: string[] = []

    for (const cap of capabilities) {
      // Skip tool-discovery itself — it's always loaded
      if (cap.slug === 'tool-discovery') continue

      const toolDefs = (cap.toolDefinitions ?? []) as unknown as ToolDefinition[]
      const toolNames = toolDefs.map((t) => `${t.name}: ${t.description}`).join('. ')
      const instructionsTruncated = (cap.systemPrompt ?? '').slice(
        0,
        TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT,
      )

      const embeddingText = [
        cap.name,
        cap.description,
        `Tools: ${toolNames}`,
        instructionsTruncated,
      ]
        .filter(Boolean)
        .join('. ')

      embeddingTexts.push(embeddingText)
      ids.push(cap.slug)
      payloads.push({
        slug: cap.slug,
        name: cap.name,
        description: cap.description ?? '',
        toolDefinitions: toolDefs,
        systemPrompt: cap.systemPrompt ?? '',
        networkAccess: cap.networkAccess,
        skillType: cap.skillType,
        category: cap.category,
      })
    }

    if (!embeddingTexts.length) return

    // Embed all capability texts
    const vectors = await embeddingService.embedBatch(embeddingTexts)

    // Ensure collection exists with correct dimensions
    const dimensions = vectors[0].length
    await this.ensureCollection(dimensions)

    // Upsert all points (Qdrant requires UUID or integer IDs)
    const points = vectors.map((vector, i) => ({
      id: slugToUUID(ids[i]),
      vector,
      payload: payloads[i] as unknown as Record<string, unknown>,
    }))

    await qdrant.upsert(TOOL_DISCOVERY_COLLECTION, { points })
    logger.info(
      `[ToolDiscovery] Indexed ${points.length} capabilities into ${TOOL_DISCOVERY_COLLECTION}`,
      { slugs: ids },
    )
  },

  /**
   * Ensure the Qdrant collection exists with correct dimensions.
   */
  async ensureCollection(dimensions: number) {
    const collections = await qdrant.getCollections()
    const exists = collections.collections.some((c) => c.name === TOOL_DISCOVERY_COLLECTION)

    if (exists) {
      const info = await qdrant.getCollection(TOOL_DISCOVERY_COLLECTION)
      const currentSize = (info.config.params.vectors as { size: number }).size
      if (currentSize !== dimensions) {
        logger.warn(
          `[ToolDiscovery] Collection dimension mismatch (${currentSize} vs ${dimensions}). Recreating.`,
        )
        await qdrant.deleteCollection(TOOL_DISCOVERY_COLLECTION)
        await qdrant.createCollection(TOOL_DISCOVERY_COLLECTION, {
          vectors: { size: dimensions, distance: 'Cosine' },
        })
      }
    } else {
      await qdrant.createCollection(TOOL_DISCOVERY_COLLECTION, {
        vectors: { size: dimensions, distance: 'Cosine' },
      })
    }
  },

  /**
   * Search for relevant capabilities based on a natural language query.
   * Filters results to only include capabilities enabled for the workspace.
   * @param maxResults - Maximum number of results to return (default: TOOL_DISCOVERY_TOP_K)
   */
  async search(
    query: string,
    enabledSlugs: string[],
    scoreThreshold = 0.3,
    maxResults?: number,
  ): Promise<DiscoveredCapability[]> {
    const topK = maxResults ?? TOOL_DISCOVERY_TOP_K
    const queryVector = await embeddingService.embed(query)

    // Search with a higher limit to account for post-filtering
    const results = await qdrant.search(TOOL_DISCOVERY_COLLECTION, {
      vector: queryVector,
      limit: topK * 3,
      with_payload: true,
      score_threshold: scoreThreshold,
    })

    logger.debug(
      `[ToolDiscovery] Search "${query.slice(0, 80)}" returned ${results.length} results (topK=${topK})`,
      {
        results: results.map((r) => ({
          slug: (r.payload as unknown as CapabilityPayload).slug,
          score: r.score,
        })),
      },
    )

    // Filter by enabled slugs and take top-K
    return results
      .filter((r) => {
        const payload = r.payload as unknown as CapabilityPayload
        return enabledSlugs.includes(payload.slug)
      })
      .slice(0, topK)
      .map((r) => {
        const payload = r.payload as unknown as CapabilityPayload
        return {
          slug: payload.slug,
          name: payload.name,
          tools: payload.toolDefinitions,
          instructions: payload.systemPrompt,
          networkAccess: payload.networkAccess,
          skillType: payload.skillType,
        }
      })
  },

  /**
   * List all available capabilities in compact format (for fallback).
   */
  async listAvailable(enabledSlugs: string[]): Promise<string> {
    const capabilities = (await prisma.capability.findMany({
      where: { slug: { in: enabledSlugs } },
      select: { slug: true, name: true, description: true, toolDefinitions: true },
    })) as CapabilityListRow[]

    return capabilities
      .map((cap: CapabilityListRow) => {
        const toolDefs = (cap.toolDefinitions ?? []) as unknown as ToolDefinition[]
        const toolNames = toolDefs.map((t) => t.name).join(', ')
        return `- ${cap.slug}: ${cap.name} — ${cap.description} (tools: ${toolNames})`
      })
      .join('\n')
  },

  /**
   * Build the minimal discovery context for the agent loop.
   * Only loads discover_tools natively — the agent discovers all other tools dynamically.
   * Preloaded slugs (from conversation state) are also loaded to maintain continuity.
   */
  buildDiscoveryContext(
    capabilities: Array<{
      slug: string
      name: string
      systemPrompt: string
      toolDefinitions: unknown
      networkAccess?: boolean
    }>,
    preloadedSlugs?: string[],
    timezone?: string,
  ): DiscoveryContext {
    const preloadedSet = new Set(preloadedSlugs ?? [])

    // Only load previously-discovered capabilities from this conversation (continuity)
    const preloadedCaps = capabilities.filter((c) => preloadedSet.has(c.slug))

    // Build system prompt: discovery instructions + any preloaded capability instructions
    const promptCaps = [
      ...preloadedCaps,
      { name: toolDiscovery.name, systemPrompt: toolDiscovery.systemPrompt },
    ]
    const systemPrompt = capabilityService.buildSystemPrompt(promptCaps, timezone)

    // Build tool definitions: preloaded tools + discover_tools
    const tools: LLMToolDefinition[] = capabilityService.buildToolDefinitions(preloadedCaps)

    // Always add discover_tools
    for (const tool of toolDiscovery.tools) {
      if (!tools.some((t) => t.name === tool.name)) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })
      }
    }

    return { systemPrompt, tools }
  },
}
