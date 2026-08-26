// The additive boot-race merge, as a pure function.
//
// Lifted verbatim out of playerProgress.applyStoredDoc so it can be unit-tested
// (test/careers/merge.spec.ts) and so the keyed store can reuse the SAME rules
// when it hydrates one player at a time. Two callers with two copies of a
// 14-rule merge is how a career quietly loses a field.
//
// IMPORT-FREE apart from the type-only record module.

import { ProgressRecord } from './record'
import { UpgradeId } from '../../shared/progression'

/**
 * Folds a pre-load SESSION stub into the STORED career and returns the result.
 *
 * BOOT RACE — the bug that erased the owner's career on every republish: a
 * player who joins before the read settles (after a republish, that is almost
 * always the OWNER testing) gets a fresh stub record; the old skip-if-present
 * merge then ignored their real career, and the next shift-end save wrote the
 * stub over it in the store. The stub only ever holds THIS session's pre-load
 * earnings (records are only created via emptyRecord), so the fix is to ADD
 * those few minutes on top of the restored career — nobody loses either side
 * of the race.
 *
 * The same shape is right for a LATE load (the store recovering mid-session):
 * what was earned during the outage stacks on top of the restored career.
 *
 * MUTATES AND RETURNS `stored`. The caller owns `stored` (it comes fresh out of
 * migrateRecord), so mutating it in place avoids a second copy; `session` is
 * never modified.
 *
 * Two fields are deliberately NOT merged — the stored value wins outright:
 *   flexGear      a session stub starts at '' and can only have been set by
 *                 setFlexGear, which re-checks the achievement against counts
 *                 the stub does not have.
 *   ownerSinceMs  the earliest coronation is in the store by definition.
 */
export function mergeSessionIntoStored(
  stored: ProgressRecord,
  session: ProgressRecord,
): ProgressRecord {
  stored.money         += session.money
  stored.xp            += session.xp
  stored.shifts        += session.shifts
  stored.lifetimeItems += session.lifetimeItems
  stored.bestItems      = Math.max(stored.bestItems, session.bestItems)

  for (const [id, lvl] of Object.entries(session.upgrades)) {
    const u = id as UpgradeId
    stored.upgrades[u] = Math.max(stored.upgrades[u] ?? 0, lvl ?? 0)
  }

  if (session.displayName) stored.displayName = session.displayName

  // Pre-load kind tallies are additive, same as the headline numbers —
  // dropping them undercounted the achievement counters by whatever the
  // player touched before the read settled.
  for (const [k, cnt] of Object.entries(session.kindCounts)) {
    stored.kindCounts[k] = (stored.kindCounts[k] ?? 0) + cnt
  }

  // Daily fields: SAME day sums (both sides earned today), a strictly
  // newer session day replaces. The old >=-replace dropped the stored
  // day's count whenever the race happened on the same UTC day —
  // which is when it always happens.
  if (session.dailyDay === stored.dailyDay && session.dailyDay !== '') {
    stored.dailyItems += session.dailyItems
  } else if (session.dailyDay > stored.dailyDay) {
    stored.dailyItems = session.dailyItems
    stored.dailyDay   = session.dailyDay
  }

  if (session.lastWorkDay >= stored.lastWorkDay && session.lastWorkDay !== '') {
    stored.lastWorkDay = session.lastWorkDay
    stored.workStreak  = Math.max(stored.workStreak, session.workStreak)
  }

  return stored
}
