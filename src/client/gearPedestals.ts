// Lobby gear pedestals — the four flex showpieces on their purple pads.
//
// KJ placed each achievement model (Disco_Ball, Ice_Bucket, Gold_Platter,
// Gold_Dustpan) parented to a pad, with a billboard TextShape sibling. This
// system drives those texts through the achievement lifecycle and makes the
// items clickable to equip:
//
//   locked, no progress   red     "Clean 500 Pizza"          (the requirement)
//   in progress           orange  "412/500 Pizza to go"      (remaining count)
//   unlocked              green   "UNLOCKED — CLICK TO EQUIP"
//   equipped              gold    "EQUIPPED — CLICK TO REVERT"
//
// Equipping is a TOGGLE on the same item: clicking your equipped showpiece
// reverts you to whatever the upgrade ladder says (box → crate → caddy →
// wheelie bin → vacuum). The server re-validates every equip against its own
// tallies, so the click is presentation only.

import { engine, Entity, Name, Transform, TextShape, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { ACHIEVEMENTS, AchievementState } from '../shared/progression'
import { getAchievements, getFlexGear, getCareer } from './progressionStore'
import { findGltfEntity, setupClickProxy } from './sceneItemHelpers'
import { requestSetup } from './spawnDirector'
import { playHoverSound, playClickSound, playMissSound } from './soundManager'
import { showNarrativeToast } from '../ui'
import { pointerMaxDist } from './phaseGate'
import { purchaseBurst } from './confettiSystem'

const COLOR_LOCKED   = Color4.create(1, 0.3, 0.28, 1)     // red
const COLOR_PROGRESS = Color4.create(1, 0.62, 0.2, 1)     // orange
const COLOR_UNLOCKED = Color4.create(0.4, 0.95, 0.5, 1)   // green
const COLOR_EQUIPPED = Color4.create(1, 0.82, 0.25, 1)    // gold

type Pedestal = {
  gear:     string
  itemEnt:  Entity
  textEnt:  Entity | null
  lastLine: string   // last text written — write only on change
}
const pedestals: Pedestal[] = []

// World-space label size — the authored 3 fit the short placeholder line, but
// the live strings run ~2.5× wider ("UNLOCKED — CLICK TO EQUIP") and clipped
// through the walls. Applied once at wiring, covering the authored text too.
const PEDESTAL_FONT_SIZE = 2

// One-shot celebration per gear per session when an unlock is first SEEN —
// the moment usually lands mid-shift via a progressUpdate, not at a pedestal.
const celebrated = new Set<string>()

function stateFor(gear: string): AchievementState | undefined {
  return getAchievements().find((a) => a.gear === gear)
}

function lineFor(gear: string): { text: string; color: Color4 } {
  const s = stateFor(gear)
  const def = ACHIEVEMENTS.find((a) => a.gear === gear)!
  if (!s || s.current <= 0) return { text: def.requirement, color: COLOR_LOCKED }
  if (!s.unlocked) {
    return { text: `${s.target - s.current}/${s.target} ${s.noun} to go`, color: COLOR_PROGRESS }
  }
  if (getFlexGear() === gear) return { text: 'EQUIPPED — CLICK TO REVERT', color: COLOR_EQUIPPED }
  return { text: 'UNLOCKED — CLICK TO EQUIP', color: COLOR_UNLOCKED }
}

function onPedestalClick(gear: string): void {
  const s = stateFor(gear)
  if (!s?.unlocked) {
    playMissSound()
    const def = ACHIEVEMENTS.find((a) => a.gear === gear)!
    showNarrativeToast(s && s.current > 0
      ? `${def.title}: ${s.target - s.current} ${s.noun.toLowerCase()} to go!`
      : `${def.title}: ${def.requirement.toLowerCase()} to earn this.`)
    return
  }
  playClickSound()
  // Toggle: clicking the equipped item reverts to the upgrade ladder.
  room.send('equipGear', { gear: getFlexGear() === gear ? '' : gear })
}

export function initGearPedestals(): void {
  // Discover each showpiece by Name; its billboard is the TextShape sharing
  // the same pad parent.
  for (const def of ACHIEVEMENTS) {
    let itemEnt: Entity | null = null
    for (const [e] of engine.getEntitiesWith(Name)) {
      if (Name.get(e).value === def.gear) { itemEnt = e; break }
    }
    if (!itemEnt) {
      console.log(`[GEAR] pedestal item '${def.gear}' not found in scene — skipping`)
      continue
    }
    const pad = Transform.getOrNull(itemEnt)?.parent
    let textEnt: Entity | null = null
    if (pad) {
      for (const [e] of engine.getEntitiesWith(TextShape, Transform)) {
        if (Transform.get(e).parent === pad) { textEnt = e; break }
      }
    }
    if (!textEnt) console.log(`[GEAR] pedestal '${def.gear}' has no TextShape sibling — text updates skipped`)
    if (textEnt) {
      const ts0 = TextShape.getMutableOrNull(textEnt)
      if (ts0) ts0.fontSize = PEDESTAL_FONT_SIZE
    }
    pedestals.push({ gear: def.gear, itemEnt, textEnt, lastLine: '' })

    // Placed GLBs aren't clickable by default — the same pointer-mask +
    // mobile-tap-proxy treatment every interactive scene item gets.
    const item = itemEnt
    const gear = def.gear
    requestSetup({
      isReady: () => findGltfEntity(item) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(item)
        if (!gltfEnt) return
        const clickEnt = setupClickProxy(gltfEnt)
        pointerEventsSystem.onPointerHoverEnter({ entity: clickEnt }, () => playHoverSound())
        pointerEventsSystem.onPointerDown(
          { entity: clickEnt, opts: { button: InputAction.IA_POINTER, hoverText: def.title, maxDistance: pointerMaxDist() } },
          () => onPedestalClick(gear),
        )
      },
    })
  }
  if (pedestals.length === 0) return

  // Text lifecycle — 1s cadence is plenty (progress moves per clean, and the
  // texts are read at walking pace in the lobby).
  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < 1) return
    acc = 0
    if (!getCareer()) return   // no server answer yet — leave the authored text
    for (const p of pedestals) {
      const { text, color } = lineFor(p.gear)
      // First time an unlock is seen this session: a little celebration.
      const s = stateFor(p.gear)
      if (s?.unlocked && !celebrated.has(p.gear)) {
        celebrated.add(p.gear)
        // Only celebrate a FRESH unlock (text previously showed progress) —
        // a veteran re-joining shouldn't get confetti for old trophies.
        if (p.lastLine.includes('to go')) {
          purchaseBurst()
          showNarrativeToast(`ACHIEVEMENT UNLOCKED: ${ACHIEVEMENTS.find(a => a.gear === p.gear)!.title}! Claim it in the lobby.`)
        }
      }
      if (text === p.lastLine || !p.textEnt) { p.lastLine = text; continue }
      p.lastLine = text
      const ts = TextShape.getMutableOrNull(p.textEnt)
      if (ts) { ts.text = text; ts.textColor = color }
    }
  })
  console.log(`[GEAR] ${pedestals.length} pedestals wired`)
}
