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

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { GameButton } from './uiButton'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { theme } from './theme'
import {
  UPGRADES, UpgradeDef, UpgradeId, maxLevel, nextUpgradeCost, rankForXp, JOB_TITLES, upgradeValue, TITLE_XP,
  AchievementState,
} from '../shared/progression'
import { OUTCOME_ADEQUATE, HOLD_DURATION_MS } from '../shared/config'
import { CareerState, getCareer, getCareerOrEmpty, getLastPayoutMs, getLastPromotion, getLastPurchase, getPrevShiftItems, upgradeLevel, requestPurchase, getAchievements } from './progressionStore'
import { tierColorForRank } from './rankBadgeSystem'
import { getSafeArea, pct } from './safeArea'

// 100ms-quantized clock for decorative pulses — see ui.tsx's pulseNow: raw
// per-frame sines force a UI update per node per frame even when idle.
const pulseNow = (): number => Math.floor(Date.now() / 100) * 100

// Upgrades whose underlying mechanic doesn't exist yet are hidden rather than
// shown disabled — advertising something unbuyable is worse than not listing
// it. Static, so filtered once instead of per frame while the shop is open.
const VISIBLE_UPGRADES = UPGRADES.filter((u) => u.implemented)

// The locked achievements nearest to completion — payout-card teaser rows.
function nearestLockedAchievements(n: number): AchievementState[] {
  return getAchievements()
    .filter((a) => !a.unlocked)
    .sort((x, y) => y.current / y.target - x.current / x.target)
    .slice(0, n)
}


const WHITE  = theme.colors.white
const SUBTLE = theme.text.subtle
const PANEL  = Color4.create(0, 0, 0, 0.82)
const TRACK  = theme.bar.bg
const GOLD   = Color4.create(1, 0.82, 0.25, 1)
const XP_FILL = theme.colors.success

const money = (n: number): string => `$${n.toLocaleString('en-US')}`

// ── Shop zoom ─────────────────────────────────────────────────────────────────
// Extra scale applied to EVERYTHING inside the shop (fonts, icons, rows, buttons)
// on top of the caller's platform scale S. The shop is a focused full-attention
// surface, so it reads best noticeably larger than the ambient HUD — and on
// high-DPI desktops the virtual-px mapping renders smaller than designed (see the
// UI_ZOOM note in ui.tsx), which left the shop hard to read.
//
// TUNE HERE: raise toward 2.5 if the shop still reads small; lower toward 1.5 if
// it crowds the screen (check mobile before going higher).
// The shop must fit FIVE upgrade rows inside the 720-tall virtual canvas with no
// scrolling. It was tuned when only two upgrades were implemented; all five ship
// now, so the zoom is capped and the row chrome (below) is compact. Mobile gets
// slightly less again — it multiplies MOBILE_SCALE on top of this.
const SHOP_ZOOM_DESKTOP = 1.6
const SHOP_ZOOM_MOBILE  = 1.3
const shopZoom = (): number => (isMobile() ? SHOP_ZOOM_MOBILE : SHOP_ZOOM_DESKTOP)

/**
 * Virtual-px width of the intermission side panel. Exported so every other
 * right-anchored surface (toast stack, payout-card centring) can clear it while
 * it is open — the ONE source of truth for that width, so a future resize can't
 * silently reintroduce overlap.
 */
export const shopPanelWidth = (S: number): number => Math.round(580 * S * shopZoom())

// The payout panel has no row-count pressure of its own but grew several bonus
// rows with the contracts/streaks work, so it keeps its own (larger) zoom.
const PAYOUT_ZOOM = 1.5

// Shifts for which onboarding hints still show on the payout card.
const HINT_SHIFTS = 5

// ── Shop open/closed ──────────────────────────────────────────────────────────
// Module state rather than React state: the renderer re-runs ui() continuously, so
// a plain flag is enough and avoids threading state through ui.tsx.
let shopOpen = false
// When the shop last OPENED — drives the side panel's slide-in and the payout
// card's matching glide, so the pair reads as one deliberate motion rather than
// the card just sitting off-centre next to an already-present panel.
let shopOpenedMs = 0
export const isShopOpen = (): boolean => shopOpen
export const setShopOpen = (open: boolean): void => {
  if (open && !shopOpen) shopOpenedMs = Date.now()
  shopOpen = open
}
const SHOP_SLIDE_MS = 250
/** 0→1 eased progress of the panel slide-in since the shop opened. */
function shopSlideEase(): number {
  const t = Math.min(1, Math.max(0, (Date.now() - shopOpenedMs) / SHOP_SLIDE_MS))
  return 1 - Math.pow(1 - t, 3)
}

