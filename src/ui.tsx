import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { engine, EasingFunction, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getUserData } from '~system/UserIdentity'
import { isMobile } from '@dcl/sdk/platform'
import { GameState } from './shared/schemas'
import { ADMIN_ADDRESSES, DEBUG, MILESTONE_EVERY } from './shared/config'
import { room } from './shared/messages'
import { playToastSound } from './client/soundManager'
import { tweenColor, applyEasing } from './client/tween'
import { theme } from './client/theme'
import { isWaitingForMatch } from './client/phaseGate'
import { isSignedUp, signUpForNextShift, cancelSignUp } from './client/participation'
import { CareerBar, ShiftPayoutPanel, UpgradeShopOverlay, UpgradeShopPanel, ShopButton, isShopOpen, CareerIntroOverlay, shouldShowCareerIntro, replayCareerIntro } from './client/progressionUi'
import { getCarried, getCarriedGeneral, getCarriedRecycle, getCarryCapacity, getPortableLeft, isCarryKnown, isCarryFull, requestPortableEmpty, getLastDeposit } from './client/carrySystem'
import { readCanvasInfo, getSafeArea, pct as saPct } from './client/safeArea'
import { getCareerOrEmpty, getContract } from './client/progressionStore'
import { TITLE_XP, rankForXp } from './shared/progression'

// ── UI layout constants — tweak these to adjust sizing and positioning ─────────

// ── Global HUD zoom ────────────────────────────────────────────────────────────
// The whole HUD is laid out in a virtual canvas; the renderer scales that canvas
// to fit the screen. Shrinking the virtual canvas zooms every element — sizes,
// positions and gaps — up together, so nothing overlaps.
//
// This is the desktop scale fix. SDK 7.24.3 added a device-pixel-ratio divide to
// the UI scale (the change that fixed mobile), which made virtual px map to
// LOGICAL px. On the high-DPI display this HUD was originally tuned against that
// halved the on-screen size, leaving the desktop HUD tiny and crammed at the top.
// A smaller virtual canvas restores it, on every display density at once (the dpr
// divide already removed the per-display variation, so a single constant is right
// for all desktops).
//
// TUNE HERE: raise UI_ZOOM toward 2.0 if the HUD still reads too small on your
// monitor; lower it toward 1.2 if it's now too big.
const UI_ZOOM             = 1.5
const VIRTUAL_W           = Math.round(1920 / UI_ZOOM)   // virtual canvas width  (1280 @ 1.5) — default/fallback
const VIRTUAL_H           = Math.round(1080 / UI_ZOOM)   // virtual canvas height ( 720 @ 1.5)

// Live virtual-canvas width. The renderer fits a FIXED-aspect virtual canvas
// inside the screen; on any aspect wider than the canvas it fits to height and
// LEFT-anchors, so '100%' and centred content skew left — reported as "UI skewed
// left, not centred" on ultrawide mobile. We flex virtualWidth each frame to match
// the real screen aspect (virtualHeight stays VIRTUAL_H, so uiScaleFactor =
// canvasH/VIRTUAL_H/dpr and the UI_ZOOM vertical scale are unchanged). Matching the
// aspect removes the letterbox: the canvas fills the screen and centring is true on
// every device. Updated via setUiRenderer, which only reassigns the virtual size —
// no re-mount. Starts at the 16:9 default until the real canvas size is known.
let currentVirtualW = VIRTUAL_W

// Platform
// Extra bump for mobile ON TOP of the global zoom above (touch targets + smaller
// screens want larger chrome). Net mobile scale = MOBILE_SCALE × UI_ZOOM.
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
// Pinned to a fraction of the canvas height so it stays in the lower third at any
// UI_ZOOM (a raw virtual-px value would drift to the very bottom as the canvas shrinks).
const HOLD_BAR_TOP        = Math.round(VIRTUAL_H * 0.61)  // lower third, below the centre reticle
const HOLD_BAR_BG_COLOR   = theme.holdBar.bg
const HOLD_BAR_FILL_COLOR = theme.holdBar.fill

// Info strip (round label + next-round controls only — bar has moved above)
const STRIP_TOP           = 258     // absolute top offset — just below bar row
const STRIP_WIDTH         = 440     // base width before MOBILE_SCALE
const ROUND_FONT_SIZE     = 22
const METER_FONT_SIZE     = 13
const LABEL_MARGIN_SMALL  = 4       // bottom margin under round label

