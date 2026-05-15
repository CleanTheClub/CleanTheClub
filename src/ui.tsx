import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { getUserData } from '~system/UserIdentity'
import { isMobile } from '@dcl/sdk/platform'
import { GameState } from './shared/schemas'
import { ADMIN_ADDRESSES, DEBUG } from './shared/config'
import { room } from './shared/messages'
import { playToastSound } from './client/soundManager'

// ── UI layout constants — tweak these to adjust sizing and positioning ─────────

// Platform
const MOBILE_SCALE        = 1.5     // uniform multiplier applied to text / chrome on mobile

// Instructions image (top-centre; also acts as title card)
// Image file is 1024×128 — display at the same aspect ratio (8:1)
const INSTR_W_DESKTOP     = 900     // display width (desktop)
const INSTR_H_DESKTOP     = 113     // display height — 900 × (128/1024)
const INSTR_W_MOBILE      = 630     // display width (mobile)
const INSTR_H_MOBILE      = 79      // display height — 630 × (128/1024)
const INSTR_MARGIN_TOP    = 8

// Entry intro animation — image centred on screen, then pops to its normal top position
const INTRO_HOLD_S      = 6.0   // seconds to hold at centre before popping
const INTRO_TWEEN_S     = 0.35  // duration of the pop to normal position (short = snappy)
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

// Info strip (round label + next-round controls only — bar has moved above)
const STRIP_TOP           = 258     // absolute top offset — just below bar row
const STRIP_WIDTH         = 440     // base width before MOBILE_SCALE
const ROUND_FONT_SIZE     = 12
const METER_FONT_SIZE     = 13
const LABEL_MARGIN_SMALL  = 4       // bottom margin under round label

// Next-round controls (shown when phase === 'open')
const NEXT_FONT_SIZE      = 15
const BTN_WIDTH           = 240
const BTN_HEIGHT          = 48
const BTN_FONT_SIZE       = 16

// Timer colour thresholds — countdown text shifts white → yellow → orange → red
const TIMER_YELLOW_S      = 45   // seconds remaining when text turns yellow
const TIMER_ORANGE_S      = 30   // seconds remaining when text turns orange
const TIMER_RED_S         = 15   // seconds remaining when text turns red

// Progress bar colours (keyed to cleanliness %)
const BAR_BG_COLOR        = { r: 0.12, g: 0.12, b: 0.12, a: 0.85 } as const
const BAR_COLOR_GOOD      = { r: 0.20, g: 0.90, b: 0.30, a: 1 }    as const  // ≥ 80 %
const BAR_COLOR_MID       = { r: 0.90, g: 0.75, b: 0.10, a: 1 }    as const  // 50–80 %
const BAR_COLOR_LOW       = { r: 0.90, g: 0.30, b: 0.15, a: 1 }    as const  // < 50 %

// Outcome images — shown in place of the instructions image during the open phase
// All outcome images are 1024×128 — same aspect ratio as InstructionsUI
const OUTCOME_IMAGES: Record<string, string> = {
  perfect:    'assets/scene/UI/PerfectClean.png',
  optimal:    'assets/scene/UI/AmazingClean.png',
  adequate:   'assets/scene/UI/AdequateClean.png',
  suboptimal: 'assets/scene/UI/BadClean.png',
}

// Text colours
const COLOR_SUBTLE        = { r: 0.60, g: 0.60, b: 0.60, a: 1 } as const  // round label
const COLOR_DIM           = { r: 0.85, g: 0.85, b: 0.85, a: 1 } as const  // meter / next-round

// Toast notifications
// Toast images are 1024×256 (4:1 ratio)
const TOAST_W_DESKTOP     = 450
const TOAST_H_DESKTOP     = 113    // 450 × (256/1024)
const TOAST_W_MOBILE      = 320
const TOAST_H_MOBILE      = 80     // 320 × (256/1024)
const TOAST_OVERLAP       = 0   // fraction of toast HEIGHT to pull each card up (creates stack)
const TOAST_FONT_SIZE     = 18     // count text (e.g. "3 / 38")
const NARR_FONT_SIZE      = 17     // narrative body text
// Position of overlaid text within the toast image.
// Values are fractions of the toast HEIGHT / WIDTH from the top-left corner.
// Tune each set independently to align with the text area in each PNG asset.
const TOAST_LABEL_TOP     = 0.5    // glasses / bottles count: vertical position
const TOAST_LABEL_LEFT    = 0.35   // glasses / bottles count: horizontal position
const NARR_LABEL_TOP      = 0.5   // narrative body text: vertical position
const NARR_LABEL_LEFT     = 0.1   // narrative body text: horizontal position
const NARR_LABEL_W_FRAC   = 0.77   // narrative text box width as fraction of toast width
// Toast container anchor — percentage strings scale with the canvas on all devices
const TOAST_POS_DESKTOP   = { top: '33%', right: '2%'  } as const
const TOAST_POS_MOBILE    = { top: '9%',  left: '38%'  } as const