/**
 * How many upgrades the player could buy RIGHT NOW — implemented, rank-unlocked,
 * not maxed, and within budget. Drives the end-of-shift shop surfacing (playtest:
 * many players never found the UPGRADES button at all): the payout CTA pulses and
 * names this count, and desktop auto-opens the side panel when it is non-zero.
 */
export function affordableUpgradeCount(): number {
  const c = getCareerOrEmpty()
  const rank = rankForXp(c.xp)
  let n = 0
  for (const def of UPGRADES) {
    if (!def.implemented) continue
    if (def.minRank !== undefined && rank < def.minRank) continue
    const cost = nextUpgradeCost(def.id, upgradeLevel(def.id))
    if (cost !== null && c.money >= cost) n++
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// Career HUD — always-visible title, promotion progress and balance.
// ─────────────────────────────────────────────────────────────────────────────
export function CareerBar({ S, withShopButton = false }: { S: number; withShopButton?: boolean }) {
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
    ? 0.7  + 0.3  * Math.sin(pulseNow() / 120)
    : 0.85 + 0.15 * Math.sin(pulseNow() / 300)
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
        borderRadius: Math.round(12 * Z),
      }}
      uiBackground={{ color: theme.hud.bg }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        <Label value={c.title} fontSize={font} color={WHITE} />
        <Label value={`  ${money(c.money)}`} fontSize={Math.round(font * moneyPop)} color={GOLD} />
      </UiEntity>

      {/* Promotion progress. At max rank the bar is full and labelled, rather than
          showing a bar that can never fill. */}
      <UiEntity uiTransform={{ width: barW, height: barH, margin: { top: Math.round(6 * Z) }, borderRadius: Math.round(barH / 2) }}
        uiBackground={{ color: TRACK }}>
        <UiEntity
          uiTransform={{ width: Math.round(barW * frac), height: barH, borderRadius: Math.round(barH / 2) }}
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
      {/* UPGRADES docked under the bar on the mobile in-shift HUD. The floating
          bottom-right button sat on the explorer's jump cluster there — screen
          corners belong to the explorer on mobile (same lesson as the shop's
          close button). This spot is already validated real estate, and it puts
          the button next to the money it spends. */}
      {withShopButton && (
        <UiEntity uiTransform={{ margin: { top: Math.round(8 * Z) } }}>
          <ShopButton S={S} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

/** Next-shift countdown colour — white, gold inside 10s, pulsing orange inside
 *  5s. Shared by the payout card and ui.tsx's fallback chip so the clock reads
 *  the same wherever it lives. */
export function countdownColor(seconds: number): Color4 {
  if (seconds <= 5)  return Color4.create(1, 0.45, 0.25, 0.7 + 0.3 * Math.sin(pulseNow() / 150))
  if (seconds <= 10) return GOLD
  return WHITE
}

// ── Payout card dismissal ─────────────────────────────────────────────────────
// The X hides the card for the REST of this intermission only — the next payout
// (different timestamp) shows it again. ui.tsx keeps the next-shift countdown
// visible in a small chip while the card is away.
let payoutDismissedMs = 0
export const dismissPayoutCard = (): void => { payoutDismissedMs = getLastPayoutMs() }

/** Whether the payout card is on screen — false while a fresh promotion banner
 *  holds the stage or after the player closed it. Drives ui.tsx's fallback
 *  countdown chip, so "when does the next shift start" is never unanswered. */
export function isPayoutCardShowing(): boolean {
  const c = getCareer()
  if (!c || !c.lastShift) return false
  if (getLastPayoutMs() === payoutDismissedMs) return false
  const promo = getLastPromotion()
  if (promo !== null && Date.now() - promo.ms < PROMO_BANNER_MS) return false
  return true
}

/**
 * The ONE obvious short-term target to leave the shift with (playtest feedback:
 * the end-of-shift moment should hand the player a reason to stay). Priority:
 * promotion within reach beats a nearly-affordable upgrade beats beating your
 * own best beats the daily streak. "Within reach" is measured against what THIS
 * shift actually paid, so the promise "one more shift" is roughly honest.
 * Upgrades already affordable are deliberately NOT a target — the gold shop CTA
 * below owns that case.
 */
function nextUpTarget(c: CareerState): string | null {
  const shift = c.lastShift
  if (!shift) return null
  const rank = rankForXp(c.xp)

  if (c.nextTitle && rank + 1 < TITLE_XP.length) {
    const xpLeft = TITLE_XP[rank + 1] - c.xp
    if (xpLeft > 0 && xpLeft <= Math.max(shift.xp, 50) * 1.5) {
      return `${xpLeft} XP to ${c.nextTitle} — one good shift away!`
    }
  }

  let best: { def: UpgradeDef; gap: number } | null = null
  for (const def of UPGRADES) {
    if (!def.implemented) continue
    if (def.minRank !== undefined && rank < def.minRank) continue
    const cost = nextUpgradeCost(def.id, upgradeLevel(def.id))
    if (cost === null || cost <= c.money) continue
    const gap = cost - c.money
    if (gap <= Math.max(shift.money, 100) * 1.5 && (best === null || gap < best.gap)) {
      best = { def, gap }
    }
  }
  if (best) return `One more shift to afford ${best.def.name} Lv ${upgradeLevel(best.def.id) + 1}!`

  if (!shift.newBest && (c.bestItems ?? 0) > shift.items) {
    return `Your best is ${c.bestItems} items — beat it next shift!`
  }
  if ((shift.streakDays ?? 0) > 0) {
    return `Come back tomorrow to grow your Day ${shift.streakDays} work streak!`
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// End-of-shift payout — the GDD's "clear feedback at the end of every shift".
// Rendered by ui.tsx during the intermission, below the outcome banner.
// ─────────────────────────────────────────────────────────────────────────────
export function ShiftPayoutPanel(
  { S, imageSrc, pct, seconds }:
  { S: number; imageSrc: string; pct: number; seconds: number },
) {
  const c = getCareer()
  const shift = c?.lastShift
  if (!c || !shift) return null
  if (!isPayoutCardShowing()) return null

  // The payout is the shift's headline moment, so it renders well above ambient
  // HUD size ("can't really read it") — but it also gained grade/tip/contract/
  // streak rows, so its zoom is its own constant rather than the shop's.
  const Z = S * PAYOUT_ZOOM

  const small = Math.round(16 * Z)
  const pad   = Math.round(14 * Z)

  // Pop-in — the card slides up and fades in over ~220ms, replacing the outcome
  // banner's old fly-to-centre beat (which is what used to collide with it).
  // When a promotion banner played first, the pop keys on the moment the card
  // actually APPEARS (banner end), not on the payout — otherwise the animation
  // has already expired by the time the card renders.
  const promo    = getLastPromotion()
  const appearMs = promo !== null && promo.ms >= getLastPayoutMs()
    ? promo.ms + PROMO_BANNER_MS
    : getLastPayoutMs()
  const popT    = Math.min(1, Math.max(0, (Date.now() - appearMs) / 220))
  const popEase = 1 - Math.pow(1 - popT, 3)
  const popDrop = Math.round((1 - popEase) * 46 * Z)   // px it rises through
  const popBg   = Color4.create(PANEL.r, PANEL.g, PANEL.b, PANEL.a * popEase)

  // Improvement vs the previous shift, shown only when it IS an improvement —
  // the point is momentum, and "beat your best" below covers the other side.
  const prevItems  = getPrevShiftItems()
  const itemsValue = prevItems >= 0 && shift.items > prevItems
    ? `${shift.items}  (+${shift.items - prevItems} vs last)`
    : String(shift.items)

  const row = (label: string, value: string, color: Color4) => (
    <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'space-between', width: Math.round(300 * Z) }}>
      <Label value={label} fontSize={small} color={SUBTLE} />
      <Label value={value} fontSize={small} color={color} />
    </UiEntity>
  )

  // While the desktop side-panel shop is open (auto-open or manual), the card
  // centres in the space LEFT of the panel instead of the full screen — on
  // narrower windows a full-width centre put the card under the panel. Eased on
  // the panel's slide, so the card GLIDES left as the panel arrives instead of
  // snapping to an off-centre spot.
  const panelClear = shopOpen && !isMobile()
    ? Math.round(shopPanelWidth(S) * shopSlideEase())
    : 0

  // ONE consolidated shift report, vertically centred on the screen.
  //
  // The intermission used to show two competing UIs: the outcome banner + "44%
  // Clean" claiming the middle of the screen, and this panel below it — which
  // then had nowhere to go and ran off the bottom on mobile. They are the same
  // information beat, so they are now one card: outcome art, grade, score,
  // payout, countdown. A centring flex column (rather than a fixed `top`) means
  // the card can never overflow, whatever rows a given shift earns.
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: { right: panelClear },
      }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'column',
          alignItems: 'center',
          padding: { top: pad, bottom: pad, left: pad * 2, right: pad * 2 },
          margin: { top: popDrop, bottom: -popDrop },   // rise without shifting the centre
          borderRadius: Math.round(18 * Z),
        }}
        uiBackground={{ color: popBg }}
      >
        {/* Outcome art — the card's headline, replacing the separate banner. */}
        <UiEntity
          uiTransform={{
            width: Math.round(330 * Z),
            height: Math.round(41 * Z),   // 8:1, matching the source art
            margin: { bottom: Math.round(6 * Z) },
          }}
          uiBackground={{ texture: { src: imageSrc }, textureMode: 'stretch', color: WHITE }}
        />

        {/* Grade + cleanliness on one line — the shift's score at a glance. */}
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: Math.round(4 * Z) } }}>
          {shift.grade && (
            <Label
              value={shift.grade}
              fontSize={Math.round(46 * Z)}
              color={shift.grade === 'S' ? GOLD
                : shift.grade === 'A' ? theme.colors.success
                : shift.grade === 'B' ? WHITE
                : theme.bar.low}
            />
          )}
          <Label value={`  ${Math.round(pct * 100)}% Clean`} fontSize={Math.round(26 * Z)} color={WHITE} />
        </UiEntity>

        {/* UiEntity columns rather than JSX fragments — the DCL renderer's
            jsxFactory has no fragment support. */}
        {shift.passed ? (
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
            {/* No "Shift Complete" heading — the outcome art above already says
                it, and on a phone every redundant row costs real estate. */}
            {row('Items cleaned', itemsValue, WHITE)}
            {row('Earned',        money(shift.money), GOLD)}
            {row('XP',            `+${shift.xp}`,     XP_FILL)}
          </UiEntity>
        ) : (
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
            {/* Docked pay is still pay — show exactly what was earned so a
                below-standard shift never reads as "you got nothing" (playtest:
                zero payout looked like a bug). */}
            {row('Items cleaned', itemsValue, WHITE)}
            {row('Partial pay',   money(shift.money), GOLD)}
            {row('XP',            `+${shift.xp}`,     XP_FILL)}
            {/* Teaching line, not a permanent fixture: genuinely useful while
                learning the standard, pure clutter by shift 20. `shifts` counts
                the shifts BEFORE this one, so a first-timer sees it at 0. */}
            {c.shifts < HINT_SHIFTS && (
              <Label
                value={`Reach ${Math.round(OUTCOME_ADEQUATE * 100)}% cleanliness for full wages!`}
                fontSize={small}
                color={SUBTLE}
                uiTransform={{ margin: { top: Math.round(6 * Z) } }}
              />
            )}
          </UiEntity>
        )}

        {/* Bonus rows — each one earned, each one named. Older payloads without
            these fields simply render nothing. */}
        {(shift.tip ?? 0) > 0 && row('Patron tip', `+${money(shift.tip)}`, GOLD)}
        {(shift.earlyBonus ?? 0) > 0 && row(
          `Closed ${Math.floor((shift.earlySeconds ?? 0) / 60)}:${String((shift.earlySeconds ?? 0) % 60).padStart(2, '0')} early`,
          `+${money(shift.earlyBonus!)}`,
          GOLD,
        )}
        {(shift.disasterBonus ?? 0) > 0 && row('Disaster cleared', `+${money(shift.disasterBonus!)}`, GOLD)}
        {(shift.haulBonus ?? 0) > 0 && row('Dumpster runs', `+${money(shift.haulBonus!)}`, GOLD)}
        {shift.contractLabel && (shift.contractDone
          ? row(shift.contractLabel, `+${money(shift.contractBonus)}`, theme.colors.success)
          : row(shift.contractLabel, 'missed', SUBTLE))}
        {shift.openingBonus && row('Opening shift bonus', '×2 XP', GOLD)}
        {(shift.streakXp ?? 0) > 0 && row(`Day ${shift.streakDays} work streak`, `+${shift.streakXp} XP`, XP_FILL)}
        {/* Flex-gear progress — the two locked achievements you're closest to,
            so every shift visibly moves you toward a lobby showpiece. */}
        {nearestLockedAchievements(2).map((a) =>
          row(a.title, `${a.current}/${a.target} ${a.noun.toLowerCase()}`, SUBTLE))}
        {shift.newBest && (
          <Label
            value="NEW PERSONAL BEST!"
            fontSize={Math.round(18 * Z)}
            color={GOLD}
            uiTransform={{ margin: { top: Math.round(6 * Z) } }}
          />
        )}

        {c.promotedTo && (
          <Label
            value={c.promotedTo === JOB_TITLES[JOB_TITLES.length - 1]
              ? 'YOU OWN THE CLUB NOW!'
              : `PROMOTED — ${c.promotedTo}!`}
            fontSize={Math.round(20 * Z)}
            color={GOLD}
            uiTransform={{ margin: { top: Math.round(8 * Z) } }}
          />
        )}

        {/* The one short-term target to leave with — the shift's "reason to
            stay". Single line by design: one goal is a hook, a list is homework. */}
        {(() => {
          const target = nextUpTarget(c)
          return target ? (
            <Label
              value={`NEXT UP: ${target}`}
              fontSize={Math.round(18 * Z)}
              color={GOLD}
              uiTransform={{ margin: { top: Math.round(10 * Z) } }}
            />
          ) : null
        })()}

        {/* Countdown lives here too — it used to be a separate line in the HUD
            strip, which is the other half of what made the intermission read as
            two competing UIs. Colour ramps as it runs out (playtest: subtle
            grey didn't register as a clock). */}
        <Label
          value={`Next shift in 0:${seconds < 10 ? '0' : ''}${seconds}`}
          fontSize={Math.round(18 * Z)}
          color={countdownColor(seconds)}
          uiTransform={{ margin: { top: Math.round(10 * Z) } }}
        />

        {/* Shop CTA at the decision moment (playtest: the UPGRADES button was
            widely missed, and shift end — money in hand, deciding whether to
            stay — is exactly when the shop matters). Hidden while the shop is
            already open (desktop auto-opens the side panel alongside). */}
        {!shopOpen && <PayoutShopCta Z={Z} />}

        {/* Dismiss for this intermission — the countdown moves to ui.tsx's
            fallback chip so the next-shift clock never disappears with it. */}
        <CloseX Z={Z * 0.8} onClose={dismissPayoutCard} />
      </UiEntity>
    </UiEntity>
  )
}

