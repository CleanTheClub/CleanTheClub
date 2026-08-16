// Set to true for fast timers during local testing
export const DEBUG = false

// V2: every round runs the SAME duration (per the GDD — the old shrinking table
// 3:00→1:00 was a V1 finale-pressure mechanic that no longer fits the endless
// loop). Difficulty comes from respawn scaling, not a shrinking clock. Single
// entry: getRoundDurationMs clamps to the last index, so all rounds read it.
const _ROUND_DURATIONS_MS  = [2.5 * 60_000]
const _DEBUG_DURATIONS_MS  = [30_000]
export const ROUND_DURATIONS_MS = DEBUG ? _DEBUG_DURATIONS_MS : _ROUND_DURATIONS_MS

// Every Nth round is a MILESTONE (longer celebration hold). Explicit — it used
// to be derived from the duration table's length, which broke the moment the
// table stopped having five entries.
export const MILESTONE_EVERY = 5

export const OPEN_DISPLAY_MS    = DEBUG ? 20_000 : 20_000   // normal intermission window
// Longer celebration hold after every MILESTONE round (each 5th). V2 loops
// forever, so this is a recurring payoff beat, not a game-over — 90s per cycle
// dragged ("round 5 big celebration doesn't match our V2 path"); 30s lets the
// crowd + confetti + music land and then gets everyone back to work.
export const FINALE_DISPLAY_MS  = DEBUG ? 30_000 : 30_000   // milestone celebration window
export const CLUTTER_RESPAWN_MS = DEBUG ? 10_000 : 120_000  // base respawn (was 90s — eased)
export const FAST_RESPAWN_MS    = DEBUG ? 5_000  : 60_000   // fast respawn (was 45s — eased)

// Respawn speed scales up with player count so the mess volume stays
// challenging regardless of group size.  Index = (playerCount − 1), clamped
// to the last entry for any count beyond the array length.
//
// factor > 1 → items respawn faster  (scaledMs = baseMs / factor)
// factor < 1 → items respawn slower  (easier)
//
// Second eased pass (mobile playtest: "too hard with 1 person") — solo and duo
// now get substantially more breathing room; larger groups barely change.
//  1 player  → 0.50× (240 s / 120 s — solo breathing room)
//  2 players → 0.95× (126 s /  63 s)
//  3 players → 1.30× ( 92 s /  46 s)
//  4 players → 1.60× ( 75 s /  38 s)
//  5+ players → 1.80× ( 67 s /  33 s)
export const RESPAWN_SCALE_FACTORS = [0.50, 0.95, 1.30, 1.60, 1.80]

// ── Demand scaling — the boss expects less of a skeleton crew ────────────────
// Respawn scaling softens how fast mess FIGHTS BACK, but the pass bar was still
// cleaned/total-items: a solo cleaner was asked to cover the same club as a
// full crew in the same 150s. Field-verified too hard. So the server scales the
// DEMANDED total by headcount before syncing GameState: the club is unchanged,
// but "100%" means "what this many cleaners can reasonably do". Every display
// (HUD bar, grunge, narration) and every consequence (grade, wages) derives
// from the same synced counts, so this one factor tunes the whole game.
//  1 player  → 0.65×  (pass at 50% standard = ~33% of the club's items)
//  2 players → 0.85×  (pass = ~43% of items)
//  3+        → 1.00×  (unchanged)
export const DEMAND_FACTORS = [0.65, 0.85, 1.0]

// ── Crew power scaling ────────────────────────────────────────────────────────
// Upgrades grow player throughput, but supply and demand only scaled with
// HEADCOUNT — so veterans finished early and idled ("as players progress, the
// rounds get easier"). Both knobs now also scale with the crew's AVERAGE total
// upgrade levels (0..18 across the five upgrades):
//   respawns: delay ÷ (1 + level × RESPAWN_POWER_PER_LEVEL) — a maxed solo
//     player (~18 levels) gets ~2× respawn pace, i.e. roughly two-rookie flow.
//   demand:  × (1 + level × DEMAND_POWER_PER_LEVEL), capped at the item pool —
//     deliberately HALF the respawn slope, so upgrades always make cleaning
//     faster than they make passing harder.
export const RESPAWN_POWER_PER_LEVEL = 0.06
export const DEMAND_POWER_PER_LEVEL  = 0.03

