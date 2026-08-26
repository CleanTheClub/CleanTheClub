# Deploying Clean The Club

The scene publishes to a **World** (`cleantheclub.dcl.eth`) and runs an
authoritative server (`authoritativeMultiplayer: true`). Careers and the
leaderboard live in an **external store**, not in DCL Storage — see the header of
`src/server/persistence.ts` for why. That makes four server EnvVars a hard
requirement for a working deploy, and a missing one is the difference between a
live world and a dead one.

Read this before publishing. It exists because the 2026-08-17 incident was a
publish that came up without those vars.

## 1. The four EnvVars

| EnvVar                | Document    | Used by |
| --------------------- | ----------- | ------- |
| `PROGRESS_BIN_ID`     | Careers     | `src/server/playerProgress.ts` |
| `PROGRESS_BIN_KEY`    | Careers     | " |
| `LEADERBOARD_BIN_ID`  | Leaderboard | `src/server/server.ts` |
| `LEADERBOARD_BIN_KEY` | Leaderboard | " |
| `CAREER_INDEX_BIN_ID`  | Board index | keyed mode only — see §5 |
| `CAREER_INDEX_BIN_KEY` | Board index | " |

They are **world-scoped remote state**, held by Decentraland's storage service —
not part of the deploy bundle. Publishing neither sets nor clears them
(`sdk-commands deploy` contains no env or storage code), so in the normal case
they carry over from the previous deploy and there is nothing to do. You only
touch them when setting the world up, rotating credentials, or repointing a bin.

Set them out-of-band with the SDK CLI, from the project directory:

```bash
sdk-commands storage env set PROGRESS_BIN_ID     --value <bin id>
sdk-commands storage env set PROGRESS_BIN_KEY    --value <master key>
sdk-commands storage env set LEADERBOARD_BIN_ID  --value <bin id>
sdk-commands storage env set LEADERBOARD_BIN_KEY --value <master key>
```

Never commit these values. There is no `.env` in this repo and there should not
be one — local preview has no EnvVars by design, and with `DEBUG = false`
careers simply do not persist between local server restarts.

> ⚠️ **Dev and production must NOT share a bin.** `scene.json`'s
> `worldConfiguration.name` flips between `afkj.dcl.eth` (dev) and
> `cleantheclub.dcl.eth` (production), and storage *and* EnvVars are both keyed by
> world name — so each world has its own credentials. If those credentials point
> at the **same** jsonbin bin, a dev playtest holding two test players will
> overwrite production's careers, and the empty-document guard cannot stop it
> because the document is not empty. This is the leading explanation for the
> 2026-08-17 incident. Verify with the digest comparison below; the shrink guard
> now refuses such a write, but separate bins is the actual fix.
>
> Note `afkj.dcl.eth` is also **shared with another project** — it holds `plants`
> and `leaderboardResetAt` keys this scene has never written. Its storage
> namespace is not ours alone.

> ⚠️ **`*_BIN_ID` is the one field that can destroy data.** Pointing it at a
> different or empty bin makes the server read a 404, treat the document as
> legitimately empty, and then write the session's records over the top as the
> whole document. The wipe guards cannot catch this — they protect a backend from
> empty overwrites, not from being aimed at the wrong backend. Recovery is the
> old bin's version history, nothing else.

## 2. Publish

```bash
npm install          # the tree must actually be installed
npm run typecheck
npm run deploy
```

`predeploy` prints a reminder pointing back here.

## 3. Verify — do not skip this

```bash
npm run server-logs
```

> ⚠️ **Only wallets listed in `scene.json` `logsPermissions` can read these.**
> It currently holds one address. If you cannot fetch logs, that is why — add
> your wallet there and republish.

A healthy boot logs three lines per document, and **both**
`[STORE:playerProgress]` and `[STORE:leaderboard]` must appear:

```
[SERVER] realm: cleantheclub.dcl.eth (preview=false, baseUrl=…) — storage and EnvVars are scoped to this name
[STORE:playerProgress] load starting — up to 30s, 10s per attempt
[STORE:playerProgress] persistence: external store (jsonbin)
[STORE:playerProgress] loaded on attempt 1 (34KB)
```

