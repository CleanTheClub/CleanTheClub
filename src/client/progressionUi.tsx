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
import { isMobile } from '@dcl/sdk/platform'
import { theme } from './theme'
import {
  UPGRADES, UpgradeDef, maxLevel, nextUpgradeCost, rankForXp, JOB_TITLES,
} from '../shared/progression'
import { OUTCOME_ADEQUATE } from '../shared/config'
import { getCareer, getCareerOrEmpty, getLastPayoutMs, upgradeLevel, requestPurchase } from './progressionStore'
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

// ── Shop zoom ─────────────────────────────────────────────────────────────────
// Extra scale applied to EVERYTHING inside the shop (fonts, icons, rows, buttons)
// on top of the caller's platform scale S. The shop is a focused full-attention
// surface, so it reads best noticeably larger than the ambient HUD — and on
// high-DPI desktops the virtual-px mapping renders smaller than designed (see the
// UI_ZOOM note in ui.tsx), which left the shop hard to read.
//
// TUNE HERE: raise toward 2.5 if the shop still reads small; lower toward 1.5 if
// it crowds the screen (check mobile before going higher).
const SHOP_ZOOM = 2.0

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

  // Bigger than the ambient HUD everywhere (reported easy to miss), bigger still
  // on mobile — this is the "what's that? gotta increase it!" surface, so it has
  // to pull the eye. The safe-area math below drops it below the explorer's
  // profile-icon cluster on mobile.
  const mobile = isMobile()
  const Z = mobile ? S * 1.7 : S * 1.3

  const barW = Math.round(260 * Z)
  const barH = Math.round(16 * Z)
  const font = Math.round(18 * Z)
  const pad  = Math.round(10 * Z)

  // Anchor to the live safe area (the region the explorer's own UI does NOT cover)
  // rather than a guessed corner. The explorer renders its UI on top of ours and
  // reports the usable rect via UiCanvasInformation.interactableArea, which changes
  // with platform and as the player toggles chat. We sit just inside its top-right:
  // clear of desktop chat/minimap (left + reserved edges) and the mobile profile/
  // joystick/interaction clusters, and it follows chat live since the UI re-renders
  // every frame. A small extra margin keeps it off the exact safe-area edge.
  // On mobile the explorer's profile-icon cluster sits inside the reported safe
  // area's top-right, so a bigger inset drops the bar below it.
  const sa = getSafeArea()
  const topPos   = pct(sa.top + (mobile ? 0.14 : 0.03))
  const rightPos = pct(sa.right + 0.015)

  // ── Juice ────────────────────────────────────────────────────────────────────
  // The XP fill breathes; within reach of a promotion (≥80%) it turns gold and
  // pulses urgently, and the label starts naming the prize. After a payout the
  // money figure pops and the XP gain floats up off the panel.
  const frac      = Math.max(0, Math.min(1, c.fraction))
  const nearPromo = c.nextTitle !== null && frac >= 0.8
  const pulse     = nearPromo
    ? 0.7  + 0.3  * Math.sin(Date.now() / 120)
    : 0.85 + 0.15 * Math.sin(Date.now() / 300)
  const fillColor = nearPromo
    ? Color4.create(1, 0.82, 0.25, Math.max(0.4, pulse))
    : Color4.create(XP_FILL.r, XP_FILL.g, XP_FILL.b, Math.max(0.5, pulse))

  const sincePayout = Date.now() - getLastPayoutMs()
  const moneyPop    = sincePayout < 600 ? 1 + 0.35 * (1 - sincePayout / 600) : 1
  const xpGain      = c.lastShift?.xp ?? 0
  const xpFloatT    = sincePayout < 2500 && xpGain > 0 ? sincePayout / 2500 : -1

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
        <Label value={`  ${money(c.money)}`} fontSize={Math.round(font * moneyPop)} color={GOLD} />
      </UiEntity>

      {/* Promotion progress. At max rank the bar is full and labelled, rather than
          showing a bar that can never fill. */}
      <UiEntity uiTransform={{ width: barW, height: barH, margin: { top: Math.round(6 * Z) } }}
        uiBackground={{ color: TRACK }}>
        <UiEntity
          uiTransform={{ width: Math.round(barW * frac), height: barH }}
          uiBackground={{ color: fillColor }}
        />
      </UiEntity>
      <Label
        value={c.nextTitle
          ? (nearPromo
            ? `${Math.round(frac * 100)}% — ${c.nextTitle} almost yours!`
            : `${Math.round(frac * 100)}% to ${c.nextTitle}`)
          : 'Top of the ladder'}
        fontSize={Math.round(14 * Z)}
        color={nearPromo ? GOLD : SUBTLE}
        uiTransform={{ margin: { top: Math.round(3 * Z) } }}
      />

      {/* +XP float — drifts up off the panel for a beat after each payout. */}
      {xpFloatT >= 0 && (
        <Label
          value={`+${xpGain} XP`}
          fontSize={Math.round(18 * Z)}
          color={{ r: XP_FILL.r, g: XP_FILL.g, b: XP_FILL.b, a: 1 - xpFloatT }}
          uiTransform={{
            positionType: 'absolute',
            position: { top: -Math.round((12 + 34 * xpFloatT) * Z), right: pad },
          }}
        />
      )}
      {c.isGuest && (
        <Label
          value="Guest — sign in to save progress"
          fontSize={Math.round(13 * Z)}
          color={theme.colors.warning}
          uiTransform={{ margin: { top: Math.round(3 * Z) } }}
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

  // The payout is the shift's headline moment and a focused overlay like the
  // shop, so it shares SHOP_ZOOM — at ambient HUD sizes it was unreadable
  // ("can't really read it") on both platforms.
  const Z = S * SHOP_ZOOM

  const font  = Math.round(22 * Z)
  const small = Math.round(16 * Z)
  const pad   = Math.round(14 * Z)

  const row = (label: string, value: string, color: Color4) => (
    <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'space-between', width: Math.round(300 * Z) }}>
      <Label value={label} fontSize={small} color={SUBTLE} />
      <Label value={value} fontSize={small} color={color} />
    </UiEntity>
  )

  // Centre on the WHOLE screen. This used to centre within the safe band, but
  // the fallback insets reserve the left 26% for desktop chat — visibly pushing
  // the panel right of centre ("some things on desktop are misaligned") for the
  // common case of a collapsed chat. At 56% height nothing actually overlaps a
  // true-centred panel.
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top, left: 0 },
        width: '100%',
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
            <Label value="Shift Below Standard" fontSize={font} color={theme.bar.low} />
            {/* Docked pay is still pay — show exactly what was earned so a
                below-standard shift never reads as "you got nothing" (playtest:
                zero payout looked like a bug). */}
            {row('Items cleaned', String(shift.items), WHITE)}
            {row('Partial pay',   money(shift.money), GOLD)}
            {row('XP',            `+${shift.xp}`,     XP_FILL)}
            <Label
              value={`Reach ${Math.round(OUTCOME_ADEQUATE * 100)}% cleanliness for full wages!`}
              fontSize={small}
              color={SUBTLE}
              uiTransform={{ margin: { top: Math.round(6 * Z) } }}
            />
          </UiEntity>
        )}

        {c.promotedTo && (
          <Label
            value={`PROMOTED — ${c.promotedTo}!`}
            fontSize={Math.round(20 * Z)}
            color={GOLD}
            uiTransform={{ margin: { top: Math.round(8 * Z) } }}
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
  const Z = S * SHOP_ZOOM
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, left: 0 },
        width: '100%', height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      }}
      uiBackground={{ color: PANEL }}
    >
      <ShopBody S={Z} rowWidth={Math.round(700 * Z)} titleSize={Math.round(44 * Z)} />
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
  const Z = S * SHOP_ZOOM
  const pad = Math.round(16 * Z)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, right: 0 },
        width: Math.round(580 * Z), height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        padding: { top: pad, bottom: pad, left: pad, right: pad },
      }}
      // Lighter than the modal scrim: enough to keep text legible over a bright,
      // confetti-filled scene without hiding it.
      uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
    >
      <ShopBody S={Z} rowWidth={Math.round(520 * Z)} titleSize={Math.round(32 * Z)} />
    </UiEntity>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Career intro — the storyline onboarding shown once per session, in the lobby