/**
 * The payout card's UPGRADES button. When something is affordable it turns gold,
 * pulses, and says how many upgrades are in budget — a card row can't be missed
 * the way the ambient HUD button was. Otherwise it stays a quiet neutral button,
 * still one tap from the shop but not shouting about purchases that can't happen.
 */
function PayoutShopCta({ Z }: { Z: number }) {
  const n = affordableUpgradeCount()
  // Desktop breathes by SIZE; mobile breathes by ALPHA at a fixed size — size
  // changes force a UI relayout every frame, which stutters on mobile's uneven
  // frame pacing (playtest: "UI tweens of scale are jittery on mobile").
  const wave  = Math.sin(pulseNow() / 180)
  const pulse = n > 0 && !isMobile() ? 1 + 0.06 * wave : 1
  const bgColor = n > 0
    ? (isMobile() ? Color4.create(GOLD.r, GOLD.g, GOLD.b, 0.8 + 0.2 * wave) : GOLD)
    : Color4.create(1, 1, 1, 0.12)
  const w = Math.round(300 * Z * pulse)
  const h = Math.round(54 * Z * pulse)
  return (
    <UiEntity
      uiTransform={{
        width: w, height: h,
        margin: { top: Math.round(12 * Z) },
        borderRadius: Math.round(12 * Z),
        justifyContent: 'center', alignItems: 'center',
      }}
      uiBackground={{ color: bgColor }}
      onMouseDown={() => setShopOpen(true)}
    >
      <Label
        value={n > 0 ? `UPGRADES — ${n} in budget!` : 'UPGRADES'}
        fontSize={Math.round(21 * Z * pulse)}
        color={n > 0 ? Color4.create(0.12, 0.08, 0, 1) : WHITE}
      />
    </UiEntity>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotion banner — the transient centre-stage moment for a rank-up. The payout
// card's PROMOTED line is the persistent record; this is the fanfare's visual:
// pops in at the upper third (clear of the vertically-centred payout card), title
// in its career-tier colour, gone after a few seconds. Sound + confetti fire from
// the store; this renders whenever a promotion is fresh, mid-round included
// (admin grants land there).
// ─────────────────────────────────────────────────────────────────────────────
export const PROMO_BANNER_MS = 4000

export function PromotionBanner({ S, centerStage = false }: { S: number; centerStage?: boolean }) {
  const promo = getLastPromotion()
  if (!promo) return null
  const t = Date.now() - promo.ms
  if (t > PROMO_BANNER_MS) return null

  const pop  = 1 - Math.pow(1 - Math.min(1, t / 300), 3)          // scale in
  const fade = t > PROMO_BANNER_MS - 700
    ? Math.max(0, (PROMO_BANNER_MS - t) / 700)                     // fade out
    : 1
  // centerStage = the intermission gave the banner the screen to itself (the
  // payout card and shop auto-open wait for it): centred and a third bigger.
  // Mid-round promotions keep the smaller upper-third placement, clear of the
  // reticle and skill-check bar.
  const Z    = S * (0.6 + 0.4 * pop) * (centerStage ? 1.3 : 1)
  const tier = tierColorForRank(promo.rank)
  const pad  = Math.round(18 * Z)
  // Clear the side panel like the payout card does — same overlap lesson.
  const panelClear = shopOpen && !isMobile()
    ? Math.round(shopPanelWidth(S) * shopSlideEase())
    : 0

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: centerStage ? 0 : '16%', left: 0 },
        width: '100%',
        height: centerStage ? '100%' : undefined,
        flexDirection: 'column',
        justifyContent: centerStage ? 'center' : 'flex-start',
        alignItems: 'center',
        padding: { right: panelClear },
      }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'column',
          alignItems: 'center',
          padding: { top: pad, bottom: pad, left: pad * 2, right: pad * 2 },
          borderRadius: Math.round(16 * Z),
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.8 * fade) }}
      >
        <Label
          value="PROMOTED!"
          fontSize={Math.round(26 * Z)}
          color={Color4.create(GOLD.r, GOLD.g, GOLD.b, fade)}
        />
        <Label
          value={promo.title}
          fontSize={Math.round(46 * Z)}
          color={Color4.create(tier.r, tier.g, tier.b, fade)}
          uiTransform={{ margin: { top: Math.round(4 * Z) } }}
        />
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
  // Same art as the HUD carry chip — the row points at the exact element the
  // purchase improves (and the texture is already resident for the HUD).
  carryCapacity: 'assets/scene/UI/carry_bag_chip.png',
  portableBin:   'assets/scene/UI/upgrade_portableBin.png',
  vacuum:        'assets/scene/UI/upgrade_vacuum.png',
}