Check the `realm:` line first, every time. Storage, player storage and EnvVars are
all keyed by that name, so a server running as the dev world reads a different
bucket with different credentials — and every storage mystery in this scene's
history would have been shorter if this line had existed.

`load starting` matters on its own: without it, no `[STORE:]` output at all
would be ambiguous between "storage was never reached" and "the server never got
this far". If you see `load starting` and nothing after it, storage is the
problem. If you see nothing at all, the scene is.

Failures go to **stderr** (`console.error`) and routine progress to stdout, so
you can filter rather than only grep.

Anything other than the three lines above, read the table below.

| Boot log | Meaning | Do |
| --- | --- | --- |
| `persistence: external store (jsonbin)` + `loaded on attempt N` | Healthy. | Nothing. |
| `*_BIN_* unresolved` **and** an SDK `Failed to fetch environment variable` line just above it | The vars are set, but the EnvVar read failed. Transient. | Nothing — the retry loops now re-ask and the session heals itself. Watch that it does. |
| `*_BIN_* unresolved` with **no** SDK error above it | The vars really are unset for this world. | Set them (§1) and republish. |
| `WARNING: ... half-configured` | One of a pair is set, the other is not. Always a config mistake. | Set both and republish. |
| `WARNING: jsonbin 404 ... treating this document as EMPTY` | The bin has no document. Correct on a brand-new bin; otherwise the `BIN_ID` is wrong or repointed. | If this document should have had data: **stop the world now**, before a save overwrites from an empty base. Fix the id, or restore from the bin's version history. |
| `load attempt N failed` repeating, then `LATE load succeeded` | The store was briefly unreachable and recovered. | Nothing. Progress restored, and the admin line plus every career bar refresh. |
| `read timed out` / `write timed out` | The store accepted the connection and never answered. Bounded per attempt, so it fails instead of wedging. | Nothing if it recovers; if it repeats, the store is unhealthy. |
| `WARNING: document SHRANK from NKB to MKB` | The payload is much smaller than it was read, but the record count is fine. | Check: same players, less data per player, means a truncated read. |
| `REFUSING SAVE — record count would fall from N to M` | The shrink guard fired. **Nothing was overwritten.** | Check the boot `realm:` line first — a dev world writing into production's bin looks exactly like this. Then check the `*_BIN_ID`. |
| `realm: <name> (preview=…, baseUrl=…)` | Which world's storage and EnvVars this server is using. | Confirm it is the world you meant. Storage keys on this name. |
| `[LB] save FAILED` | The leaderboard write failed. The in-memory board is fine and the next shift end rewrites it. | Nothing unless it repeats. |

In-world, the admin panel (wallets in `ADMIN_ADDRESSES`) shows a `storage:` line
for careers, plus a `board:` line that appears **only** when the leaderboard
needs attention. Any player with a career sees
`⚠ Progress NOT saving — storage issue` whenever the load has definitively
failed. All three refresh on join, after every shift-end save, and on a
background recovery — so an indicator going green is as visible as one going
red. A mis-deployed world announces itself; it does not fail quietly.

## 4. What a bad deploy looks like from a player's seat

Worth knowing, because it is easy to misread as data loss. When the store cannot
be reached, `loadConfirmed` never sets, so **every save is refused**. Players see
empty careers, an empty leaderboard and an empty owners wall. Nothing has been
deleted — the same blocked state that hides the data also prevents overwriting
it. Fix the credentials, republish, and the careers come back.

The one case that *is* real loss is the repointed `BIN_ID` above.

## 5. Career storage shape

`CAREER_STORAGE_MODE` in `src/shared/config.ts` picks how careers are stored.
**It ships as `'blob'` and you should not flip it until §6 passes.**

| | `'blob'` (current) | `'keyed'` |
| --- | --- | --- |
| Layout | one document, every career | one DCL-storage key per wallet + a small board index |
| A save writes | every career ever earned | only the players who changed |
| Grows with | players **×** item variety per player | players (index only, 7 fixed scalars each) |
| Backend | jsonbin or DCL Storage | DCL Storage only |

