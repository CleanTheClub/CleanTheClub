import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { GameButton } from './client/uiButton'
import { engine, EasingFunction, timers } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getUserData } from '~system/UserIdentity'
import { isMobile } from '@dcl/sdk/platform'
import { ADMIN_ADDRESSES, DEBUG, MILESTONE_EVERY, THEME_DEFS, POP_HIT_T, FRENZY_LAST_S } from './shared/config'
import { room } from './shared/messages'
import { playToastSound } from './client/soundManager'
import { tweenColor, applyEasing } from './client/tween'
import { theme } from './client/theme'
import { isWaitingForMatch, gameState } from './client/phaseGate'
import { launchCelebration, stopCelebrationNow, promotionBurst } from './client/confettiSystem'
import { crowdCheer } from './client/npcCrowdSystem'
import { getHaulDebug } from './client/carrySystem'
import { playOwnerSting } from './client/musicManager'
import { isSignedUp, signUpForNextShift, cancelSignUp } from './client/participation'
import { isSpectating, enterSpectate, exitSpectate, nextSpectateTarget, spectateTargetInfo, stepSpectateOrbit, stepSpectateZoom } from './client/spectateSystem'
import { tierColorForRank } from './client/rankBadgeSystem'
import { CareerBar, ShiftPayoutPanel, PromotionBanner, PROMO_BANNER_MS, UpgradeShopOverlay, UpgradeShopPanel, ShopButton, isShopOpen, setShopOpen, affordableUpgradeCount, shopPanelWidth, isPayoutCardShowing, countdownColor, CareerIntroOverlay, shouldShowCareerIntro, replayCareerIntro } from './client/progressionUi'
import { getCarriedGeneral, getCarriedRecycle, getCarryCapacity, getPortableLeft, isCarryKnown, isCarryFull, requestPortableEmpty, getLastDeposit, getHauling, getHaulStage, setCarryHoldTest } from './client/carrySystem'
import { readCanvasInfo, getSafeArea, getScreenInsets, pct as saPct } from './client/safeArea'
import { platformKnown } from './client/platformWait'
import { getCareerOrEmpty, getContract, getLastPayoutMs, getLastPromotion, upgradeLevel } from './client/progressionStore'
import { TITLE_XP, rankForXp, upgradeValue } from './shared/progression'

// ── UI layout constants — tweak these to adjust sizing and positioning ─────────

// ── Global HUD scale — virtual canvas ─────────────────────────────────────────
// The whole HUD is laid out in a virtual canvas; the renderer scales that canvas
// to fit the screen (uiScaleFactor = min(screenW/virtualW, screenH/virtualH)).
//
// CALIBRATED AGAINST SDK 7.26.1 (auth-server build). 7.26 removed the
// device-pixel-ratio term from the scale formula — apparent HUD size no longer
// varies with display density AT ALL, which is what fixed "UI overlaps on the
// 4K/dpr-1 screen but looks fine on the MacBook" (final playtest). Under the
// OLD formula every machine rendered its own size (screenH/(720·dpr)), so
// there is no single "old look" to restore — a reference had to be picked.
// It is KJ's retina Macs (dpr 2, effective screenH/1440): px values map to
// screenH/1440 everywhere now. 1080 was tried first (the dpr-1.5 rendering
// from the final-playtest screenshots) and read ~33% too big on the retina
// machines the HUD is actually developed on. Downstream px constants keep
// their tuned values — do NOT rescale them; move only this canvas.
//
// Mobile targets the platform's own 720-tall default (7.26 ships 1600×720
// there): needs a REAL-PHONE check, see UPGRADE-SDK.md. Resolved LIVE in
// uiStateSystem, not here — isMobile() is false until the platform round-trip
// lands (see platformWait).
//
// TUNE HERE: lower DESKTOP_VIRTUAL_H toward 1200 if the HUD reads too small;
// raise toward 1800 if it crowds the screen. Everything scales together —
// the one-time '[UI] canvas' log below prints the numbers to calibrate with.
// (1440 = the old retina-Mac rendering; KJ wanted it a notch smaller still.)
const DESKTOP_VIRTUAL_H   = 1800
const MOBILE_VIRTUAL_H    = 720
let currentVirtualH       = DESKTOP_VIRTUAL_H

// Live virtual-canvas width. The renderer fits a FIXED-aspect virtual canvas
// inside the screen; on any aspect wider than the canvas it fits to height and
// LEFT-anchors, so '100%' and centred content skew left — reported as "UI skewed
// left, not centred" on ultrawide mobile. We flex virtualWidth to match the real
// screen aspect (virtualHeight stays fixed per platform, so the vertical scale
// is stable). Matching the aspect removes the letterbox: the canvas fills the
// screen and centring is true on every device. Updated via setUiRenderer, which
// only reassigns the virtual size — no re-mount. Starts at the 16:9 default
// until the real canvas size is known.
let currentVirtualW = Math.round(DESKTOP_VIRTUAL_H * (16 / 9))

// Platform
// Extra bump for mobile ON TOP of the (720-tall-canvas) mobile scale above —
// touch targets + smaller screens want larger chrome.
const MOBILE_SCALE        = 1.1     // multiplier applied to text / chrome on mobile

// Instructions image (top-centre; also acts as title card)
// Image file is 1024×128 — display at the same aspect ratio (8:1)
const INSTR_W_DESKTOP     = 900     // display width (desktop)
const INSTR_H_DESKTOP     = 113     // display height — 900 × (128/1024)
const INSTR_W_MOBILE      = 630     // display width (mobile)
const INSTR_H_MOBILE      = 79      // display height — 630 × (128/1024)
const INSTR_MARGIN_TOP    = 8

// Entry intro animation — image centred on screen, then pops to its normal top position
const INTRO_HOLD_S       = 6.0   // seconds to hold at centre on player entry
const ROUND_START_HOLD_S = 2.5   // seconds to hold InstructionsUI at centre between rounds
const INTRO_TWEEN_S      = 0.35  // duration of the pop to normal position (short = snappy)
const INTRO_SIZE_MULT   = 1.75  // intro image is this much bigger than its normal size
const INTRO_CENTER_Y    = 400   // virtual px from canvas top — where the intro image centre sits
const INTRO_TIMER_BELOW = 100  // px relative to INTRO_CENTER_Y where the timer sits during intro

// Timer row
const TIMER_ROW_TOP       = 120     // absolute top offset from canvas (virtual px)
const TIMER_ICON_SIZE     = 64      // base size before MOBILE_SCALE
const TIMER_FONT_SIZE     = 72      // countdown digits
const TIMER_ICON_MARGIN   = 14      // gap between icon and digits

// Timer status pill (FRENZY / LAST CALL) — rendered INSIDE the timer row,
// right of the digits and vertically centred with them. History: stacked in
// the info strip it drifted into the SPREE flash zone; moved to a fixed band
// at y=194 it overlapped mobile's taller countdown digits (~215 bottom vs the
// bar at 232 — no free band exists on phones). In-row flex placement cannot
// overlap anything on any platform, and the row's one-time recentre at 0:20
// is itself the "frenzy just started" attention snap.

// Progress bar row — sits just below the timer, wider than before
const BAR_ROW_TOP         = 232     // absolute top offset — just below timer (tune as needed)
const BAR_FULL_W_DESKTOP  = 800     // total width of track + label
const BAR_FULL_W_MOBILE   = 560
const BAR_LABEL_W         = 120     // width reserved for "X% Clean" text
const BAR_LABEL_GAP       = 14      // gap between track right edge and label
const BAR_HEIGHT          = 16

// Hold-to-clean progress bar — screen-space (never occluded by the avatar, unlike
// the old in-world billboard).  Shown only while a sticky patch is being held.
const HOLD_BAR_W_DESKTOP  = 720
const HOLD_BAR_W_MOBILE   = 520
const HOLD_BAR_HEIGHT     = 36
const HOLD_BAR_FONT       = 26    // "Release in the green!" prompt
// Tuned absolute value from the 720-tall-canvas era (0.61 × 720). Kept as the
// same virtual-px number through the 7.26 migration so the on-screen position
// is unchanged: ~61% down on mobile (720 canvas), ~41% down on desktop (1080
// canvas) — exactly where it rendered before, on both.
const HOLD_BAR_TOP        = 439  // below the centre reticle
const HOLD_BAR_BG_COLOR   = theme.holdBar.bg
const HOLD_BAR_FILL_COLOR = theme.holdBar.fill

// Info strip (round label + next-round controls only — bar has moved above)
const STRIP_TOP           = 258     // absolute top offset — just below bar row
const STRIP_WIDTH         = 440     // base width before MOBILE_SCALE
const ROUND_FONT_SIZE     = 22
const METER_FONT_SIZE     = 13
const LABEL_MARGIN_SMALL  = 4       // bottom margin under round label

// Next-round controls (shown when phase === 'open')
const BTN_HEIGHT          = 48

// Timer colour thresholds — countdown text shifts white → yellow → orange → red.
// Rather than hard-snapping at each boundary, we ease between bands with
// tweenColor (see the timer-colour state block below).
const TIMER_YELLOW_S      = 45   // seconds remaining when text turns yellow
const TIMER_ORANGE_S      = 30   // seconds remaining when text turns orange
const TIMER_RED_S         = 15   // seconds remaining when text turns red

// Band colours (index 0 = calm → 3 = critical) — sourced from the shared theme.
const TIMER_BAND_COLORS = theme.timer
// How long the colour takes to ease from one band into the next.
const TIMER_COLOR_TWEEN_S = 0.6

function timerBandOf(seconds: number): number {
  if (seconds > TIMER_YELLOW_S) return 0
  if (seconds > TIMER_ORANGE_S) return 1
  if (seconds > TIMER_RED_S)    return 2
  return 3
}

// Progress bar colours (keyed to cleanliness %) — sourced from the shared theme.
const BAR_BG_COLOR        = theme.bar.bg
const BAR_COLOR_GOOD      = theme.bar.good   // ≥ 80 %
const BAR_COLOR_MID       = theme.bar.mid    // 50–80 %
const BAR_COLOR_LOW       = theme.bar.low    // < 50 %
// How long the bar fill takes to ease from one band into the next.
const BAR_COLOR_TWEEN_S   = 0.4

function barBandOf(pct: number): number {
  if (pct >= 0.8) return 0
  if (pct >= 0.5) return 1
  return 2
}
const BAR_BAND_COLORS = [BAR_COLOR_GOOD, BAR_COLOR_MID, BAR_COLOR_LOW] as const

// Outcome images — shown in place of the instructions image during the open phase
// All outcome images are 1024×128 — same aspect ratio as InstructionsUI
const OUTCOME_IMAGES: Record<string, string> = {
  perfect:    'assets/scene/UI/PerfectClean.png',
  optimal:    'assets/scene/UI/AmazingClean.png',
  adequate:   'assets/scene/UI/AdequateClean.png',
  suboptimal: 'assets/scene/UI/BadClean.png',
}

// Shown in place of the per-round outcome card during the FINALE celebration
// (after the final round). Same 1024×128 aspect as the outcome images.

// Text colours — sourced from the shared theme.
const COLOR_SUBTLE        = theme.text.subtle  // round label
const COLOR_DIM           = theme.text.dim     // meter / next-round

// Toast notifications
// Toast images are 1024×256 (4:1 ratio)
const TOAST_W_DESKTOP     = 450
const TOAST_H_DESKTOP     = 113    // 450 × (256/1024)
// Mobile toasts are now sized UP, not down. Previously mobile shrank the bubble
// (320×80) while MOBILE_SCALE grew the text inside it 1.5×, so the narrative copy
// overflowed the speech-bubble art — "the Narrative notifications text is
// overlapping the speaking bubble" on iOS. Keeps the 1024×256 (4:1) art ratio.
const TOAST_W_MOBILE      = 480
const TOAST_H_MOBILE      = 120    // 480 × (256/1024)
const TOAST_OVERLAP       = 0   // fraction of toast HEIGHT to pull each card up (creates stack)
const TOAST_FONT_SIZE     = 18     // count text (e.g. "3 / 38")
const NARR_FONT_SIZE      = 17     // narrative body text
// Position of overlaid text within the toast image.
// Values are fractions of the toast HEIGHT / WIDTH from the top-left corner.
// Tune each set independently to align with the text area in each PNG asset.
const TOAST_LABEL_TOP     = 0.5    // glasses / bottles count: vertical position
const TOAST_LABEL_LEFT    = 0.35   // glasses / bottles count: horizontal position
const NARR_LABEL_TOP      = 0.6   // narrative body text: vertical position
const NARR_LABEL_LEFT     = 0.325   // narrative body text: horizontal position
const NARR_LABEL_W_FRAC   = 0.6   // narrative text box width as fraction of toast width
// Toast container anchor — percentage strings scale with the canvas on all devices
const TOAST_POS_DESKTOP   = { top: '33%', right: '2%'  } as const
// Below the top-centre HUD block (timer/bar/contract) — at 9% the stack sat
// straight over them on phones ('notifications overlap the task and timer').
const TOAST_POS_MOBILE    = { top: '36%', left: '2%' } as const

// HUD backdrop — single semi-transparent scrim behind all top-centre elements.
// Sized to the banner width + padding so it frames the whole cluster cleanly.
// Height adapts: grows to cover the next-round button during the open phase.
const HUD_BG_COLOR   = theme.hud.bg
const HUD_BG_PAD_X   = 28   // horizontal padding beyond the banner on each side (px)
const HUD_BG_PAD_TOP =  6   // gap above the banner image
const HUD_BG_PAD_BOT = 18   // gap below the round label / next-round button

// Admin panel (desktop only — right edge is unsafe on mobile)
// Below the (enlarged) career bar — at the old top:20 the two overlapped.
const ADMIN_TOP           = '34%' as const
const ADMIN_RIGHT         = 20
const ADMIN_FONT_SIZE     = 10
const ADMIN_COLOR         = { r: 1, g: 0.6, b: 0.1, a: 0.8 } as const
const ADMIN_BTN_WIDTH     = 140
const ADMIN_BTN_HEIGHT    = 34
const ADMIN_BTN_FONT      = 12
const ADMIN_MARGIN        = 4

// ─────────────────────────────────────────────────────────────────────────────

let isAdmin = false

// Admin achievement-cycle buttons: gear → index of the stage the NEXT click sets.
const ACH_STAGES = ['zero', 'half', 'almost', 'full'] as const
const ADMIN_ACH_GEARS = [
  { gear: 'Gold_Dustpan', label: 'Dustpan' },
  { gear: 'Gold_Platter', label: 'Platter' },
  { gear: 'Ice_Bucket',   label: 'IceBucket' },
  { gear: 'Disco_Ball',   label: 'Disco' },
]
const achStageIdx = new Map<string, number>()