// What the next level CONCRETELY buys, as "current → next" in the upgrade's own
// units (playtest: the prose descriptions alone left the actual effect unclear).
// Presentation-only, like the icons — levelValues stay the single gameplay truth.
// Vacuum shows total pieces per clean (extra + the clicked one): "sweeps 1 → 2"
// beats exposing the internal "+0 → +1 extra" bookkeeping.
const UPGRADE_DELTA: Record<UpgradeId, (cur: number, next: number) => string> = {
  movementSpeed: (c, n) => `speed +${Math.round((c - 1) * 100)}% → +${Math.round((n - 1) * 100)}%`,
  moppingSpeed:  (c, n) => `mop ${(HOLD_DURATION_MS * c / 1000).toFixed(1)}s → ${(HOLD_DURATION_MS * n / 1000).toFixed(1)}s`,
  carryCapacity: (c, n) => `carry ${c} → ${n}`,
  portableBin:   (c, n) => `${c} → ${n} per shift`,
  vacuum:        (c, n) => `sweeps ${c + 1} → ${n + 1} at once`,
}

/** Level as filled/empty dots — reads at a glance where "Lv 2/4" needed parsing. */
function LevelPips({ level, max, S }: { level: number; max: number; S: number }) {
  const size = Math.round(10 * S)
  return (
    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { left: Math.round(10 * S) } }}>
      {Array.from({ length: max }, (_, i) => (
        <UiEntity
          key={String(i)}
          uiTransform={{
            width: size, height: size,
            margin: { right: Math.round(4 * S) },
            borderRadius: Math.round(size / 2),
          }}
          uiBackground={{ color: i < level ? GOLD : Color4.create(1, 1, 1, 0.18) }}
        />
      ))}
    </UiEntity>
  )
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

  const font  = Math.round(19 * S)
  const small = Math.round(14 * S)
  const icon  = Math.round(46 * S)

  // One clear reason why a purchase isn't available, rather than a dead button.
  const statusLabel = maxed
    ? 'MAX'
    : locked
    ? `Needs ${JOB_TITLES[def.minRank!]}`
    : !affordable
    ? money(cost!)
    : money(cost!)

  // Server-confirmed purchase → the bought row flashes gold and fades back over
  // ~700ms (sound + confetti fire from the store; this is the visual receipt).
  const lp     = getLastPurchase()
  const flashT = lp && lp.id === def.id ? (Date.now() - lp.ms) / 700 : 1
  const rowBg  = flashT < 1
    ? Color4.create(1, 0.82, 0.25, 0.06 + 0.38 * (1 - flashT))
    : Color4.create(1, 1, 1, 0.06)

  return (
    <UiEntity
      uiTransform={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width,
        margin: { bottom: Math.round(7 * S) },
        padding: { top: Math.round(6 * S), bottom: Math.round(6 * S), left: Math.round(10 * S), right: Math.round(12 * S) },
        borderRadius: Math.round(10 * S),
      }}
      uiBackground={{ color: rowBg }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        <UiEntity
          // flexShrink 0: rows under width pressure (locked rows swap the
          // fixed-width buy button for a free-width label) steal width from
          // the icon, squashing the square art into a portrait sliver.
          uiTransform={{ width: icon, height: icon, flexShrink: 0, margin: { right: Math.round(12 * S) } }}
          uiBackground={{ texture: { src: UPGRADE_ICONS[def.id] }, textureMode: 'stretch', color: WHITE }}
        />
        <UiEntity uiTransform={{ flexDirection: 'column' }}>
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <Label value={def.name} fontSize={font} color={WHITE} />
            <LevelPips level={level} max={max} S={S} />
          </UiEntity>
          {/* Flavor line + the concrete "current → next" delta on ONE row — a
              third line per row would overflow the mobile modal (five rows must
              fit the short viewport; same pressure that compacted this chrome). */}
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <Label value={def.description} fontSize={small} color={SUBTLE} />
            {!maxed && (
              <Label
                value={`  ${UPGRADE_DELTA[def.id](upgradeValue(def.id, level), upgradeValue(def.id, level + 1))}`}
                fontSize={small}
                color={GOLD}
              />
            )}
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {maxed || locked ? (
        <Label value={statusLabel} fontSize={small} color={locked ? theme.colors.tertiary : GOLD} />
      ) : (
        <GameButton
          value={statusLabel}
          variant={affordable ? 'primary' : 'secondary'}
          fontSize={Math.round(17 * S)}
          uiTransform={{ width: Math.round(130 * S), height: Math.round(42 * S) }}
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

  const visible = VISIBLE_UPGRADES

  return (
    <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: Math.round(12 * S) } }}>
        <Label value="UPGRADES" fontSize={titleSize} color={WHITE} />
        <Label value={`   ${money(c.money)}`} fontSize={Math.round(titleSize * 0.82)} color={GOLD} />
      </UiEntity>

      {visible.map((def) => <UpgradeRow key={def.id} def={def} S={S} width={rowWidth} />)}
    </UiEntity>
  )
}