// ── Closing window — let the club actually finish clean ───────────────────────
// Playtest feedback: "when you finally finish cleaning a floor they respawn and the
// game seems endless... the total percentage completed is difficult to guess until
// the end." The problem isn't respawn SPEED, it's that the club can never visibly
// REACH clean, so a shift has no felt conclusion and the cleanliness bar just
// jitters instead of climbing.
//
// For the last stretch of every round, no new mess is scheduled. The bar then
// converges honestly on the final score, players can see themselves finishing, and
// the celebration lands on a club that is actually clean rather than one that
// re-dirtied a second before the doors opened.
//
// Scaled as a FRACTION of the round rather than a fixed duration, so it stays
// proportionate as rounds get shorter (3 min down to 1 min, and shorter still if
// the duration table is ever extended).
export const RESPAWN_CUTOFF_FRACTION = 0.25   // final 25% of a round spawns nothing
export const HOLD_DURATION_MS   = DEBUG ? 500    : 2_500   // hold-to-clean duration (lined up with mop emote)
export const PICKUP_EMOTE_MS    = 1_500                    // match PickUp_Anim_emote.glb clip length
// The mopping emote now fires immediately on hold-start (no step delay — the player
// is already on the patch), so it runs for the FULL hold duration and stops exactly
// as the bar completes and the patch poofs. Keep MOPPING_EMOTE_MS == HOLD_DURATION_MS.
export const MOPPING_EMOTE_MS   = 2_000                    // = HOLD_DURATION_MS (fires at t=0)
export const PICKUP_TOUCH_MS   = 800                       // ms from click → hand touches item (tune to match anim)

// Restoration meter thresholds
export const TRANSFORM_DIM    = 0.3
export const TRANSFORM_MID    = 0.6
export const TRANSFORM_BRIGHT = 0.8

// Outcome thresholds (evaluated when time expires)
export const OUTCOME_OPTIMAL  = 0.8
export const OUTCOME_ADEQUATE = 0.5

// ── Themed rounds ─────────────────────────────────────────────────────────────
// Playtest: "many object types appear together — players switch constantly
// between actions without mastering any one of them". A themed round narrows
// the MIX (excluded categories start the round pre-cleaned, i.e. absent) and
// biases the contract roll toward the night's story. The SERVER rolls the theme
// and ships it in GameState; clients only present it.
//
// categories: item categories present in the round; null = the full mix.
// contractKinds: contract pool for the round (server ContractKind names);
//                null = any contract.

export type ThemeId = '' | 'pizzaParty' | 'cocktailNight' | 'movieNight' | 'henStagDo' | 'walkout'
  | 'lostProperty' | 'paparazzi' | 'breakage' | 'springCleaning'
export type ItemCategory = 'general' | 'recycle' | 'glasses' | 'sticky' | 'reset'

// Extra themed mess, scattered at random each themed round. The server samples
// `countMin..countMax` anchors from the positions of the authored scene items
// (every one a spot already validated by having something placed there), adds a
// small jitter + random yaw, and assigns a random model from `models`. Model
// names resolve to assets/scene/Models/<name>/<name>.glb; their recycling
// stream comes from classifyRubbish on the model name, same as scene rubbish.
export type ThemeSpawnCfg = { models: string[]; countMin: number; countMax: number }

export type RoundThemeDef = {
  id: Exclude<ThemeId, ''>
  title: string
  blurb: string
  categories: ItemCategory[] | null
  contractKinds: string[] | null
  spawns?: ThemeSpawnCfg
  /**
   * Name filter for BASE scene rubbish, on top of `categories`: when set, a
   * rubbish item stays in the round only if its scene Name contains one of
   * these fragments (lowercase). Playtest: category masking alone left ties at
   * the pizza party — "general" covers both pizza slices and underwear.
   * Other categories (sticky, glasses, resets) are unaffected.
   */
  keepRubbishNames?: string[]
}