// ── Image toast stack ─────────────────────────────────────────────────────────

type ToastKind = 'cleaned' | 'glasses' | 'bottles' | 'narrative'

interface ToastEntry {
  id:       number
  kind:     ToastKind
  count?:   number
  total?:   number
  text?:    string
  timerId?: number
}

let _toastId = 0
const activeToasts: ToastEntry[] = []

const TOAST_SRC: Record<ToastKind, string> = {
  cleaned:   'assets/scene/UI/CleanedUI.png',
  glasses:   'assets/scene/UI/GlassesCollectedUI.png',
  bottles:   'assets/scene/UI/BottlesCollectedUI.png',
  narrative: 'assets/scene/UI/NarrativeUI.png',
}

const TOAST_DURATION: Record<ToastKind, number> = {
  cleaned:   2_000,
  glasses:   2_800,
  bottles:   2_800,
  narrative: 7_000,
}

function _addToast(entry: Omit<ToastEntry, 'id' | 'timerId'>, durationMs?: number) {
  const id = ++_toastId
  const t: ToastEntry = { ...entry, id }
  // timers.*, not the global setTimeout — engine-tick timers respect the scene
  // lifecycle instead of firing from outside it.
  t.timerId = timers.setTimeout(() => {
    const i = activeToasts.findIndex(x => x.id === id)
    if (i !== -1) activeToasts.splice(i, 1)
  }, durationMs ?? TOAST_DURATION[entry.kind])
  activeToasts.push(t)
  playToastSound(entry.kind)
}

/** Show the "Cleaned!" confirmation image. */
export function showCleanedToast() {
  _addToast({ kind: 'cleaned' })
}

/** Show (or refresh) the glasses/bottles collection counter. */
export function showCollectionToast(kind: 'glasses' | 'bottles', count: number, total: number) {
  const existing = activeToasts.find(t => t.kind === kind)
  if (existing) {
    existing.count = count
    existing.total = total
    if (existing.timerId !== undefined) timers.clearTimeout(existing.timerId)
    existing.timerId = timers.setTimeout(() => {
      const i = activeToasts.findIndex(x => x.id === existing.id)
      if (i !== -1) activeToasts.splice(i, 1)
    }, TOAST_DURATION[kind])
    playToastSound(kind)
  } else {
    _addToast({ kind, count, total })
  }

  if (count === total) {
    timers.setTimeout(() => showCleanedToast(), 350)
  }
}

// ── Narrative toast queue ─────────────────────────────────────────────────────
// One announcement at a time. A round end can legitimately produce five in the
// same second (milestone + LAST CALL + outcome + achievement + disaster bonus)
// — stacked they shout over each other and each rings its own full-volume
// ding. Queued, it's the same information with one voice: followers run at a
// shortened duration so the backlog clears quickly, the queue caps at 3 with
// the OLDEST dropped (later announcements are the round's conclusions), and
// back-to-back duplicates coalesce.
const NARRATIVE_QUEUE_MAX = 3
const NARRATIVE_FAST_MS   = 3_500
const NARRATIVE_GAP_MS    = 400
const narrativeQueue: string[] = []
let narrativeActive = false

/** Show a narrative pop-up with `text` overlaid on the NarrativeUI image. */
export function showNarrativeToast(text: string) {
  if (narrativeActive) {
    if (narrativeQueue[narrativeQueue.length - 1] === text) return
    narrativeQueue.push(text)
    while (narrativeQueue.length > NARRATIVE_QUEUE_MAX) narrativeQueue.shift()
    return
  }
  narrativeActive = true
  const durationMs = narrativeQueue.length > 0 ? NARRATIVE_FAST_MS : TOAST_DURATION.narrative
  _addToast({ kind: 'narrative', text }, durationMs)
  timers.setTimeout(() => {
    narrativeActive = false
    const next = narrativeQueue.shift()
    if (next !== undefined) showNarrativeToast(next)
  }, durationMs + NARRATIVE_GAP_MS)
}

// Own wallet address, for telling our ownerCrowned broadcast from someone
// else's. '' until getUserData answers — the compare below just misses the
// "self" wording in that (sub-second) window, nothing worse.
let ownAddress = ''

async function checkAdmin() {
  try {
    const { data } = await getUserData({})
    if (data?.userId) {
      ownAddress = data.userId.toLowerCase()
      if (ADMIN_ADDRESSES.includes(ownAddress)) isAdmin = true
    }
    if (DEBUG) isAdmin = true
  } catch (_) {}
}

// Reads phaseGate's once-per-frame snapshot instead of opening another
// component iterator from inside the render loop.
const getGameState = () => gameState()

function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// DEBUG-only now: the "Round N — Milestone" label was cut from the player HUD
// (feedback 2026-08-15) — milestone rounds already announce themselves via the
// SPRING CLEANING theme card/chip, so the label was a second voice saying less.
function getRoundLabel(n: number): string {
  const isMilestone = (n + 1) % MILESTONE_EVERY === 0
  return isMilestone ? `Round ${n + 1} — Milestone` : `Round ${n + 1}`
}


// ── Top-image animation state ─────────────────────────────────────────────────
// Two animations share the same lerp targets (centre↔normal):
//   introStartMs  — player enters scene: image tweens centre → normal (with hold)
//   outcomeStartMs — round ends: image tweens normal → centre
//   prevIsOpen     — detects phase transitions to start/stop those tweens automatically
//
// introHoldS is 0 for round-start tweens (no hold needed) and INTRO_HOLD_S for player entry.
let introStartMs   = -1
let introHoldS     = INTRO_HOLD_S
let outcomeStartMs = -1
let prevIsOpen     = false
// Payout timestamp the shop last auto-opened for — once per shift end, and keyed
// on the PAYOUT (not the phase flip) so the affordability check runs against the
// wallet AFTER wages landed, not the pre-payout balance.
let autoOpenedPayoutMs = 0
// Admin theme-pin cycle position: 0 = random, 1.. = THEME_DEFS index + 1.
// Local echo of what was last sent — the server owns the actual pin.
let adminThemeIdx = 0
// Admin hold-test: audition placed models on the carry rig (0 = off).
// Names must match the Creator Hub entities exactly.
const HOLD_TEST_MODELS = [
  'Vacuum', 'Disco_Ball', 'Gold_Dustpan', 'Gold_Platter', 'Gold_Wheelie_Bin',
  'Ice_Bucket', 'Janitor_Caddy', 'Milk_Crate',
]
let adminHoldIdx = 0
// Admin confetti test — cycles the four celebration strengths, then OFF.
// Purely local: confetti is a client effect, so there's no server round-trip
// and it can be fired in any phase (playtest: "I didn't see confetti").
const CONFETTI_TEST: Array<{ label: string; outcome: 'suboptimal' | 'adequate' | 'optimal'; finale: boolean }> = [
  { label: 'weak',    outcome: 'suboptimal', finale: false },
  { label: 'ok',      outcome: 'adequate',   finale: false },
  { label: 'optimal', outcome: 'optimal',    finale: false },
  { label: 'FINALE',  outcome: 'optimal',    finale: true  },
]
let adminConfettiIdx = 0
// When the themed-round story card started showing (round start / scene entry).
// Long hold + late fade: reading time first, THEN the screen declutters.
let themeStoryStartMs   = -1
const THEME_STORY_MS      = 9_000
const THEME_STORY_FADE_MS = 900
// Roulette spin at the front of the story card — decelerating title cycle.
// 100ms-quantized clock for decorative pulses. Feeding raw Date.now() sines
// into color props changed the prop EVERY frame — a guaranteed UI update per
// node per frame even with the game static. Same idiom as the roulette tick.
const pulseNow = (): number => Math.floor(Date.now() / 100) * 100

const THEME_ROULETTE_MS   = 1_600
// Hoisted — building this inside the render allocated a fresh array every
// frame for the full 9s the roulette card is up.
const THEME_WHEEL = [...THEME_DEFS.map((td) => td.title), 'CLASSIC NIGHT']
// Title font auto-fits the LONGEST possible wheel line inside the card's padded
// width, so no theme name can ever touch the padding (feedback: theme text must
// "always fit neatly inside the container"). Derived from the data rather than
// hand-tuned: adding a longer theme title later shrinks the font instead of
// silently overflowing. 0.65 ≈ average glyph width (em fraction) for this
// uppercase font — raised from 0.60 after an in-world check still showed the
// title touching the padding (2026-08-16 screenshot).
const THEME_CARD_W      = 680
const THEME_CARD_PAD    = 16
const THEME_TITLE_CHARS = Math.max(...THEME_WHEEL.map((t) => t.length)) + 'TONIGHT: '.length
const THEME_TITLE_FONT  = Math.min(38, Math.floor((THEME_CARD_W - THEME_CARD_PAD * 4) / (0.65 * THEME_TITLE_CHARS)))
// The BLURB needs an EXPLICIT height: DCL Labels wrap their text but do NOT
// grow their layout box for the extra lines, so a two-line blurb painted past
// the card's background (the "description doesn't fit the pill" report —
// the container never knew the text was two lines tall). Estimated with the
// same glyph math as the title; over-estimating just pads the card bottom.
const THEME_BLURB_FONT  = 26
const themeBlurbLines = (text: string, fontPx: number, innerW: number): number =>
  Math.max(1, Math.ceil((text.length * 0.52 * fontPx) / innerW))
// Beat between the payout card's centre-stage pop and the shop panel sliding in.
const SHOP_AUTO_OPEN_DELAY_MS = 1500

// ── Countdown timer colour state ──────────────────────────────────────────────
// `currentTimerColor` is read by the timer Label each render; tweenColor mutates
// it over time whenever the countdown crosses into a new band.  We track the
// active tween's system so a fresh band change can cancel a still-running ease.
let currentTimerColor: Color4 = Color4.create(1, 1, 1, 1)
let lastTimerBand            = -1
let activeTimerTween: ((dt: number) => void) | null = null

// ── Progress bar colour state — same band-tween pattern as the timer ──────────
let currentBarColor: Color4 = Color4.create(0.90, 0.30, 0.15, 1)  // starts at "low"
let lastBarBand           = -1
let activeBarTween: ((dt: number) => void) | null = null

// ── Hold-to-clean bar state — driven by InteractionManager via cleaningSystem ──
let holdBarVisible  = false
let holdBarProgress = 0
// Fisch-style skill-check zone (0..1 fractions of the track). null = no zone.
let holdZoneStart: number | null = null
let holdZoneEnd   = 0

/** Show/hide the hold-to-clean progress bar (called when a hold begins/ends). */
export function setHoldBarVisible(visible: boolean) {
  holdBarVisible = visible
  if (!visible) { holdBarProgress = 0; holdZoneStart = null }
}
/** Update hold-to-clean progress, 0..1 (called each frame while holding). */
export function setHoldBarProgress(progress: number) {
  holdBarProgress = Math.max(0, Math.min(1, progress))
}
/** Set (or clear, with null) the green release zone for the current hold. */
export function setHoldBarZone(start: number | null, end = 0) {
  holdZoneStart = start
  holdZoneEnd   = end
}

// ── Mobile skill-check tap target ─────────────────────────────────────────────
// Registered by InteractionManager at init (it already imports this module, so a
// stored callback avoids an import cycle). A UI button is the only RELIABLE tap
// target on touch: screen taps outside interactables go to the camera and never
// reach inputSystem, which is why the tap-anywhere version didn't register.
// Mobile skill-tap plumbing. TWO paths, both needed: the InteractionManager's
// global input poll catches taps anywhere on the WORLD, but a touch that lands
// ON a UI element is consumed by the UI layer and never reaches that poll —
// a visual-only pill was therefore a dead zone exactly where players aim
// (playtest: "popcorn near-impossible, POP pill unresponsive"). So the pills
// call in here directly for on-pill taps, and the poll covers everywhere else.
let skillTapHandler: (() => void) | null = null
export function setSkillTapHandler(fn: () => void) { skillTapHandler = fn }

// ── Rhythm Pop ring state — driven per-frame by InteractionManager ────────────
// popRingT: 0..1 progress of the current beat's shrinking ring, null = inactive.
let popRingT: number | null = null
let popRingHits = 0
export function setPopRing(t: number | null, hits: number) {
  popRingT = t
  popRingHits = hits
}

