import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, PointerEventType, inputSystem, timers } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, PICKUP_TOUCH_MS, InteractionType, POP_BEATS, POP_BEAT_MS, POP_HIT_T, POP_FIRST_GRACE_MS } from '../shared/config'
import { holdDurationMs } from './upgradeEffects'
import { GLASS_ID_PREFIX } from '../shared/glassDiscovery'
import { showCleanedToast, showNarrativeToast, setHoldBarZone, flashPerfect, flashMiss, setSkillTapHandler, setPopRing } from '../ui'
import { promotionBurst } from './confettiSystem'
import { playHoverSound, playStickySound, stopStickySound, playCleanSound, playPerfectSound, playMissSound } from './soundManager'
import { playPickupEmote, playMoppingEmote, cancelEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { clicksAllowed, onPhaseChange, withinReach, POINTER_MAX_DIST, SYNC_POLL_S } from './phaseGate'
import { registerSpreeHit } from './spreeSystem'

const pendingCleans     = new Set<string>()
const pendingVisualHide = new Set<string>()  // items awaiting delayed hide at touch moment
const lastState         = new Map<string, boolean>()

// Stored after sync so enable/disable can re-register handlers at any time.
// posEntity: where the item actually IS. On mobile the pointer `entity` is the
// enlarged tap-proxy — a CHILD whose Transform.position is local (0,0,0) — so
// reading position off it measured distance to the scene origin and made every
// sticky patch "too far away" on phones. World positions always come from the
// scene container entity instead.
type ItemRef = { entity: Entity; type: InteractionType; posEntity: Entity }
const itemRefs = new Map<string, ItemRef>()

function itemPos(id: string) {
  const ref = itemRefs.get(id)
  return ref ? Transform.getOrNull(ref.posEntity)?.position : undefined
}

// zoneStart/zoneEnd: the Fisch-style skill-check window (fractions of the hold).
// Releasing while progress is inside it completes the clean instantly; releasing
// outside cancels as before; holding to 100% still cleans with no skill required.
type ActiveHold = { id: string; startMs: number; zoneStart: number; zoneEnd: number }
let activeHold: ActiveHold | null = null

// Random per hold so the timing can't be muscle-memorised, and never earlier than
// 35% so the mop emote gets a beat to read before the window opens.
// Both the width AND the position roll per hold: narrow zones are riskier, early
// zones (from 15%) demand a snap reaction, late ones a patient nerve — so no two
// patches feel alike.
const SKILL_ZONE_MIN_W = 0.12
const SKILL_ZONE_MAX_W = 0.25
function rollSkillZone(): { zoneStart: number; zoneEnd: number } {
  const w = SKILL_ZONE_MIN_W + Math.random() * (SKILL_ZONE_MAX_W - SKILL_ZONE_MIN_W)
  const zoneStart = 0.15 + Math.random() * (0.95 - w - 0.15)
  return { zoneStart, zoneEnd: zoneStart + w }
}

// Every Nth consecutive PERFECT gets a confetti pop on top of the flash + chime.
const STREAK_CONFETTI_EVERY = 5

// Consecutive green-zone hits. Only an attempted-and-missed release breaks it —
// patiently holding to 100% is neutral, so cautious players aren't punished for
// not engaging with the minigame.
let perfectStreak = 0

// ── Rhythm Pop (popcorn) ──────────────────────────────────────────────────────
// A 3-beat circular timing game — see config for the design note. Runs beside
// the hold machinery (mutually exclusive with it) and drives ui.tsx's ring via
// setPopRing. onDone always fires with the hit count; the caller performs the
// actual clean, so the server path is identical to a plain click.
type ActiveRhythm = {
  id: string; beat: number; beatStartMs: number; hits: number; tapped: boolean
  onDone: (hits: number) => void
}
let activeRhythm: ActiveRhythm | null = null
export const isRhythmActive = (): boolean => activeRhythm !== null

/** Starts the pop rhythm for an item. False = another minigame is running. */
export function startPopRhythm(id: string, onDone: (hits: number) => void): boolean {
  if (activeRhythm || activeHold) return false
  activeRhythm = { id, beat: 0, beatStartMs: Date.now(), hits: 0, tapped: false, onDone }
  return true
}

function judgeRhythmTap(): void {
  if (!activeRhythm || activeRhythm.tapped) return
  const now = Date.now()
  // The pointer-down that STARTED the rhythm arrives this same frame — ignore it.
  if (activeRhythm.beat === 0 && now - activeRhythm.beatStartMs < POP_FIRST_GRACE_MS) return
  activeRhythm.tapped = true
  const t = (now - activeRhythm.beatStartMs) / POP_BEAT_MS
  if (t >= POP_HIT_T) {
    activeRhythm.hits++
    playPerfectSound(activeRhythm.hits)   // ascending pop-pop-pop
  } else {
    // Too early — same rules as the skill check: an attempted-and-missed
    // timing breaks the streak and says so; not engaging stays neutral.
    perfectStreak = 0
    flashMiss()
    playMissSound()
  }
}

// ─── Open-phase gate ──────────────────────────────────────────────────────────
const OPEN_PHASE_TOAST_COOLDOWN_MS = 3_000
let lastOpenPhaseToastMs = 0

function getPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

function maybeShowOpenPhaseToast() {
  const now = Date.now()
  if (now - lastOpenPhaseToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastOpenPhaseToastMs = now
  showNarrativeToast('Wait for the next round!')
}

let lastTooFarToastMs = 0
function maybeShowTooFarToast() {
  playMissSound()   // every attempt gets the "nope" blip; the toast is throttled
  const now = Date.now()
  if (now - lastTooFarToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastTooFarToastMs = now
  showNarrativeToast('Too far away — get closer!')
}

function findClutterEntity(itemId: string): Entity | undefined {
  for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
    if (ClutterSync.get(entity).itemId === itemId) return entity
  }
  return undefined
}

function tryClean(
  id: string,
  applyCleanState: (id: string, isCleaned: boolean) => void,
) {
  if (pendingCleans.has(id)) return
  const syncEnt = findClutterEntity(id)
  if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
  pendingCleans.add(id)
  registerSpreeHit()
  disableClick(id)            // remove prompt immediately while pending
  applyCleanState(id, true)   // optimistic swap
  room.send('cleanItem', { itemId: id })
  showCleanedToast()
}

// ─── Enable / disable pointer interactions per item ───────────────────────────

function enableClick(id: string) {
  if (!clicksAllowed()) return  // pointer events only live during the 'playing' phase
  const ref = itemRefs.get(id)
  if (!ref) return
  const { entity, type } = ref

  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())

  if (type === 'hold') {
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Hold to Clean', maxDistance: POINTER_MAX_DIST } },
      () => {
        if (pendingCleans.has(id) || activeHold || activeRhythm) return
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
        if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }
        // Reach gate — pointer rays pass through pointer-layer-free walls/floors,
        // so a patch upstairs was moppable from below. Real distance check instead.
        if (!withinReach(itemPos(id))) {
          maybeShowTooFarToast()
          return
        }
        playStickySound()
        const { zoneStart, zoneEnd } = rollSkillZone()
        activeHold = { id, startMs: Date.now(), zoneStart, zoneEnd }
        showHoldBarRef(id, true)
        updateHoldBarRef(id, 0)
        setHoldBarZone(zoneStart, zoneEnd)

        // Mopping emote — same step-to-item + emote logic as the pickup animation,
        // fired while the player holds to clean the sticky patch.
        const pos = itemPos(id)
        // Emote runs for exactly the (possibly upgraded) hold duration so it stops
        // as the bar completes rather than looping past it.
        if (pos) playMoppingEmote(pos, holdDurationMs())
      }
    )
    // NOTE: no onPointerUp here on purpose. It gave the patch an extra pointer-event
    // entry that the quick items (bottles/rubbish) don't have, diverging the setup
    // and suppressing the hover outline + adding a stray "Interact" prompt. Release
    // is detected by the hold-progress system's inputSystem.isPressed poll instead,
    // so the pointer events now match the other mess items exactly (hover + down).
  } else {
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean', maxDistance: POINTER_MAX_DIST } },
      () => {
        if (pendingCleans.has(id)) return
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
        if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }

        playCleanSound()               // instant audio feedback on click
        pendingCleans.add(id)
        disableClick(id)
        showCleanedToast()

        const pos = Transform.getOrNull(entity)?.position
        if (pos) playPickupEmote(pos)

        // Delay visual hide + sparkle to sync with the emote hand-touch moment.
        // Guard: if cleanRejected arrives before the timer fires it clears
        // pendingVisualHide — the timer then bails out without hiding the item.
        pendingVisualHide.add(id)
        room.send('cleanItem', { itemId: id })

        timers.setTimeout(() => {
          // Always delete the pending-hide guard first so the ClutterSync watcher
          // can take over if it hasn't already (e.g. after re-entry clear).
          const wasPending = pendingVisualHide.has(id)
          pendingVisualHide.delete(id)
          // Hide + sparkle if:
          //   (a) normal path — still in the pending set (cleanRejected didn't fire), OR
          //   (b) onEnterSceneObservable wiped pendingVisualHide but the ClutterSync
          //       watcher already confirmed clean (lastState=true).
          // In case (b) applyCleanState is a no-op, but sparkle plays at the right moment.
          if (!wasPending && lastState.get(id) !== true) return
          applyCleanStateRef(id, true)
          if (pos) playSparkle(pos)
        }, PICKUP_TOUCH_MS)
      }
    )
  }
}