// Server-owned spawn slots for themed extras — pre-created at boot so the sync
// enumIds stay stable. Must be ≥ every theme's countMax.
export const THEME_SLOT_PREFIX = 'theme_'
export const THEME_SLOT_COUNT  = 30
export const themeModelSrc = (model: string): string => `assets/scene/Models/${model}/${model}.glb`

// ── Spawn size classes ────────────────────────────────────────────────────────
// Anchors inherited from glassware sit in TIGHT spots (bar shelves, table
// clusters); only physically small models fit there without clipping. All other
// anchors (floors, seats) are OPEN and take anything. Playtest: "items are
// different shapes and sizes and some spawn areas are tighter than others".
// An anchor is tight when its source item's scene Name contains one of these:
export const TIGHT_ANCHOR_PARTS = ['glass', 'bottle', 'drink', 'wine']
// Models small enough for a tight spot; everything else is open-anchor only:
export const THEME_SMALL_MODELS = new Set([
  'drink', 'brokenBottle', 'polaroidA', 'polaroidB', 'polaroidC', 'polaroidD', 'polaroidE',
  'tie', 'sock', 'sockB', 'phone', 'keys', 'camera',
  'brokenGlass', 'reallyBrokenGlass', 'glassesBroken',
])


// ── Closing-time frenzy ───────────────────────────────────────────────────────
// Final seconds of a round: each clean counts DOUBLE toward the spree combo.
// Shared by spreeSystem (the scoring) and ui.tsx (the pill under the timer) —
// lives here because those two import in opposite directions and a shared
// constant in either would cycle.
export const FRENZY_LAST_S = 20

// ── Rhythm Pop (popcorn) ──────────────────────────────────────────────────────
// Clicking ANY popcorn — scene-placed or theme-spawned, one rule per item type —
// starts a 3-beat circular rhythm: a ring shrinks onto a POP! disc each beat,
// tap as it lands (desktop: click anywhere; mobile: the POP! button). Hits are
// bonus mastery (3/3 = PERFECT + streak); the popcorn cleans when the beats end
// no matter what — the minigame can slow you down, never lock you out.
export const POP_NAME_PART   = 'popcorn'
export const POP_BEATS       = 3
export const POP_BEAT_MS     = 700
// Tap counts as a HIT in the last 35% of the ring's fall (~245ms at 700ms
// beats). MUST equal the moment the disc/ring turn gold in ui.tsx — playtest:
// with the visual cue on a different threshold than the judgement, players
// couldn't tell why they hit or missed. The gold IS the window.
export const POP_HIT_T       = 0.65
export const POP_FIRST_GRACE_MS = 150 // the click that STARTED the rhythm can't judge beat 1

// ── Dumpster haul loop ────────────────────────────────────────────────────────
// Bins have a per-STREAM capacity per round (deposits don't identify stations —
// bins are interchangeable, so "the general bins are full" is club-wide state).
// A full stream refuses deposits until someone with EMPTY hands clicks a bin,
// shoulders the big bag, and hauls it to a dumpster outside the club. The
// hauler is paid on the shift payout.
// 18 (was 30 — too high vs the ~40-item stream census: one late haul at best).
// Now the first haul lands mid-round; themed nights with extras get two.
// Capacity of ONE bin. The club has 4 general + 4 recycling bins across 4
// stations and each fills independently, so a full bin is a routing decision
// ("next station") or an invitation to haul it — never a hard stop. TUNE HERE:
// lower = more hauling and more walking between stations.
export const BIN_CAPACITY = 12
export const HAUL_BONUS          = 15
export const DUMPSTER_PREFIX     = 'Dumpster'
// Bins start stinking at this fill fraction; the stink RATE then ramps with
// fill (a faint waft at a third full, a plume at overflow) and the bin models
// breathe-pulse harder as they fill — the bins themselves are the fill gauge.
export const BIN_STINK_FRACTION  = 0.3