/**
 * Corner close control. The SDK ships no standard close icon (dcl-ui-toolkit has
 * one, but it's a separate package — not worth a dependency for a glyph), so
 * this is a plain square hit target with an X: the convention players already
 * know, always in the same corner, and far easier to hit than a text button that
 * could be pushed off a short viewport (which is exactly what happened to the
 * old bottom-anchored CLOSE on mobile).
 */
function CloseX({ Z, onClose }: { Z: number; onClose?: () => void }) {
  const size = Math.round(52 * Z)
  // Anchored to the shop CARD's top-right corner, not the screen's. Screen
  // corners belong to the explorer (profile cluster on mobile, minimap on
  // desktop), and even safe-area anchoring proved wrong on real devices — the
  // reported inset didn't cover the mobile profile chip. The card is centred
  // with margin on every device, so its own corner can never sit under chrome.
  // Requires the PARENT to be the card wrapper (position: relative context).
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: Math.round(6 * Z), right: Math.round(6 * Z) },
        width: size,
        height: size,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: Math.round(size / 2),   // circular close, standard affordance
      }}
      uiBackground={{ color: Color4.create(1, 1, 1, 0.16) }}
      onMouseDown={() => (onClose ? onClose() : setShopOpen(false))}
    >
      <Label value="X" fontSize={Math.round(30 * Z)} color={WHITE} />
    </UiEntity>
  )
}

