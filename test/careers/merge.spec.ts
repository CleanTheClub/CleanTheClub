import { describe, it, expect } from 'vitest'
import { mergeSessionIntoStored } from '../../src/server/careers/merge'
import { emptyRecord, ProgressRecord } from '../../src/server/careers/record'

// The boot-race merge decides what happens when a player's stored career lands
// AFTER they have already started earning this session. Getting a rule wrong here
// either double-counts money or silently drops a field, and both look like a
// storage bug rather than a merge bug. Each rule gets its own case.

const rec = (over: Partial<ProgressRecord> = {}): ProgressRecord => ({ ...emptyRecord(), ...over })

describe('mergeSessionIntoStored', () => {
  describe('when the session earned headline progress before the career landed', () => {
    it('should add money, xp, shifts and lifetimeItems onto the stored career', () => {
      const stored  = rec({ money: 100, xp: 500, shifts: 4, lifetimeItems: 60 })
      const session = rec({ money: 25,  xp: 30,  shifts: 1, lifetimeItems: 12 })

      const merged = mergeSessionIntoStored(stored, session)

      expect(merged.money).toBe(125)
      expect(merged.xp).toBe(530)
      expect(merged.shifts).toBe(5)
      expect(merged.lifetimeItems).toBe(72)
    })

    it('should not mutate the session record', () => {
      const session = rec({ money: 25, kindCounts: { pizza: 3 } })

      mergeSessionIntoStored(rec({ money: 100, kindCounts: { pizza: 10 } }), session)

      expect(session.money).toBe(25)
      expect(session.kindCounts.pizza).toBe(3)
    })
  })

  describe('when both sides have a personal best', () => {
    it('should keep the higher bestItems rather than adding them', () => {
      expect(mergeSessionIntoStored(rec({ bestItems: 40 }), rec({ bestItems: 55 })).bestItems).toBe(55)
      expect(mergeSessionIntoStored(rec({ bestItems: 70 }), rec({ bestItems: 55 })).bestItems).toBe(70)
    })
  })

  describe('when both sides hold upgrade levels', () => {
    it('should take the higher level per upgrade, never the sum', () => {
      const stored  = rec({ upgrades: { mop: 3, cart: 1 } as any })
      const session = rec({ upgrades: { mop: 1, vacuum: 2 } as any })

      const merged = mergeSessionIntoStored(stored, session) as any

      expect(merged.upgrades.mop).toBe(3)
      expect(merged.upgrades.cart).toBe(1)
      expect(merged.upgrades.vacuum).toBe(2)
    })
  })

  describe('when kind tallies exist on both sides', () => {
    it('should add them per key, so achievement counters are not undercounted', () => {
      const stored  = rec({ kindCounts: { pizza: 100, wineglass: 5 } })
      const session = rec({ kindCounts: { pizza: 7, deposit: 2 } })

      const merged = mergeSessionIntoStored(stored, session)

      expect(merged.kindCounts).toEqual({ pizza: 107, wineglass: 5, deposit: 2 })
    })
  })

  describe('when the daily counter is involved', () => {
    it('and both sides are on the same day, should sum the counts', () => {
      const merged = mergeSessionIntoStored(
        rec({ dailyDay: '2026-08-26', dailyItems: 30 }),
        rec({ dailyDay: '2026-08-26', dailyItems: 12 }),
      )

      expect(merged.dailyDay).toBe('2026-08-26')
      expect(merged.dailyItems).toBe(42)
    })

    it('and the session is on a strictly newer day, should replace both fields', () => {
      const merged = mergeSessionIntoStored(
        rec({ dailyDay: '2026-08-25', dailyItems: 30 }),
        rec({ dailyDay: '2026-08-26', dailyItems: 12 }),
      )

      expect(merged.dailyDay).toBe('2026-08-26')
      expect(merged.dailyItems).toBe(12)
    })

    it('and the stored day is newer, should keep the stored day untouched', () => {
      const merged = mergeSessionIntoStored(
        rec({ dailyDay: '2026-08-26', dailyItems: 30 }),
        rec({ dailyDay: '2026-08-25', dailyItems: 12 }),
      )

      expect(merged.dailyDay).toBe('2026-08-26')
      expect(merged.dailyItems).toBe(30)
    })

    it('and the session has no day at all, should leave the stored counter alone', () => {
      const merged = mergeSessionIntoStored(
        rec({ dailyDay: '2026-08-26', dailyItems: 30 }),
        rec({ dailyDay: '', dailyItems: 0 }),
      )

      expect(merged.dailyDay).toBe('2026-08-26')
      expect(merged.dailyItems).toBe(30)
    })
  })

  describe('when the work streak is involved', () => {
    it('and the session worked on the same or a later day, should take the higher streak', () => {
      const merged = mergeSessionIntoStored(
        rec({ lastWorkDay: '2026-08-25', workStreak: 4 }),
        rec({ lastWorkDay: '2026-08-26', workStreak: 5 }),
      )

      expect(merged.lastWorkDay).toBe('2026-08-26')
      expect(merged.workStreak).toBe(5)
    })

    it('and the session never completed a shift, should keep the stored streak', () => {
      const merged = mergeSessionIntoStored(
        rec({ lastWorkDay: '2026-08-25', workStreak: 4 }),
        rec({ lastWorkDay: '', workStreak: 0 }),
      )

      expect(merged.lastWorkDay).toBe('2026-08-25')
      expect(merged.workStreak).toBe(4)
    })
  })

  describe('when the display name differs', () => {
    it('should prefer the session name, which is the one the explorer just reported', () => {
      expect(mergeSessionIntoStored(rec({ displayName: 'Old' }), rec({ displayName: 'New' })).displayName)
        .toBe('New')
    })

    it('should keep the stored name when the session has none', () => {
      expect(mergeSessionIntoStored(rec({ displayName: 'Old' }), rec({ displayName: '' })).displayName)
        .toBe('Old')
    })
  })

  describe('when a field is owned by the store', () => {
    it('should not let a session stub overwrite flexGear', () => {
      // A stub starts at '' and can only be set by setFlexGear, which checks the
      // achievement against counts the stub does not have.
      expect(mergeSessionIntoStored(rec({ flexGear: 'gold_dustpan' }), rec({ flexGear: '' })).flexGear)
        .toBe('gold_dustpan')
    })

    it('should not let a session stub overwrite ownerSinceMs', () => {
      // The earliest coronation is in the store by definition — it orders the
      // CLUB OWNERS wall.
      expect(mergeSessionIntoStored(rec({ ownerSinceMs: 1_700_000_000_000 }), rec({ ownerSinceMs: 0 })).ownerSinceMs)
        .toBe(1_700_000_000_000)
    })
  })

  describe('when the session stub is completely empty (the common case)', () => {
    it('should leave the stored career exactly as it was', () => {
      const stored = rec({
        money: 900, xp: 18_500, shifts: 40, lifetimeItems: 1200, bestItems: 88,
        displayName: 'Veteran', lastWorkDay: '2026-08-20', workStreak: 3,
        dailyItems: 14, dailyDay: '2026-08-20', kindCounts: { pizza: 400 },
        flexGear: 'gold_platter', ownerSinceMs: 1_600_000_000_000,
        upgrades: { mop: 3 } as any,
      })
      const before = JSON.parse(JSON.stringify(stored))

      expect(mergeSessionIntoStored(stored, emptyRecord())).toEqual(before)
    })
  })
})
