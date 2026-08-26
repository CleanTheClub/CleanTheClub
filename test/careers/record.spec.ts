import { describe, it, expect } from 'vitest'
import {
  emptyRecord, migrateRecord, isWorthKeeping, SCHEMA_VERSION,
} from '../../src/server/careers/record'

// migrateRecord stands between a corrupt entry and a crashed session;
// isWorthKeeping decides whether a career is kept forever. Both act on data
// nobody can regenerate.

describe('migrateRecord', () => {
  describe('when the stored value is not a usable object', () => {
    it('should return a valid empty record rather than throwing', () => {
      for (const junk of [null, undefined, 42, 'nope', true, []]) {
        expect(migrateRecord(junk)).toEqual(emptyRecord())
      }
    })
  })

  describe('when fields are present and well-typed', () => {
    it('should carry every field across', () => {
      const raw = {
        v: 1, money: 500, xp: 1200, shifts: 8, lifetimeItems: 240,
        displayName: 'Cleaner', bestItems: 45, lastWorkDay: '2026-08-26',
        workStreak: 3, dailyItems: 20, dailyDay: '2026-08-26',
        upgrades: { mop: 2 }, kindCounts: { pizza: 30 },
        flexGear: 'gold_platter', ownerSinceMs: 1_700_000_000_000,
      }

      expect(migrateRecord(raw)).toEqual({ ...raw, v: SCHEMA_VERSION })
    })
  })

  describe('when a numeric field is malformed', () => {
    it('should floor fractional values', () => {
      expect(migrateRecord({ money: 10.9 }).money).toBe(10)
    })

    it('should clamp negatives to zero', () => {
      expect(migrateRecord({ money: -50, xp: -1 }).money).toBe(0)
      expect(migrateRecord({ xp: -1 }).xp).toBe(0)
    })

    it('should fall back to the default when the type is wrong', () => {
      expect(migrateRecord({ money: '500' }).money).toBe(0)
      expect(migrateRecord({ shifts: null }).shifts).toBe(0)
    })
  })

  describe('when sparse maps are malformed', () => {
    it('should drop non-positive and non-numeric upgrade levels', () => {
      const rec = migrateRecord({ upgrades: { mop: 3, cart: 0, vacuum: -1, bad: 'x' } }) as any
      expect(rec.upgrades).toEqual({ mop: 3 })
    })

    it('should drop non-positive and non-numeric kind counts', () => {
      expect(migrateRecord({ kindCounts: { pizza: 5, sock: 0, tie: -2, bad: {} } }).kindCounts)
        .toEqual({ pizza: 5 })
    })

    it('should preserve arbitrary kind keys, since achievements sum them at read time', () => {
      expect(migrateRecord({ kindCounts: { somethingNew: 4, streakbest: 9 } }).kindCounts)
        .toEqual({ somethingNew: 4, streakbest: 9 })
    })

    it('should ignore a non-object map', () => {
      expect(migrateRecord({ upgrades: 'nope', kindCounts: 7 }).kindCounts).toEqual({})
    })
  })

  describe('when the stored entry carries unknown fields', () => {
    it('should drop them rather than passing them through', () => {
      expect('somethingRemoved' in (migrateRecord({ somethingRemoved: 1 }) as any)).toBe(false)
    })
  })

  describe('when the stored entry has an old or missing version stamp', () => {
    it('should stamp the current schema version regardless', () => {
      expect(migrateRecord({ v: 0, money: 5 }).v).toBe(SCHEMA_VERSION)
      expect(migrateRecord({ money: 5 }).v).toBe(SCHEMA_VERSION)
      expect(migrateRecord({ v: 99, money: 5 }).v).toBe(SCHEMA_VERSION)
    })
  })
})

describe('isWorthKeeping', () => {
  describe('when the record shows any earned progress', () => {
    it('should keep it', () => {
      expect(isWorthKeeping({ ...emptyRecord(), shifts: 1 })).toBe(true)
      expect(isWorthKeeping({ ...emptyRecord(), xp: 1 })).toBe(true)
      expect(isWorthKeeping({ ...emptyRecord(), money: 1 })).toBe(true)
      expect(isWorthKeeping({ ...emptyRecord(), lifetimeItems: 1 })).toBe(true)
    })
  })

  describe('when the record is a bare row created by a passer-by', () => {
    it('should drop it', () => {
      expect(isWorthKeeping(emptyRecord())).toBe(false)
      expect(isWorthKeeping(emptyRecord('SomeName'))).toBe(false)
    })
  })

  describe('when the only content is a field the rule does not test', () => {
    it('should still drop it, which is the documented and accepted edge', () => {
      // Cleaning during a round that never completed leaves kindCounts but no
      // shifts/xp/money. Recorded so it's a decision, not a surprise.
      expect(isWorthKeeping({ ...emptyRecord(), kindCounts: { pizza: 12 } })).toBe(false)
      expect(isWorthKeeping({ ...emptyRecord(), bestItems: 30 })).toBe(false)
    })
  })
})
