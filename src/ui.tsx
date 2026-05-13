import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { getUserData } from '~system/UserIdentity'
import { isMobile } from '@dcl/sdk/platform'
import { GameState } from './shared/schemas'
import { ADMIN_ADDRESSES, DEBUG } from './shared/config'
import { room } from './shared/messages'
import { playToastSound } from './client/soundManager'

let isAdmin = false

// ── Image toast stack ─────────────────────────────────────────────────────────
// Toasts appear on the right side at mid-height, stacking vertically, auto-expiring.

type ToastKind = 'cleaned' | 'glasses' | 'bottles' | 'narrative'

interface ToastEntry {
  id:       number
  kind:     ToastKind
  count?:   number    // glasses / bottles: items collected so far
  total?:   number    // glasses / bottles: collection goal
  text?:    string    // narrative: message to display
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

  // When the full collection is complete, pop a cleaned confirmation below it
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

const WHITE = { r: 1, g: 1, b: 1, a: 1 } as const

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

  // ── Platform-aware sizing ────────────────────────────────────────────────────
  // isMobile() resolves asynchronously — returns false until the client reports
  // its platform, after which the renderer re-runs and picks up the correct values.
  //
  // Mobile safe area (normalised, ref 1600×720):
  //   left: 30%,  right: 25%,  top: 8%,  bottom: 8%
  // In virtual 1920×1080 coords (scale ≈ 0.667):
  //   safe left  ≈ 720 vx,  safe right boundary ≈ vx 1320,  safe top ≈ 87 vy
  const mobile = isMobile()
  const S      = mobile ? 1.5 : 1   // uniform scale multiplier for text / UI chrome

  // Instructions
  const instrSize   = mobile ? 630 : 900   // smaller on mobile — still readable

  // Timer
  const timerIconSz = Math.round(64  * S)
  const timerFont   = Math.round(72  * S)

  // Secondary strip
  const stripWidth  = Math.round(440 * S)
  const roundFont   = Math.round(12  * S)
  const meterFont   = Math.round(13  * S)
  const barHeight   = Math.round(14  * S)
  const bannerH     = Math.round(52  * S)
  const bannerFont  = Math.round(17  * S)
  const nextFont    = Math.round(15  * S)
  const btnW        = Math.round(240 * S)
  const btnH        = Math.round(48  * S)
  const btnFont     = Math.round(16  * S)

  // Toasts
  // Desktop: right side (right: 40). Mobile: left of centre safe zone (left: 730)
  // so toasts stay clear of the 25% reserved right edge and 30% reserved left edge.
  const toastSize   = mobile ? 320  : 450
  // Negative overlap between stacked toasts — the images are mostly transparent,
  // content fills ~20% of height. Pull each toast up by ~75% of the image height
  // so only the content areas are visible with a small gap between them.
  const toastOverlap = -Math.round(toastSize * 0.70)
  const toastFont   = Math.round(14  * S)
  const narrFont    = Math.round(15  * S)
  const toastPos    = mobile
    ? { top: 92, left: 730 } as const   // top of safe zone, inside centre band
    : { top: 360, right: 40 } as const
  const toastAlign  = mobile ? 'flex-start' as const : 'flex-end' as const

  const barColor = pct >= 0.8
    ? { r: 0.2, g: 0.9, b: 0.3, a: 1 as number }
    : pct >= 0.5
    ? { r: 0.9, g: 0.75, b: 0.1, a: 1 as number }
    : { r: 0.9, g: 0.3, b: 0.15, a: 1 as number }

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', alignItems: 'center', flexDirection: 'column' }}
    >

      {/* ── Instructions image ───────────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{ width: instrSize, height: instrSize, margin: { top: 8 } }}
        uiBackground={{
          texture:     { src: 'assets/scene/UI/InstructionsUI.png' },
          textureMode: 'stretch',
          color:       WHITE,
        }}
      />

      {/* ── Timer row: icon left, big bold countdown right ───────────────────── */}
      {!isOpen && (
        <UiEntity
          uiTransform={{
            positionType:   'absolute',
            position:       { top: 160 },
            width:          '100%',
            flexDirection:  'row',
            alignItems:     'center',
            justifyContent: 'center',
          }}
        >
          <UiEntity
            uiTransform={{ width: timerIconSz, height: timerIconSz, margin: { right: 14 } }}
            uiBackground={{
              texture:     { src: 'assets/scene/UI/TimerIcon.png' },
              textureMode: 'stretch',
              color:       WHITE,
            }}
          />
          <Label
            value={formatTime(seconds)}
            fontSize={timerFont}
            color={WHITE}
          />
        </UiEntity>
      )}

      {/* ── Secondary info strip (round label + meter + progress) ─────────── */}
      <UiEntity
        uiTransform={{ width: stripWidth, flexDirection: 'column', alignItems: 'center', margin: { top: 14 } }}
      >
        <Label
          value={DEBUG ? `[DEBUG] ${getRoundLabel(roundNumber)}` : getRoundLabel(roundNumber)}
          fontSize={roundFont}
          color={{ r: 0.6, g: 0.6, b: 0.6, a: 1 }}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        <Label
          value={`${Math.round(pct * 100)}% Cleaned — ${cleaned} / ${total}`}
          fontSize={meterFont}
          color={{ r: 0.85, g: 0.85, b: 0.85, a: 1 }}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        <UiEntity
          uiTransform={{ width: '100%', height: barHeight, margin: { bottom: 8 } }}
          uiBackground={{ color: { r: 0.12, g: 0.12, b: 0.12, a: 0.85 } }}
        >
          <UiEntity
            uiTransform={{ width: `${Math.round(pct * 100)}%`, height: '100%' }}
            uiBackground={{ color: barColor }}
          />
        </UiEntity>

        {isOpen && (
          <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}
          >
            <UiEntity
              uiTransform={{ width: '100%', height: bannerH, justifyContent: 'center', alignItems: 'center', margin: { bottom: 10 } }}
              uiBackground={{ color: getOutcomeBanner(outcome).bg }}
            >
              <Label value={getOutcomeBanner(outcome).text} fontSize={bannerFont} color={WHITE} />
            </UiEntity>

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
                color={{ r: 0.85, g: 0.85, b: 0.85, a: 1 }}
              />
            )}
          </UiEntity>
        )}
      </UiEntity>

      {/* Admin panel — desktop only (right edge unsafe on mobile) */}
      {isAdmin && !mobile && (
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

      {/* ── Image toast stack ─────────────────────────────────────────────────── */}
      {/* Desktop: right side. Mobile: top of centre safe zone (left ≈ 730 vx),  */}
      {/* clear of the 25% right-reserved and 30% left-reserved mobile HUD edges. */}
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
                width:          toastSize,
                height:         toastSize,
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
                    position: { top: Math.round(toastSize * 0.53), left: Math.round(toastSize * 0.30) },
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
                    position: { top: Math.round(toastSize * 0.53), left: Math.round(toastSize * 0.30) },
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
