// Central colour palette for the whole client.
//
// `theme.colors` is a reusable base palette (swatches you can pull anywhere —
// UI, confetti, NPC accents, etc).  The remaining groups are semantic colours
// the game UI consumes directly, so tuning a colour happens in one place.
//
// Everything is a Color4 so the values can be lerped by tweenColor.

import { Color4 } from '@dcl/sdk/math'

export const theme = {
  // ── Base palette ─────────────────────────────────────────────────────────────
  colors: {
    body     : Color4.fromHexString('#212529ff'),
    secondary: Color4.fromHexString('#260042ff'),
    tertiary : Color4.fromHexString('#909294ff'),

    primary  : Color4.fromHexString('#FB6200ff'),
    success  : Color4.fromHexString('#D53DF9ff'),
    danger   : Color4.fromHexString('#9F2042ff'),
    warning  : Color4.fromHexString('#CCFBFEff'),
    info     : Color4.fromHexString('#06A77Dff'),

    light    : Color4.fromHexString('#f8f9faff'),
    dark     : Color4.fromHexString('#212529ff'),

    white    : Color4.create(1, 1, 1, 1),
  },

  // ── Countdown timer bands (calm → critical) ─────────────────────────────────
  timer: [
    Color4.create(1, 1,    1,    1),  // > 45s  white
    Color4.create(1, 0.85, 0.0,  1),  // 30–45s yellow
    Color4.create(1, 0.45, 0.0,  1),  // 15–30s orange
    Color4.create(1, 0.10, 0.05, 1),  // ≤ 15s  red
  ] as const,

  // ── Progress bar fill, keyed to cleanliness % ───────────────────────────────
  bar: {
    good: Color4.create(0.20, 0.90, 0.30, 1),    // ≥ 80 %
    mid:  Color4.create(0.90, 0.75, 0.10, 1),    // 50–80 %
    low:  Color4.create(0.90, 0.30, 0.15, 1),    // < 50 %
    bg:   Color4.create(0.12, 0.12, 0.12, 0.85), // track background
  },

  // ── HUD text + chrome ───────────────────────────────────────────────────────
  text: {
    subtle: Color4.create(0.85, 0.85, 0.85, 1),  // round label
    dim:    Color4.create(0.85, 0.85, 0.85, 1),  // meter / next-round
  },
  hud: {
    bg: Color4.create(0, 0, 0, 0.40),            // backdrop scrim
  },
} as const