function disableClick(id: string) {
  const ref = itemRefs.get(id)
  if (!ref) return
  pointerEventsSystem.removeOnPointerDown(ref.entity)
  pointerEventsSystem.removeOnPointerHoverEnter(ref.entity)
  PointerEvents.deleteFrom(ref.entity)
}

// ─── Scene GLB entity swap ────────────────────────────────────────────────────
// Called by the deferred GLB setup system in cleaningSystem once the GltfContainer
// entity is ready and its collision mask has been set to CL_POINTER.
// Moves any already-registered pointer events from the placeholder entity to the
// real mesh entity, then re-enables click if the item is not already cleaned.
export function updateSceneHoldGltf(itemId: string, gltfEntity: Entity) {
  const ref = itemRefs.get(itemId)
  if (!ref || ref.entity === gltfEntity) return
  const old = ref.entity
  pointerEventsSystem.removeOnPointerDown(old)
  pointerEventsSystem.removeOnPointerHoverEnter(old)
  PointerEvents.deleteFrom(old)
  ref.entity = gltfEntity
  if (!pendingCleans.has(itemId)) {
    const syncEnt = findClutterEntity(itemId)
    if (!syncEnt || !ClutterSync.get(syncEnt).isCleaned) enableClick(itemId)
  }
}

/**
 * Registers a server-spawned disaster stage (stain/polish) into the hold
 * pipeline — full skill-check, streaks, mop emote, the lot. Idempotent; called
 * by themeSpawnSystem when the replicated entity appears. Clicks are wired here
 * directly: the ClutterSync watcher's appear branch routes new items through
 * the sticky spawn director, which ignores non-sticky ids and would never
 * enable these. While a stage is LOCKED the server keeps it at scale ~0.001 —
 * no surface to hover — and rejects crafted cleans, so no extra gating needed.
 */
