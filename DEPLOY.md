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

At boot each document logs one line. **Both** `[STORE:playerProgress]` and
`[STORE:leaderboard]` must report the external store:

```
[STORE:playerProgress] persistence: external store (jsonbin)
[STORE:playerProgress] loaded on attempt 1
```

That is a healthy deploy. Anything else, read the table below.

| Boot log | Meaning | Do |
| --- | --- | --- |
| `persistence: external store (jsonbin)` + `loaded on attempt N` | Healthy. | Nothing. |
| `*_BIN_* unresolved` **and** an SDK `Failed to fetch environment variable` line just above it | The vars are set, but the EnvVar read failed. Transient. | Nothing — the retry loops now re-ask and the session heals itself. Watch that it does. |
| `*_BIN_* unresolved` with **no** SDK error above it | The vars really are unset for this world. | Set them (§1) and republish. |
| `WARNING: ... half-configured` | One of a pair is set, the other is not. Always a config mistake. | Set both and republish. |
| `WARNING: jsonbin 404 ... treating this document as EMPTY` | The bin has no document. Correct on a brand-new bin; otherwise the `BIN_ID` is wrong or repointed. | If this document should have had data: **stop the world now**, before a save overwrites from an empty base. Fix the id, or restore from the bin's version history. |
| `load attempt N failed` repeating, then `LATE load succeeded` | The store was briefly unreachable and recovered. | Nothing. Progress restored and pushed to everyone connected. |

In-world, the admin panel (wallets in `ADMIN_ADDRESSES`) shows the same state as
a `storage:` line, and any player with a career sees
`⚠ Progress NOT saving — storage issue` whenever the load has definitively
failed. A mis-deployed world announces itself; it does not fail quietly.

## 4. What a bad deploy looks like from a player's seat

Worth knowing, because it is easy to misread as data loss. When the store cannot
be reached, `loadConfirmed` never sets, so **every save is refused**. Players see
empty careers, an empty leaderboard and an empty owners wall. Nothing has been
deleted — the same blocked state that hides the data also prevents overwriting
it. Fix the credentials, republish, and the careers come back.

The one case that *is* real loss is the repointed `BIN_ID` above.

## Related

- `src/server/persistence.ts` — the storage layer, and the incident history in its comments.
- `src/shared/config.ts` — `REQUIRE_EXTERNAL_STORE`, and why the DCL Storage fallback is refused.
- `UPGRADE-SDK.md` — read before changing the SDK pin. The pin carries the multiplayer server runtime.
- `backups/` — point-in-time snapshots, excluded from deploys by `.dclignore`.