/**
 * Full-screen modal shop. Used where there is nothing behind worth preserving —
 * the lobby and the spectator screen, both of which are already scrims.
 */
export function UpgradeShopOverlay({ S }: { S: number }) {
  if (!shopOpen) return null
  const Z = S * shopZoom()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, left: 0 },
        width: '100%', height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      }}
      uiBackground={{ color: PANEL }}
    >
      {/* Wrapper = the card bounds; CloseX rides its top-right corner. */}
      <UiEntity uiTransform={{ flexDirection: 'column' }}>
        <ShopBody S={Z} rowWidth={Math.round(620 * Z)} titleSize={Math.round(38 * Z)} />
        <CloseX Z={Z} />
      </UiEntity>
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
  const Z = S * shopZoom()
  const pad = Math.round(16 * Z)
  // Slides in from the right edge; the payout card glides left on the same ease.
  const slideIn = Math.round(shopPanelWidth(S) * (1 - shopSlideEase()))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute', position: { top: 0, right: -slideIn },
        width: shopPanelWidth(S), height: '100%',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        padding: { top: pad, bottom: pad, left: pad, right: pad },
      }}
      // Lighter than the modal scrim: enough to keep text legible over a bright,
      // confetti-filled scene without hiding it.
      uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
    >
      <UiEntity uiTransform={{ flexDirection: 'column' }}>
        <ShopBody S={Z} rowWidth={Math.round(500 * Z)} titleSize={Math.round(30 * Z)} />
        <CloseX Z={Z} />
      </UiEntity>
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
// Admin preview: force the intro open from anywhere (the lobby is a 5-second
// beat now, so waiting to catch it naturally isn't practical), and optionally
// force the new-player story path for an account that has already worked shifts.
let introForced       = false
let introForceNewbie  = false