// ── Action flash — one pop-and-fade slot shared by the moment-to-moment juice
// (PERFECT skill hits, MISSED, cleaning SPREEs). Latest event wins the slot.
const PERFECT_FLASH_MS  = 700
let perfectFlashStartMs = -1
let perfectFlashStreak  = 0
let perfectFlashKind: 'perfect' | 'miss' | 'spree' | 'cancel' = 'perfect'
// Spree flash during the closing frenzy reads "FRENZY SPREE ×N!" in the frenzy
// colour — the event flash carries the state, so no second banner is needed
// anywhere near it (frenzy + spree text used to overlap mid-screen).
let perfectFlashFrenzy  = false
// 'cancel' text — names WHICH silent path ended a mop hold. Field debugging
// aid that doubles as honest UX: the bar vanishing with no explanation was
// reported as "weird and hard to diagnose"; now the screen says why (and the
// tester's screenshot tells us exactly which code path to fix).
let cancelFlashText = ''
export function flashPerfect(streak: number) {
  perfectFlashStartMs = Date.now()
  perfectFlashStreak  = streak
  perfectFlashKind    = 'perfect'
}
export function flashMiss() {
  perfectFlashStartMs = Date.now()
  perfectFlashStreak  = 0
  perfectFlashKind    = 'miss'
}
export function flashSpree(combo: number, frenzy = false) {
  perfectFlashStartMs = Date.now()
  perfectFlashStreak  = combo
  perfectFlashKind    = 'spree'
  perfectFlashFrenzy  = frenzy
}
/** A mop hold ended without a hit/miss resolution — say why on screen. */
export function flashHoldCancel(label: string) {
  perfectFlashStartMs = Date.now()
  perfectFlashKind    = 'cancel'
  cancelFlashText     = label
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

/** Called each time the local player enters the scene — restarts the full intro (with hold). */
export function resetIntro() {
  introStartMs = Date.now()
  introHoldS   = INTRO_HOLD_S
  themeStoryStartMs = Date.now()   // an arriving player gets the night's story too
}

/** Called by narrativeSystem when a new round starts — shows InstructionsUI at centre then pops to top. */
export function triggerRoundStartIntro() {
  introStartMs   = Date.now()
  introHoldS     = ROUND_START_HOLD_S
  outcomeStartMs = -1
  themeStoryStartMs = Date.now()
}

// Career-storage health, mirrored for the admin panel. A silent persistence
// failure (stale jsonbin creds after a Creator Hub re-point) once cost real
// careers on every republish — this line makes the failure visible in-world.
let storageStatus: { backend: string; loadConfirmed: boolean; lastSaveOk: boolean | null; lastSaveMs: number } | null = null

// ── UI state system ───────────────────────────────────────────────────────────
// Render is a pure read: phase-edge detection, the letterbox re-config, the
// shop auto-open and the colour-band tween triggers all used to run INSIDE
// uiBody() — state mutation, engine.removeSystem calls and a renderer
// re-configure from within the render callback (a re-entrancy hazard). This
// system owns all of it now; uiBody just renders what it left behind.
let letterboxAcc = 0
let loggedCanvasCalib = false
function uiStateSystem(dt: number): void {
  // Keep the virtual canvas matched to the real screen aspect so there's no
  // letterbox to skew centred content (see currentVirtualW above). Clamped so a
  // portrait or extreme aspect can't drive fixed-width elements off-canvas; the
  // >=8px guard avoids re-setting on sub-pixel jitter. 4 Hz — this only
  // changes on resize/orientation/chat toggle.
  letterboxAcc += dt
  if (letterboxAcc >= 0.25) {
    letterboxAcc = 0
    const canvasInfo = readCanvasInfo()
    if (canvasInfo) {
      // Platform height resolves late (isMobile is false until getPlatform
      // answers) — desktop until then, corrected by this same re-call.
      const vh = platformKnown() && isMobile() ? MOBILE_VIRTUAL_H : DESKTOP_VIRTUAL_H
      let desired = Math.max(vh, Math.min(Math.round(vh * (10 / 3)), Math.round(vh * (canvasInfo.width / canvasInfo.height))))
      // 7.26 overrides any EXACT 16:9 virtual size to 1600×720 on mobile ("you
      // didn't think about phones") — which would fight this aspect-match and
      // reintroduce the letterbox on 16:9 phones. Nudge off the exact ratio.
      if (Math.abs(desired / vh - 16 / 9) < 0.002) desired += 4
      // One-time calibration line: THE numbers to quote when a machine's HUD
      // reads too big/small (dpr is diagnostic only — 7.26 ignores it).
      if (!loggedCanvasCalib) {
        loggedCanvasCalib = true
        console.log(`[UI] canvas ${canvasInfo.width}x${canvasInfo.height} dpr=${canvasInfo.devicePixelRatio ?? '?'} → virtual ${desired}x${vh} (px scale ${(canvasInfo.height / vh).toFixed(3)})`)
      }
      if (vh !== currentVirtualH || Math.abs(desired - currentVirtualW) >= 8) {
        currentVirtualH = vh
        currentVirtualW = desired
        ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: currentVirtualW, virtualHeight: currentVirtualH, screenInset: 'none' })
      }
    }
  }

  const gs      = getGameState()
  const isOpen  = (gs?.phase ?? 'lobby') === 'open'
  const pct     = Math.min(1, (gs?.cleanedCount ?? 0) / Math.max(1, gs?.totalCount ?? 1))
  const seconds = gs?.secondsLeft ?? 0

  // ── Round-transition detection ──────────────────────────────────────────────
  if (isOpen && !prevIsOpen) {
    // Round just ended — tween outcome image from normal position to centre.
    outcomeStartMs = Date.now()
    introStartMs   = -1   // cancel any pending player-entry intro
  }
  // Round-start intro is triggered explicitly via triggerRoundStartIntro() from
  // narrativeSystem — more reliable than edge detection for button-click starts.
  prevIsOpen = isOpen

  // ── Shift-end shop surfacing (desktop) ──────────────────────────────────────
  // Playtest: many players never found the UPGRADES button. When the payout lands
  // during the intermission and the player can afford at least one upgrade, the
  // side panel opens itself — the celebration stays visible behind it, and closing
  // it sticks for the rest of the intermission (this fires once per payout).
  // Mobile keeps the payout card's CTA instead: the modal would cover the payout.
  //
  // SEQUENCED, not simultaneous (playtest round 2: banner + card + panel landing
  // together meant a promotion "didn't catch my attention at all"): a fresh
  // promotion banner plays solo first, then the card pops at true centre, and
  // only after its beat does the panel slide in.
  const payoutMs = getLastPayoutMs()
  if (isOpen && !isMobile() && payoutMs > 0 && payoutMs !== autoOpenedPayoutMs) {
    const promo     = getLastPromotion()
    const promoHold = promo !== null && promo.ms >= payoutMs ? PROMO_BANNER_MS : 0
    if (Date.now() - payoutMs > promoHold + SHOP_AUTO_OPEN_DELAY_MS) {
      autoOpenedPayoutMs = payoutMs
      if (!isShopOpen() && affordableUpgradeCount() > 0) setShopOpen(true)
    }
  }

  // ── Bar fill colour — ease between bands as cleanliness crosses 50 % / 80 % ──
  if (!isOpen) {
    const band = barBandOf(pct)
    if (band !== lastBarBand) {
      lastBarBand = band
      if (activeBarTween) engine.removeSystem(activeBarTween)
      activeBarTween = tweenColor(
        currentBarColor,
        BAR_BAND_COLORS[band],
        BAR_COLOR_TWEEN_S,
        (v) => { currentBarColor = v },
        () => { activeBarTween = null },
        EasingFunction.EF_EASEOUTCUBIC,
      )
    }
    // ── Countdown colour — ease between bands instead of hard-snapping ────────
    const tBand = timerBandOf(seconds)
    if (tBand !== lastTimerBand) {
      lastTimerBand = tBand
      if (activeTimerTween) engine.removeSystem(activeTimerTween)
      activeTimerTween = tweenColor(
        currentTimerColor,
        TIMER_BAND_COLORS[tBand],
        TIMER_COLOR_TWEEN_S,
        (v) => { currentTimerColor = v },
        () => { activeTimerTween = null },
        EasingFunction.EF_EASEOUTCUBIC,
      )
    }
  }
}

// ── Owner coronation + theme-pick state ───────────────────────────────────────
// These handlers live HERE, not in a dedicated module: ui.tsx is the one place
// that can call showNarrativeToast without creating an import cycle (everything
// else that toasts is already imported BY ui). See carrySystem's header for the
// house rule this follows.
// roundNumber whose intermission has already spent its owner pick (-1 = none).
let themePickTakenRound = -2
let ownerPickModalOpen  = false

export function setupUi() {
  checkAdmin()
  room.onMessage('storageStatus', (data) => {
    try { storageStatus = JSON.parse(data.statusJson) } catch { storageStatus = null }
  })

  // Coronation — a room-wide moment: everyone gets the toast, the crowd's
  // applause and the finale-track sting. The new owner's own client already
  // fired the full confetti barrage from its progressUpdate (progressionStore);
  // bystanders get a smaller burst so the moment still lands visually.
  room.onMessage('ownerCrowned', (data) => {
    const self = ownAddress !== '' && data.address.toLowerCase() === ownAddress
    showNarrativeToast(self
      ? 'YOU OWN THE CLUB NOW — take a bow!'
      : `${data.displayName} just made CLUB OWNER — give it up!`)
    crowdCheer()
    playOwnerSting()
    if (!self) promotionBurst()
  })

  // Owner theme pick — announcement closes the picker everywhere (first owner
  // won the night) and pins the "taken" flag to this intermission's round.
  room.onMessage('ownerThemePicked', (data) => {
    themePickTakenRound = getGameState()?.roundNumber ?? -1
    ownerPickModalOpen  = false
    showNarrativeToast(`Tonight: ${data.themeTitle} — chosen by Owner ${data.displayName}`)
  })
  room.onMessage('ownerPickResult', (data) => {
    if (!data.ok) {
      ownerPickModalOpen = false
      showNarrativeToast(data.reason)
    }
  })

  engine.addSystem(uiStateSystem)
  // screenInset 'none': safe-area handling stays OURS (safeArea.ts reads the
  // live interactableArea, including chat open/close) — 7.26's automatic inset
  // would double-apply on top of it. See UPGRADE-SDK.md.
  ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: currentVirtualW, virtualHeight: currentVirtualH, screenInset: 'none' })
}

const WHITE = theme.colors.white

// ── Rubbish carry chip — bottom-centre, only while actually cleaning ──────────
// Mirrors the server's carriedUpdate (see carrySystem). Bottom-centre keeps it
// clear of the career HUD (top-right), the toast stack (top), the hold bar
// (61% height) and the mobile joystick / interaction clusters (bottom corners);
// the safe-area inset keeps it above any explorer chrome along the bottom edge.
function CarryChip({ S }: { S: number }) {
  if (!isCarryKnown()) return null   // no server answer yet — render nothing

  // Dumpster haul takes over the chip: the bag is the load, and the chip is the
  // one HUD element already about "what's in your hands".
  if (getHauling() !== '') {
    const sa2 = getSafeArea()
    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: saPct(sa2.bottom + 0.03), left: 0 },
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{
            padding: { top: Math.round(8 * S), bottom: Math.round(8 * S), left: Math.round(16 * S), right: Math.round(16 * S) },
            borderRadius: Math.round(12 * S),
          }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.72 } }}
        >
          <Label
            value={getHaulStage() === 'back'
              ? 'BIN EMPTIED — put it back at its station!'
              : 'HAULING THE FULL BIN — dumpster is outside!'}
            fontSize={Math.round(26 * S)}
            color={getHaulStage() === 'back'
              ? { r: 0.4, g: 0.95, b: 0.5, a: 0.75 + 0.25 * Math.sin(pulseNow() / 200) }
              : { r: 1, g: 0.82, b: 0.25, a: 0.75 + 0.25 * Math.sin(pulseNow() / 200) }}
          />
        </UiEntity>
      </UiEntity>
    )
  }

  const gen  = getCarriedGeneral()
  const rec  = getCarriedRecycle()
  const cap  = Math.max(1, getCarryCapacity())
  const full = isCarryFull()

  const icon    = Math.round(44 * S)
  const font    = Math.round(26 * S)
  const pad     = Math.round(8 * S)
  const trackW  = Math.round(180 * S)
  const trackH  = Math.round(18 * S)
  const sa      = getSafeArea()

  // A FILL BAR, not an equation. "0 + 0 / 10" asked the player to parse three
  // numbers and infer which was which; the question they actually have is "how
  // full am I, and what's in there?". A bar answers the first at a glance, and
  // colouring its segments (gold = general, blue = recycling, matching the bins)
  // answers the second without a legend.
  const GOLD = { r: 1, g: 0.82, b: 0.25, a: 1 }
  const BLUE = { r: 0.45, g: 0.68, b: 1, a: 1 }
  const genW = Math.round(trackW * Math.min(1, gen / cap))
  const recW = Math.round(trackW * Math.min(1, rec / cap))
  // Pulse the whole chip when full, so "go empty this" is impossible to miss.
  const pulse = full ? 0.75 + 0.25 * Math.sin(pulseNow() / 140) : 1

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: saPct(sa.bottom + 0.02), left: 0 },
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
      }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: { top: pad, bottom: pad, left: pad, right: Math.round(pad * 1.6) },
          borderRadius: Math.round(22 * S),
        }}
        uiBackground={{ color: theme.hud.bg }}
      >
        <UiEntity
          uiTransform={{ width: icon, height: icon, margin: { right: Math.round(10 * S) } }}
          uiBackground={{ texture: { src: 'assets/scene/UI/carry_bag_chip.png' }, textureMode: 'stretch', color: WHITE }}
        />

        {/* Capacity track — segments sit side by side and grow left to right. */}
        <UiEntity
          uiTransform={{
            width: trackW, height: trackH,
            flexDirection: 'row',
            borderRadius: Math.round(trackH / 2),
            margin: { right: Math.round(10 * S) },
          }}
          uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.14 } }}
        >
          <UiEntity uiTransform={{ width: genW, height: trackH }}
            uiBackground={{ color: { ...GOLD, a: pulse } }} />
          <UiEntity uiTransform={{ width: recW, height: trackH }}
            uiBackground={{ color: { ...BLUE, a: pulse } }} />
        </UiEntity>

        <Label
          value={`${gen + rec}/${cap}`}
          fontSize={font}
          color={full ? theme.colors.warning : WHITE}
        />

        {full && (
          <Label
            value="  FULL"
            fontSize={Math.round(22 * S)}
            color={{ r: 1, g: 0.55, b: 0.2, a: pulse }}
          />
        )}

        {/* Portable Bin: "EMPTY 1/2" = uses left / uses per shift (feedback:
            the prose version was too long for the chip). The shop row already
            teaches what the upgrade does; here the count is what matters.
            Greyed (secondary) with empty hands — the server re-validates. */}
        {getPortableLeft() > 0 && (
          <GameButton
            value={`EMPTY ${getPortableLeft()}/${upgradeValue('portableBin', upgradeLevel('portableBin'))}`}
            variant={gen + rec > 0 ? 'primary' : 'secondary'}
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(116 * S), height: Math.round(44 * S), margin: { left: Math.round(12 * S) } }}
            onMouseDown={() => requestPortableEmpty()}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

// Root wrapper: constrains ALL scene UI to the renderer-reported DEVICE safe
// margins (notch, status bar, home indicator, rounded corners) via the SDK's
// ScreenInsetArea. Desktop insets are typically zero, so this is a no-op
// there. Complementary to getSafeArea(), which handles the EXPLORER's own
// chrome (chat, minimap, profile) — two different fields of
// UiCanvasInformation, both needed.
// A scrim must cover the PHYSICAL screen, and inside ScreenInsetArea '100%'
// means only the notch-safe region — so the lobby darkness started just after
// the device's speaker inset (playtest). The darkness is therefore drawn here,
// OUTSIDE the inset, while the screens' CONTENT stays inset and clear of the
// notch. Mirrors uiBody's screen order: career intro > lobby > spectate.
const scrimActive = (): boolean => {
  const phase   = getGameState()?.phase ?? 'lobby'
  const waiting = isWaitingForMatch()
  const isLobby = phase === 'lobby'
  // Never dim a LIVE camera. Spectating counts as `waiting`, so the waiting
  // scrim was being painted straight over the club the spectator came to
  // watch. The career intro keeps its own opaque backdrop, so it still reads
  // correctly if it lands during a spectate session.
  if (isSpectating()) return false
  return isLobby || waiting || shouldShowCareerIntro(isLobby || waiting)
}

