# Upgrading the SDK — read before running any install

> **STATUS 2026-08-19: MIGRATION DONE.** The auth-server tag rebased onto
> 7.26.x, so the gate below cleared and the scene now pins
> `7.26.1-32160793830.commit-0b97733`. What was done, per the plan below:
> UI_ZOOM deleted (desktop virtual canvas is 1080-tall, mobile 720-tall,
> resolved live in uiStateSystem — px constants deliberately UNCHANGED, the
> new mapping is numerically identical to the old tuned look on dpr-1.5
> desktops and fixes dpr-1 displays); the aspect-flex kept (with a nudge off
> exact 16:9 to dodge 7.26's mobile 1600×720 override); `screenInset: 'none'`
> passed so safeArea.ts stays the one inset authority. Desktop verified;
> item 3's REAL-PHONE CHECK IS STILL OWED before the next deploy.

> **STATUS 2026-08-26: THE PIN IS NOW DETACHED.** `auth-server` has rebased
> twice more since we pinned and currently reads
> `7.26.1-32860802198.commit-dae48fb` (published 08-25). No dist-tag points at
> our `commit-0b97733` any more. That is not urgent — the version is still
> published, installable, and its integrity matches the lockfile — but we are on
> a build nobody else is testing against, and the gap widens with every rebase.
> Decide deliberately whether to track `auth-server` again or stay put; do not
> let a stray `npm install` decide it for us. Both `upgrade-sdk` scripts are
> blocked for exactly that reason.

The scene is pinned to the **auth-server** dist-tag:

    "@dcl/sdk": "7.26.1-32160793830.commit-0b97733"

That pin is not cosmetic — it is the build that ships the multiplayer server
runtime this game depends on. `npm run upgrade-sdk` used to re-resolve the
`auth-server` tag, which silently moves the pin wherever the tag now points.
It is deliberately blocked; do the install by hand once you've read this.

## Before you start

    npm view @dcl/sdk dist-tags

**The original gate is CLEARED — this section is kept for the rule it encodes.**
It used to read "7.26.0 must exist" and "`auth-server` must point at a 7.26.x
build". Both happened: 7.26.0 published 08-13, `auth-server` rebased onto 7.26.x,
and we migrated on 08-19.

The rule that still holds: **never move to a mainline `latest`.** Leaving the
`auth-server` line means losing the multiplayer server runtime the whole game is
built on. Any pin we adopt must be an `auth-server` build.

The live question now is drift, not availability. As of 2026-08-26:

    latest       7.26.0
    auth-server  7.26.1-32860802198.commit-dae48fb   ← moved 08-25
    next         7.26.1-32969506852.commit-b7a44a2
    ours         7.26.1-32160793830.commit-0b97733   ← no tag points here

Re-running the four UI items below is only warranted if a newer `auth-server`
build changes UI scaling again. Check its release notes before assuming it does;
the 7.26 scaling rework is already absorbed.

## SDK 7.26.0 changes UI scaling — we are exposed in four places

7.26.0 reworks UI scaling for cross-platform consistency. Our live scene is
unaffected until we build against it, but four things here were written to
compensate for the OLD behaviour and will be wrong afterwards:

1. **`UI_ZOOM = 1.5` in `src/ui.tsx`.**
   It exists solely to undo the device-pixel-ratio divide added in 7.24.3.
   7.26.0 removes DPR from UI pixel calculations, so this compensation becomes
   a straight 1.5x oversize. Expect to set `UI_ZOOM = 1` (making the virtual
   canvas 1920x1080, which is also 7.26's desktop default) and re-check the HUD.

2. **The dynamic `virtualWidth` letterbox fix** (`uiStateSystem` in `ui.tsx`).
   We re-call `setUiRenderer` as the aspect changes because the renderer
   letterboxes a fixed-aspect canvas and left-anchors it. If 7.26 makes scaling
   predictable this may be unnecessary — try deleting it and testing ultrawide
   plus portrait before keeping it.

3. **Mobile HUD menu moves top-RIGHT to top-LEFT — VERIFY, don't assume.**
   Checked: every mobile-anchored element sits 36-56% down the screen
   (`TOAST_POS_MOBILE` is `top: '36%'`, the story card 38%, the pop ring 56%),
   so nothing of ours currently occupies the top-left corner the menu is moving
   into. Low risk, but confirm on a device — the menu's real footprint is not
   documented, and anything we add near the top later inherits this hazard.

4. **Safe-area handling — ANSWERED by Foundation (Pravus, 2026-08-11).**
   Our custom `UiCanvasInformation.interactableArea` logic (safeArea.ts) will
   NOT break under SDK 7.26.0 + Mobile explorer 1.12.1 — the API keeps working
   and keeps reporting correct values. Because we read it LIVE, our HUD adapts
   to the new mobile interactable area automatically, even on the current build.
   Two sanctioned paths when we migrate:

   * **Keep the custom logic (recommended for the migration itself):** pass
     `screenInset: 'none'` to `setUiRenderer` so the new automatic inset never
     double-applies on top of ours. Minimal diff, battle-tested behaviour, and
     we keep the live chat-open/close tracking.
   * **Simplify later (optional):** delete safeArea.ts + the `<ScreenInsetArea>`
     wrapper and pass `screenInset: 'interactable'` — the platform then insets
     the whole canvas automatically. Cheaper code, but it shifts EVERYTHING
     (including centred content) and desktop/mobile areas differ, so it needs a
     full visual retest. Post-delivery work, not migration work.

   ⚠️ Do not confuse Pravus's `screenInset: 'none'` (keep virtual canvas,
   disable only the auto-inset) with the trap fallback below, which ALSO zeroes
   virtualWidth/virtualHeight and thereby disables the virtual screen entirely.
   The `screenInset` value is safe to set on its own; the zeroed sizes are not.

   The only piece that still encodes old assumptions is the `FALLBACK` constant
   (`left: 0.26`) — it's used only when `interactableArea` is unreadable, and
   should be retuned during the migration pass.

## The announcement's "escape hatch" is NOT for us

    setUiRenderer(ui, { virtualWidth: 0, virtualHeight: 0, screenInset: 'none' })

Those parameters DISABLE the virtual screen feature entirely (confirmed in the
creators channel) — UI values then map to REAL screen pixels with no scaling.

Our whole HUD is authored against a 1280x720 virtual canvas: every font size,
button height, margin and offset is a virtual-pixel number, plus a MOBILE_SCALE
multiplier on top. Without the virtual canvas those numbers mean nothing
consistent — the HUD would render at roughly half size on a 2400px-wide phone
and oversized in a small desktop window.

Taking this option means hand-rewriting the UI to be resolution-independent.
That is far MORE work than the real fix, which is retuning `UI_ZOOM` and
re-testing. Do not reach for it under time pressure — it is a trap for a
virtual-canvas scene like ours.

If we genuinely need to ship without doing the migration, the correct fallback
is the other one in the announcement: stay on (or revert to) the previous
auth-server SDK version, where our current UI values are already correct.

## Order of work

1. Install locally. Do **not** publish.
2. Confirm the auth-server runtime still works (`isServer`, `syncEntity`,
   `registerMessages`) — the server is the reason for the pin.
3. Test the HUD on desktop AND a real phone.
4. Fix the four items above.
5. Publish only once the UI is right.

Staying on a known-good `auth-server` pin always costs us nothing. Moving
without doing steps 2-4 can cost us the server runtime or the HUD, so the
`upgrade-sdk` scripts stay blocked and the install stays manual.
