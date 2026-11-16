/**
 * Pure helpers for the export panel's four user-editable selections (sessions,
 * memories, MCP, automations). Kept free of React and the DOM so the important
 * behaviour — an explicit "uncheck everything" must survive a preview refresh
 * — can be unit-tested without a browser.
 */
import type { ExportSessionSummary } from './model.js'

/**
 * Whether a preview row can actually be exported. The export service skips a
 * brand-new session with no rows to write, so offering it here would let the
 * user tick a row that can never enable the "begin" button.
 */
export function isExportWritable(item: ExportSessionSummary): boolean {
  if (item.status !== 'new' && item.status !== 'ahead' && item.status !== 'conflict') return false
  return !(item.status === 'new' && item.pendingRows === 0)
}

/** Add one id to a selection or remove it, preserving order and uniqueness. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]
}

/**
 * Reconcile a selection against the ids a fresh preview still offers.
 *
 * Before the user has edited a board, adopt whatever the preview offers (the
 * default "all pending"). Once edited, the explicit choice wins — including
 * the empty choice — and only ids that no longer need writing are dropped.
 *
 * The old implementation did `kept.length > 0 ? kept : writable`: an empty
 * explicit selection was mistaken for "not decided yet" and silently turned
 * back into "all selected", so unchecking the last row appeared to do nothing.
 */
export function reconcileSelection(
  current: readonly string[],
  offered: readonly string[],
  touched: boolean,
): string[] {
  if (!touched) return [...offered]
  const available = new Set(offered)
  return current.filter(id => available.has(id))
}