// Next-round controls (shown when phase === 'open')
const NEXT_FONT_SIZE      = 15
const PCT_FONT_SIZE       = 44      // achieved-cleanliness % shown under the outcome / finale card
const BTN_WIDTH           = 240
const BTN_HEIGHT          = 48
const BTN_FONT_SIZE       = 16

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

// ── Image toast stack ─────────────────────────────────────────────────────────

type ToastKind = 'cleaned' | 'glasses' | 'bottles' | 'narrative'

interface ToastEntry {
  id:       number
  kind:     ToastKind
  count?:   number
  total?:   number
  text?:    string
  timerId?: ReturnType<typeof setTimeout>
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

function _addToast(entry: Omit<ToastEntry, 'id' | 'timerId'>) {
  const id = ++_toastId
  const t: ToastEntry = { ...entry, id }
  t.timerId = setTimeout(() => {
    const i = activeToasts.findIndex(x => x.id === id)
    if (i !== -1) activeToasts.splice(i, 1)
  }, TOAST_DURATION[entry.kind])
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
    if (existing.timerId) clearTimeout(existing.timerId)
    existing.timerId = setTimeout(() => {
      const i = activeToasts.findIndex(x => x.id === existing.id)
      if (i !== -1) activeToasts.splice(i, 1)
    }, TOAST_DURATION[kind])
    playToastSound(kind)
  } else {
    _addToast({ kind, count, total })
  }

  if (count === total) {
    setTimeout(() => showCleanedToast(), 350)
  }
}

/** Show a narrative pop-up with `text` overlaid on the NarrativeUI image. */
export function showNarrativeToast(text: string) {
  _addToast({ kind: 'narrative', text })
}

async function checkAdmin() {
  try {
    const { data } = await getUserData({})
    if (data?.userId && ADMIN_ADDRESSES.includes(data.userId.toLowerCase())) {
      isAdmin = true
    }
    if (DEBUG) isAdmin = true
  } catch (_) {}
}

function getGameState() {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs
  return null
}

function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Rounds continue indefinitely in V2, so this can no longer clamp to a fixed list —
// the old version labelled every round past the 5th "Final Round", which would be
// wrong on every shift from then on. Milestone rounds (every 5th) keep a special
// label since they still trigger the celebration hold.
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
let skillTapHandler: (() => void) | null = null
export function setSkillTapHandler(fn: () => void) { skillTapHandler = fn }

// ── Action flash — one pop-and-fade slot shared by the moment-to-moment juice
// (PERFECT skill hits, MISSED, cleaning SPREEs). Latest event wins the slot.
const PERFECT_FLASH_MS  = 700
let perfectFlashStartMs = -1
let perfectFlashStreak  = 0
let perfectFlashKind: 'perfect' | 'miss' | 'spree' = 'perfect'
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
export function flashSpree(combo: number) {
  perfectFlashStartMs = Date.now()
  perfectFlashStreak  = combo
  perfectFlashKind    = 'spree'
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

/** Called each time the local player enters the scene — restarts the full intro (with hold). */
export function resetIntro() {
  introStartMs = Date.now()
  introHoldS   = INTRO_HOLD_S
}

/** Called by narrativeSystem when a new round starts — shows InstructionsUI at centre then pops to top. */
export function triggerRoundStartIntro() {
  introStartMs   = Date.now()
  introHoldS     = ROUND_START_HOLD_S
  outcomeStartMs = -1
}

export function setupUi() {
  checkAdmin()
  ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: VIRTUAL_W, virtualHeight: VIRTUAL_H })
}

const WHITE = theme.colors.white