// BALANCED inset container instead of the SDK's ScreenInsetArea: the stock
// component insets each side by its own device margin, so with a notch on one
// side the safe region's centre sits half-a-notch off the PHYSICAL centre —
// and every centred row with it ("all the centred UI is ~1cm right of the DCL
// cursor", playtest). Insetting both horizontal sides by max(left, right)
// keeps edge anchors notch-safe while making container-centre == physical
// centre, where the crosshair is. Same data source as the SDK component.
// How much of the DEVICE screen inset this scene applies itself.
//
// 1 = we inset the whole reported margin (the original behaviour, from when the
// explorer applied none of it to scene UI). 0 = trust the explorer entirely.
//
// TUNE HERE if the HUD sits wrong after an explorer update. DCL shipped a UI
// change on 2026-08-18 and the HUD immediately read as "everything slightly
// closer to the centre" — the signature of the inset being applied TWICE, ours
// on top of theirs. Dropped to 0 on that reading. If a notched phone now shows
// HUD edges under the notch, the explorer is NOT insetting after all: put this
// back to 1. (Anything between is a legitimate middle ground.)
const SCREEN_INSET_SCALE = 0

const ui = () => {
  const raw = getScreenInsets()
  const inset = {
    top:    raw.top    * SCREEN_INSET_SCALE,
    bottom: raw.bottom * SCREEN_INSET_SCALE,
    left:   raw.left   * SCREEN_INSET_SCALE,
    right:  raw.right  * SCREEN_INSET_SCALE,
  }
  const h = Math.max(inset.left, inset.right)
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {scrimActive() && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%' }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.82 } }}
        />
      )}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: inset.top, left: h, right: h, bottom: inset.bottom },
        }}
      >
        {uiBody()}
      </UiEntity>
    </UiEntity>
  )
}

// Hoisted render literals — rebuilt per frame otherwise.
const FULL_SCREEN_SCRIM_C = { width: '100%' as const, height: '100%' as const }
const FULL_WIDTH_ROW_C = {
  width: '100%' as const,
  flexDirection: 'row' as const,
  justifyContent: 'center' as const,
}

