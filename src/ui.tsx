import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { GameState } from './shared/schemas'

let toastMsg = ''
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function showToast(msg: string) {
  toastMsg = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg = '' }, 2500)
}

function getGameState() {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs
  return null
}

function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: 1920, virtualHeight: 1080 })
}

const ui = () => {
  const gs        = getGameState()
  const cleaned   = gs?.cleanedCount ?? 0
  const total     = Math.max(1, gs?.totalCount ?? 1)
  const seconds   = gs?.secondsLeft ?? 0
  const phase     = gs?.phase ?? 'playing'
  const pct       = Math.min(1, cleaned / total)
  const isOpen    = phase === 'open'
  const isOpening = phase === 'opening'

  const bannerText = isOpen
    ? 'Club is Open! Great work!'
    : isOpening
    ? 'Almost there — hold it!'
    : 'Clean up before opening time!'

  const barColor = pct >= 0.8
    ? { r: 0.2, g: 0.9, b: 0.3, a: 1 as number }
    : { r: 0.9, g: 0.55, b: 0.1, a: 1 as number }

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', alignItems: 'center', flexDirection: 'column' }}
    >
      <UiEntity
        uiTransform={{ margin: { top: 20 }, width: 480, flexDirection: 'column', alignItems: 'center' }}
      >
        {/* Banner */}
        <UiEntity
          uiTransform={{ width: '100%', height: 48, justifyContent: 'center', alignItems: 'center', margin: { bottom: 6 } }}
          uiBackground={{ color: isOpen ? { r: 1, g: 0.84, b: 0, a: 0.92 } : { r: 0.1, g: 0.1, b: 0.1, a: 0.85 } }}
        >
          <Label value={bannerText} fontSize={16} color={{ r: 1, g: 1, b: 1, a: 1 }} />
        </UiEntity>

        {/* Meter label */}
        <Label
          value={`${Math.round(pct * 100)}% Clean — ${cleaned} / ${total}`}
          fontSize={13}
          color={{ r: 0.85, g: 0.85, b: 0.85, a: 1 }}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        {/* Progress bar */}
        <UiEntity
          uiTransform={{ width: '100%', height: 14, margin: { bottom: 8 } }}
          uiBackground={{ color: { r: 0.12, g: 0.12, b: 0.12, a: 0.85 } }}
        >
          <UiEntity
            uiTransform={{ width: `${Math.round(pct * 100)}%`, height: '100%' }}
            uiBackground={{ color: barColor }}
          />
        </UiEntity>

        {/* Timer */}
        {phase === 'playing' && (
          <Label value={`⏱ ${formatTime(seconds)}`} fontSize={20} color={{ r: 1, g: 1, b: 1, a: 1 }} />
        )}
      </UiEntity>

      {/* Toast */}
      {toastMsg !== '' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { bottom: 120 },
            alignSelf: 'center',
            width: 360,
            height: 46,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: { r: 0.08, g: 0.08, b: 0.08, a: 0.92 } }}
        >
          <Label value={toastMsg} fontSize={15} color={{ r: 1, g: 1, b: 1, a: 1 }} />
        </UiEntity>
      )}
    </UiEntity>
  )
}