// ── Rubbish carry chip — bottom-centre, only while actually cleaning ──────────
// Mirrors the server's carriedUpdate (see carrySystem). Bottom-centre keeps it
// clear of the career HUD (top-right), the toast stack (top), the hold bar
// (61% height) and the mobile joystick / interaction clusters (bottom corners);
// the safe-area inset keeps it above any explorer chrome along the bottom edge.
function CarryChip({ S }: { S: number }) {
  if (!isCarryKnown()) return null   // no server answer yet — render nothing

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
  const pulse = full ? 0.75 + 0.25 * Math.sin(Date.now() / 140) : 1

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

        {/* Portable Bin: empty on the spot, uses remaining in the label. Greyed
            (secondary) with empty hands — the server re-validates regardless. */}
        {getPortableLeft() > 0 && (
          <Button
            value={`EMPTY (${getPortableLeft()})`}
            variant={gen + rec > 0 ? 'primary' : 'secondary'}
            fontSize={Math.round(20 * S)}
            uiTransform={{ width: Math.round(150 * S), height: Math.round(44 * S), margin: { left: Math.round(12 * S) } }}
            onMouseDown={() => requestPortableEmpty()}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

const ui = () => {
  // Keep the virtual canvas matched to the real screen aspect so there's no
  // letterbox to skew centred content (see currentVirtualW above). Clamped so a
  // portrait or extreme aspect can't drive fixed-width elements off-canvas; the
  // >=8px guard avoids re-setting on sub-pixel jitter.
  const canvasInfo = readCanvasInfo()
  if (canvasInfo) {
    const desired = Math.max(720, Math.min(2400, Math.round(VIRTUAL_H * (canvasInfo.width / canvasInfo.height))))
    if (Math.abs(desired - currentVirtualW) >= 8) {
      currentVirtualW = desired
      ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: currentVirtualW, virtualHeight: VIRTUAL_H })
    }
  }

  const gs            = getGameState()
  const cleaned       = gs?.cleanedCount ?? 0
  const total         = Math.max(1, gs?.totalCount ?? 1)
  const seconds       = gs?.secondsLeft ?? 0
  const phase         = gs?.phase ?? 'lobby'
  const roundNumber   = gs?.roundNumber ?? 0
  const isMilestoneRound = (roundNumber + 1) % MILESTONE_EVERY === 0
  const outcome       = gs?.outcome ?? ''
  const isFinale      = gs?.isFinale ?? false
  const pct           = Math.min(1, cleaned / total)
  const isOpen        = phase === 'open'
  const isLobby       = phase === 'lobby'
  const starting      = gs?.starting ?? false
  const playersIn     = gs?.playersIn ?? 0
  const waiting       = isWaitingForMatch()

  // ── Round-transition detection ────────────────────────────────────────────────
  // Runs every render call but only acts when isOpen changes value.
  if (isOpen && !prevIsOpen) {
    // Round just ended — tween outcome image from normal position to centre.
    outcomeStartMs = Date.now()
    introStartMs   = -1   // cancel any pending player-entry intro
  }
  // Round-start intro is triggered explicitly via triggerRoundStartIntro() from
  // narrativeSystem — more reliable than render-loop detection for button-click starts.
  prevIsOpen = isOpen

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
  const flashSizes     = perfectFlashKind === 'perfect' ? [34, 64] : perfectFlashKind === 'spree' ? [26, 44] : [24, 40]
  const perfectFont    = Math.round(lerp(flashSizes[0], flashSizes[1], perfectEase) * S)
  const flashText      = perfectFlashKind === 'perfect'
    ? (perfectFlashStreak > 1 ? `PERFECT ×${perfectFlashStreak}!` : 'PERFECT!')
    : perfectFlashKind === 'spree'
    ? `SPREE ×${perfectFlashStreak}!`
    : 'MISSED!'
  const flashColor     = perfectFlashKind === 'perfect'
    ? { r: 1, g: 0.82, b: 0.25, a: perfectAlpha }
    : perfectFlashKind === 'spree'
    ? { r: 1, g: 0.62, b: 0.2,  a: perfectAlpha }
    : { r: 1, g: 0.35, b: 0.3,  a: perfectAlpha }

  // Deposit flash — reads carrySystem's last-deposit state (no setter import,
  // which would cycle). "+N BINNED/RECYCLED!" pops right after a bin empty.
  const dep        = getLastDeposit()
  const depElapsed = dep.ms >= 0 ? Date.now() - dep.ms : Infinity
  const depEase    = 1 - Math.pow(1 - Math.min(1, depElapsed / 250), 3)
  const depFont    = Math.round(lerp(26, 46, depEase) * S)
  const depAlpha   = depElapsed < 400 ? 1 : Math.max(0, 1 - (depElapsed - 400) / (PERFECT_FLASH_MS - 400))
  const btnW         = Math.round(BTN_WIDTH          * S)
  const btnH         = Math.round(BTN_HEIGHT         * S)
  const btnFont      = Math.round(BTN_FONT_SIZE      * S)
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
  const toastPos     = mobile ? TOAST_POS_MOBILE : TOAST_POS_DESKTOP
  const toastAlign   = mobile ? 'flex-start' as const : 'flex-end' as const
  // When the round-end banner fills the centre of the screen (desktop only),
  // push the toast stack down by 2 slots so it clears the banner.
  // Mobile toasts anchor at top:9% — already above the banner — no offset needed.
  // introHolding is computed after elapsedS/introActive below and factored in there.

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
  }
  const barColor = currentBarColor

  // ── Countdown colour — ease between bands instead of hard-snapping ────────────
  // Only react while actively counting down (playing phase).  When the band
  // changes we cancel any in-flight tween and start a new ease toward the new
  // band colour; `currentTimerColor` is what the Label actually renders.
  if (!isOpen) {
    const band = timerBandOf(seconds)
    if (band !== lastTimerBand) {
      lastTimerBand = band
      if (activeTimerTween) engine.removeSystem(activeTimerTween)
      activeTimerTween = tweenColor(
        currentTimerColor,
        TIMER_BAND_COLORS[band],
        TIMER_COLOR_TWEEN_S,
        (v) => { currentTimerColor = v },
        () => { activeTimerTween = null },
        EasingFunction.EF_EASEOUTCUBIC,
      )
    }
  }
  const timerColor = currentTimerColor

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
  const FULL_SCREEN_SCRIM = { width: '100%' as const, height: '100%' as const }
  // Rows that centre their content across the full screen. justifyContent:'center'
  // needs a definite width to centre within; '100%' gives it one that matches the
  // scrim, so text stays centred on the actual screen rather than on the 1920 box.
  const FULL_WIDTH_ROW = {
    width: '100%' as const,
    flexDirection: 'row' as const,
    justifyContent: 'center' as const,
  }

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
        uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.82 } }}
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
            <Button
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
        <CareerBar S={S} />
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
        uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.82 } }}
      >
        <UiEntity uiTransform={{ ...centeredRow, margin: { bottom: Math.round(16 * S) } }}>
          <Label value="Spectating" fontSize={Math.round(56 * S)} color={WHITE} />
        </UiEntity>

        {/* Next-shift countdown. During the intermission secondsLeft counts down to
            the next round, which is exactly the "next match countdown" the GDD asks
            for; mid-round there is no meaningful number yet, so say so plainly
            rather than showing a stale or misleading one. */}
        <UiEntity uiTransform={centeredRow}>
          <Label
            value={isOpen
              ? `Next shift starts in ${seconds}s`
              : 'Next shift starts when this round ends'}
            fontSize={Math.round(30 * S)}
            color={WHITE}
          />
        </UiEntity>

        {/* Pre sign-up — the GDD specifies opting in rather than auto-enrolling, so
            arriving never drops a player into a shift they didn't choose. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(24 * S) } }}>
          {isSignedUp() ? (
            <Button
              value="SIGNED UP — CANCEL"
              variant="secondary"
              fontSize={Math.round(26 * S)}
              uiTransform={{ width: Math.round(360 * S), height: Math.round(76 * S) }}
              onMouseDown={() => cancelSignUp()}
            />
          ) : (
            <Button
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

        {/* Waiting is the natural moment to spend earnings, and gives the wait a
            purpose rather than leaving players staring at a scrim. */}
        <UiEntity uiTransform={{ ...centeredRow, margin: { top: Math.round(22 * S) } }}>
          <ShopButton S={S} />
        </UiEntity>

        <CareerBar S={S} />
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
      <CareerBar S={S} withShopButton={mobile && !isShopOpen()} />
      {/* The whole intermission in one centred card — outcome art, grade, score,
          payout and countdown. Self-centring, so it can't overflow. */}
      {isOpen && <ShiftPayoutPanel S={S} imageSrc={topImageSrc} pct={pct} seconds={seconds} />}

      {/* Rubbish carry count — live while cleaning; hidden during the intermission,
          when there is nothing in hand to track (round start resets it anyway). */}
      {!isOpen && <CarryChip S={S} />}

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
          {/* Track */}
          <UiEntity
            uiTransform={{ width: barTrackW, height: barHeight }}
            uiBackground={{ color: BAR_BG_COLOR }}
          >
            <UiEntity
              uiTransform={{ width: `${Math.round(pct * 100)}%`, height: '100%' }}
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
              ? (mobile ? 'Hit SCRUB in the green!' : 'Release in the green!')
              : 'Cleaning…'}
            fontSize={Math.round(HOLD_BAR_FONT * S)}
            color={holdZoneStart !== null ? WHITE : COLOR_DIM}
            uiTransform={{ margin: { bottom: 8 } }}
          />
          {/* Track */}
          <UiEntity
            uiTransform={{ width: holdBarW, height: holdBarHeight }}
            uiBackground={{ color: HOLD_BAR_BG_COLOR }}
          >
            {/* Fill */}
            <UiEntity
              uiTransform={{ width: `${Math.round(holdBarProgress * 100)}%`, height: '100%' }}
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
                uiBackground={{ color: { r: 0.2, g: 1, b: 0.45, a: 0.45 + 0.2 * Math.sin(Date.now() / 140) } }}
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
              }}
              uiBackground={{
                color: holdZoneStart !== null && holdBarProgress >= holdZoneStart && holdBarProgress <= holdZoneEnd
                  ? { r: 1, g: 0.82, b: 0.25, a: 1 }
                  : WHITE,
              }}
            />
          </UiEntity>

          {/* Mobile skill input — the button IS the timing tap on touch. Bigger
              while the tick is in the green, as a "NOW!" signal you can feel. */}
          {mobile && holdZoneStart !== null && (
            <Button
              value="SCRUB!"
              variant="primary"
              fontSize={Math.round((holdBarProgress >= holdZoneStart && holdBarProgress <= holdZoneEnd ? 40 : 32) * S)}
              uiTransform={{
                width:  Math.round(300 * S),
                height: Math.round(100 * S),
                margin: { top: Math.round(16 * S) },
              }}
              onMouseDown={() => skillTapHandler?.()}
            />
          )}
        </UiEntity>
      )}

      {/* ── PERFECT! flash — pops when a skill-check release lands in the green.
           Rendered outside the hold-bar block because the bar hides on release,
           exactly when this needs to be visible. */}
      {perfectElapsed < PERFECT_FLASH_MS && (
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
          {/* Round label — only when it MEANS something. Endless rounds make a
              plain "Round 7" noise in an already-tight strip (and unreadable on
              mobile), but a milestone round is worth announcing. Kept always in
              DEBUG, where the round number is a testing tool. */}
          {!isFinale && (DEBUG || isMilestoneRound) && (
            <Label
              value={DEBUG ? `[DEBUG] ${getRoundLabel(roundNumber)}` : getRoundLabel(roundNumber)}
              fontSize={roundFont}
              color={COLOR_SUBTLE}
              uiTransform={{ margin: { bottom: LABEL_MARGIN_SMALL } }}
            />
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

          {/* Closing-time frenzy — final seconds, sprees count double. */}
          {!isOpen && phase === 'playing' && seconds <= 20 && seconds > 0 && (
            <Label
              value="FRENZY! Sprees count double"
              fontSize={Math.round(24 * S)}
              color={{ r: 1, g: 0.45, b: 0.25, a: 0.7 + 0.3 * Math.sin(Date.now() / 120) }}
              uiTransform={{ margin: { bottom: LABEL_MARGIN_SMALL } }}
            />
          )}

          {/* The intermission countdown moved into the shift report card — it was
              the other half of the two-competing-UIs problem. */}
        </UiEntity>
      </UiEntity>

      {/* ── Admin panel — desktop only (right edge unsafe on mobile) ─────────── */}
      {isAdmin && !mobile && (
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
          {/* Testing grants/sinks — money both ways, and rank up/down (XP jumps to
              the next title, or back to the floor of the previous one). */}
          <Button
            value="+$1,000"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => room.send('adminGrant', { money: 1000, xp: 0 })}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <Button
            value="−$1,000"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => room.send('adminGrant', { money: -1000, xp: 0 })}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <Button
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
          <Button
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
          {/* Intro previews — the lobby is a ~5s beat now, so catching the cards
              naturally isn't practical. "New" forces the 3-card story even on an
              account that has already worked shifts. */}
          <Button
            value="Intro: new"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => replayCareerIntro(true)}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <Button
            value="Intro: returning"
            variant="secondary"
            fontSize={ADMIN_BTN_FONT}
            onMouseDown={() => replayCareerIntro(false)}
            uiTransform={{ width: ADMIN_BTN_WIDTH, height: ADMIN_BTN_HEIGHT, margin: { bottom: ADMIN_MARGIN } }}
          />
          <Button
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
    </UiEntity>
  )
}
