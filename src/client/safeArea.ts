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
export function getSafeArea(): SafeArea {
  const info = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (!info || info.width <= 0 || info.height <= 0 || !info.interactableArea) return FALLBACK

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