The blob grows on two axes because `kindCounts` is sparse and unbounded — a
veteran who has touched thirty item kinds carries thirty keys, and every save
rewrites all of it for everyone. Keyed mode moves those fields into the player's
own record, so the shared document holds only what the leaderboards read.

Why the boards need an index at all: `Storage.player.getValues(address, …)` only
ever lists **one** address's keys. There is no way to enumerate players, and four
of the five board categories plus the CLUB OWNERS wall are global top-N queries
over every career ever earned. The index is that roster.

> ⚠️ **The index is not a cache and must never be pruned.** `Storage.get` returns
> `null` for a 404 *and* for 429/5xx/transport failures — "no career" and "storage
> is refusing us" are indistinguishable. The index breaks the tie: if it lists an
> address, a `null` read is provably a failure, so that player is marked
> **blocked** and their saves are refused rather than overwriting a real career
> with an empty record. Drop a row and that player reads as brand new.

## 6. Before flipping to `'keyed'`

Keyed mode requires DCL `Storage`, which is the backend this scene abandoned in
June — `persistence.ts` records it behaving as if scoped per **deploy** rather
than per location on a World, and that observation is still marked UNRESOLVED.
Nothing in the SDK or CLI corroborates it (the only scope identifier that crosses
the wire is world name plus base parcel), but nothing refutes it either.

Settle it first, on a throwaway world, not this one:

```bash
# 1. Deploy, then write a value
sdk-commands storage set probe --value "$(date +%s)"
# 2. Redeploy the same world, unchanged
npm run deploy
# 3. Read it back
sdk-commands storage get probe
```

If step 3 returns the value from step 1, scene storage survives redeploys and
keyed mode is safe to trial. If it comes back empty, the June observation still
holds, **keyed mode would lose every career on the next publish**, and the right
move is to take the reproduction to Foundation rather than flip the flag.

Keyed mode also needs **two more EnvVars**, because the board index lives in its
own bin. This is not optional: on the jsonbin path the bin is chosen by the
EnvVar prefix alone, so sharing `PROGRESS` would make the index overwrite the
legacy blob and destroy the rollback.

```bash
sdk-commands storage env set CAREER_INDEX_BIN_ID  --value <a NEW, empty bin id>
sdk-commands storage env set CAREER_INDEX_BIN_KEY --value <master key>
```

Once that is set and §6's probe passes: flip the flag, deploy, and watch the boot
log.

```
[PROGRESS] board index is empty — looking for a legacy blob to migrate
[PROGRESS] MIGRATING 209 career(s) to per-player storage — the legacy blob is left untouched
[PROGRESS] MIGRATION COMPLETE — 209 career(s) now per-player. Verify the boards, then keep the blob as a rollback point.
```

The migration runs once, writes per-player records **before** the index, and
**never touches the legacy blob**. That makes it resumable (a partial run is a
valid state — the index lists exactly what landed, and the next boot re-derives
the rest) and reversible while you verify. Two log lines mean stop and read:

| Boot log | Meaning |
| --- | --- |
| `migration ABORTED — the legacy blob would not read` | An empty index could not be trusted to mean "nothing to migrate". Nothing was written. Fix the store and reboot. |
| `career read BLOCKED for 0x… ` | The roster vouches for a career that would not read. That player's saves are refused — deliberately. Nothing is overwritten; it retries each checkpoint. |

Then check the boards actually still show offline veterans (TOP EARNERS, HIGHEST
RANK, MOST SHIFTS and the owners wall are the ones that depend on the index), and
the admin `storage:` line. A reverted flip finds the blob exactly as it was — but
progress earned *after* the cutover lives only in the per-player records and does
not flow back, so verify before, not after.

## Related

- `src/server/persistence.ts` — the document layer, and the incident history in its comments.
- `src/server/careers/boardIndex.ts` — why per-player storage needs a roster. Read before touching keyed mode.
- `src/shared/config.ts` — `REQUIRE_EXTERNAL_STORE` and `CAREER_STORAGE_MODE`.
- `npm test` — unit tests for the career merge, migration, record coercion and index projection.
- `UPGRADE-SDK.md` — read before changing the SDK pin. The pin carries the multiplayer server runtime.
- `backups/` — point-in-time snapshots, excluded from deploys by `.dclignore`.
