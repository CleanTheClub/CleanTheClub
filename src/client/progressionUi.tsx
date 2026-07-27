// Career progression UI — persistent HUD, end-of-shift payout, and upgrade shop.
//
// Kept out of ui.tsx, which is already large; ui.tsx composes these components into
// its single render tree. Every component takes the caller's mobile scale `S` so
// sizing stays consistent with the rest of the HUD.
//
// LAYOUT RULE (learned from the narrative-toast overflow bug): text inside a fixed
// panel derives its size from that panel, and full-bleed overlays use percentage
// width — never a fixed virtual-pixel width, which does not reach the screen edges
// on aspects wider than 16:9.

import ReactEcs, { UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { theme } from './theme'
import {
  UPGRADES, UpgradeDef, maxLevel, nextUpgradeCost, rankForXp, JOB_TITLES,
} from '../shared/progression'
import { getCareer, getCareerOrEmpty, upgradeLevel, requestPurchase } from './progressionStore'
import { getSafeArea, pct } from './safeArea'

const WHITE  = theme.colors.white
const SUBTLE = theme.text.subtle
const PANEL  = Color4.create(0, 0, 0, 0.82)
const TRACK  = theme.bar.bg
const GOLD   = Color4.create(1, 0.82, 0.25, 1)
const XP_FILL = theme.colors.success

const money = (n: number): string => `$${n.toLocaleString('en-US')}`

// Local mirror of the renderer's PositionUnit rather than a deep import from
// @dcl/react-ecs/dist/... — reaching into dist internals breaks on any SDK
// restructure, and this only needs the two forms the payout panel actually uses.
type TopUnit = number | `${number}%`

// ── Shop open/closed ──────────────────────────────────────────────────────────
// Module state rather than React state: the renderer re-runs ui() continuously, so
// a plain flag is enough and avoids threading state through ui.tsx.
let shopOpen = false
export const isShopOpen = (): boolean => shopOpen
export const setShopOpen = (open: boolean): void => { shopOpen = open }
export const closeShop = (): void => { shopOpen = false }

// ─────────────────────────────────────────────────────────────────────────────
// Career HUD — always-visible title, promotion progress and balance.
// ─────────────────────────────────────────────────────────────────────────────
export function CareerBar({ S }: { S: number }) {
  const c = getCareer()
  if (!c) return null   // no progressUpdate yet — render nothing rather than zeros

  const barW = Math.round(240 * S)
  const barH = Math.round(10 * S)
  const font = Math.round(18 * S)
  const pad  = Math.round(10 * S)

  // Anchor to the live safe area (the region the explorer's own UI does NOT cover)
  // rather than a guessed corner. The explorer renders its UI on top of ours and
  // reports the usable rect via UiCanvasInformation.interactableArea, which changes
  // with platform and as the player toggles chat. We sit just inside its top-right:
  // clear of desktop chat/minimap (left + reserved edges) and the mobile profile/
  // joystick/interaction clusters, and it follows chat live since the UI re-renders
  // every frame. A small extra margin keeps it off the exact safe-area edge.
  const sa = getSafeArea()
  const topPos   = pct(sa.top + 0.03)
  const rightPos = pct(sa.right + 0.015)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: topPos, right: rightPos },
        flexDirection: 'column',
        alignItems: 'flex-end',
        padding: { top: pad, bottom: pad, left: pad, right: pad },
      }}
      uiBackground={{ color: theme.hud.bg }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        <Label value={c.title} fontSize={font} color={WHITE} />
        <Label value={`  ${money(c.money)}`} fontSize={font} color={GOLD} />
      </UiEntity>

      {/* Promotion progress. At max rank the bar is full and labelled, rather than
          showing a bar that can never fill. */}
      <UiEntity uiTransform={{ width: barW, height: barH, margin: { top: Math.round(6 * S) } }}
        uiBackground={{ color: TRACK }}>
        <UiEntity
          uiTransform={{ width: Math.round(barW * Math.max(0, Math.min(1, c.fraction))), height: barH }}
          uiBackground={{ color: XP_FILL }}
        />
      </UiEntity>
      <Label
        value={c.nextTitle ? `${Math.round(c.fraction * 100)}% to ${c.nextTitle}` : 'Top of the ladder'}
        fontSize={Math.round(14 * S)}
        color={SUBTLE}
        uiTransform={{ margin: { top: Math.round(3 * S) } }}
      />
      {c.isGuest && (
        <Label
          value="Guest — sign in to save progress"
          fontSize={Math.round(13 * S)}
          color={theme.colors.warning}
          uiTransform={{ margin: { top: Math.round(3 * S) } }}
        />
      )}
    </UiEntity>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// End-of-shift payout — the GDD's "clear feedback at the end of every shift".
// Rendered by ui.tsx during the intermission, below the outcome banner.
// ─────────────────────────────────────────────────────────────────────────────
export function ShiftPayoutPanel({ S, top }: { S: number; top: TopUnit }) {
  const c = getCareer()
  const shift = c?.lastShift
  if (!c || !shift) return null

  const font  = Math.round(22 * S)
  const small = Math.round(16 * S)
  const pad   = Math.round(14 * S)

  const row = (label: string, value: string, color: Color4) => (
    <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'space-between', width: Math.round(300 * S) }}>
      <Label value={label} fontSize={small} color={SUBTLE} />
      <Label value={value} fontSize={small} color={color} />
    </UiEntity>
  )

  // Centre within the SAFE band, not the whole screen: a full-width centred row
  // centres over the reserved left 25% (desktop chat/minimap) too, pushing the
  // panel left of true-usable centre and under explorer UI. Offsetting by the
  // safe-area left inset and narrowing to the safe width centres it in the region
  // the player can actually see. `top` stays as passed (well below any top inset).
  const sa = getSafeArea()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top, left: pct(sa.left) },
        width: pct(Math.max(0.1, 1 - sa.left - sa.right)),
        flexDirection: 'row',
        justifyContent: 'center',
      }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'column',
          alignItems: 'center',
          padding: { top: pad, bottom: pad, left: pad * 2, right: pad * 2 },
        }}
        uiBackground={{ color: PANEL }}
      >
        {/* UiEntity columns rather than JSX fragments — the DCL renderer's
            jsxFactory has no fragment support. */}
        {shift.passed ? (
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
            <Label value="Shift Complete" fontSize={font} color={WHITE} />
            {row('Items cleaned', String(shift.items), WHITE)}
            {row('Earned',        money(shift.money), GOLD)}
            {row('XP',            `+${shift.xp}`,     XP_FILL)}
          </UiEntity>
        ) : (
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
            <Label value="Shift Failed" fontSize={font} color={theme.bar.low} />
            <Label
              value="The club wasn't clean enough — no wage this shift."
              fontSize={small}
              color={SUBTLE}
            />
          </UiEntity>
        )}

        {c.promotedTo && (
          <Label
            value={`PROMOTED — ${c.promotedTo}!`}
            fontSize={Math.round(20 * S)}
            color={GOLD}
            uiTransform={{ margin: { top: Math.round(8 * S) } }}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade shop — browsable in the lobby and between shifts (GDD: "players can
// browse upgrades while waiting for the next match to start").
// ─────────────────────────────────────────────────────────────────────────────
// Per-upgrade thumbnail tiles (assets/scene/UI/upgrade_*.png). Presentation only,
// so the paths live here rather than on the shared UpgradeDef.
const UPGRADE_ICONS: Record<string, string> = {
  movementSpeed: 'assets/scene/UI/upgrade_movementSpeed.png',
  moppingSpeed:  'assets/scene/UI/upgrade_moppingSpeed.png',
  carryCapacity: 'assets/scene/UI/upgrade_carryCapacity.png',
  portableBin:   'assets/scene/UI/upgrade_portableBin.png',
  vacuum:        'assets/scene/UI/upgrade_vacuum.png',
}

function UpgradeRow({ def, S, width }: { def: UpgradeDef; S: number; width: number; key?: string }) {
  const c     = getCareerOrEmpty()
  const level = upgradeLevel(def.id)
  const max   = maxLevel(def)
  const cost  = nextUpgradeCost(def.id, level)
  const rank  = rankForXp(c.xp)

  const locked   = def.minRank !== undefined && rank < def.minRank
  const maxed    = cost === null
  const affordable = cost !== null && c.money >= cost

  const font  = Math.round(21 * S)
  const small = Math.round(15 * S)
  const icon  = Math.round(64 * S)

  // One clear reason why a purchase isn't available, rather than a dead button.
  const statusLabel = maxed
    ? 'MAX'
    : locked
    ? `Needs ${JOB_TITLES[def.minRank!]}`
    : !affordable
    ? money(cost!)
    : money(cost!)

  return (
    <UiEntity
      uiTransform={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width,
        margin: { bottom: Math.round(10 * S) },
        padding: { top: Math.round(10 * S), bottom: Math.round(10 * S), left: Math.round(12 * S), right: Math.round(14 * S) },
      }}
      uiBackground={{ color: Color4.create(1, 1, 1, 0.06) }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        <UiEntity
          uiTransform={{ width: icon, height: icon, margin: { right: Math.round(12 * S) } }}
          uiBackground={{ texture: { src: UPGRADE_ICONS[def.id] }, textureMode: 'stretch', color: WHITE }}
        />
        <UiEntity uiTransform={{ flexDirection: 'column' }}>
          <Label value={`${def.name}   Lv ${level}/${max}`} fontSize={font} color={WHITE} />
          <Label value={def.description} fontSize={small} color={SUBTLE} />
        </UiEntity>
      </UiEntity>

      {maxed || locked ? (
        <Label value={statusLabel} fontSize={small} color={locked ? theme.colors.tertiary : GOLD} />
      ) : (
        <Button
          value={statusLabel}
          variant={affordable ? 'primary' : 'secondary'}
          fontSize={Math.round(18 * S)}
          uiTransform={{ width: Math.round(150 * S), height: Math.round(52 * S) }}
          // Still sent when unaffordable: the server is the authority and will
          // refuse and resync, which self-corrects a client showing stale money.
          onMouseDown={() => requestPurchase(def.id)}
        />
      )}
    </UiEntity>
  )
}

// Shared shop contents, laid out to whatever width the presentation gives it.
// Both the modal and the side panel render this, so the two can never drift apart.
function ShopBody({ S, rowWidth, titleSize }: { S: number; rowWidth: number; titleSize: number }) {
  const c = getCareerOrEmpty()

  // Upgrades whose underlying mechanic doesn't exist yet are hidden rather than
  // shown disabled — advertising something unbuyable is worse than not listing it.
  const visible = UPGRADES.filter((u) => u.implemented)

  return (
    <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: Math.round(16 * S) } }}>
        <Label value="UPGRADES" fontSize={titleSize} color={WHITE} />
        <Label value={`   ${money(c.money)}`} fontSize={Math.round(titleSize * 0.82)} color={GOLD} />
      </UiEntity>

      {visible.map((def) => <UpgradeRow key={def.id} def={def} S={S} width={rowWidth} />)}

      <Button
        value="CLOSE"
        variant="secondary"
        fontSize={Math.round(20 * S)}
        uiTransform={{ width: Math.round(180 * S), height: Math.round(52 * S), margin: { top: Math.round(16 * S) } }}
        onMouseDown={() => { shopOpen = false }}
      />
    </UiEntity>
  )
}