// ── Disaster spots ────────────────────────────────────────────────────────────
// The "boss mess": one big multi-stage clean per round (sometimes). Three verbs
// in sequence at one spot — sweep the pile (3 quick clicks), mop the stain
// under it (the existing hold + skill check), then a fast polish pass — with a
// cash bonus on the finale. Rare by design: the week-2 feedback said too many
// PARALLEL activity types overwhelms, so depth arrives as one special moment,
// not another scattered category.
export const DISASTER_PREFIX = 'dis_'
// Logical stage items of disaster N: dis_N_pileA .. dis_N_polish. Five cleans,
// so a disaster is worth five items of demand automatically.
export const DISASTER_STAGES = ['pileA', 'pileB', 'pileC', 'stain', 'polish'] as const
export const DISASTER_CHANCE_CLASSIC = 0.35   // classic rounds; never on warm-up
export const DISASTER_THEMES = ['walkout', 'henStagDo']   // these always get one
export const DISASTER_BONUS  = 25             // $ finale bonus, paid to the polisher

// RULE (playtest 2026-08-06): Creator Hub is the ONLY scale authority. Spawned
// models use the median authored scale of their own CH-placed instances —
// never an override, never a guess, never another model's scale. A model with
// NO CH placement is EXCLUDED from spawning (with a loud server log) until one
// is placed; placing a single scaled instance anywhere in CH enables it.

export const THEME_DEFS: RoundThemeDef[] = [
  {
    id: 'pizzaParty',
    title: 'PIZZA PARTY',
    blurb: 'Someone threw a pizza party. The pizza won.',
    // 'recycle' admitted so napkins survive the name filter — party debris that
    // fits the story. Ties/bras/socks/phones do not (hence the name filter).
    categories: ['general', 'recycle', 'sticky'],
    contractKinds: ['general', 'sticky'],
    spawns: { models: ['pizza', 'pizzaEaten'], countMin: 18, countMax: 26 },
    keepRubbishNames: ['pizza', 'napkin'],
  },
  {
    id: 'cocktailNight',
    title: 'COCKTAIL NIGHT',
    blurb: 'Cocktail night got out of hand — glasses as far as the eye can see.',
    categories: ['glasses', 'recycle', 'sticky'],
    contractKinds: ['glasses', 'recycle'],
    spawns: { models: ['drink', 'brokenBottle', 'Gin', 'Martini', 'Negroni'], countMin: 18, countMax: 26 },
  },
  {
    id: 'movieNight',
    title: 'MOVIE NIGHT',
    blurb: 'Film night. The popcorn went everywhere except mouths.',
    categories: ['general', 'recycle', 'sticky'],
    contractKinds: ['general'],
    spawns: { models: ['popcorn', 'Smoothie', 'CosmicLatte', 'DCLCan'], countMin: 18, countMax: 26 },
    keepRubbishNames: ['popcorn', 'drink', 'napkin'],
  },
  {
    id: 'henStagDo',
    title: 'HEN & STAG NIGHT',
    blurb: "Two parties collided. Clothes and photos everywhere — don't ask about the ties.",
    // Previously unfiltered ("chaos IS the theme"): it kept all 104 base items
    // AND added spawns — making it strictly HARDER than a classic round (83
    // demand / 8 bin trips solo, vs 68/6). That inverted the whole point of
    // themes: narrow the mix so one action can be mastered. Now it keeps the
    // party's own debris — clothes and litter — and hands glassware to
    // cocktail night and mopping to spring cleaning.
    categories: ['general', 'recycle'],
    // Restricted from null: 'glasses' and 'sticky' contracts would be
    // impossible now that those categories are masked out.
    contractKinds: ['general', 'recycle', 'deposits', 'disaster'],
    spawns: { models: ['tie', 'bra', 'sock', 'sockB', 'polaroidA', 'polaroidB'], countMin: 16, countMax: 24 },
  },
  {
    id: 'walkout',
    title: 'THE WALKOUT',
    blurb: 'The last crew walked out mid-shift. Bags everywhere and the furniture left as-is.',
    // Previously unfiltered, same problem as henStagDo (77 demand / 7 trips solo).
    // Keeps the abandoned-shift story: sacks of general waste plus the props
    // the crew never put back, which also gives the round its own texture
    // (quick pickups + a few hold-to-restore props) rather than everything.
    categories: ['general', 'reset'],
    // Walkout always spawns a disaster, so its contract pool can lean on it.
    contractKinds: ['deposits', 'disaster'],
    spawns: { models: ['bigRubbishBag'], countMin: 10, countMax: 14 },
  },
  {
    id: 'lostProperty',
    title: 'LOST PROPERTY NIGHT',
    blurb: 'The cloakroom exploded. Phones, keys, and one shoe. Always one shoe.',
    categories: ['general', 'sticky'],
    contractKinds: ['general'],
    spawns: { models: ['phone', 'keys', 'camera', 'brokenShoe'], countMin: 14, countMax: 20 },
    keepRubbishNames: ['phone', 'keys', 'camera', 'shoe', 'sock', 'tie', 'bra'],
  },
  {
    id: 'paparazzi',
    title: 'PAPARAZZI NIGHT',
    blurb: 'A celebrity dropped by. The floor is 90% flash photography.',
    categories: ['general', 'recycle', 'sticky'],
    contractKinds: ['recycle'],
    spawns: { models: ['polaroidA', 'polaroidB', 'polaroidC', 'polaroidD', 'polaroidE', 'camera'], countMin: 16, countMax: 24 },
    keepRubbishNames: ['polaroid', 'camera', 'napkin'],
  },
  {
    id: 'breakage',
    title: 'BREAKAGE NIGHT',
    blurb: "A shelf gave way. Mind your step — it's all glass out there.",
    categories: ['glasses', 'recycle', 'sticky'],
    contractKinds: ['glasses', 'recycle'],
    // These only spawn once each has a CH placement (the scale rule) — the
    // boot log lists any still EXCLUDED.
    spawns: { models: ['brokenGlass', 'reallyBrokenGlass', 'glassesBroken', 'brokenBottle'], countMin: 14, countMax: 20 },
    keepRubbishNames: ['glass', 'bottle'],
  },
  {
    // BOSS ROUND — every milestone round (5th, 10th, …) IS spring cleaning:
    // only mopping, everywhere. Never in the random pool (RoundManager pins it
    // to milestones); admin cycle can still force it for testing.
    id: 'springCleaning',
    title: 'SPRING CLEANING',
    blurb: 'Deep clean! Management wants every inch of this club mopped.',
    categories: ['sticky'],
    contractKinds: ['sticky'],
    spawns: { models: ['StickyPatch', 'StickyPatchBB'], countMin: 14, countMax: 18 },
  },
]

