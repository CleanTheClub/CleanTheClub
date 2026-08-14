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
}) {
  const id = props.id ?? props.value
  const t  = props.uiTransform ?? {}
  const h  = typeof t.height === 'number' ? t.height : 60
  const isPressed = Date.now() - (pressedAt.get(id) ?? -PRESS_MS * 2) < PRESS_MS
  const innerSize = isPressed ? '92%' : '100%'

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
        uiTransform={{ width: innerSize, height: innerSize, borderRadius: Math.round(h * 0.24) }}
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
