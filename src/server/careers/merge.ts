// The additive boot-race merge, as a pure function.
//
// Lifted out of playerProgress.applyStoredDoc so it can be unit-tested and so
// the keyed store reuses the SAME rules when hydrating one player. Two copies of
// a 14-rule merge is how a career quietly loses a field.

import { ProgressRecord } from './record'
import { UpgradeId } from '../../shared/progression'

/**
 * Folds a pre-load SESSION stub into the STORED career.
 *
 * BOOT RACE — the bug that erased the owner's career on every republish: a
 * player joining before the read settles (usually the owner, testing) gets a
 * fresh stub, the old skip-if-present merge ignored their real career, and the
 * next save wrote the stub over it. A stub only holds this session's pre-load
 * earnings, so the fix is to ADD them on top. Same shape suits a LATE load:
 * what was earned during an outage stacks onto the restored career.
 *
 * MUTATES AND RETURNS `stored` (caller owns it, fresh from migrateRecord);
 * `session` is never modified.
 *
 * Two fields deliberately NOT merged — the store wins: `flexGear`, because a
 * stub can only have it set by setFlexGear against counts it doesn't have; and
 * `ownerSinceMs`, because the earliest coronation is in the store by definition.
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