export function registerDisasterHold(itemId: string, entity: Entity) {
  if (itemRefs.has(itemId)) return
  itemRefs.set(itemId, { entity, type: 'hold', posEntity: entity })
  if (!pendingCleans.has(itemId)) {
    const syncEnt = findClutterEntity(itemId)
    if (!syncEnt || !ClutterSync.get(syncEnt).isCleaned) enableClick(itemId)
  }
}

/**
 * Removes a dynamically-registered hold (see registerDisasterHold). Needed for
 * theme SLOTS that carried a sticky-patch model one round (spring cleaning)
 * and a quick-click model the next — without this, a slot that was ever a
 * hold would answer as "Hold to Clean" forever.
 */
export function unregisterDynamicHold(itemId: string) {
  if (!itemRefs.has(itemId)) return
  disableClick(itemId)
  itemRefs.delete(itemId)
}

// ─── Refs captured at init so enable/disable closures can call them ──────────
// (avoids threading callbacks through every helper)

let applyCleanStateRef: (id: string, isCleaned: boolean) => void = () => {}
let showHoldBarRef:     (id: string, visible: boolean) => void   = () => {}
let updateHoldBarRef:   (id: string, progress: number) => void   = () => {}
// Optional staggered spawn-in: when set, an uncleaned item is popped in by the
// spawn director (clicks enabled on pop-complete) instead of snapping visible.
let spawnInRef:         ((id: string, onPopped: () => void) => void) | null = null

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initInteractionManager(
  dirtyEntities:     Map<string, Entity>,
  applyCleanState:   (id: string, isCleaned: boolean) => void,
  showHoldBar:       (id: string, visible: boolean) => void,
  updateHoldBar:     (id: string, progress: number) => void,
  sceneHoldEntities?: Map<string, Entity>,
  spawnIn?: (id: string, onPopped: () => void) => void,
) {
  applyCleanStateRef = applyCleanState
  showHoldBarRef     = showHoldBar
  updateHoldBarRef   = updateHoldBar
  spawnInRef         = spawnIn ?? null

  // On scene (re-)entry clear all stale client state so the ClutterSync watcher
  // treats every item as freshly unseen and correctly re-enables uncleaned ones.
  onEnterSceneObservable.add(() => {
    if (activeHold) {
      showHoldBar(activeHold.id, false)
      stopStickySound()
      activeHold = null
    }
    if (activeRhythm) {
      activeRhythm = null
      setPopRing(null, 0)
    }
    pendingCleans.clear()
    pendingVisualHide.clear()
    lastState.clear()
  })

  // Populate item refs immediately — enable/disable can be called as soon as sync fires
  for (const def of CLUTTER_DEFS) {
    if (def.sceneGlb) continue   // click + visuals owned by a scene-discovery system
    const e = dirtyEntities.get(def.id)!
    itemRefs.set(def.id, { entity: e, type: def.type ?? 'quick', posEntity: e })
  }
  // Scene-discovered hold entities (e.g. StickyPatches from GLB) — type is always
  // 'hold'. The container entity stays the position source even after
  // updateSceneHoldGltf swaps the pointer entity to the (mobile) tap proxy.
  if (sceneHoldEntities) {
    for (const [itemId, entity] of sceneHoldEntities) {
      itemRefs.set(itemId, { entity, type: 'hold', posEntity: entity })
    }
  }

  // Ends the active hold and applies the skill-check outcome for an attempt made
  // at progress `at` (0..1): inside the green zone → instant PERFECT clean;
  // outside → cancel + streak break. Shared by the desktop release and the mobile
  // second tap, so the two platforms can never drift on the rules.
  function resolveSkillCheck(at: number): void {
    if (!activeHold) return
    const { id, zoneStart, zoneEnd } = activeHold
    activeHold = null
    cancelEmote()
    stopStickySound()
    showHoldBar(id, false)
    updateHoldBar(id, 0)

    if (at >= zoneStart && at <= zoneEnd) {
      perfectStreak++
      flashPerfect(perfectStreak)
      playPerfectSound(perfectStreak)   // chime rises with the streak
      playCleanSound()
      const holdPos = itemPos(id)
      if (holdPos) playSparkle(holdPos)
      // Streak milestones get a confetti pop — the club celebrates with you.
      if (perfectStreak % STREAK_CONFETTI_EVERY === 0) promotionBurst()
      tryClean(id, applyCleanState)
    } else {
      perfectStreak = 0   // attempted the timing and missed — streak broken
      flashMiss()
      playMissSound()
    }
  }

  // The mobile SCRUB/POP button routes here. Rhythm first — it and the hold
  // are mutually exclusive, so whichever is active owns the tap.
  setSkillTapHandler(() => {
    if (activeRhythm) { judgeRhythmTap(); return }
    if (!activeHold) return
    const heldMs = Date.now() - activeHold.startMs
    if (heldMs <= 250) return
    resolveSkillCheck(heldMs / holdDurationMs())
  })

  // ── Rhythm Pop frame system — beat progression, desktop taps, finish ─────────
  engine.addSystem(() => {
    if (!activeRhythm) return
    // Desktop tap = pointer press anywhere: the cursor is camera-locked, so a
    // global press IS the tap (mobile goes through the POP! button above).
    if (!isMobile() && inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN)) {
      judgeRhythmTap()
    }
    const elapsed = Date.now() - activeRhythm.beatStartMs
    setPopRing(Math.min(1, elapsed / POP_BEAT_MS), activeRhythm.hits)
    if (elapsed < POP_BEAT_MS) return

    if (activeRhythm.beat + 1 < POP_BEATS) {
      activeRhythm.beat++
      activeRhythm.beatStartMs = Date.now()
      activeRhythm.tapped = false
      return
    }
    // Beats done. At least ONE hit collects (zero-effort collection made the
    // rhythm decorative — playtest); full marks add the mastery layer. A blank
    // run flashes MISSED and the popcorn stays for a retry.
    const { hits, onDone } = activeRhythm
    activeRhythm = null
    setPopRing(null, 0)
    if (hits === POP_BEATS) {
      perfectStreak++
      flashPerfect(perfectStreak)
      if (perfectStreak % STREAK_CONFETTI_EVERY === 0) promotionBurst()
    } else if (hits === 0) {
      flashMiss()
      playMissSound()
    }
    onDone(hits)
  })

  // Frame system: drives hold progress + fires on completion
  engine.addSystem(() => {
    if (!activeHold) return
    const heldMs = Date.now() - activeHold.startMs

    // The skill input differs by platform. DESKTOP: release the held button —
    // polled via isPressed rather than onPointerUp, which can be missed when the
    // step-to-item move slides the cursor off the patch (60 ms grace avoids the
    // press-edge race on the first frame). MOBILE: a touch screen has no held
    // pointer state (a tap starts the hold and the bar fills on its own), so the
    // skill input is a SECOND tap to lock the marker — the 250 ms grace keeps the
    // starting tap itself from resolving the check. Letting the bar run to 100%
    // stays the no-skill fallback on both platforms.
    if (isMobile()) {
      if (heldMs > 250 && inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN)) {
        resolveSkillCheck(heldMs / holdDurationMs())
        return
      }
    } else if (heldMs > 60 && !inputSystem.isPressed(InputAction.IA_POINTER)) {
      resolveSkillCheck(heldMs / holdDurationMs())
      return
    }

    // Read live, not captured at hold-start: the Mopping Speed upgrade shortens
    // this, and the bar, the completion check and the emote must all agree.
    const progress = heldMs / holdDurationMs()
    updateHoldBar(activeHold.id, Math.min(1, progress))

    if (progress >= 1) {
      const { id } = activeHold
      activeHold = null
      showHoldBar(id, false)
      playCleanSound()
      const holdPos = itemPos(id)
      if (holdPos) playSparkle(holdPos)
      tryClean(id, applyCleanState)
    }
  })

  // Enable clicks once server state is synced, then remove this one-shot system.
  const enableOnSync = () => {
    if (!isStateSyncronized()) return
    for (const def of CLUTTER_DEFS) {
      if (def.sceneGlb) continue
      enableClick(def.id)
    }
    // Scene-hold items (sticky patches) are NOT eagerly enabled here — the
    // ClutterSync watcher's appear branch routes them through the spawn director,
    // which enables clicks only once the patch has popped in (fully loaded).
    engine.removeSystem(enableOnSync)
  }
  engine.addSystem(enableOnSync)

  // Watch ClutterSync → apply authoritative state + manage click availability
  // (polled at SYNC_POLL_S, not every frame).
  let syncAcc = 0
  engine.addSystem((dt: number) => {
    syncAcc += dt
    if (syncAcc < SYNC_POLL_S) return
    syncAcc = 0
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)

      pendingCleans.delete(state.itemId)

      if (state.isCleaned) {
        if (activeHold?.id === state.itemId) {
          showHoldBar(state.itemId, false)
          activeHold = null
        }
        disableClick(state.itemId)
        // If a pickup timer is pending, let it apply the visual at the touch moment.
        // For hold items the timer is never set, so this branch is a no-op for them.
        if (!pendingVisualHide.has(state.itemId)) {
          applyCleanState(state.itemId, true)
        }
      } else {
        // Round reset / first appearance — cancel any pending visual hide, then
        // stagger the pop-in: spawnInRef pops the patch in once its GLB + collider
        // are ready and enables clicks at that point (fixes round-1 click races and
        // adds a satisfying pop).  Falls back to instant restore if no director.
        pendingVisualHide.delete(state.itemId)
        if (spawnInRef) {
          spawnInRef(state.itemId, () => enableClick(state.itemId))
        } else {
          enableClick(state.itemId)
          applyCleanState(state.itemId, false)
        }
      }
    }
  })

  // ── Phase gate — sticky-patch pointer events only live during 'playing' ───────
  onPhaseChange((phase) => {
    if (phase === 'playing') {
      for (const [id] of itemRefs) {
        if (pendingCleans.has(id)) continue
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) continue
        enableClick(id)
      }
    } else {
      // Leaving 'playing' (intermission/finale) — kill any in-progress hold so it
      // can't complete while cleaning is disabled, then turn off all pointer events.
      if (activeHold) {
        showHoldBarRef(activeHold.id, false)
        stopStickySound()
        activeHold = null
      }
      // An in-flight rhythm dies without its clean — the round is over anyway.
      if (activeRhythm) {
        activeRhythm = null
        setPopRing(null, 0)
      }
      for (const [id] of itemRefs) disableClick(id)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (data.itemId.startsWith(GLASS_ID_PREFIX)) return  // handled by glassSystem
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)  // cancels timer if not yet fired
    if (activeHold?.id === data.itemId) {
      showHoldBar(data.itemId, false)
      activeHold = null
    }
    // Restore dirty visual immediately in case the timer already fired and hid the item.
    // lastState is then cleared so the ClutterSync watcher re-applies authoritative state
    // on its next tick (confirms item is still dirty, re-enables click).
    applyCleanStateRef(data.itemId, false)
    lastState.delete(data.itemId)
  })
}
