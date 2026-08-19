// Live UI safe area — the region NOT covered by the explorer's own UI.
//
// The explorer renders its UI (chat, minimap, sidebar, profile, joystick,
// interaction button…) ON TOP of scene UI, and reports the still-usable rectangle
// via UiCanvasInformation.interactableArea. That rectangle is LIVE: it shrinks when
// chat opens and grows when it's hidden, and differs by platform. Anchoring scene
// HUD to it — rather than to guessed fixed corners — keeps our UI clear of the
// explorer's on every device and as the player toggles chat.
//
// COORDINATE NOTE: interactableArea is expressed in the real UI-canvas pixel space
// (UiCanvasInformation.width/height), which is NOT the 1280x720 virtual canvas we
// configure in setUiRenderer. We therefore return the insets as FRACTIONS (0..1) of
// the canvas, so callers anchor with percentage positions that resolve against the
// real screen in either coordinate space.

import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'

// ── Canvas info, resiliently ──────────────────────────────────────────────────
// UiCanvasInformation classically lives on engine.RootEntity — but explorer
// builds have shipped with it missing there (field report 2026-08-04: wide-
// screen layout broke and "we used to be able to query ui canvas information";
// a Foundation workaround exists but is undocumented). If the root read fails,
// scan for the component on ANY entity before giving up, and log which path
// worked once so field reports carry their own diagnosis.
type Insets = { top: number; left: number; right: number; bottom: number }
// devicePixelRatio no longer affects UI layout (SDK 7.26 removed it from the
// scale formula) — surfaced here purely as a diagnostic, so scale reports from
// different machines carry the one value that used to make them differ.
type CanvasInfo = { width: number; height: number; devicePixelRatio?: number; interactableArea?: Insets; screenInsetArea?: Insets }

const NO_INSETS: Insets = { top: 0, left: 0, right: 0, bottom: 0 }

/**
 * DEVICE screen insets (notch, status bar, home indicator) — the same field
 * the SDK's ScreenInsetArea component positions itself from. Exposed so the
 * UI root can build a horizontally BALANCED inset container: the stock
 * component insets left and right unequally, which put "centred" UI a
 * notch-half off the physical screen centre (playtest: "all the centered UI
 * is ~1cm right of the DCL cursor").
 */
export function getScreenInsets(): Insets {
  return readCanvasInfo()?.screenInsetArea ?? NO_INSETS
}
let loggedSource = ''

// 100ms memo — this is called from ~6 UI sites per RENDER (and the fallback
// path is a full component scan). The canvas only changes on resize / chat
// toggle, so sub-frame freshness buys nothing.
let cachedInfo: CanvasInfo | null = null
let cachedInfoAtMs = 0

export function readCanvasInfo(): CanvasInfo | null {
  const now = Date.now()
  if (now - cachedInfoAtMs < 100) return cachedInfo
  cachedInfoAtMs = now
  cachedInfo = readCanvasInfoFresh()
  return cachedInfo
}

function readCanvasInfoFresh(): CanvasInfo | null {
  const root = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (root && root.width > 0 && root.height > 0) {
    if (loggedSource !== 'root') { loggedSource = 'root'; console.log('[UI] canvas info via RootEntity') }
    return root as CanvasInfo
  }
  for (const [, info] of engine.getEntitiesWith(UiCanvasInformation)) {
    if (info.width > 0 && info.height > 0) {
      if (loggedSource !== 'scan') { loggedSource = 'scan'; console.log('[UI] canvas info via entity scan (NOT RootEntity — explorer moved it)') }
      return info as CanvasInfo
    }
  }
  if (loggedSource !== 'none') { loggedSource = 'none'; console.log('[UI] canvas info UNAVAILABLE — wide-screen aspect matching and live safe-area disabled (fallbacks active)') }
  return null
}

export type SafeArea = {
  /** Fraction of screen height reserved at the top edge (0..1). */
  top: number
  /** Fraction of screen width reserved at the left edge (0..1). */
  left: number
  /** Fraction of screen width reserved at the right edge (0..1). */
  right: number
  /** Fraction of screen height reserved at the bottom edge (0..1). */
  bottom: number
  /** True when a real interactableArea was read (vs the heuristic fallback). */
  known: boolean
}

// Fallback used only when interactableArea isn't populated yet (or at all): keep to
// the right side, clear of the top and bottom corners — the band that's reserved on
// neither desktop (left 25%) nor mobile (left edge / top-right / bottom-right).
// Deliberately conservative so an early frame or an odd client still lands safely.
const FALLBACK: SafeArea = { top: 0.12, left: 0.26, right: 0.02, bottom: 0.12, known: false }

/**
 * Current safe-area insets as fractions of the screen. Cheap enough to call each
 * render (single component read); the renderer re-runs continuously, so anchors
 * built from this track the explorer UI live.
 */
let cachedArea: SafeArea = FALLBACK
let cachedAreaAtMs = 0

export function getSafeArea(): SafeArea {
  const now = Date.now()
  if (now - cachedAreaAtMs < 100) return cachedArea
  cachedAreaAtMs = now
  cachedArea = computeSafeArea()
  return cachedArea
}

function computeSafeArea(): SafeArea {
  const info = readCanvasInfo()
  if (!info || !info.interactableArea) return FALLBACK

  const a = info.interactableArea
  return {
    top:    Math.max(0, a.top    / info.height),
    left:   Math.max(0, a.left   / info.width),
    right:  Math.max(0, a.right  / info.width),
    bottom: Math.max(0, a.bottom / info.height),
    known:  true,
  }
}

/** Convenience: a `${n}%` string from a 0..1 fraction, for uiTransform positions. */
export const pct = (fraction: number): `${number}%` => `${Math.round(fraction * 1000) / 10}%`
