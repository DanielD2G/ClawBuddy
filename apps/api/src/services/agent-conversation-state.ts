import { prisma } from '../lib/prisma.js'
import { buildSessionConversationState } from './session-state.service.js'
import { buildPromptSection } from './system-prompt-builder.js'

/** tool-discovery is always in the prompt natively — no need to track it as "loaded". */
const PROMPT_NATIVE_SLUG = 'tool-discovery'

export const MAX_CONVERSATION_LOADED_CAPABILITIES = 8

export function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function mergeConversationLoadedCapabilitySlugs(
  existing: string[] | null | undefined,
  additions: string[] | null | undefined,
  enabledCapabilitySlugs: Set<string>,
): string[] {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const slug of [...(additions ?? []), ...(existing ?? [])]) {
    if (!enabledCapabilitySlugs.has(slug)) continue
    if (slug === PROMPT_NATIVE_SLUG) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    merged.push(slug)
    if (merged.length >= MAX_CONVERSATION_LOADED_CAPABILITIES) break
  }

  return merged
}

export async function persistConversationLoadedCapabilitySlugs(
  sessionId: string,
  current: string[],
  additions: string[],
  enabledCapabilitySlugs: Set<string>,
): Promise<string[]> {
  if (!additions.length) return current

  const next = mergeConversationLoadedCapabilitySlugs(current, additions, enabledCapabilitySlugs)
  if (stringArraysEqual(current, next)) return current

  const session = await prisma.chatSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { sessionAllowRules: true },
  })

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      sessionAllowRules: buildSessionConversationState(session.sessionAllowRules, {
        loadedCapabilitySlugs: next,
      }),
    },
  })

  return next
}

export function buildConversationLoadedCapabilitiesSection(
  loadedCapabilitySlugs: string[],
  capabilities: Array<{ slug: string; name: string }>,
): string {
  if (!loadedCapabilitySlugs.length) return ''

  const loadedNames = loadedCapabilitySlugs
    .map((slug) => capabilities.find((cap) => cap.slug === slug)?.name ?? slug)
    .filter(Boolean)

  if (!loadedNames.length) return ''

  return buildPromptSection(
    'conversation_loaded_capabilities',
    `These capabilities were already discovered or used earlier in this conversation and remain available now: ${loadedNames.join(', ')}.
For short follow-up requests such as "again", "otra vez", "same", or retries, reuse the most relevant capability from this list before falling back to generic bash/python or running tool discovery again.`,
  )
}