// Odds that a round beyond the warm-up rolls a theme (round 0 is always classic
// so new players learn the full loop first). Same theme never repeats twice.
export const THEME_CHANCE = 0.5

// Wallet addresses that can see the admin reset panel (lowercase)
export const ADMIN_ADDRESSES: string[] = [
  '0x8967ad851ccbd4c1a2d57a128d3c606fcab29bad',
]

export type InteractionType = 'quick' | 'hold' | 'collect' | 'reset'

export type ClutterDef = {
  id: string
  position: { x: number; y: number; z: number }
  scale?: { x: number; y: number; z: number }
  fast?: boolean
  type?: InteractionType   // defaults to 'quick'
  // When true, no primitive entity is created and no InteractionManager click is
  // registered — a scene-side system (e.g. restoreSystem) owns the visuals and
  // click handling, but the server still tracks the itemId via ClutterSync.
  sceneGlb?: boolean
  // Optional world-space position for the stink emitter — use when the GLB origin
  // doesn't match where the mesh actually sits in the scene (e.g. origin at floor
  // level but mesh on an upper floor). Falls back to `position` if not set.
  stinkPos?: { x: number; y: number; z: number }
}

export const CLUTTER_DEFS: ClutterDef[] = [
  // Reset items — visuals & click owned by restoreSystem; server tracks via these ids
  { id: 'test_reset',     position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 5.28,  y: 7.41, z: 24.07 } },
  { id: 'stool_2',        position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 8.51,  y: 7.41, z: 27.14 } },
  { id: 'chaise_cushion', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 24.86, y: 7.3,  z: 13.66 } },
  { id: 'sofa_cushion_1', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 12.19, y: 8.81, z: 28.47 } },
  { id: 'sofa_cushion_2', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 16.6,  y: 7.2,  z: 22.72 } },
  { id: 'sofa_cushion_3', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 25.45, y: 7.2,  z: 23.31 } },
]