// Admin panel (desktop only — right edge is unsafe on mobile)
const ADMIN_TOP           = 20
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
  narrative: 4_500,
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

function getRoundLabel(n: number): string {
  const labels = ['Round 1', 'Round 2', 'Round 3', 'Final Round']
  return labels[Math.min(n, labels.length - 1)]
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

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

/** Called each time the local player enters the scene — restarts the full intro (with hold). */
export function resetIntro() {
  introStartMs = Date.now()
  introHoldS   = INTRO_HOLD_S
}

export function setupUi() {
  checkAdmin()
  ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: 1920, virtualHeight: 1080 })
}

const WHITE = { r: 1, g: 1, b: 1, a: 1 } as const

const ui = () => {
  const gs            = getGameState()
  const cleaned       = gs?.cleanedCount ?? 0
  const total         = Math.max(1, gs?.totalCount ?? 1)
  const seconds       = gs?.secondsLeft ?? 0
  const phase         = gs?.phase ?? 'playing'
  const roundNumber   = gs?.roundNumber ?? 0
  const outcome       = gs?.outcome ?? ''
  const canStartEarly = gs?.canStartEarly ?? false
  const pct           = Math.min(1, cleaned / total)
  const isOpen        = phase === 'open'

  // ── Round-transition detection ────────────────────────────────────────────────
  // Runs every render call but only acts when isOpen changes value.
  if (isOpen && !prevIsOpen) {
    // Round just ended — tween outcome image from normal position to centre.
    outcomeStartMs = Date.now()
    introStartMs   = -1   // cancel any pending player-entry intro
  }
  if (!isOpen && prevIsOpen) {
    // New round started — tween instructions from centre back to normal, no hold.
    introStartMs   = Date.now()
    introHoldS     = 0
    outcomeStartMs = -1
  }
  prevIsOpen = isOpen

  // isMobile() resolves asynchronously — returns false until the client reports
  // its platform, after which the renderer re-runs and picks up the correct values.
  const mobile = isMobile()
  const S      = mobile ? MOBILE_SCALE : 1

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
  const nextFont     = Math.round(NEXT_FONT_SIZE     * S)
  const btnW         = Math.round(BTN_WIDTH          * S)
  const btnH         = Math.round(BTN_HEIGHT         * S)
  const btnFont      = Math.round(BTN_FONT_SIZE      * S)
  const toastW       = mobile ? TOAST_W_MOBILE : TOAST_W_DESKTOP
  const toastH       = mobile ? TOAST_H_MOBILE : TOAST_H_DESKTOP
  const toastOverlap = -Math.round(toastH * TOAST_OVERLAP)
  const toastFont    = Math.round(TOAST_FONT_SIZE    * S)
  const narrFont     = Math.round(NARR_FONT_SIZE     * S)
  const toastPos     = mobile ? TOAST_POS_MOBILE : TOAST_POS_DESKTOP
  const toastAlign   = mobile ? 'flex-start' as const : 'flex-end' as const

  const barColor = pct >= 0.8 ? BAR_COLOR_GOOD
                 : pct >= 0.5 ? BAR_COLOR_MID
                 :              BAR_COLOR_LOW

  const timerColor = seconds > TIMER_YELLOW_S ? WHITE
                   : seconds > TIMER_ORANGE_S  ? { r: 1, g: 0.85, b: 0.0,  a: 1 }
                   : seconds > TIMER_RED_S     ? { r: 1, g: 0.45, b: 0.0,  a: 1 }
                   :                             { r: 1, g: 0.10, b: 0.05, a: 1 }

  // ── Shared lerp targets (used by both intro and outcome animations) ───────────
  // eased = 0 → image at centre/big;  eased = 1 → image at normal top position
  const introImgW   = Math.round(instrW * INTRO_SIZE_MULT)
  const introImgH   = Math.round(instrH * INTRO_SIZE_MULT)
  const centredLeft = Math.round((1920 - introImgW) / 2)
  const centredTop  = Math.round(INTRO_CENTER_Y - introImgH / 2)
  const normLeft    = Math.round((1920 - instrW) / 2)
  const normTop     = INSTR_MARGIN_TOP

  // ── Intro animation (centre → normal): player entry or round start ────────────
  // introHoldS = INTRO_HOLD_S for player entry (holds at centre), 0 for round start (snaps immediately).
  const elapsedS      = introStartMs >= 0 ? (Date.now() - introStartMs) / 1000 : 9999
  const introActive   = elapsedS < introHoldS + INTRO_TWEEN_S
  const introProgress = elapsedS < introHoldS ? 0
    : Math.min(1, (elapsedS - introHoldS) / INTRO_TWEEN_S)
  // Ease-in quad — accelerates into the snap, feels like a quick pop
  const eased           = introProgress * introProgress
  const animW           = Math.round(lerp(introImgW, instrW,    eased))
  const animH           = Math.round(lerp(introImgH, instrH,    eased))
  const animTop         = Math.round(lerp(centredTop,  normTop,  eased))
  const animLeft        = Math.round(lerp(centredLeft, normLeft, eased))
  // Timer tracks the image and scales to match during the animation
  const timerAnimTop    = Math.round(lerp(INTRO_CENTER_Y + INTRO_TIMER_BELOW, TIMER_ROW_TOP, eased))
  const animTimerIconSz = Math.round(lerp(timerIconSz * INTRO_SIZE_MULT, timerIconSz, eased))
  const animTimerFont   = Math.round(lerp(timerFont   * INTRO_SIZE_MULT, timerFont,   eased))

  // ── Outcome animation (normal → centre): round ends ──────────────────────────
  // Ease-out feel: moves quickly from normal position then settles at centre.
  const outcomeSec      = outcomeStartMs >= 0 ? (Date.now() - outcomeStartMs) / 1000 : 9999
  const outcomeProgress = Math.min(1, outcomeSec / INTRO_TWEEN_S)
  const outcomeEased    = (1 - outcomeProgress) * (1 - outcomeProgress)  // 1→0 (ease-out)
  const outcomeAnimW    = Math.round(lerp(introImgW, instrW,    outcomeEased))
  const outcomeAnimH    = Math.round(lerp(introImgH, instrH,    outcomeEased))
  const outcomeAnimTop  = Math.round(lerp(centredTop,  normTop,  outcomeEased))
  const outcomeAnimLeft = Math.round(lerp(centredLeft, normLeft, outcomeEased))

  // Source for the "settled" image slot (instructions or outcome card)
  const topImageSrc = isOpen
    ? (OUTCOME_IMAGES[outcome] ?? OUTCOME_IMAGES['suboptimal'])
    : 'assets/scene/UI/InstructionsUI.png'

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', alignItems: 'center', flexDirection: 'column' }}
    >

      {/* ── Top image slot ───────────────────────────────────────────────────────
           Hidden whenever an animated overlay covers it (intro or open phase).
           Always sits at its normal top position so it snaps into view correctly
           once the overlay finishes.                                             */}
      <UiEntity
        uiTransform={{ width: instrW, height: instrH, margin: { top: INSTR_MARGIN_TOP } }}
        uiBackground={{
          texture:     { src: topImageSrc },
          textureMode: 'stretch',
          color:       (introActive || isOpen) ? { r: 1, g: 1, b: 1, a: 0 } : WHITE,
        }}
      />

      {/* ── Intro overlay — centre → normal (player entry or round start) ─────── */}
      {introActive && !isOpen && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position:     { top: animTop, left: animLeft },
            width:        animW,
            height:       animH,
          }}
          uiBackground={{
            texture:     { src: 'assets/scene/UI/InstructionsUI.png' },
            textureMode: 'stretch',
            color:       WHITE,
          }}
        />
      )}

      {/* ── Outcome overlay — normal → centre when round ends, holds at centre ── */}
      {isOpen && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position:     { top: outcomeAnimTop, left: outcomeAnimLeft },
            width:        outcomeAnimW,
            height:       outcomeAnimH,
          }}
          uiBackground={{
            texture:     { src: topImageSrc },
            textureMode: 'stretch',
            color:       WHITE,
          }}
        />
      )}

      {/* ── Timer row: icon left, big bold countdown right ───────────────────── */}
      {/* Hidden during intro — the intro timer overlay takes over             */}
      {!isOpen && !introActive && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: TIMER_ROW_TOP },
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
            position:       { top: timerAnimTop },
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
            position:       { top: BAR_ROW_TOP },
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

      {/* ── Info strip (round label + next-round controls) ────────────────────── */}
      <UiEntity
        uiTransform={{
          positionType:   'absolute',
          position:       { top: STRIP_TOP },
          width:          '100%',
          flexDirection:  'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{ width: stripWidth, flexDirection: 'column', alignItems: 'center' }}
        >
          <Label
            value={DEBUG ? `[DEBUG] ${getRoundLabel(roundNumber)}` : getRoundLabel(roundNumber)}
            fontSize={roundFont}
            color={COLOR_SUBTLE}
            uiTransform={{ margin: { bottom: LABEL_MARGIN_SMALL } }}
          />

          {isOpen && (
            <UiEntity
              uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}
            >
              {canStartEarly ? (
                <Button
                  value="▶  Start Next Round"
                  variant="primary"
                  fontSize={btnFont}
                  onMouseDown={() => room.send('startNextRound', { dummy: true })}
                  uiTransform={{ width: btnW, height: btnH }}
                />
              ) : (
                <Label
                  value={`Next round in ${formatTime(seconds)}`}
                  fontSize={nextFont}
                  color={COLOR_DIM}
                />
              )}
            </UiEntity>
          )}
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