/**
 * True while the intro should replace the screen. `atRestScreen` is the caller's
 * "we're in the lobby or spectating" state — the intro never interrupts active
 * cleaning, except when an admin has explicitly forced a preview.
 */
export function shouldShowCareerIntro(atRestScreen: boolean): boolean {
  if (getCareer() === null) return false   // no career data yet — nothing to show
  return introForced || (atRestScreen && !introSeen)
}

/** Admin preview hook — `asNewPlayer` shows the 3-card story rather than the
 *  returning-player welcome card. */
export function replayCareerIntro(asNewPlayer: boolean): void {
  introSeen        = false
  introCard        = 0
  introForced      = true
  introForceNewbie = asNewPlayer
}

function dismissCareerIntro(): void {
  introSeen        = true
  introCard        = 0
  introForced      = false
  introForceNewbie = false
}

export function CareerIntroOverlay({ S }: { S: number }) {
  const c = getCareer()
  if (!c) return null

  const mobile = isMobile()
  const Z = mobile ? S * 1.5 : S * 1.3
  const heading = Math.round(40 * Z)
  const body    = Math.round(22 * Z)
  const gap     = Math.round(14 * Z)

  const newbie = introForceNewbie || c.shifts === 0
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
          <GameButton
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

          <UiEntity uiTransform={{ width: barW, height: barH, margin: { top: gap }, borderRadius: Math.round(barH / 2) }}
            uiBackground={{ color: TRACK }}>
            <UiEntity uiTransform={{ width: Math.round(barW * frac), height: barH, borderRadius: Math.round(barH / 2) }}
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

          {/* Daily hook, delivered at the moment attention peaks. */}
          {c.openingAvailable && (
            <Label
              value="★ Opening shift bonus ready — first passed shift pays DOUBLE XP!"
              fontSize={Math.round(18 * Z)}
              color={GOLD}
              uiTransform={{ margin: { top: gap } }}
            />
          )}

          <GameButton
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
    <GameButton
      value="UPGRADES"
      variant="secondary"
      fontSize={Math.round(20 * S)}
      uiTransform={{ width: Math.round(220 * S), height: Math.round(56 * S) }}
      onMouseDown={() => setShopOpen(true)}
    />
  )
}
