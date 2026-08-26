// Per-player career records in address-keyed DCL storage.
//
// One key per wallet: `Storage.player.get(address, 'career')`. A save writes ONE
// player instead of rewriting every career, and the unbounded fields stop
// inflating a document everyone shares.
//
// Read boardIndex.ts first — the two hazards it documents (no cross-player
// enumeration, and a failed read looking absent) shape every signature here.
//
// ADDRESS NORMALISATION IS NOT OPTIONAL. The SDK lowercases the address only for
// its internal cache key; the URL uses the caller's casing verbatim. So `0xAbC`
// and `0xabc` share a cache entry while hitting two paths — two separate buckets
// in preview. Everything here lowercases first, and callers should too.

import { Storage } from '@dcl/sdk/server'
import { ProgressRecord, migrateRecord } from './record'

/** The per-player key holding the career record. */
const CAREER_KEY = 'career'

/**
 * What a hydration read established.
 *
 * The three-way split is the point. `Storage.player.get` collapses "no such key"
 * and "storage said no" into one `null`, and acting on that ambiguity is how
 * per-player storage eats careers. Only the caller's roster can break the tie,
 * so it passes `knownToExist` in and gets an unambiguous outcome back.
 */
export type CareerRead =
  /** A record came back and was migrated to the current schema. */
  | { outcome: 'found'; record: ProgressRecord }
  /** Provably no stored career: the read completed AND the roster agrees. */
  | { outcome: 'absent' }
  /** The roster says this player has a career but the read did not return it.
   *  Treat as unknown: never create, never overwrite, retry later. */
  | { outcome: 'failed'; reason: string }

/**
 * @param address      wallet address, any casing
 * @param knownToExist the board index holds a row for it, so a career provably
 *                     exists — the only way to tell absence from a failed read.
 */
export async function readCareer(address: string, knownToExist: boolean): Promise<CareerRead> {
  const addr = address.toLowerCase()
  try {
    // Skips the 60s read cache for the one read whose correctness matters most.
    // Still coalesces with in-flight GETs, so a join burst is one request.
    const raw = await Storage.player.get<unknown>(addr, CAREER_KEY, { fresh: true })
    if (raw !== null && raw !== undefined) {
      return { outcome: 'found', record: migrateRecord(raw) }
    }
    if (knownToExist) {
      return {
        outcome: 'failed',
        reason: 'index holds a row for this address but the record read came back empty',
      }
    }
    return { outcome: 'absent' }
  } catch (e) {
    // assertIsServer throws before isServer() resolves, and realm resolution
    // throws on a bad getRealm. Both transient — never read them as 'absent'.
    return { outcome: 'failed', reason: `read threw: ${e}` }
  }
}

/**
 * Writes one player's career. False on any failure, so the caller keeps its dirty
 * flag and retries at the next checkpoint.
 *
 * Two SDK behaviours, neither needing handling here: `set` may return true
 * WITHOUT writing when the value is unchanged (`skipIfUnchanged` defaults true),
 * which is desirable; and a false discards the HTTP status and may in fact have
 * been applied, so it means "unknown, retry", never "not written".
 */
export async function writeCareer(address: string, record: ProgressRecord): Promise<boolean> {
  const addr = address.toLowerCase()
  try {
    return await Storage.player.set(addr, CAREER_KEY, record)
  } catch (e) {
    console.log(`[CAREERS] write threw for ${addr}:`, e)
    return false
  }
}
