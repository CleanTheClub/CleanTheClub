import { describe, it, expect } from 'vitest'
import {
  projectBoardRow, boardRowToRecord, migrateBoardRow, migrateIndex,
  indexIsEmpty, emptyIndex, INDEX_SCHEMA_VERSION,
} from '../../src/server/careers/boardIndex'
import { emptyRecord, ProgressRecord } from '../../src/server/careers/record'

// The index is the roster that lets a failed per-player read be told apart from a
// new player. If it loses a row, that player reads as brand new and their career
// gets overwritten — so completeness and defensive parsing matter more here than
// anywhere else in the careers module.

const rec = (over: Partial<ProgressRecord> = {}): ProgressRecord => ({ ...emptyRecord(), ...over })

describe('projectBoardRow', () => {
  it('should carry exactly the seven fields the boards read', () => {
    const row = projectBoardRow(rec({
      displayName: 'Veteran', money: 900, xp: 18_500, shifts: 40,
      dailyItems: 14, dailyDay: '2026-08-26', ownerSinceMs: 1_600_000_000_000,
    }))

    expect(row).toEqual({
      n: 'Veteran', m: 900, x: 18_500, s: 40,
      di: 14, dd: '2026-08-26', o: 1_600_000_000_000,
    })
  })

  it('should not carry the unbounded fields, which is the whole point of the split', () => {
    const row = projectBoardRow(rec({ kindCounts: { pizza: 400 }, upgrades: { mop: 3 } as any })) as any

    expect(row.kindCounts).toBeUndefined()
    expect(row.upgrades).toBeUndefined()
    expect(Object.keys(row).sort()).toEqual(['dd', 'di', 'm', 'n', 'o', 's', 'x'])
  })
})

describe('boardRowToRecord', () => {
  it('should restore the board-visible fields', () => {
    const restored = boardRowToRecord({
      n: 'Veteran', m: 900, x: 18_500, s: 40, di: 14, dd: '2026-08-26', o: 42,
    })

    expect(restored.displayName).toBe('Veteran')
    expect(restored.money).toBe(900)
    expect(restored.xp).toBe(18_500)
    expect(restored.shifts).toBe(40)
    expect(restored.dailyItems).toBe(14)
    expect(restored.dailyDay).toBe('2026-08-26')
    expect(restored.ownerSinceMs).toBe(42)
  })

  it('should leave every other field at its default, which is why it must never be persisted', () => {
    const restored = boardRowToRecord({ n: 'V', m: 900, x: 1, s: 1, di: 0, dd: '', o: 0 })

    expect(restored.kindCounts).toEqual({})
    expect(restored.upgrades).toEqual({})
    expect(restored.flexGear).toBe('')
    expect(restored.bestItems).toBe(0)
    expect(restored.workStreak).toBe(0)
    expect(restored.lifetimeItems).toBe(0)
  })

  it('should round-trip cleanly through projectBoardRow', () => {
    const row = { n: 'V', m: 12, x: 34, s: 5, di: 6, dd: '2026-01-01', o: 7 }
    expect(projectBoardRow(boardRowToRecord(row))).toEqual(row)
  })
})

describe('migrateBoardRow', () => {
  describe('when the row is unusable', () => {
    it('should return null so the caller can skip it', () => {
      for (const junk of [null, undefined, 5, 'x']) {
        expect(migrateBoardRow(junk)).toBeNull()
      }
    })
  })

  describe('when fields are malformed', () => {
    it('should coerce numbers and clamp negatives', () => {
      expect(migrateBoardRow({ m: -5, x: 10.7, s: 'no', di: NaN, o: Infinity }))
        .toEqual({ n: '', m: 0, x: 10, s: 0, di: 0, dd: '', o: 0 })
    })

    it('should coerce a non-string name or day to empty', () => {
      expect(migrateBoardRow({ n: 42, dd: {} })!.n).toBe('')
      expect(migrateBoardRow({ n: 42, dd: {} })!.dd).toBe('')
    })
  })
})

describe('migrateIndex', () => {
  it('should lowercase every address key, since casing is not normalised on the wire', () => {
    const doc = migrateIndex({
      v: 1,
      rows: { '0xAbCdEf': { n: 'A', m: 1, x: 1, s: 1, di: 0, dd: '', o: 0 } },
    })

    expect(Object.keys(doc.rows)).toEqual(['0xabcdef'])
  })

  it('should drop unusable rows but keep the rest of the roster', () => {
    const doc = migrateIndex({
      rows: {
        '0xa': { n: 'A', m: 5, x: 5, s: 1, di: 0, dd: '', o: 0 },
        '0xb': null,
        '0xc': { n: 'C', m: 7, x: 7, s: 2, di: 0, dd: '', o: 0 },
      },
    })

    expect(Object.keys(doc.rows).sort()).toEqual(['0xa', '0xc'])
  })

  describe('when the document is absent or shapeless', () => {
    it('should return an empty index rather than throwing', () => {
      for (const junk of [null, undefined, {}, { rows: 'nope' }, 7]) {
        expect(migrateIndex(junk)).toEqual(emptyIndex())
      }
    })

    it('should stamp the current index schema version', () => {
      expect(migrateIndex(null).v).toBe(INDEX_SCHEMA_VERSION)
    })
  })
})

describe('indexIsEmpty', () => {
  it('should treat a missing or row-less index as empty, guarding against a roster wipe', () => {
    expect(indexIsEmpty(null)).toBe(true)
    expect(indexIsEmpty(emptyIndex())).toBe(true)
  })

  it('should treat any single row as non-empty', () => {
    expect(indexIsEmpty({
      v: 1, rows: { '0xa': { n: 'A', m: 1, x: 1, s: 1, di: 0, dd: '', o: 0 } },
    })).toBe(false)
  })
})
