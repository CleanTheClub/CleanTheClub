import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { getUserData } from '~system/UserIdentity'
import { GameState } from './shared/schemas'
import { ADMIN_ADDRESSES, DEBUG } from './shared/config'
import { room } from './shared/messages'

let toastMsg = ''
let toastTimer: ReturnType<typeof setTimeout> | null = null
let isAdmin = false

export function showToast(msg: string) {
  toastMsg = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg = '' }, 2500)
}

async function checkAdmin() {
  try {
    const { data } = await getUserData({})
    if (data?.userId && ADMIN_ADDRESSES.includes(data.userId.toLowerCase())) {
      isAdmin = true
    }
    // In DEBUG mode anyone can use the admin panel for easy testing
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

function getOutcomeBanner(outcome: string): { text: string; bg: { r: number; g: number; b: number; a: number } } {
  if (outcome === 'optimal') return {
    text: 'Club is Open — Great Work! 🎉',
    bg: { r: 0.1, g: 0.7, b: 0.3, a: 0.95 },
  }
  if (outcome === 'adequate') return {
    text: 'Club Opens — Room for Improvement!',
    bg: { r: 0.8, g: 0.55, b: 0.1, a: 0.95 },
  }
  return {
    text: 'Yikes... but the doors are open!',
    bg: { r: 0.7, g: 0.15, b: 0.15, a: 0.95 },
  }
}

export function setupUi() {
  checkAdmin()
  ReactEcsRenderer.setUiRenderer(ui, { virtualWidth: 1920, virtualHeight: 1080 })
}

const ui = () => {
  const gs           = getGameState()
  const cleaned      = gs?.cleanedCount ?? 0
  const total        = Math.max(1, gs?.totalCount ?? 1)
  const seconds      = gs?.secondsLeft ?? 0
  const phase        = gs?.phase ?? 'playing'
  const roundNumber  = gs?.roundNumber ?? 0
  const outcome      = gs?.outcome ?? ''
  const canStartEarly = gs?.canStartEarly ?? false
  const pct          = Math.min(1, cleaned / total)
  const isOpen       = phase === 'open'

  const bannerBg   = isOpen
    ? getOutcomeBanner(outcome).bg
    : { r: 0.1, g: 0.1, b: 0.1, a: 0.85 }
  const bannerText = isOpen
    ? getOutcomeBanner(outcome).text
    : 'Clean up before opening time!'

  const barColor = pct >= 0.8
    ? { r: 0.2, g: 0.9, b: 0.3, a: 1 as number }
    : pct >= 0.5
    ? { r: 0.9, g: 0.75, b: 0.1, a: 1 as number }
    : { r: 0.9, g: 0.3, b: 0.15, a: 1 as number }

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', alignItems: 'center', flexDirection: 'column' }}
    >
      <UiEntity
        uiTransform={{ margin: { top: 20 }, width: 480, flexDirection: 'column', alignItems: 'center' }}
      >
        {/* Round label */}
        <Label
          value={DEBUG ? `[DEBUG] ${getRoundLabel(roundNumber)}` : getRoundLabel(roundNumber)}
          fontSize={12}
          color={{ r: 0.6, g: 0.6, b: 0.6, a: 1 }}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        {/* Banner */}
        <UiEntity
          uiTransform={{ width: '100%', height: 48, justifyContent: 'center', alignItems: 'center', margin: { bottom: 6 } }}
          uiBackground={{ color: bannerBg }}
        >
          <Label value={bannerText} fontSize={16} color={{ r: 1, g: 1, b: 1, a: 1 }} />
        </UiEntity>

        {/* Meter label */}
        <Label
          value={`${Math.round(pct * 100)}% Cleaned — ${cleaned} / ${total}`}
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

        {/* Timer — only while playing */}
        {!isOpen && (
          <Label value={`⏱ ${formatTime(seconds)}`} fontSize={20} color={{ r: 1, g: 1, b: 1, a: 1 }} />
        )}

        {/* Celebration countdown + early-start */}
        {isOpen && (
          <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', margin: { top: 10 } }}
          >
            {canStartEarly ? (
              <Button
                value="▶  Start Next Round"
                variant="primary"
                fontSize={16}
                onMouseDown={() => room.send('startNextRound', { dummy: true })}
                uiTransform={{ width: 240, height: 48 }}
              />
            ) : (
              <Label
                value={`Next round in ${formatTime(seconds)}`}
                fontSize={15}
                color={{ r: 0.85, g: 0.85, b: 0.85, a: 1 }}
              />
            )}
          </UiEntity>
        )}
      </UiEntity>

      {/* Admin panel */}
      {isAdmin && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 20, right: 20 },
            flexDirection: 'column',
            alignItems: 'flex-end',
          }}
        >
          <Label
            value={DEBUG ? 'ADMIN  [DEBUG ON]' : 'ADMIN'}
            fontSize={10}
            color={{ r: 1, g: 0.6, b: 0.1, a: 0.8 }}
            uiTransform={{ margin: { bottom: 4 } }}
          />
          <Button
            value="Reset to Round 1"
            variant="secondary"
            fontSize={12}
            onMouseDown={() => room.send('adminReset', { dummy: true })}
            uiTransform={{ width: 140, height: 34 }}
          />
        </UiEntity>
      )}

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
