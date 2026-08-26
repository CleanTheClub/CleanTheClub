import { describe, it, expect } from 'vitest'
import { planMigration } from '../../src/server/careers/migration'
import { SCHEMA_VERSION } from '../../src/server/careers/record'
import { INDEX_SCHEMA_VERSION } from '../../src/server/careers/boardIndex'

// The migration runs once per world against data nobody can regenerate. Its plan
// has to be complete (every keepable career written), consistent (the index lists
// exactly what was written) and defensive (one corrupt row cannot abort the rest).

const career = (over: Record<string, unknown> = {}) => ({
  money: 100, xp: 500, shifts: 4, lifetimeItems: 60, displayName: 'Cleaner', ...over,
})

describe('planMigration', () => {
  describe('when the blob holds real careers', () => {
    it('should plan one write per career', () => {
      const plan = planMigration({ '0xa': career(), '0xb': career({ money: 7 }) })

      expect(plan.writes.map((w) => w.address).sort()).toEqual(['0xa', '0xb'])
      expect(plan.pruned).toBe(0)
    })

    it('should build an index row for every planned write, and nothing else', () => {
      const plan = planMigration({ '0xa': career(), '0xb': career() })

      expect(Object.keys(plan.index.rows).sort()).toEqual(plan.writes.map((w) => w.address).sort())
    })

    it('should stamp both schema versions', () => {
      const plan = planMigration({ '0xa': career() })

      expect(plan.writes[0].record.v).toBe(SCHEMA_VERSION)
      expect(plan.index.v).toBe(INDEX_SCHEMA_VERSION)
    })

    it('should lowercase addresses, since the SDK does not normalise them on the wire', () => {
      const plan = planMigration({ '0xAbCdEf': career() })

      expect(plan.writes[0].address).toBe('0xabcdef')
      expect(Object.keys(plan.index.rows)).toEqual(['0xabcdef'])
    })

    it('should carry the unbounded fields into the per-player record', () => {
      const plan = planMigration({
        '0xa': career({ kindCounts: { pizza: 400 }, upgrades: { mop: 3 }, flexGear: 'gold_platter' }),
      })

      expect(plan.writes[0].record.kindCounts).toEqual({ pizza: 400 })
      expect(plan.writes[0].record.upgrades).toEqual({ mop: 3 })
      expect(plan.writes[0].record.flexGear).toBe('gold_platter')
    })
  })

  describe('when the blob holds rows with no earned progress', () => {
    it('should prune them instead of migrating them, matching what a save would do', () => {
      const plan = planMigration({
        '0xreal': career(),
        '0xpasserby': { displayName: 'Tourist' },
        '0xzeroed': { money: 0, xp: 0, shifts: 0, lifetimeItems: 0 },
      })

      expect(plan.writes.map((w) => w.address)).toEqual(['0xreal'])
      expect(plan.pruned).toBe(2)
      expect(Object.keys(plan.index.rows)).toEqual(['0xreal'])
    })
  })

  describe('when an entry is corrupt', () => {
    it('should not abort the migration for the other players', () => {
      const plan = planMigration({ '0xa': career(), '0xbroken': 'not an object', '0xc': career() })

      expect(plan.writes.map((w) => w.address).sort()).toEqual(['0xa', '0xc'])
      // The corrupt entry migrates to a zeroed record, which the keep rule prunes.
      expect(plan.pruned).toBe(1)
    })

    it('should salvage the usable fields of a partially corrupt entry', () => {
      const plan = planMigration({
        '0xa': { money: 250, xp: 'broken', kindCounts: { pizza: -5, sock: 3 } },
      })

      expect(plan.writes[0].record.money).toBe(250)
      expect(plan.writes[0].record.xp).toBe(0)
      expect(plan.writes[0].record.kindCounts).toEqual({ sock: 3 })
    })
  })

  describe('when there is nothing to migrate', () => {
    it('should return an empty plan for an empty or shapeless players map', () => {
      for (const junk of [null, undefined, {}, 'nope', 7]) {
        const plan = planMigration(junk)
        expect(plan.writes).toEqual([])
        expect(plan.pruned).toBe(0)
        expect(plan.index.rows).toEqual({})
      }
    })
  })

  describe('when run twice on the same blob', () => {
    it('should produce an identical plan, since it derives rather than accumulates', () => {
      const blob = { '0xa': career(), '0xb': career({ xp: 9 }) }

      expect(planMigration(blob)).toEqual(planMigration(blob))
    })
  })
})
