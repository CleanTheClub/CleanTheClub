// Per-player career records in address-keyed DCL storage.
//
// One key per wallet: `Storage.player.get(address, 'career')`. This is the shape
// the growing single blob wanted to be — a save writes ONE player's record
// instead of rewriting every career ever earned, and the unbounded fields
// (kindCounts, upgrades) stop inflating a document that everyone shares.
//
// Read boardIndex.ts first. The two hazards it documents — no cross-player
// enumeration, and a failed read being indistinguishable from an absent one —
// are what shape every signature here.
//
// ADDRESS NORMALISATION IS NOT OPTIONAL. The SDK lowercases the address only for
// its internal cache key; the URL it builds uses the caller's casing verbatim
// (@dcl/sdk/src/server/storage/player.ts). So `0xAbC` and `0xabc` share one cache
// entry while hitting two different paths — which in preview really is two
// separate buckets. Every function here lowercases before touching the SDK, and
// callers should too.

import { Storage } from '@dcl/sdk/server'
import { ProgressRecord, migrateRecord } from './record'

/** The per-player key holding the career record. */
const CAREER_KEY = 'career'

/**
 * What a hydration read actually established.
 *
 * The three-way split is the whole point. `Storage.player.get` collapses "no
 * such key" and "storage said no" into a single `null`, and acting on that
 * ambiguity is how per-player storage eats careers: read null, assume a new
 * player, write an empty record over a real one. Only the caller's roster (the
 * board index) can break the tie, so it passes `knownToExist` in and gets an
 * unambiguous outcome back.
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
 * Reads one player's career.
 *
 * @param address      wallet address, any casing
 * @param knownToExist true when the board index holds a row for this address,
 *                     i.e. a career provably exists. This is the ONLY thing
 *                     that can distinguish a real absence from a failed read.
 */
export async function readCareer(address: string, knownToExist: boolean): Promise<CareerRead> {
  const addr = address.toLowerCase()
  try {
    // `fresh` skips the 60s read cache for the one read whose correctness
    // matters most. It still coalesces with any in-flight GET for the same key,
    // so a burst of joins is a single request either way.
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
    // assertIsServer throws when isServer() has not resolved yet (it is an atom
    // initialised false and filled by an async RPC), and realm resolution throws
    // on a bad getRealm. Both are transient and must never read as 'absent'.
    return { outcome: 'failed', reason: `read threw: ${e}` }
  }
}

/**
 * Writes one player's career. Returns false on any failure so the caller keeps
 * its dirty flag and retries at the next checkpoint.
 *
 * Two SDK behaviours worth knowing, neither of which needs handling here:
 *  - `set` may return true WITHOUT a network write when the value is byte-identical
 *    to what it last confirmed (`skipIfUnchanged` defaults true). That is the
 *    desired outcome, not a problem — an unchanged record needs no request.
 *  - `set` returning false discards the HTTP status, so 404/413/429/500 are
 *    indistinguishable, and a failed write may in fact have been applied. So a
 *    false is "unknown, retry", never "definitely not written".
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
