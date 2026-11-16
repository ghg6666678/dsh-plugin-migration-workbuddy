import { describe, expect, it } from 'vitest'
import { isExportWritable, reconcileSelection, toggleId } from '../src/export-selection.js'
import type { ExportSessionSummary } from '../src/model.js'

function row(status: ExportSessionSummary['status'], pendingRows = 5): ExportSessionSummary {
  return { status, pendingRows } as ExportSessionSummary
}

describe('export selection', () => {
  it('only offers rows the service will actually write', () => {
    expect(isExportWritable(row('new'))).toBe(true)
    expect(isExportWritable(row('ahead'))).toBe(true)
    expect(isExportWritable(row('conflict'))).toBe(true)
    // A brand-new session with nothing to write is skipped by the service;
    // offering it would let the user tick a row that cannot enable "begin".
    expect(isExportWritable(row('new', 0))).toBe(false)
    expect(isExportWritable(row('synced'))).toBe(false)
    expect(isExportWritable(row('empty'))).toBe(false)
    expect(isExportWritable(row('workbuddy-ahead'))).toBe(false)
  })

  it('toggles an id on and off without duplicates', () => {
    expect(toggleId([], 'a')).toEqual(['a'])
    expect(toggleId(['a'], 'a')).toEqual([])
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('adopts every offered id until the user touches the board', () => {
    expect(reconcileSelection([], ['a', 'b'], false)).toEqual(['a', 'b'])
    // A stale choice is replaced by the fresh preview's default.
    expect(reconcileSelection(['old'], ['a', 'b'], false)).toEqual(['a', 'b'])
  })

  it('keeps an explicit empty selection across a refresh (uncheck-all)', () => {
    // Regression: the old `kept.length > 0 ? kept : writable` turned an empty
    // explicit choice back into "all", so unchecking the last row did nothing.
    expect(reconcileSelection([], ['a', 'b'], true)).toEqual([])
  })

  it('keeps a partial explicit choice and drops rows no longer offered', () => {
    expect(reconcileSelection(['a', 'b'], ['b', 'c'], true)).toEqual(['b'])
    expect(reconcileSelection(['a'], [], true)).toEqual([])
  })
})
