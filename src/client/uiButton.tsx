// Shared button chrome — rounded corners plus lightweight hover/press feedback
// on top of the stock react-ecs Button, which draws sharp-cornered flat fills
// and gives no interaction response at all.
//
// The wrapper reserves the caller's width/height on an OUTER UiEntity and lets
// the visible button move INSIDE it: a press shrinks it ~8% for 140ms, hover
// paints a soft rounded halo behind it and plays the hover blip. The outer box
// never changes size, so siblings never shift — feedback stays local to the
// button.
//
// Feedback state lives in module maps keyed by button id (default: the label)
// because the UI renders every frame and react-ecs components hold no state.
// Two buttons sharing a label share press state — harmless here, since
// same-label buttons never show on screen together.

import ReactEcs, { Button, UiEntity } from '@dcl/sdk/react-ecs'
import type { UiTransformProps } from '@dcl/sdk/react-ecs'
import { playHoverSound, playClickSound } from './soundManager'

const PRESS_MS = 140

// ── Wiggle — "you can afford this" attention cue ─────────────────────────────
// A short horizontal shake burst every couple of seconds, opted into via the
// `wiggle` prop (shop entry points + affordable buy buttons). POSITION, not
// scale: per-frame size tweens force relayout and stutter on mobile's uneven
// frame pacing (the PayoutShopCta lesson), while the inner button shifting a
// few px inside its fixed outer box moves nothing else on screen. Sampled on
// the same 100ms-quantized clock as every other decorative pulse, so an idle
// screen isn't re-laid-out at frame rate.
// Tuned UP from ±3px/1.5 cycles (playtest: "should be much more obvious, like
// a shake"): ±8px, two full left-right oscillations per burst. At the 100ms
// sample rate that lands on alternating ±7px offsets — an unmistakable rattle.
const WIGGLE_PERIOD_MS = 2000   // one burst per period
const WIGGLE_BURST_MS  = 600    // burst length within the period
const WIGGLE_AMP_PX    = 8
const pulseNow = (): number => Math.floor(Date.now() / 100) * 100
function wiggleOffsetX(): number {
  const t = pulseNow() % WIGGLE_PERIOD_MS
  if (t >= WIGGLE_BURST_MS) return 0
  return Math.round(WIGGLE_AMP_PX * Math.sin((t / WIGGLE_BURST_MS) * Math.PI * 4))
}

const pressedAt = new Map<string, number>()
const hovered   = new Set<string>()

export function GameButton(props: {
  value: string
  variant?: 'primary' | 'secondary'
  fontSize?: number
  /** Outer box: width / height / margin — the shape callers passed to Button. */
  uiTransform?: UiTransformProps
  onMouseDown?: () => void
  /** Stable feedback key; defaults to the label. */
  id?: string
  /** Periodic attention shake — set while the action is worth shouting about
   *  (e.g. an upgrade is affordable). */
  wiggle?: boolean
}) {
  const id = props.id ?? props.value
  const t  = props.uiTransform ?? {}
  const h  = typeof t.height === 'number' ? t.height : 60
  const isPressed = Date.now() - (pressedAt.get(id) ?? -PRESS_MS * 2) < PRESS_MS
  const innerSize = isPressed ? '92%' : '100%'
  // No shake mid-press — the press shrink is its own feedback.
  const shakeX = props.wiggle && !isPressed ? wiggleOffsetX() : 0
  // Wiggle also paints the button AMBER-ORANGE (feedback: the shake alone
  // wasn't drawing the eye to "worth clicking right now") — motion plus colour,
  // one signal. Orange, not red: red read as danger (playtest feedback), and
  // not purple: it would sink into the club's own palette. Amber rhymes with
  // the gold money text — "spendable", which is what this state means. Dark
  // text for contrast on the warm fill. CONDITIONAL SPREAD, not always-present
  // props: an explicit `color={undefined}` still overrides the variant's text
  // colour in the react-ecs prop merge — which made every non-wiggling primary
  // button render white-on-white, i.e. textless (field report, one deploy of
  // pain).
  const alertProps = props.wiggle
    ? {
        uiBackground: { color: { r: 0.98, g: 0.62, b: 0.09, a: 1 } },
        color: { r: 0.12, g: 0.06, b: 0.01, a: 1 },
      }
    : {}

  return (
    <UiEntity
      uiTransform={{
        ...t,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        borderRadius: Math.round(h * 0.3),
      }}
      uiBackground={{ color: { r: 1, g: 1, b: 1, a: hovered.has(id) ? 0.14 : 0 } }}
    >
      <Button
        value={props.value}
        variant={props.variant ?? 'primary'}
        fontSize={props.fontSize}
        {...alertProps}
        uiTransform={{ width: innerSize, height: innerSize, borderRadius: Math.round(h * 0.24), margin: { left: shakeX } }}
        onMouseEnter={() => {
          if (!hovered.has(id)) { hovered.add(id); playHoverSound() }
        }}
        onMouseLeave={() => { hovered.delete(id) }}
        onMouseDown={() => {
          pressedAt.set(id, Date.now())
          playClickSound()
          props.onMouseDown?.()
        }}
      />
    </UiEntity>
  )
}
