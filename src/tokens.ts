/**
 * Runtime-equivalent heuristic token pricing for imported surface events.
 *
 * `@deepseek-ai/dsh-token-meter` is NOT resolvable from the installed plugin
 * bundle (the profile's node_modules has no `@deepseek-ai/dsh-token-meter`), so
 * this mirrors `dsh-token-meter/lib/types/estimate.js` verbatim instead of
 * importing it. The runtime charges `compaction/summary.shadowedTokenCount`
 * against its own `contextPressure.surfaceTokens`; if an import declares a
 * different price for the same shadowed range, `surfaceTokens` goes negative and
 * violates the runtime's own zod schema. Pricing with the same heuristic keeps
 * the two sides consistent.
 *
 * Verified against `@deepseek-ai/dsh-token-meter@0.2.2-rc.1`. Keep in sync when
 * the runtime's estimator changes.
 *
 * @module dsh-plugin-migration-workbuddy/tokens
 */

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4
/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4
/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

type PricedBlock = {
  type?: string
  text?: string
  name?: string
  arguments?: string
  [key: string]: unknown
}

type PricedMessage = {
  role?: string
  content?: PricedBlock[]
  [key: string]: unknown
}

/** Structural JSON price of one block outside the typed pricing arms. */
export function estimateStructuralBlock(block: PricedBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}

/** Price content blocks recursively under the fixed density heuristic. */
export function estimateContent(blocks: PricedBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil((block.name ?? '').length / CHARS_PER_TOKEN)
          + Math.ceil((block.arguments ?? '').length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/** Price the rendered system prompt: the `system/message` surface node's text. */
export function estimateSystemMessage(message: PricedMessage): number {
  const content = message.content ?? []
  if (content.length === 0) return 0
  let characters = 0
  for (const block of content) {
    characters += block.type === 'text' ? (block.text ?? '').length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Heuristically price one model-visible message. */
export function estimateMessage(message: PricedMessage): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content ?? []) + ROLE_OVERHEAD
}

/** Price the tool-schema part of a canonical request envelope. */
export function estimateToolsTokens(header: { tools?: unknown[] } | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Mirror of `dsh-session`'s `deriveEventMessage` for the surface event types an
 * import writes: `user/message` carries the message directly in `data`; every
 * other surface event carries `data.message`; an empty `assistant/message`
 * content produces no message at all (0 tokens).
 */
export function deriveEventMessage(event: { type: string; data?: unknown }): PricedMessage | null {
  const data = event.data as Record<string, unknown> | undefined
  if (data === undefined) return null
  switch (event.type) {
    case 'user/message':
      return data as PricedMessage
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      const message = data.message as PricedMessage | undefined
      if (message === undefined || (message.content?.length ?? 0) === 0) return null
      return message
    }
    case 'tool/result':
      return (data.message as PricedMessage | undefined) ?? null
    default:
      return null
  }
}

/** Runtime-equivalent heuristic price of one surface event, in tokens. */
export function estimateEventTokens(event: { type: string; data?: unknown }): number {
  const message = deriveEventMessage(event)
  return message === null ? 0 : estimateMessage(message)
}