// ── Mini-item sizing ──────────────────────────────────────────────────────────
// MEASURED longest axis, in metres, of each item model's own mesh (colliders
// excluded). These vary wildly by author — phone is 2.19m in mesh space while a
// polaroid is 0.61m — which is invisible in the world (every placement carries
// its Creator Hub scale) but made the carry-box minis render at wildly
// different sizes off one flat multiplier: the phone came out ~3.5x a polaroid.
//
// Minis now scale to ITEM_MINI_TARGET_M / <this>, so every item reads the same
// size in the hand whatever its author did.
//
// REGENERATE after adding or re-exporting an item model — an entry that's
// missing falls back to the old flat scale and logs once.
export const MODEL_SIZE_M: Record<string, number> = {
  Bin_General: 1.103,
  Bin_Recycling: 1.103,
  Bins_Stand: 1.794,
  Bottle_02: 0.969,
  Box_Wearable: 0.411,
  CosmicLatte: 0.441,
  DCLCan: 0.427,
  Disco_Ball: 0.452,
  Dumpster: 2.721,
  Gin: 0.46,
  Gold_Dustpan: 0.701,
  Gold_Platter: 0.52,
  Gold_Wheelie_Bin: 0.834,
  Ice_Bucket: 0.381,
  Janitor_Caddy: 0.562,
  Martini: 0.518,
  MessageBubble: 0.834,
  Milk_Crate: 0.385,
  Mopping_emote: 1.373,
  Negroni: 0.631,
  PartyPhone_emote: 2.438,
  Rubbish_Bag: 0.738,
  Smoothie: 0.662,
  SofaCushionAnim_1: 0.704,
  SofaCushionAnim_2: 0.797,
  SofaCushionAnim_3: 0.665,
  StickyPatch: 1.121,
  StickyPatchBB: 1.765,
  Vacuum: 0.51,
  WineGlass_01: 0.849,
  ambient_sound: 0.296,
  bigRubbishBag: 1.0,
  bra: 1.398,
  brokenBottle: 1.589,
  brokenGlass: 1.413,
  brokenShoe: 0.8,
  camera: 0.951,
  cleanBarStool: 0.94,
  cleanBarStoolAnim: 0.94,
  cleanChaiseCushion: 0.643,
  cleanChaiseCushionAnim: 0.762,
  cleanSofaCushion: 0.714,
  cleanSofaCushion2: 0.663,
  cleanSofaCushion3: 0.665,
  dirtyBarStool: 0.94,
  dirtyChaiseCushion: 0.762,
  dirtySofaCushion: 0.704,
  dirtySofaCushion2: 0.797,
  dirtySofaCushion3: 0.665,
  drink: 1.309,
  glasses: 0.815,
  glassesBroken: 0.873,
  keys: 0.884,
  napkinA: 0.619,
  napkinB: 0.622,
  nft: 0.5,
  phone: 2.194,
  pizza: 1.113,
  pizzaEaten: 1.025,
  polaroidA: 0.612,
  polaroidB: 0.612,
  polaroidC: 0.612,
  polaroidD: 0.612,
  polaroidE: 0.612,
  popcorn: 1.664,
  reallyBrokenGlass: 1.502,
  sitting_pose_collider: 0.41,
  sock: 1.777,
  sockB: 1.777,
  tie: 1.59,
  vertical_blue_pad: 2.0,
  video_player: 2.969,
}

/** Longest axis a carried mini should occupy in the hand, in metres. TUNE HERE. */
export const ITEM_MINI_TARGET_M = 0.16