// (or spectate screen), before normal play. New players (0 shifts) get a 3-card
// story ending on their career card; returning players get a single welcome-back
// card. Framing the loop as a career is the GDD's core promise, and this puts it
// front-and-centre at the moment attention is highest.
// ─────────────────────────────────────────────────────────────────────────────
let introSeen  = false
let introCard  = 0

/** True while the intro should replace the lobby/spectate screen. */
export function shouldShowCareerIntro(): boolean {
  return !introSeen && getCareer() !== null
}

function dismissCareerIntro(): void {
  introSeen = true
  introCard = 0
}

export function CareerIntroOverlay({ S }: { S: number }) {
  const c = getCareer()
  if (!c) return null

  const mobile = isMobile()
  const Z = mobile ? S * 1.5 : S * 1.3
  const heading = Math.round(40 * Z)
  const body    = Math.round(22 * Z)
  const gap     = Math.round(14 * Z)

  const newbie = c.shifts === 0
  const rung   = `Rung ${c.rank + 1} of ${JOB_TITLES.length}`
  const barW   = Math.round(320 * Z)
  const barH   = Math.round(16 * Z)
  const frac   = Math.max(0, Math.min(1, c.fraction))

  // Card contents. Returning players skip straight to the career card.
  const storyCards: Array<{ title: string; lines: string[] }> = [
    {
      title: 'WELCOME TO THE CLUB',
      lines: [
        "Last night's party WRECKED the place —",
        'and the old cleaning crew walked out.',
      ],
    },
    {
      title: 'MAKE YOUR CAREER',
      lines: [
        'Every shift pays. Wages buy gear,',
        'XP earns promotions — twelve rungs',
        'from Junior Janitor to CLUB OWNER.',
      ],
    },
  ]
  const onCareerCard = !newbie || introCard >= storyCards.length

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, left: 0 },
        width: '100%', height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      }}
      uiBackground={{ color: Color4.create(0, 0, 0, 0.9) }}
    >
      {!onCareerCard ? (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <Label value={storyCards[introCard].title} fontSize={heading} color={GOLD} />
          <Label
            value={storyCards[introCard].lines.join('\n')}
            fontSize={body}
            color={WHITE}
            textAlign="middle-center"
            uiTransform={{ margin: { top: gap } }}
          />
          <Button
            value="NEXT"
            variant="primary"
            fontSize={Math.round(24 * Z)}
            uiTransform={{ width: Math.round(220 * Z), height: Math.round(64 * Z), margin: { top: gap * 2 } }}
            onMouseDown={() => { introCard++ }}
          />
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <Label value={newbie ? 'YOUR CAREER CARD' : 'WELCOME BACK'} fontSize={heading} color={GOLD} />
          <Label value={c.title} fontSize={Math.round(32 * Z)} color={WHITE}
            uiTransform={{ margin: { top: gap } }} />
          <Label value={rung} fontSize={body} color={SUBTLE}
            uiTransform={{ margin: { top: Math.round(4 * Z) } }} />

          <UiEntity uiTransform={{ width: barW, height: barH, margin: { top: gap } }}
            uiBackground={{ color: TRACK }}>
            <UiEntity uiTransform={{ width: Math.round(barW * frac), height: barH }}
              uiBackground={{ color: XP_FILL }} />
          </UiEntity>
          <Label
            value={c.nextTitle
              ? `${Math.round(frac * 100)}% to ${c.nextTitle}`
              : 'Top of the ladder — defend it!'}
            fontSize={body} color={SUBTLE}
            uiTransform={{ margin: { top: Math.round(4 * Z) } }}
          />
          <Label value={`  ${money(c.money)} in the bank`} fontSize={body} color={GOLD}
            uiTransform={{ margin: { top: Math.round(4 * Z) } }} />

          <Button
            value={newbie ? "LET'S CLEAN!" : 'BACK TO WORK'}
            variant="primary"
            fontSize={Math.round(26 * Z)}
            uiTransform={{ width: Math.round(280 * Z), height: Math.round(72 * Z), margin: { top: gap * 2 } }}
            onMouseDown={() => dismissCareerIntro()}
          />
        </UiEntity>
      )}
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