/**
 * Full-screen modal shop. Used where there is nothing behind worth preserving —
 * the lobby and the spectator screen, both of which are already scrims.
 */
export function UpgradeShopOverlay({ S }: { S: number }) {
  if (!shopOpen) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, left: 0 },
        width: '100%', height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      }}
      uiBackground={{ color: PANEL }}
    >
      <ShopBody S={S} rowWidth={Math.round(700 * S)} titleSize={Math.round(44 * S)} />
    </UiEntity>
  )
}

/**
 * Side-panel shop, used during the intermission.
 *
 * The intermission is the game's payoff — the crowd arrives, confetti fires, the
 * music swaps and the player's own party emote plays. Blacking that out behind a
 * full-screen modal would hide the exact reward the shift was earned for, so here
 * the shop takes only the right-hand strip and leaves the celebration visible and
 * playing behind it.
 */
export function UpgradeShopPanel({ S }: { S: number }) {
  if (!shopOpen) return null
  const pad = Math.round(16 * S)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, right: 0 },
        width: Math.round(580 * S), height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        padding: { top: pad, bottom: pad, left: pad, right: pad },
      }}
      // Lighter than the modal scrim: enough to keep text legible over a bright,
      // confetti-filled scene without hiding it.
      uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
    >
      <ShopBody S={S} rowWidth={Math.round(520 * S)} titleSize={Math.round(32 * S)} />
    </UiEntity>
  )
}

/** Small button that opens the shop; shown in the lobby and between shifts. */
export function ShopButton({ S }: { S: number }) {
  return (
    <Button
      value="UPGRADES"
      variant="secondary"
      fontSize={Math.round(20 * S)}
      uiTransform={{ width: Math.round(220 * S), height: Math.round(56 * S) }}
      onMouseDown={() => { shopOpen = true }}
    />
  )
}