const uiBody = () => {
  const gs            = getGameState()
  const cleaned       = gs?.cleanedCount ?? 0
  const total         = Math.max(1, gs?.totalCount ?? 1)
  const seconds       = gs?.secondsLeft ?? 0
  const phase         = gs?.phase ?? 'lobby'
  const roundNumber   = gs?.roundNumber ?? 0
  const outcome       = gs?.outcome ?? ''
  const isFinale      = gs?.isFinale ?? false
  const pct           = Math.min(1, cleaned / total)
  const isOpen        = phase === 'open'
  const isLobby       = phase === 'lobby'
  // Themed round — server-rolled; '' (or an unknown id from a newer server) = classic.
  const themeDef      = THEME_DEFS.find((t) => t.id === (gs?.theme ?? '')) ?? null
  // Last-call grace window — 100% reached early; secondsLeft counts it down.
  const lastCall      = gs?.lastCall ?? false
  const starting      = gs?.starting ?? false
  const playersIn     = gs?.playersIn ?? 0
  const waiting       = isWaitingForMatch()

  // isMobile() resolves asynchronously — returns false until the client reports
  // its platform, after which the renderer re-runs and picks up the correct values.
  const mobile = isMobile()
  const S      = mobile ? MOBILE_SCALE : 1

  // The shop has two presentations, chosen by what is behind it.
  //
  // During the intermission it is a side PANEL: that phase is the game's payoff —
  // crowd arrives, confetti, party music, the player's own emote — and a
  // full-screen modal would black out the exact reward the shift was earned for.
  //
  // Everywhere else — lobby, spectating, and ALL of mobile — it is a full-screen
  // MODAL. Lobby/spectate are already scrims; and on a phone the side panel ate
  // half the screen while its content overflowed the short viewport, pushing
  // CLOSE off-screen — the modal centres everything with room to spare.
  // Career intro / welcome-back card — replaces the lobby or spectate screen
  // once per session, until dismissed. Never interrupts active cleaning (an
  // admin preview is the one exception; see shouldShowCareerIntro).
  if (shouldShowCareerIntro(isLobby || waiting)) {
    return <CareerIntroOverlay S={S} />
  }

  // Side panel whenever the club is visible behind it (playing OR intermission)
  // on desktop: a full-screen modal mid-shift would black out the timer and the
  // room while the clock runs. Lobby and spectate have nothing worth preserving
  // behind them, and a phone has no room for a side panel, so those get the
  // modal (which is also the only path that renders in those screens).
  const shopAsPanel = isShopOpen() && !mobile && !isLobby && !waiting
  if (isShopOpen() && !shopAsPanel) {
    return <UpgradeShopOverlay S={S} />
  }

  const instrW       = mobile ? INSTR_W_MOBILE : INSTR_W_DESKTOP
  const instrH       = mobile ? INSTR_H_MOBILE : INSTR_H_DESKTOP
  const timerIconSz  = Math.round(TIMER_ICON_SIZE   * S)
  const timerFont    = Math.round(TIMER_FONT_SIZE    * S)
  const stripWidth   = Math.round(STRIP_WIDTH        * S)
  const roundFont    = Math.round(ROUND_FONT_SIZE    * S)
  const meterFont    = Math.round(METER_FONT_SIZE    * S)
  const barHeight    = Math.round(BAR_HEIGHT         * S)
  const barFullW     = mobile ? BAR_FULL_W_MOBILE : BAR_FULL_W_DESKTOP
  const barLabelW    = Math.round(BAR_LABEL_W        * S)
  const barTrackW    = barFullW - barLabelW - BAR_LABEL_GAP
  const holdBarW     = mobile ? HOLD_BAR_W_MOBILE : HOLD_BAR_W_DESKTOP
  const holdBarHeight = Math.round(HOLD_BAR_HEIGHT * S)

  // Action flash animation — quick cubic pop of the font, then a fade-out.
  // PERFECT pops big and gold, SPREE mid-size and orange, MISSED small and red.
  const perfectElapsed = perfectFlashStartMs >= 0 ? Date.now() - perfectFlashStartMs : Infinity
  const perfectPop     = Math.min(1, perfectElapsed / 250)
  const perfectEase    = 1 - Math.pow(1 - perfectPop, 3)
  const perfectAlpha   = perfectElapsed < 400 ? 1 : Math.max(0, 1 - (perfectElapsed - 400) / (PERFECT_FLASH_MS - 400))
  const flashSizes     = perfectFlashKind === 'perfect' ? [34, 64]
    : perfectFlashKind === 'spree' ? [34, 56]   // badge multiplier — bigger since the kicker carries the words
    : perfectFlashKind === 'cancel' ? [20, 28]
    : [24, 40]
  const perfectFont    = Math.round(lerp(flashSizes[0], flashSizes[1], perfectEase) * S)
  const flashText      = perfectFlashKind === 'perfect'
    ? (perfectFlashStreak > 1 ? `PERFECT ×${perfectFlashStreak}!` : 'PERFECT!')
    : perfectFlashKind === 'spree'
    ? (perfectFlashFrenzy ? `FRENZY SPREE ×${perfectFlashStreak}!` : `SPREE ×${perfectFlashStreak}!`)
    : perfectFlashKind === 'cancel'
    ? `✕ ${cancelFlashText}`
    : 'MISSED!'
  const flashColor     = perfectFlashKind === 'perfect'
    ? { r: 1, g: 0.82, b: 0.25, a: perfectAlpha }
    : perfectFlashKind === 'spree'
    ? (perfectFlashFrenzy
      ? { r: 1, g: 0.45, b: 0.25, a: perfectAlpha }
      : { r: 1, g: 0.62, b: 0.2,  a: perfectAlpha })
    : perfectFlashKind === 'cancel'
    ? { r: 0.8, g: 0.8, b: 0.85, a: perfectAlpha }
    : { r: 1, g: 0.35, b: 0.3,  a: perfectAlpha }

  // Deposit flash — reads carrySystem's last-deposit state (no setter import,
  // which would cycle). "+N BINNED/RECYCLED!" pops right after a bin empty.
  const dep        = getLastDeposit()
  const depElapsed = dep.ms >= 0 ? Date.now() - dep.ms : Infinity
  const depEase    = 1 - Math.pow(1 - Math.min(1, depElapsed / 250), 3)
  const depFont    = Math.round(lerp(26, 46, depEase) * S)
  const depAlpha   = depElapsed < 400 ? 1 : Math.max(0, 1 - (depElapsed - 400) / (PERFECT_FLASH_MS - 400))
  const btnH         = Math.round(BTN_HEIGHT         * S)
  const toastW       = mobile ? TOAST_W_MOBILE : TOAST_W_DESKTOP
  const toastH       = mobile ? TOAST_H_MOBILE : TOAST_H_DESKTOP
  const toastOverlap = -Math.round(toastH * TOAST_OVERLAP)
  // Toast text scales with the BUBBLE, not with MOBILE_SCALE. Both labels are
  // positioned as fractions of the toast rect and sit inside fixed speech-bubble
  // art, so any font that scales independently of the rect will eventually spill
  // out of the artwork. Deriving it from the rect makes overflow impossible by
  // construction, whatever the bubble is resized to later.
  const toastScale   = toastW / TOAST_W_DESKTOP
  const toastFont    = Math.round(TOAST_FONT_SIZE    * toastScale)
  const narrFont     = Math.round(NARR_FONT_SIZE     * toastScale)
  // While the side-panel shop is open the stack anchors LEFT of the panel —
  // toasts landed on top of the upgrade rows otherwise (playtest screenshot).
  const toastPos     = mobile
    ? TOAST_POS_MOBILE
    : shopAsPanel
      ? { top: TOAST_POS_DESKTOP.top, right: shopPanelWidth(S) + 16 }
      : TOAST_POS_DESKTOP
  const toastAlign   = mobile ? 'flex-start' as const : 'flex-end' as const
  // When the round-end banner fills the centre of the screen (desktop only),
  // push the toast stack down by 2 slots so it clears the banner.
  // Mobile toasts anchor at top:9% — already above the banner — no offset needed.
  // introHolding is computed after elapsedS/introActive below and factored in there.

  // Colour bands + phase edges are advanced by uiStateSystem (render is a pure
  // read); barColor/timerColor just render whatever it left behind.
  const barColor = currentBarColor
  // Gold during last call — the countdown is a victory lap, not a deadline.
  const timerColor = lastCall ? { r: 1, g: 0.82, b: 0.25, a: 1 } : currentTimerColor

  // ── Shared lerp targets (used by both intro and outcome animations) ───────────
  // eased = 0 → image at centre/big;  eased = 1 → image at normal top position
  const introImgW   = Math.round(instrW * INTRO_SIZE_MULT)
  const introImgH   = Math.round(instrH * INTRO_SIZE_MULT)
  const centredTop  = Math.round(INTRO_CENTER_Y - introImgH / 2)
  const normTop     = INSTR_MARGIN_TOP

  // ── Intro animation (centre → normal): player entry or round start ────────────
  // introHoldS = INTRO_HOLD_S for player entry (holds at centre), 0 for round start (snaps immediately).
  const elapsedS      = introStartMs >= 0 ? (Date.now() - introStartMs) / 1000 : 9999
  const introActive   = elapsedS < introHoldS + INTRO_TWEEN_S
  // Banner is at centre when: round-end outcome is showing, OR intro is in its hold phase.
  const introHolding  = introActive && elapsedS < introHoldS
  const toastTopSlots = (isOpen || introHolding) && !mobile ? 2 : 0
  const introProgress = elapsedS < introHoldS ? 0
    : Math.min(1, (elapsedS - introHoldS) / INTRO_TWEEN_S)
  // Two curves: position eases out smoothly (no overshoot — avoids clipping the
  // top of the canvas), while size uses EF_EASEOUTBACK so the banner springs in
  // with a little pop as it settles to its normal scale.
  const easedPos        = applyEasing(introProgress, EasingFunction.EF_EASEOUTCUBIC)
  const easedSize       = applyEasing(introProgress, EasingFunction.EF_EASEOUTBACK)
  const animW           = Math.round(lerp(introImgW, instrW,    easedSize))
  const animH           = Math.round(lerp(introImgH, instrH,    easedSize))
  const animTop         = Math.round(lerp(centredTop,  normTop,  easedPos))
  // Timer tracks the image: position with the smooth curve, scale with the pop.
  const timerAnimTop    = Math.round(lerp(INTRO_CENTER_Y + INTRO_TIMER_BELOW, TIMER_ROW_TOP, easedPos))
  const animTimerIconSz = Math.round(lerp(timerIconSz * INTRO_SIZE_MULT, timerIconSz, easedSize))
  const animTimerFont   = Math.round(lerp(timerFont   * INTRO_SIZE_MULT, timerFont,   easedSize))

  // ── Outcome animation (normal → centre): round ends ──────────────────────────
  // Ease-out feel: moves quickly from normal position then settles at centre.
  const outcomeSec      = outcomeStartMs >= 0 ? (Date.now() - outcomeStartMs) / 1000 : 9999
  const outcomeProgress = Math.min(1, outcomeSec / INTRO_TWEEN_S)
  // EF_EASEOUTBACK overshoots slightly past the centred size before settling,
  // giving the outcome banner a punchy "zoom-in" as the round ends.  1→0 maps
  // normal-position (progress 0) to centre/big (progress 1).
  const outcomeEased    = 1 - applyEasing(outcomeProgress, EasingFunction.EF_EASEOUTBACK)
  const outcomeAnimW    = Math.round(lerp(introImgW, instrW,    outcomeEased))
  const outcomeAnimH    = Math.round(lerp(introImgH, instrH,    outcomeEased))
  const outcomeAnimTop  = Math.round(lerp(centredTop,  normTop,  outcomeEased))

  // Source for the "settled" image slot (instructions or outcome card).
  // Milestones show the round's REAL outcome card like any other round — the
  // old "CLUB COMPLETE" banner read as an ending, which V2's endless loop no
  // longer has (playtest: "very misleading"). The milestone still gets its
  // longer hold, confetti, crowd and the next-shift countdown. If bespoke
  // "MILESTONE!" art lands, swap it in here behind isFinale.
  const topImageSrc = isOpen
    ? (OUTCOME_IMAGES[outcome] ?? OUTCOME_IMAGES['suboptimal'])
    : 'assets/scene/UI/InstructionsUI.png'

  // Full-bleed overlays must NOT use virtual-px widths. The renderer fits the 1920x1080
  // virtual canvas INSIDE the screen (scale = min(w/vw, h/vh) / dpr), so on any
  // aspect wider than 16:9 a VIRT_W-wide box stops short of the screen edges —
  // leaving the scene visible in bands beside a dark panel, reported as "there's
  // a gray layout when waiting for a match". Percentages resolve against the real
  // screen and always cover it.
  const FULL_SCREEN_SCRIM = FULL_SCREEN_SCRIM_C
  // Rows that centre their content across the full screen. justifyContent:'center'
  // needs a definite width to centre within; '100%' gives it one that matches the
  // scrim, so text stays centred on the actual screen rather than on the 1920 box.
  const FULL_WIDTH_ROW = FULL_WIDTH_ROW_C

  // ── HUD backdrop geometry — tracks the banner wherever it is ─────────────────
  // The backdrop follows the banner image's CURRENT rect so the scrim moves WITH
  // the banner as it flies in on round start (intro) or sits centred during the
  // intermission/outcome — instead of staying pinned at the settled top position.
  const bannerTop  = isOpen ? outcomeAnimTop  : (introActive ? animTop  : normTop)
  const bannerW    = isOpen ? outcomeAnimW    : (introActive ? animW    : instrW)
  const bannerH    = isOpen ? outcomeAnimH    : (introActive ? animH    : instrH)

  const hudBgTop   = bannerTop  - HUD_BG_PAD_TOP
  const hudBgWidth = bannerW + HUD_BG_PAD_X * 2
  const hudBgBottomY = isOpen
    // Intermission: cover the centred card + the next-round controls beneath it.
    ? bannerTop + bannerH + LABEL_MARGIN_SMALL + btnH + HUD_BG_PAD_BOT
    : introActive
      // Round-start intro: just wrap the flying banner so the scrim moves with it.
      ? bannerTop + bannerH + HUD_BG_PAD_BOT
      // Settled gameplay HUD: stretch down to cover the timer / bar / round label.
      : STRIP_TOP + Math.round(roundFont * 1.5) + HUD_BG_PAD_BOT
  const hudBgHeight  = hudBgBottomY - hudBgTop

  // (The achieved-cleanliness % and finale countdown that used to be laid out
  // here now live inside the shift report card, which sizes itself.)

  // ── Lobby overlay — gather + START a match. Replaces the whole HUD. ───────────
  // Centering uses the same mechanism as the HUD timer/banner: each element sits in
  // a full-VIRT_W row with justifyContent:'center' (flex alignItems does NOT centre
  // reliably in this renderer). The column's justifyContent:'center' centres the
  // stack vertically. Fonts scale by S for mobile legibility.
  // ── Pre-sync — no GameState yet (cold server boot / CRDT still syncing) ──────
  // Without this branch the null phase fell through as 'lobby', which showed a
  // full lobby screen — live START NOW included — to a player who might really
  // be joining mid-round; their stale press could genuinely start a match the
  // moment the server dropped to the lobby (see the presence-timeout note in
  // server.ts). A joiner sees this holding screen for the first moments instead.
  if (!gs) {
    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute', position: { top: 0, left: 0 },
          ...FULL_SCREEN_SCRIM,
          flexDirection: 'column', justifyContent: 'center',
        }}
        /* darkness drawn full-bleed in ui() — inner bg removed to avoid a double-dark seam at the inset edge */
      >
        <UiEntity uiTransform={{ ...FULL_WIDTH_ROW, margin: { bottom: Math.round(14 * S) } }}>
          <Label value="Connecting to the club…" fontSize={Math.round(40 * S)} color={WHITE} />
        </UiEntity>
        <UiEntity uiTransform={FULL_WIDTH_ROW}>
          <Label value="The night is loading. One second." fontSize={Math.round(22 * S)} color={COLOR_SUBTLE} />
        </UiEntity>
      </UiEntity>
    )
  }

  if (isLobby) {
    const titleW = mobile ? 1040 : 820
    const titleH = Math.round(titleW / 8)            // InstructionsUI.png is 1024×128 (8:1)
    const centeredRow = FULL_WIDTH_ROW
    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute', position: { top: 0, left: 0 },
          ...FULL_SCREEN_SCRIM,
          flexDirection: 'column', justifyContent: 'center',
        }}
        /* darkness drawn full-bleed in ui() — inner bg removed to avoid a double-dark seam at the inset edge */
      >
        <UiEntity uiTransform={{ ...centeredRow, margin: { bottom: Math.round(30 * S) } }}>
          <UiEntity
            uiTransform={{ width: titleW, height: titleH }}
            uiBackground={{ texture: { src: 'assets/scene/UI/InstructionsUI.png' }, textureMode: 'stretch', color: WHITE }}
          />
        </UiEntity>
        {/* Copy matches what the club actually does now: shifts run back to back
            and the lobby auto-starts, so this is a "next shift" beat rather than
            V1's manual gate ("sent back to the lobby… doesn't work well for the
            new game style"). */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { bottom: Math.round(14 * S) } }}>
          <Label value="The mess never sleeps — every shift pays."
            fontSize={Math.round(26 * S)} color={COLOR_SUBTLE} />
        </UiEntity>
        <UiEntity uiTransform={{ ...centeredRow, margin: { bottom: Math.round(30 * S) } }}>
          <Label value={`Cleaners in the club: ${playersIn}`}
            fontSize={Math.round(32 * S)} color={WHITE} />
        </UiEntity>
        <UiEntity uiTransform={centeredRow}>
          {starting ? (
            <Label value={`Next shift in ${seconds}…`} fontSize={Math.round(64 * S)} color={WHITE} />
          ) : (
            <GameButton
              value="START NOW"
              variant="primary"
              fontSize={Math.round(34 * S)}
              uiTransform={{ width: Math.round(360 * S), height: Math.round(92 * S) }}
              onMouseDown={() => room.send('startMatch', { dummy: true })}
            />
          )}
        </UiEntity>

        {/* GDD: "players can browse upgrades while waiting for the next match". */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(18 * S) } }}>
          <ShopButton S={S} />
        </UiEntity>

        {/* Absolutely positioned, so it sits in the same bottom-left spot here as
            it does in the in-shift HUD rather than jumping between screens. */}
        <CareerBar S={S} withMusicButton={true} />
      </UiEntity>
    )
  }

  // ── Spectate HUD — the camera is live behind this, so the screen stays almost
  // clear: a chip naming who's being watched, and a control row at the bottom.
  // The sign-up button rides along so watching never delays joining. All exits
  // (STOP, promotion, lobby, targets gone) drop back to the waiting overlay
  // below, because isSpectating() flips false.
  if (waiting && isSpectating()) {
    const target     = spectateTargetInfo()
    const titleColor = target && target.title ? tierColorForRank(target.rank) : COLOR_SUBTLE
    const chipTop    = mobile ? '12%' : Math.round(24 * S)   // clears the profile icons on phones
    return (
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, ...FULL_SCREEN_SCRIM }}>
        <UiEntity uiTransform={{ ...FULL_WIDTH_ROW, positionType: 'absolute', position: { top: chipTop } }}>
          <UiEntity
            uiTransform={{
              flexDirection: 'row', alignItems: 'center',
              height: Math.round(52 * S),
              padding: { left: Math.round(20 * S), right: Math.round(22 * S) },
              borderRadius: Math.round(26 * S),
            }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.72 } }}
          >
            <UiEntity
              uiTransform={{
                width: Math.round(13 * S), height: Math.round(13 * S),
                borderRadius: Math.round(7 * S),
                margin: { right: Math.round(10 * S) },
              }}
              uiBackground={{ color: { r: 1, g: 0.23, b: 0.23, a: 1 } }}
            />
            <Label value={`LIVE — ${target?.name ?? '…'}`} fontSize={Math.round(24 * S)} color={WHITE} />
            {target && target.title ? (
              <Label
                value={`  ${target.title.toUpperCase()}`}
                fontSize={Math.round(20 * S)}
                color={titleColor}
              />
            ) : null}
          </UiEntity>
        </UiEntity>

        {/* The clock never disappears while watching (field report: "as a
            player I want to know how long until I can actually play") — the
            round countdown mid-shift, the next-shift countdown in between. */}
        <UiEntity uiTransform={{ ...FULL_WIDTH_ROW, positionType: 'absolute', position: { top: mobile ? '19%' : Math.round(86 * S) } }}>
          <Label
            value={isOpen
              ? `Next shift in ${seconds}s`
              : `Shift ends in ${formatTime(seconds)}`}
            fontSize={Math.round(22 * S)}
            color={COLOR_SUBTLE}
          />
        </UiEntity>

        {/* Camera controls — tap-to-step on purpose: each press swings the
            orbit 45° or steps the zoom, and the camera's own lerp glides it
            there. Discrete, player-commanded moves; nothing to get stuck held
            down, and no continuous motion to churn stomachs. */}
        <UiEntity
          uiTransform={{
            ...FULL_WIDTH_ROW, alignItems: 'center',
            positionType: 'absolute', position: { bottom: mobile ? '21%' : '13%' },
          }}
        >
          {/* Direction sign: "<" must pan the VIEW leftward (target slides right)
              — playtest reported the first wiring as inverted. */}
          <GameButton
            value="ORBIT <"
            variant="secondary"
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(140 * S), height: Math.round(60 * S), margin: { right: Math.round(10 * S) } }}
            onMouseDown={() => stepSpectateOrbit(1)}
          />
          <GameButton
            value="ZOOM -"
            variant="secondary"
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(140 * S), height: Math.round(60 * S), margin: { right: Math.round(10 * S) } }}
            onMouseDown={() => stepSpectateZoom(1)}
          />
          <GameButton
            value="ZOOM +"
            variant="secondary"
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(140 * S), height: Math.round(60 * S), margin: { right: Math.round(10 * S) } }}
            onMouseDown={() => stepSpectateZoom(-1)}
          />
          <GameButton
            value="ORBIT >"
            variant="secondary"
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(140 * S), height: Math.round(60 * S) }}
            onMouseDown={() => stepSpectateOrbit(-1)}
          />
        </UiEntity>

        <UiEntity
          uiTransform={{
            ...FULL_WIDTH_ROW, alignItems: 'center',
            positionType: 'absolute', position: { bottom: mobile ? '10%' : '4%' },
          }}
        >
          <GameButton
            value="< PREV"
            variant="secondary"
            fontSize={Math.round(22 * S)}
            uiTransform={{ width: Math.round(150 * S), height: Math.round(70 * S), margin: { right: Math.round(12 * S) } }}
            onMouseDown={() => nextSpectateTarget(-1)}
          />
          {isSignedUp() ? (
            <GameButton
              value="SIGNED UP — CANCEL"
              variant="secondary"
              fontSize={Math.round(22 * S)}
              uiTransform={{ width: Math.round(320 * S), height: Math.round(70 * S) }}
              onMouseDown={() => cancelSignUp()}
            />
          ) : (
            <GameButton
              value="JOIN NEXT SHIFT"
              variant="primary"
              fontSize={Math.round(24 * S)}
              uiTransform={{ width: Math.round(320 * S), height: Math.round(70 * S) }}
              onMouseDown={() => signUpForNextShift()}
            />
          )}
          <GameButton
            value="NEXT >"
            variant="secondary"
            fontSize={Math.round(22 * S)}
            uiTransform={{ width: Math.round(150 * S), height: Math.round(70 * S), margin: { left: Math.round(12 * S) } }}
            onMouseDown={() => nextSpectateTarget(1)}
          />
          <GameButton
            value="STOP"
            variant="secondary"
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(110 * S), height: Math.round(70 * S), margin: { left: Math.round(24 * S) } }}
            onMouseDown={() => exitSpectate('user')}
          />
        </UiEntity>
      </UiEntity>
    )
  }

  // ── Waiting overlay — a match is already in progress; join the next one. ──────
  if (waiting) {
    const centeredRow = FULL_WIDTH_ROW
    return (
      <UiEntity
        uiTransform={{
          positionType: 'absolute', position: { top: 0, left: 0 },
          ...FULL_SCREEN_SCRIM,
          flexDirection: 'column', justifyContent: 'center',
        }}
        /* darkness drawn full-bleed in ui() — inner bg removed to avoid a double-dark seam at the inset edge */
      >
        {/* Was titled "Spectating" — which promised a camera this screen does
            not have (field report: "it says spectating but the player isn't
            put into spectate mode"). This is the WAITING screen; the camera is
            behind WATCH LIVE below. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { bottom: Math.round(16 * S) } }}>
          <Label value="Shift in progress" fontSize={Math.round(56 * S)} color={WHITE} />
        </UiEntity>

        {/* Next-shift countdown. During the intermission secondsLeft counts down
            to the next round; mid-round it counts the CURRENT round out, which
            is the same answer a waiting player needs — "how long until I can
            actually play" (field report: the old text gave no number here). */}
        <UiEntity uiTransform={centeredRow}>
          <Label
            value={isOpen
              ? `Next shift starts in ${seconds}s`
              : `Next shift when this round ends — ${formatTime(seconds)} left`}
            fontSize={Math.round(30 * S)}
            color={WHITE}
          />
        </UiEntity>

        {/* Pre sign-up — the GDD specifies opting in rather than auto-enrolling, so
            arriving never drops a player into a shift they didn't choose. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(24 * S) } }}>
          {isSignedUp() ? (
            <GameButton
              value="SIGNED UP — CANCEL"
              variant="secondary"
              fontSize={Math.round(26 * S)}
              uiTransform={{ width: Math.round(360 * S), height: Math.round(76 * S) }}
              onMouseDown={() => cancelSignUp()}
            />
          ) : (
            <GameButton
              value="JOIN NEXT SHIFT"
              variant="primary"
              fontSize={Math.round(28 * S)}
              uiTransform={{ width: Math.round(360 * S), height: Math.round(76 * S) }}
              onMouseDown={() => signUpForNextShift()}
            />
          )}
        </UiEntity>

        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(10 * S) } }}>
          <Label
            value={isSignedUp()
              ? "You're in — you'll start cleaning next round."
              : 'Watch until you\'re ready, then join.'}
            fontSize={Math.round(22 * S)}
            color={COLOR_SUBTLE}
          />
        </UiEntity>

        {/* Live camera on the crew — makes "watch until you're ready" literal.
            ALWAYS offered (was gated on spectateTargetCount() > 0, which on
            mobile flickered to zero whenever the remote cleaner's avatar
            transform hadn't streamed — the button vanished for whole rounds).
            An unwatchable instant now answers with a toast instead of a
            missing button; the roster refreshes every half second. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(14 * S) } }}>
          <GameButton
            value="WATCH LIVE"
            variant="secondary"
            fontSize={Math.round(26 * S)}
            uiTransform={{ width: Math.round(360 * S), height: Math.round(76 * S) }}
            onMouseDown={() => {
              if (!enterSpectate()) showNarrativeToast('No one to watch just yet — try again in a moment')
            }}
          />
        </UiEntity>

        {/* Waiting is the natural moment to spend earnings, and gives the wait a
            purpose rather than leaving players staring at a scrim. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(22 * S) } }}>
          <ShopButton S={S} />
        </UiEntity>

        <CareerBar S={S} withMusicButton={true} />
      </UiEntity>
    )
  }

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%' }}
    >

      {/* ── Career HUD + end-of-shift payout ─────────────────────────────────────
           The payout sits at 56% height, well clear of the top-centre banner stack
           (outcome image, % figure, countdown) so it can never collide with them —
           the failure mode that produced the narrative/speech-bubble overlap. It
           renders only during the intermission, and only once a payout has arrived. */}
      {/* Hidden while the side panel is open: the bar's top-right anchor sits in
          the panel's footprint, and the panel header already shows the wallet. */}
      {!shopAsPanel && <CareerBar S={S} withShopButton={mobile && !isShopOpen()} withMusicButton={true} />}
      {/* The whole intermission in one centred card — outcome art, grade, score,
          payout and countdown. Self-centring, so it can't overflow. */}
      {isOpen && <ShiftPayoutPanel S={S} imageSrc={topImageSrc} pct={pct} seconds={seconds} />}
      {/* Countdown chip — whenever the card is away (dismissed, or the promotion
          banner has the stage), the next-shift clock stays answered up top. */}
      {isOpen && !isPayoutCardShowing() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: TIMER_ROW_TOP, left: 0 },
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{
              padding: {
                top: Math.round(6 * S), bottom: Math.round(6 * S),
                left: Math.round(16 * S), right: Math.round(16 * S),
              },
              borderRadius: Math.round(14 * S),
            }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.65 } }}
          >
            <Label
              value={`Next shift in 0:${seconds < 10 ? '0' : ''}${seconds}`}
              fontSize={Math.round(26 * S)}
              color={countdownColor(seconds)}
            />
          </UiEntity>
        </UiEntity>
      )}
      {/* Transient PROMOTED banner — self-hides a few seconds after a rank-up.
          During the intermission it has the screen to itself (card + shop wait). */}
      <PromotionBanner S={S} centerStage={isOpen} />

      {/* Rubbish carry count — live while cleaning; hidden during the intermission,
          when there is nothing in hand to track (round start resets it anyway). */}
      {!isOpen && <CarryChip S={S} />}

      {/* Music mute now lives in the CareerBar dock on BOTH platforms (KJ:
          "on desktop let's put the mute button under the career ladder
          section, top right") — one tidy audio corner instead of a stray
          top-left button. See CareerBar's withMusicButton. */}

      {/* Shop access — available at ANY time, not just between shifts.
          Upgrades apply the moment they are bought, so buying Movement Speed or
          Strength mid-shift is a "feel it immediately" moment; gating it to the
          intermission only added a wait. The round keeps running while the shop
          is open, which makes it a real trade-off rather than a free pause.
          DESKTOP ONLY: on mobile the bottom-right corner is the explorer's jump
          cluster and even safe-area anchoring landed on it (device-verified), so
          there the button docks under the career bar instead — see CareerBar's
          withShopButton. Hidden while the side panel is open, which occupies
          that side. */}
      {!mobile && !shopAsPanel && !isShopOpen() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: {
              bottom: saPct(getSafeArea().bottom + 0.03),
              right:  saPct(getSafeArea().right + 0.02),
            },
          }}
        >
          <ShopButton S={S} />
        </UiEntity>
      )}

      {/* Side-panel shop — leaves the celebration playing behind it. */}
      {shopAsPanel && <UpgradeShopPanel S={S} />}

      {/* ── HUD backdrop — renders first so it sits behind all other elements ───
           Horizontally centred by a full-width flex row rather than computed
           left offsets: virtual-px arithmetic drifts off true centre on displays
           where the canvas mapping misreports (the mobile "shifted left" bug),
           while '100%' always resolves to the real screen.

           Hidden during the intermission: it was sized to the outcome banner,
           which the shift report card has replaced, so it would otherwise be a
           dark rectangle floating behind nothing. ───────────────────────────── */}
      {!isOpen && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position:     { top: hudBgTop, left: 0 },
            width:        '100%',
            flexDirection: 'row',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{ width: hudBgWidth, height: hudBgHeight, borderRadius: Math.round(18 * S) }}
            uiBackground={{ color: HUD_BG_COLOR }}
          />
        </UiEntity>
      )}

      {/* ── Top image slot — hidden whenever an animated overlay covers it. ───── */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position:     { top: INSTR_MARGIN_TOP, left: 0 },
          width:        '100%',
          flexDirection: 'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          // Rounded to match the rest of the HUD — borderRadius masks the
          // texture, so the banner PNG's square corners are clipped away.
          uiTransform={{ width: instrW, height: instrH, borderRadius: Math.round(16 * S) }}
          uiBackground={{
            texture:     { src: topImageSrc },
            textureMode: 'stretch',
            color:       (introActive || isOpen) ? { r: 1, g: 1, b: 1, a: 0 } : WHITE,
          }}
        />
      </UiEntity>

      {/* ── Intro overlay — centre → normal (player entry or round start) ─────── */}
      {introActive && !isOpen && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position:     { top: animTop, left: 0 },
            width:        '100%',
            flexDirection: 'row',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{ width: animW, height: animH }}
            uiBackground={{
              texture:     { src: 'assets/scene/UI/InstructionsUI.png' },
              textureMode: 'stretch',
              color:       WHITE,
            }}
          />
        </UiEntity>
      )}

      {/* The outcome banner, the standalone "% Clean" figure and the finale
          countdown all used to live here as separate top-centre overlays. They
          are now the header, score line and footer of the single shift report
          card (ShiftPayoutPanel) — one thing to read instead of three competing
          for the same screen space. The confetti, crowd and music still play
          around it, which is what the intermission is actually for. */}

      {/* ── Timer row: icon left, big bold countdown right ───────────────────── */}
      {/* Hidden during intro — the intro timer overlay takes over             */}
      {!isOpen && !introActive && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: TIMER_ROW_TOP, left: 0 },
            width:          '100%',
            flexDirection:  'row',
            alignItems:     'center',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{ width: timerIconSz, height: timerIconSz, margin: { right: TIMER_ICON_MARGIN } }}
            uiBackground={{
              texture:     { src: 'assets/scene/UI/TimerIcon.png' },
              textureMode: 'stretch',
              color:       WHITE,
            }}
          />
          <Label value={formatTime(seconds)} fontSize={timerFont} color={timerColor} />
          {/* FRENZY / LAST CALL status pill — see the layout note at the old
              TIMER_STATUS constant site. Mutually exclusive states share the
              slot; the intro timer overlay never carries it (frenzy is a
              round-END state, the intro plays at round start). */}
          {phase === 'playing' && (lastCall || (seconds <= FRENZY_LAST_S && seconds > 0)) && (
            <UiEntity
              uiTransform={{
                margin: { left: Math.round(16 * S) },
                padding: {
                  top: Math.round(5 * S), bottom: Math.round(5 * S),
                  left: Math.round(14 * S), right: Math.round(14 * S),
                },
                borderRadius: Math.round(14 * S),
              }}
              uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.65 } }}
            >
              <Label
                value={lastCall
                  ? 'LAST CALL — doors open early!'
                  : 'FRENZY! Sprees ×2'}
                fontSize={Math.round(19 * S)}
                color={lastCall
                  ? { r: 1, g: 0.82, b: 0.25, a: 0.7 + 0.3 * Math.sin(pulseNow() / 200) }
                  : { r: 1, g: 0.45, b: 0.25, a: 0.7 + 0.3 * Math.sin(pulseNow() / 120) }}
              />
            </UiEntity>
          )}
        </UiEntity>
      )}

      {/* ── Intro timer overlay — tracks the image during the intro animation ── */}
      {introActive && !isOpen && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: timerAnimTop, left: 0 },
            width:          '100%',
            flexDirection:  'row',
            alignItems:     'center',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{ width: animTimerIconSz, height: animTimerIconSz, margin: { right: TIMER_ICON_MARGIN } }}
            uiBackground={{
              texture:     { src: 'assets/scene/UI/TimerIcon.png' },
              textureMode: 'stretch',
              color:       WHITE,
            }}
          />
          <Label value={formatTime(seconds)} fontSize={animTimerFont} color={timerColor} />
        </UiEntity>
      )}

      {/* ── Progress bar row — just below the timer, wider, label to the right ── */}
      {!isOpen && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: BAR_ROW_TOP, left: 0 },
            width:          '100%',
            flexDirection:  'row',
            justifyContent: 'center',
            alignItems:     'center',
          }}
        >
          {/* Track — stadium ends, matching the rest of the rounded chrome */}
          <UiEntity
            uiTransform={{ width: barTrackW, height: barHeight, borderRadius: Math.round(barHeight / 2) }}
            uiBackground={{ color: BAR_BG_COLOR }}
          >
            <UiEntity
              uiTransform={{ width: `${Math.round(pct * 100)}%`, height: '100%', borderRadius: Math.round(barHeight / 2) }}
              uiBackground={{ color: barColor }}
            />
          </UiEntity>
          {/* "X% Clean" label to the right of the bar */}
          <Label
            value={`${Math.round(pct * 100)}% Clean`}
            fontSize={meterFont}
            color={COLOR_DIM}
            uiTransform={{ width: barLabelW, margin: { left: BAR_LABEL_GAP } }}
          />
        </UiEntity>
      )}


      {/* ── Mobile skill-tap catcher — THE WHOLE SCREEN ──────────────────────
           Delivery, not timing, is what keeps failing: the telemetry shows
           every tap that reaches the judge is a HIT (12/13, then 3/3), while
           the taps that "do nothing" never arrive at all. Both previous paths
           are fragile — the world-input poll depends on catching an edge in
           the current frame (coalesced away when the phone slows), and the
           SCRUB pill is a 300×100 target you have to hit while watching a bar.
           A UI element is the one delivery path this explorer is reliable
           about, so during a hold the ENTIRE screen becomes that element. The
           near-zero alpha keeps it hit-testable while invisible; the pill still
           renders on top as the affordance. It exists only while a zone is
           live (≤2.5s), so it cannot swallow anything else meaningful. */}
      {mobile && holdBarVisible && holdZoneStart !== null && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
            width: '100%',
            height: '100%',
          }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.01 } }}
          onMouseDown={() => skillTapHandler?.()}
        />
      )}

      {/* ── Hold-to-clean bar — screen-space, shown only while holding a patch ───
           Width '100%' rather than VIRT_W: percentage width is the only sizing that
           always spans the real canvas, so justifyContent centres on the true
           screen centre on every display (reported off-centre with VIRT_W). */}
      {holdBarVisible && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: HOLD_BAR_TOP, left: 0 },
            width:          '100%',
            flexDirection:  'column',
            justifyContent: 'center',
            alignItems:     'center',
          }}
        >
          <Label
            value={holdZoneStart !== null
              ? (mobile ? 'Tap in the green!' : 'Release in the green!')
              : 'Cleaning…'}
            fontSize={Math.round(HOLD_BAR_FONT * S)}
            color={holdZoneStart !== null ? WHITE : COLOR_DIM}
            uiTransform={{ margin: { bottom: 8 } }}
          />
          {/* Track — rounded like every other bar; the zone band and posts stay
              square (they're precision markers, and mid-track they never touch
              the rounded ends) */}
          <UiEntity
            uiTransform={{ width: holdBarW, height: holdBarHeight, borderRadius: Math.round(holdBarHeight / 2) }}
            uiBackground={{ color: HOLD_BAR_BG_COLOR }}
          >
            {/* Fill */}
            <UiEntity
              uiTransform={{ width: `${Math.round(holdBarProgress * 100)}%`, height: '100%', borderRadius: Math.round(holdBarHeight / 2) }}
              uiBackground={{ color: HOLD_BAR_FILL_COLOR }}
            />
            {/* Skill-check zone — release while the fill edge is inside for an
                instant clean. Pulses to draw the eye; drawn after the fill so it
                stays visible on top, with crisp white edge posts. */}
            {holdZoneStart !== null && (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: 0, left: Math.round(holdZoneStart * holdBarW) },
                  width: Math.round((holdZoneEnd - holdZoneStart) * holdBarW),
                  height: '100%',
                }}
                uiBackground={{ color: { r: 0.2, g: 1, b: 0.45, a: 0.45 + 0.2 * Math.sin(pulseNow() / 140) } }}
              />
            )}
            {holdZoneStart !== null && (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: -2, left: Math.round(holdZoneStart * holdBarW) - 1 },
                  width: 3, height: holdBarHeight + 4,
                }}
                uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.9 } }}
              />
            )}
            {holdZoneStart !== null && (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: -2, left: Math.round(holdZoneEnd * holdBarW) - 1 },
                  width: 3, height: holdBarHeight + 4,
                }}
                uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.9 } }}
              />
            )}
            {/* Fill-edge tick — the "cursor" the player is actually timing. Turns
                gold the moment it enters the green zone: the "NOW!" signal. */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: -5, left: Math.max(0, Math.round(holdBarProgress * holdBarW) - 3) },
                width: 6,
                height: holdBarHeight + 10,
                borderRadius: 3,
              }}
              uiBackground={{
                color: holdZoneStart !== null && holdBarProgress >= holdZoneStart && holdBarProgress <= holdZoneEnd
                  ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                  : WHITE,
              }}
            />
          </UiEntity>

          {/* Mobile skill target — a plain UiEntity with onMouseDown (not the
              react-ecs Button, whose extra chrome was in the mix when taps
              died). UI consumes touches that land on it, so it MUST handle
              them itself; taps off the pill reach the InteractionManager's
              global poll instead — two paths, judge-once safe either way.
              Gold + bigger while the tick is in the green. */}
          {mobile && holdZoneStart !== null && (() => {
            const inZone = holdBarProgress >= holdZoneStart && holdBarProgress <= holdZoneEnd
            return (
              <UiEntity
                uiTransform={{
                  width:  Math.round(340 * S),
                  height: Math.round(110 * S),
                  margin: { top: Math.round(16 * S) },
                  borderRadius: Math.round(30 * S),
                  justifyContent: 'center', alignItems: 'center',
                }}
                uiBackground={{ color: inZone
                  ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                  : { r: 0.35, g: 0.2, b: 0.5, a: 0.9 } }}
                onMouseDown={() => skillTapHandler?.()}
              >
                {/* The Label carries its OWN handler: react-ecs pointer events
                    do not bubble, so a tap landing on the text — dead centre,
                    where players aim — could miss the pill's handler entirely
                    (mobile report: "click scrub at the right time, nothing
                    happens"). Double-fire from label+pill on one tap is safe:
                    resolveSkillCheck nulls activeHold on the first call. */}
                <Label value="SCRUB!" fontSize={Math.round((inZone ? 40 : 32) * S)}
                  color={inZone ? { r: 0.15, g: 0.1, b: 0, a: 1 } : WHITE}
                  onMouseDown={() => skillTapHandler?.()} />
              </UiEntity>
            )
          })()}
        </UiEntity>
      )}

      {/* ── Rhythm Pop ring — a translucent ring shrinks onto the POP! disc each
           beat; tap as it lands. Circles via full borderRadius; both centred in
           a fixed box because React-ECS has no overlap-centring primitive. */}
      {!isOpen && popRingT !== null && (() => {
        const T     = Math.round(90 * S)                       // target disc
        const scale = Math.max(1, 3 - 2 * popRingT)            // ring: 3× → 1×
        const R     = Math.round(T * scale)
        const box   = Math.round(T * 3)
        // The gold moment IS the hit window — same constant as the judgement,
        // so what the player sees is exactly what the game scores.
        const landed = popRingT >= POP_HIT_T
        return (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: '38%', left: 0 },
              width: '100%',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <UiEntity uiTransform={{ width: box, height: box }}>
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: Math.round((box - R) / 2), left: Math.round((box - R) / 2) },
                  width: R, height: R, borderRadius: Math.round(R / 2),
                }}
                uiBackground={{ color: landed
                  ? { r: 1, g: 0.82, b: 0.25, a: 0.45 }   // gold ring = tap NOW
                  : { r: 1, g: 1, b: 1, a: 0.28 } }}
              />
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: Math.round((box - T) / 2), left: Math.round((box - T) / 2) },
                  width: T, height: T, borderRadius: Math.round(T / 2),
                  justifyContent: 'center', alignItems: 'center',
                }}
                uiBackground={{ color: landed
                  ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                  : { r: 1, g: 0.72, b: 0.2, a: 0.85 } }}
              >
                <Label value="POP!" fontSize={Math.round((landed ? 30 : 24) * S)} color={{ r: 0.15, g: 0.1, b: 0, a: 1 }} />
              </UiEntity>
            </UiEntity>
            {/* One-line rule — a brand-new mechanic teaches itself in place. */}
            <Label
              value="Tap when it turns GOLD!"
              fontSize={Math.round(20 * S)}
              color={{ r: 1, g: 1, b: 1, a: 0.85 }}
              uiTransform={{ margin: { top: Math.round(2 * S) } }}
            />
            {/* Kernel dots — hits so far. */}
            <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', margin: { top: Math.round(6 * S) } }}>
              {[0, 1, 2].map((i) => (
                <UiEntity key={String(i)}
                  uiTransform={{
                    width: Math.round(14 * S), height: Math.round(14 * S),
                    margin: { left: Math.round(5 * S), right: Math.round(5 * S) },
                    borderRadius: Math.round(7 * S),
                  }}
                  uiBackground={{ color: i < popRingHits
                    ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                    : { r: 1, g: 1, b: 1, a: 0.25 } }}
                />
              ))}
            </UiEntity>
            {/* Mobile tap target — same two-path handling as the SCRUB pill.
                Purple at rest, gold ONLY when the ring lands (an always-amber
                pill read as "gold from start" and lied about the timing). */}
            {mobile && (
              <UiEntity
                uiTransform={{
                  width: Math.round(290 * S), height: Math.round(100 * S),
                  margin: { top: Math.round(12 * S) },
                  borderRadius: Math.round(28 * S),
                  justifyContent: 'center', alignItems: 'center',
                }}
                uiBackground={{ color: landed
                  ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                  : { r: 0.35, g: 0.2, b: 0.5, a: 0.9 } }}
                onMouseDown={() => skillTapHandler?.()}
              >
                {/* Same label-absorption guard as the SCRUB pill; the rhythm
                    judge's tap dedupe makes a label+pill double-fire one tap. */}
                <Label value="POP!" fontSize={Math.round((landed ? 38 : 32) * S)}
                  color={landed ? { r: 0.15, g: 0.1, b: 0, a: 1 } : WHITE}
                  onMouseDown={() => skillTapHandler?.()} />
              </UiEntity>
            )}
          </UiEntity>
        )
      })()}

      {/* ── PERFECT! flash — pops when a skill-check release lands in the green.
           Rendered outside the hold-bar block because the bar hides on release,
           exactly when this needs to be visible. */}
      {perfectElapsed < PERFECT_FLASH_MS && perfectFlashKind !== 'spree' && perfectFlashKind !== 'perfect' && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: HOLD_BAR_TOP - Math.round(70 * S), left: 0 },
            width:          '100%',
            flexDirection:  'row',
            justifyContent: 'center',
          }}
        >
          <Label
            value={flashText}
            fontSize={perfectFont}
            color={flashColor}
          />
        </UiEntity>
      )}

      {/* ── Spree / PERFECT badge — restyled from bare colored strings (feedback:
           "spree UI text is uglyyy", then "the Perfect xN text is ugly"). One
           badge language for both: dark pill, quiet kicker line, big
           drop-shadowed headline that keeps the pop-in scale and fades on the
           shared flash alpha. The shadow is a second Label offset a few px
           behind — UI Labels have no outline. MISSED and the grey ✕ cancels
           stay plain small text: failure shouldn't get celebration chrome. */}
      {perfectElapsed < PERFECT_FLASH_MS && (perfectFlashKind === 'spree' || perfectFlashKind === 'perfect') && (() => {
        const isPerfect = perfectFlashKind === 'perfect'
        const mult   = isPerfect ? 'PERFECT!' : `×${perfectFlashStreak}`
        const kicker = isPerfect
          ? (perfectFlashStreak > 1 ? `STREAK ×${perfectFlashStreak}` : 'NICE TIMING')
          : (perfectFlashFrenzy ? 'FRENZY SPREE' : 'CLEANING SPREE')
        // 0.7 em/char was too tight for the short "×3" case — the label wrapped
        // mid-token and rendered as "×" over "3" on desktop (field report
        // 2026-08-18). Wider per-char budget AND textWrap="nowrap" below, so a
        // mis-measure can never split the headline again.
        const boxW   = Math.round(perfectFont * 0.95 * Math.max(3, mult.length))
        const boxH   = Math.round(perfectFont * 1.12)
        const accent = !isPerfect && perfectFlashFrenzy ? { r: 1, g: 0.45, b: 0.25 } : { r: 1, g: 0.82, b: 0.25 }
        return (
          <UiEntity
            uiTransform={{
              positionType:   'absolute',
              position:       { top: HOLD_BAR_TOP - Math.round(96 * S), left: 0 },
              width:          '100%',
              flexDirection:  'row',
              justifyContent: 'center',
            }}
          >
            <UiEntity
              uiTransform={{
                flexDirection: 'column',
                alignItems:    'center',
                padding: {
                  top: Math.round(8 * S), bottom: Math.round(10 * S),
                  left: Math.round(22 * S), right: Math.round(22 * S),
                },
                borderRadius: Math.round(16 * S),
              }}
              uiBackground={{ color: { r: 0.05, g: 0.02, b: 0.1, a: 0.72 * perfectAlpha } }}
            >
              <Label
                value={kicker}
                fontSize={Math.round(15 * S)}
                color={{ r: 1, g: 1, b: 1, a: 0.85 * perfectAlpha }}
              />
              <UiEntity uiTransform={{ width: boxW, height: boxH }}>
                <Label
                  value={mult}
                  fontSize={perfectFont}
                  textAlign="middle-center"
                  textWrap="nowrap"
                  color={{ r: 0, g: 0, b: 0, a: 0.8 * perfectAlpha }}
                  uiTransform={{
                    positionType: 'absolute',
                    position: { top: Math.round(3 * S), left: Math.round(3 * S) },
                    width: '100%', height: '100%',
                  }}
                />
                <Label
                  value={mult}
                  fontSize={perfectFont}
                  textAlign="middle-center"
                  textWrap="nowrap"
                  color={{ ...accent, a: perfectAlpha }}
                  uiTransform={{
                    positionType: 'absolute',
                    position: { top: 0, left: 0 },
                    width: '100%', height: '100%',
                  }}
                />
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* ── Deposit flash — names the stream, so the sort is reinforced. ─────── */}
      {depElapsed < PERFECT_FLASH_MS && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: '38%', left: 0 },
            width:          '100%',
            flexDirection:  'row',
            justifyContent: 'center',
          }}
        >
          <Label
            value={`+${dep.count} ${dep.type === 'recycle' ? 'RECYCLED' : 'BINNED'}!`}
            fontSize={depFont}
            color={{ r: 1, g: 0.82, b: 0.25, a: depAlpha }}
          />
        </UiEntity>
      )}

      {/* ── Theme story card — tonight's "what happened here", on its own clock.
           A fixed lower-centre band, clear of the banner (upper third), the intro
           timer and the toast stack — the earlier banner-tracking version landed
           on the countdown and vanished with the intro before anyone could read
           it. Nine seconds of hold with a dark backdrop, then a fade: reading
           time first, then the screen declutters. ─────────────────────────────── */}
      {!isOpen && themeStoryStartMs > 0 && (() => {
        const t = Date.now() - themeStoryStartMs
        if (t > THEME_STORY_MS) return null
        const fade = t > THEME_STORY_MS - THEME_STORY_FADE_MS
          ? Math.max(0, (THEME_STORY_MS - t) / THEME_STORY_FADE_MS)
          : 1
        // Roulette reveal — EVERY round spins (playtest request): classic
        // rounds are a real slot on the wheel too, so the ritual is constant
        // and a themed landing feels like a win. The server's roll is long
        // done; this is pure drama, and the spin visibly decelerates.
        const wheel = THEME_WHEEL
        const finalTitle = themeDef?.title ?? 'CLASSIC NIGHT'
        const finalBlurb = themeDef?.blurb ?? 'Just a regular shift — the mess never sleeps.'
        const spinning  = t < THEME_ROULETTE_MS
        // QUANTIZED to fixed 100ms ticks: per-frame stepping looked smooth on
        // desktop but jittered with mobile's uneven frame pacing. Fixed ticks
        // read identically everywhere — and click like a real slot machine.
        const qt        = Math.floor(t / 100) * 100
        const spinT     = Math.min(1, qt / THEME_ROULETTE_MS)
        const spinIdx   = Math.floor((1 - Math.pow(1 - spinT, 2)) * wheel.length * 3)
        const shownTitle = spinning ? wheel[spinIdx % wheel.length] : finalTitle
        const pad = Math.round(THEME_CARD_PAD * S)
        // FIXED card + label geometry. An auto-sized card re-measures on every
        // 100ms title swap — different widths recentre the box, and on mobile a
        // long title could line-wrap and change its HEIGHT ("roulette jitter").
        // The title FONT is derived from the longest wheel line (see
        // THEME_TITLE_FONT), so the spin only repaints glyphs inside an
        // immovable box and every title clears the padding.
        const cardW  = Math.round(THEME_CARD_W * S)
        const titleH = Math.round(48 * S)
        return (
          <UiEntity
            uiTransform={{
              positionType:  'absolute',
              position:      { top: '56%', left: 0 },
              width:         '100%',
              flexDirection: 'row',
              justifyContent: 'center',
            }}
          >
            <UiEntity
              uiTransform={{
                width:         cardW,
                flexDirection: 'column',
                alignItems:    'center',
                padding: { top: pad, bottom: pad, left: pad * 2, right: pad * 2 },
                borderRadius: Math.round(16 * S),
              }}
              uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.78 * fade } }}
            >
              {/* nowrap: the fixed titleH box fits exactly one line, and the
                  font is pre-sized so one line is all any title needs — a wrap
                  here could only mean clipping. */}
              <Label value={`TONIGHT: ${shownTitle}`} fontSize={Math.round(THEME_TITLE_FONT * S)}
                textAlign="middle-center"
                textWrap="nowrap"
                uiTransform={{ width: '100%', height: titleH }}
                color={spinning
                  ? { r: 1, g: 1, b: 1, a: 0.75 }
                  : { r: 1, g: 0.82, b: 0.25, a: fade }} />
              {!spinning && (() => {
                const blurbFont = Math.round(THEME_BLURB_FONT * S)
                const innerW    = cardW - pad * 4
                const lines     = themeBlurbLines(finalBlurb, blurbFont, innerW)
                return (
                  <Label value={finalBlurb} fontSize={blurbFont}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={{ r: 1, g: 1, b: 1, a: fade }}
                    uiTransform={{
                      width: '100%',
                      height: Math.round(lines * blurbFont * 1.3),
                      margin: { top: Math.round(8 * S) },
                    }} />
                )
              })()}
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* ── Info strip (round label + next-round controls) ────────────────────── */}
      <UiEntity
        uiTransform={{
          positionType:   'absolute',
          position:       { top: STRIP_TOP, left: 0 },
          width:          '100%',
          flexDirection:  'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{ width: stripWidth, flexDirection: 'column', alignItems: 'center' }}
        >
          {/* Round label — DEBUG only, where the round number is a testing tool.
              Removed from the player HUD entirely: endless rounds made "Round 7"
              noise, and milestone rounds are already announced by the SPRING
              CLEANING theme card, so "Round 5 — Milestone" was redundant. */}
          {!isFinale && DEBUG && (
            <Label
              value={`[DEBUG] ${getRoundLabel(roundNumber)}`}
              fontSize={roundFont}
              color={COLOR_SUBTLE}
              uiTransform={{ margin: { bottom: LABEL_MARGIN_SMALL } }}
            />
          )}

          {/* Theme label — a quiet reminder of tonight's story once the story
              card has faded. Chip styling matches the contract chip below so the
              strip reads as one family. Hidden while the story card is up — two
              surfaces saying the same thing is distraction, not reinforcement. */}
          {!isOpen && themeDef && (themeStoryStartMs < 0 || Date.now() - themeStoryStartMs > THEME_STORY_MS) && (
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: {
                  top: Math.round(4 * S), bottom: Math.round(4 * S),
                  left: Math.round(12 * S), right: Math.round(12 * S),
                },
                margin: { bottom: LABEL_MARGIN_SMALL },
                borderRadius: Math.round(14 * S),
              }}
              uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.65 } }}
            >
              <Label value={themeDef.title} fontSize={Math.round(22 * S)}
                color={{ r: 1, g: 0.82, b: 0.25, a: 1 }} />
            </UiEntity>
          )}

          {/* Shift contract — the round's server-rolled mini-goal, live progress.
              Its own chip (background + generous type) rather than another line
              of small text: it was illegible on mobile against a busy scene, and
              it's the one thing here the player is actively working toward.
              Green once complete so the bonus feels banked. */}
          {!isOpen && getContract() && (
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: {
                  top: Math.round(5 * S), bottom: Math.round(5 * S),
                  left: Math.round(12 * S), right: Math.round(12 * S),
                },
                margin: { bottom: LABEL_MARGIN_SMALL },
                borderRadius: Math.round(14 * S),
              }}
              uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.65 } }}
            >
              <Label
                value={`${getContract()!.label}   ${Math.min(getContract()!.progress, getContract()!.target)}/${getContract()!.target}`}
                fontSize={Math.round(26 * S)}
                color={getContract()!.progress >= getContract()!.target
                  ? theme.colors.success
                  : { r: 1, g: 0.82, b: 0.25, a: 1 }}
              />
            </UiEntity>
          )}

          {/* FRENZY and LAST CALL moved to the fixed timer-status pill (see
              TIMER_STATUS_TOP) — stacked here they drifted down into the
              SPREE flash zone and overlapped it. */}

          {/* The intermission countdown moved into the shift report card — it was
              the other half of the two-competing-UIs problem. */}
        </UiEntity>
      </UiEntity>

      {/* ── Admin panel — desktop only (right edge unsafe on mobile), and hidden
           while the side-panel shop owns the right edge (buttons overlapped the
           upgrade rows' cost buttons). ─────────────────────────────────────────── */}
      {isAdmin && !mobile && !shopAsPanel && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position:     { top: ADMIN_TOP, right: ADMIN_RIGHT },
            flexDirection: 'column',
            alignItems:   'flex-end',
          }}
        >
          <Label
            value={DEBUG ? 'ADMIN  [DEBUG ON]' : 'ADMIN'}
            fontSize={ADMIN_FONT_SIZE}
            color={ADMIN_COLOR}
            uiTransform={{ margin: { bottom: ADMIN_MARGIN } }}
          />
          {/* Haul state — the stuck-bin bug is mobile-only, and mobile has no
              console (preview lacks the auth server), so the state is rendered
              instead. If stage reads 'none' while a bin is still in hand, the
              server is right and the bug is purely visual; `ghosts` counts
              remote-carry props, which should be 0 when playing alone. */}
          {(() => {
            const h = getHaulDebug()
            return (
              <Label
                value={`haul: ${h.hauling || 'none'}/${h.haulStage || '-'} bin=${h.haulBinName || '-'} carried=${h.carried} own=${h.ownKnown ? 'ok' : 'UNKNOWN'} ghosts=${h.ghosts}`}
                fontSize={Math.round(ADMIN_BTN_FONT * 0.95)}
                color={h.ownKnown && h.ghosts === 0 ? ADMIN_COLOR : { r: 1, g: 0.35, b: 0.3, a: 1 }}
                uiTransform={{ margin: { bottom: ADMIN_MARGIN } }}
              />
            )
          })()}
          {/* Persistence health — red until careers are provably being saved. */}
          {(() => {
            const s = storageStatus
            const text = !s ? 'storage: …'
              : s.backend === 'storage' ? 'storage: DCL (WIPES ON REPUBLISH!)'
              : !s.loadConfirmed ? 'storage: jsonbin — LOAD FAILED'
              : s.lastSaveOk === false ? 'storage: jsonbin — SAVE FAILED'
              : s.lastSaveOk === true ? `storage: jsonbin ✓ saved ${Math.max(0, Math.round((Date.now() - s.lastSaveMs) / 60000))}m ago`
              : 'storage: jsonbin ✓ loaded, no saves yet'
            const healthy = s !== null && s.backend === 'jsonbin' && s.loadConfirmed && s.lastSaveOk !== false
            return (
              <Label
                value={text}
                fontSize={Math.round(ADMIN_BTN_FONT * 0.95)}
                color={healthy ? { r: 0.4, g: 0.95, b: 0.5, a: 1 } : { r: 1, g: 0.35, b: 0.3, a: 1 }}
                uiTransform={{ margin: { bottom: ADMIN_MARGIN } }}
              />
            )
          })()}
          {/* Testing grants/sinks — money both ways, and rank up/down (XP jumps to
              the next title, or back to the floor of the previous one). */}
          <GameButton
            value="+$1,000"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => room.send('adminGrant', { money: 1000, xp: 0 })}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value="−$1,000"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => room.send('adminGrant', { money: -1000, xp: 0 })}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value="+1 Rank"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              const c = getCareerOrEmpty()
              const rank = rankForXp(c.xp)
              if (rank >= TITLE_XP.length - 1) return   // already Club Owner
              room.send('adminGrant', { money: 0, xp: TITLE_XP[rank + 1] - c.xp })
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value="−1 Rank"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              const c = getCareerOrEmpty()
              const rank = rankForXp(c.xp)
              if (rank <= 0) return   // already at the bottom rung
              room.send('adminGrant', { money: 0, xp: TITLE_XP[rank - 1] - c.xp })
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          {/* Gear achievements — each click SETS the next stage in the cycle
              (zero → half → almost → full), so one walk of the button covers the
              pedestal's whole lifecycle: red requirement, orange "N to go",
              nearly-there, unlocked + click-to-equip. Server-side it's a set,
              not an add — every test starts from a known state, and revoking
              below target also un-equips the gear if worn. Label shows what
              the NEXT click will set. */}
          {ADMIN_ACH_GEARS.map(({ gear, label }) => (
            <GameButton
              id={gear}
              value={`${label}: set ${ACH_STAGES[achStageIdx.get(gear) ?? 0]}`}
              variant="secondary"
              fontSize={ADMIN_BTN_FONT}
              onMouseDown={() => {
                const idx = achStageIdx.get(gear) ?? 0
                room.send('adminAchievement', { gear, stage: ACH_STAGES[idx] })
                achStageIdx.set(gear, (idx + 1) % ACH_STAGES.length)
              }}
              uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
            />
          ))}
          {/* One-click whole-wall states: every pedestal unlocked (walk the
              entrance, equip each item, check the in-hand models), and the
              full reset back to red requirements. 'full' IS the real unlock
              path — same server code as earning it. Cycle indices are re-aimed
              so each per-gear button's next click still makes sense. */}
          <GameButton
            id="ach_unlock_all"
            value="Unlock ALL gear"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              for (const { gear } of ADMIN_ACH_GEARS) {
                room.send('adminAchievement', { gear, stage: 'full' })
                achStageIdx.set(gear, 0)   // next per-gear click: zero (re-lock one)
              }
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            id="ach_lock_all"
            value="Re-lock ALL gear"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              for (const { gear } of ADMIN_ACH_GEARS) {
                room.send('adminAchievement', { gear, stage: 'zero' })
                achStageIdx.set(gear, 1)   // next per-gear click: half (progress text)
              }
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          {/* Intro previews — the lobby is a ~5s beat now, so catching the cards
              naturally isn't practical. "New" forces the 3-card story even on an
              account that has already worked shifts. */}
          <GameButton
            value="Intro: new"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => replayCareerIntro(true)}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value="Intro: returning"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => replayCareerIntro(false)}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          {/* Theme pin — cycles RANDOM → each theme → RANDOM. Sticky on the
              server (every following round uses it), applies from the NEXT
              round. Label shows what was last sent. */}
          <GameButton
            value={`Theme: ${adminThemeIdx === 0 ? 'RANDOM' : THEME_DEFS[adminThemeIdx - 1].title}`}
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              adminThemeIdx = (adminThemeIdx + 1) % (THEME_DEFS.length + 1)
              room.send('adminForceTheme', {
                themeId: adminThemeIdx === 0 ? '' : THEME_DEFS[adminThemeIdx - 1].id,
              })
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          {/* Hold-test — cycles placed models onto the carry rig (same attach,
              pose and emote as the box). Local preview only. */}
          <GameButton
            value={`Hold: ${adminHoldIdx === 0 ? 'OFF' : HOLD_TEST_MODELS[adminHoldIdx - 1]}`}
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              adminHoldIdx = (adminHoldIdx + 1) % (HOLD_TEST_MODELS.length + 1)
              setCarryHoldTest(adminHoldIdx === 0 ? null : HOLD_TEST_MODELS[adminHoldIdx - 1])
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value={`Confetti: ${adminConfettiIdx === 0 ? 'OFF' : CONFETTI_TEST[adminConfettiIdx - 1].label}`}
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => {
              adminConfettiIdx = (adminConfettiIdx + 1) % (CONFETTI_TEST.length + 1)
              if (adminConfettiIdx === 0) {
                stopCelebrationNow()
              } else {
                const t = CONFETTI_TEST[adminConfettiIdx - 1]
                launchCelebration(t.outcome, t.finale)
              }
            }}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <GameButton
            value="Reset to Round 1"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => room.send('adminReset', { dummy: true })}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT }}
          />
        </UiEntity>
      )}

      {/* ── Image toast stack ─────────────────────────────────────────────────── */}
      {/* Desktop: right side mid-height. Mobile: top of centre safe zone.        */}
      {/* Percentage position strings scale correctly across all screen sizes.    */}
      {activeToasts.length > 0 && (
        <UiEntity
          uiTransform={{
            positionType:  'absolute',
            position:      toastPos,
            flexDirection: 'column',
            alignItems:    toastAlign,
          }}
        >
          {/* Transparent spacer — pushes stack below the round-end banner on desktop */}
          {toastTopSlots > 0 && (
            <UiEntity uiTransform={{ width: toastW, height: toastTopSlots * toastH }} />
          )}
          {activeToasts.map((toast, idx) => (
            <UiEntity
              key={String(toast.id)}
              uiTransform={{
                width:          toastW,
                height:         toastH,
                margin:         { bottom: idx < activeToasts.length - 1 ? toastOverlap : 0 },
                justifyContent: 'flex-end',
                alignItems:     'flex-start',
              }}
              uiBackground={{
                texture:     { src: TOAST_SRC[toast.kind] },
                textureMode: 'stretch',
                color:       WHITE,
              }}
            >
              {(toast.kind === 'glasses' || toast.kind === 'bottles') && (
                <Label
                  value={`${toast.count} / ${toast.total}`}
                  fontSize={toastFont}
                  color={WHITE}
                  uiTransform={{
                    positionType: 'absolute',
                    position: { top: Math.round(toastH * TOAST_LABEL_TOP), left: Math.round(toastW * TOAST_LABEL_LEFT) },
                  }}
                />
              )}
              {toast.kind === 'narrative' && toast.text !== undefined && (
                <Label
                  value={toast.text}
                  fontSize={narrFont}
                  color={WHITE}
                  textAlign="middle-left"
                  uiTransform={{
                    positionType: 'absolute',
                    position: { top: Math.round(toastH * NARR_LABEL_TOP), left: Math.round(toastW * NARR_LABEL_LEFT) },
                    width: Math.round(toastW * NARR_LABEL_W_FRAC),
                  }}
                />
              )}
            </UiEntity>
          ))}
        </UiEntity>
      )}

      {/* ── OWNER'S PICK — choose tonight's theme ─────────────────────────────
           Club Owners only, intermission only, until some owner has picked.
           Bottom-centre with the CarryChip's safe-area anchoring (the chip is
           hidden during the intermission, so the slot is free on both
           platforms). First owner to confirm wins the night — the server
           enforces it; the picked/refused broadcasts close this UI. */}
      {isOpen && !ownerPickModalOpen
        && getCareerOrEmpty().nextTitle === null
        && themePickTakenRound !== roundNumber && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { bottom: saPct(getSafeArea().bottom + 0.03), left: 0 },
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
          }}
        >
          <GameButton
            value="★ OWNER'S PICK — TONIGHT'S THEME"
            variant="primary"
            fontSize={Math.round(20 * S)}
            wiggle={true}
            uiTransform={{ width: Math.round(400 * S), height: Math.round(56 * S) }}
            onMouseDown={() => { ownerPickModalOpen = true }}
          />
        </UiEntity>
      )}

      {/* Theme menu — LAST in the tree so it draws over everything else. Two
          fixed columns rather than flex-wrap: deterministic layout that fits
          the short mobile viewport with room to spare. */}
      {isOpen && ownerPickModalOpen && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute', position: { top: 0, left: 0 },
            width: '100%', height: '100%',
            flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.85 } }}
        >
          <Label
            value="OWNER'S PICK — TONIGHT'S THEME"
            fontSize={Math.round(30 * S)}
            color={{ r: 1, g: 0.82, b: 0.25, a: 1 }}
            uiTransform={{ margin: { bottom: Math.round(6 * S) } }}
          />
          <Label
            value="Your call, boss. First owner to pick sets the night."
            fontSize={Math.round(18 * S)}
            color={COLOR_SUBTLE}
            uiTransform={{ margin: { bottom: Math.round(16 * S) } }}
          />
          <UiEntity uiTransform={{ flexDirection: 'row' }}>
            {[0, 1].map((col) => (
              <UiEntity
                key={String(col)}
                uiTransform={{
                  flexDirection: 'column',
                  margin: { left: Math.round(8 * S), right: Math.round(8 * S) },
                }}
              >
                {[...THEME_DEFS.map((t) => ({ id: t.id as string, title: t.title })), { id: '', title: 'CLASSIC NIGHT' }]
                  .filter((_, i) => i % 2 === col)
                  .map((t) => (
                    <GameButton
                      id={`ownerPick_${t.id || 'classic'}`}
                      value={t.title}
                      variant="secondary"
                      fontSize={Math.round(17 * S)}
                      uiTransform={{ width: Math.round(300 * S), height: Math.round(46 * S), margin: { bottom: Math.round(8 * S) } }}
                      onMouseDown={() => { room.send('ownerPickTheme', { themeId: t.id }) }}
                    />
                  ))}
              </UiEntity>
            ))}
          </UiEntity>
          <GameButton
            value="CANCEL"
            variant="secondary"
            fontSize={Math.round(18 * S)}
            uiTransform={{ width: Math.round(200 * S), height: Math.round(48 * S), margin: { top: Math.round(10 * S) } }}
            onMouseDown={() => { ownerPickModalOpen = false }}
          />
        </UiEntity>
      )}
    </UiEntity>
  )
}
