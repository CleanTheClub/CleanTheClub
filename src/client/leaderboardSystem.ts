// =============================================================
// Clean The Club — Leaderboard System
//
// One board displayed above the video screen showing the top-10
// all-time cleaners. All layout, style, and position config lives
// in the block below — no Creator Hub entities required.
// =============================================================

import {
  engine,
  MeshRenderer,
  MeshCollider,
  ColliderLayer,
  Material,
  MaterialTransparencyMode,
  pointerEventsSystem,
  InputAction,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
  executeTask,
} from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { Quaternion, Color4 } from '@dcl/sdk/math'
import { playHoverSound, playClickSound } from './soundManager'
import { getUserData } from '~system/UserIdentity'
import { room } from '../shared/messages'

// ===============================================================
//  ██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗
// ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
// ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
// ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
// ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
//  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝
//
//  Edit anything in this block — no other files need touching.
// ===============================================================

// ── Board world position ──────────────────────────────────────
// The video screen sits at x=16, y=7.5, z=3.15, facing +Z (into the scene).
// Board is placed on the screen face — same centre x/y, slightly in front (higher z).
// Rotation (0, 180, 0) = faces into the scene (+Z direction), same as video screen.
const LB_POSITION = { x: 16, y: 7.5, z: 3.5 }
const LB_ROTATION = { x: 0, y: 180, z: 0 }   // euler degrees

// ── Rows ──────────────────────────────────────────────────────
const LB_ENTRIES    = 8      // number of player rows
const LB_START_Y    = 1.5    // local Y of the first entry row
const LB_STEP_Y     = 0.55   // vertical gap between rows
const LB_HEADER_GAP = 0.75   // extra gap above row 0 for the header

// ── Columns ───────────────────────────────────────────────────
const LB_NAME_X  = -3.5     // local X of the name column  (negative = left)
const LB_SCORE_X =  3.0     // local X of the score column (positive = right)
const LB_DEPTH   =  0.1     // local Z lift off the screen face

// ── Typography ────────────────────────────────────────────────
const LB_FONT_HEADER = 2.8
const LB_FONT_ENTRY  = 2.4

// ── Column header labels ───────────────────────────────────────
const LB_HEADER_NAME  = 'CLEANER'
const LB_HEADER_SCORE = 'CLEANED'

// ── Colours  (r/g/b/a each 0–1) ───────────────────────────────
const LB_COLOR_HEADER = { r: 1,   g: 0.5,  b: 0.15, a: 1 }   // orange
const LB_COLOR_NAME   = { r: 1,   g: 1,    b: 1,    a: 1 }   // white
const LB_COLOR_SCORE  = { r: 0.8, g: 0.6,  b: 1,    a: 1 }   // lilac

// ── Mock data ─────────────────────────────────────────────────
// Shown immediately on load until the server sends real data.
// Kept neutral so the swap to real scores isn't jarring.
const LB_MOCK_DATA: Array<{ displayName: string; count: number }> = [
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
  { displayName: '---', count: 0 },
]

// =============================================================
//                  end of config
// =============================================================

// Two label entities per row: [nameLabel, scoreLabel, nameLabel, scoreLabel …]
// Module-level — populated once by setupLeaderboardBoard().
const leaderboardLabels: Entity[] = []
// Idempotency guard: prevents duplicate entities if setupLeaderboardBoard()
// is ever called more than once (e.g. during hot-reload in the SDK playground).
let boardInitialised = false

function getLabels(entryIdx: number): { name: Entity; score: Entity } {
  const base = entryIdx * 2
  return { name: leaderboardLabels[base], score: leaderboardLabels[base + 1] }
}

export function setupLeaderboardBoard(): void {
  if (boardInitialised) return
  boardInitialised = true
  const quat = Quaternion.fromEulerDegrees(
    LB_ROTATION.x,
    LB_ROTATION.y,
    LB_ROTATION.z,
  )

  const board = engine.addEntity()
  Transform.create(board, { position: LB_POSITION, rotation: quat })

  const headerY = LB_START_Y + LB_HEADER_GAP

  // Header row
  const hName = engine.addEntity()
  Transform.create(hName, { position: { x: LB_NAME_X, y: headerY, z: LB_DEPTH }, parent: board })
  TextShape.create(hName, {
    text: LB_HEADER_NAME,
    fontSize: LB_FONT_HEADER,
    textColor: LB_COLOR_HEADER,
    textAlign: TextAlignMode.TAM_MIDDLE_LEFT,
  })

  const hScore = engine.addEntity()
  Transform.create(hScore, { position: { x: LB_SCORE_X, y: headerY, z: LB_DEPTH }, parent: board })
  TextShape.create(hScore, {
    text: LB_HEADER_SCORE,
    fontSize: LB_FONT_HEADER,
    textColor: LB_COLOR_HEADER,
  })

  // Kept so the cycling display can retitle the board per category.
  headerNameEntity  = hName
  headerScoreEntity = hScore

  // Entry rows
  for (let i = 0; i < LB_ENTRIES; i++) {
    const y = LB_START_Y - i * LB_STEP_Y

    const nameLabel = engine.addEntity()
    Transform.create(nameLabel, { position: { x: LB_NAME_X, y, z: LB_DEPTH }, parent: board })
    TextShape.create(nameLabel, {
      text: '',
      fontSize: LB_FONT_ENTRY,
      textColor: LB_COLOR_NAME,
      textAlign: TextAlignMode.TAM_MIDDLE_LEFT,
    })

    const scoreLabel = engine.addEntity()
    Transform.create(scoreLabel, { position: { x: LB_SCORE_X, y, z: LB_DEPTH }, parent: board })
    TextShape.create(scoreLabel, {
      text: '',
      fontSize: LB_FONT_ENTRY,
      textColor: LB_COLOR_SCORE,
    })

    leaderboardLabels.push(nameLabel, scoreLabel)
  }

  // ── Category arrows ──────────────────────────────────────────
  // Flat quads with a pointer collider, parented to the board so they inherit
  // its position and rotation. Text glyphs sit slightly proud of each quad.
  const makeArrow = (glyph: string, x: number, step: number, hover: string) => {
    const btn = engine.addEntity()
    Transform.create(btn, {
      position: { x, y: LB_ARROW_Y, z: LB_DEPTH },
      scale:    { x: LB_ARROW_SIZE, y: LB_ARROW_SIZE, z: LB_ARROW_SIZE },
      parent:   board,
    })
    MeshRenderer.setPlane(btn)
    MeshCollider.setPlane(btn, ColliderLayer.CL_POINTER)
    Material.setPbrMaterial(btn, {
      albedoColor:      Color4.create(0, 0, 0, 0.55),
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      specularIntensity: 0,
      metallic: 0,
      roughness: 1,
    })

    const glyphEnt = engine.addEntity()
    // NOT mirrored: the board's other labels are parented the same way and read
    // correctly, and mirroring an arrow glyph flips which way it points.
    Transform.create(glyphEnt, {
      position: { x: 0, y: 0, z: -0.02 },
      parent:   btn,
    })
    TextShape.create(glyphEnt, { text: glyph, fontSize: 3, textColor: LB_COLOR_HEADER })

    const state: ArrowState = { entity: btn, pressedAt: -1, restZ: LB_DEPTH }
    arrowStates.push(state)

    pointerEventsSystem.onPointerHoverEnter({ entity: btn }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      { entity: btn, opts: { button: InputAction.IA_POINTER, hoverText: hover, maxDistance: 8 } },
      () => {
        if (categories.length === 0) return
        state.pressedAt = Date.now()
        playClickSound()
        manualUntilMs = Date.now() + LB_MANUAL_HOLD_S * 1000
        categoryIndex = (categoryIndex + step + categories.length) % categories.length
        renderCategory(categories[categoryIndex])
      },
    )
    return btn
  }

  makeArrow('<', -1.2, -1, 'Previous board')
  makeArrow('>',  1.2, +1, 'Next board')

  // Show mock data immediately so the board looks populated before
  // the server sends its first leaderboardUpdate message
  updateLeaderboardDisplay(LB_MOCK_DATA)
}

// ── Category cycling (V2) ─────────────────────────────────────
// The GDD asks for expanded leaderboard categories. Rather than building extra
// in-world boards — more geometry, more wall space, more to read at a glance — the
// single board cycles through the categories the server sends, retitling itself
// each time. One board stays readable and needs no new art.
const LB_CYCLE_SECONDS = 10

// ── Player control ────────────────────────────────────────────
// The board is rendered CLIENT-SIDE from the broadcast payload, so each player
// can look at a different category without affecting anyone else's view — no
// server round-trip, no shared state to fight over.
//
// Touching an arrow takes manual control and pauses the auto-cycle. Rather than
// stranding a board on whatever someone last picked, control lapses back to
// cycling after a period of no input — so an abandoned board resumes advertising
// every category to the next person who walks up.
// Bottom-centre of the board, side by side like pagination — moved from the
// right edge (small, easy to miss) on playtest feedback.
const LB_ARROW_Y       = -3.0
const LB_ARROW_SIZE    = 1.1
const LB_MANUAL_HOLD_S = 30     // no input for this long → auto-cycle resumes

let manualUntilMs = 0
const isManual = (): boolean => Date.now() < manualUntilMs

// Press feedback. The reference implementation (stom66/dcl-sky-chaser) uses an
// animated lever GLB so switching boards is a physical act rather than a click
// on a flat panel. Without a bespoke model we get the same read by dipping the
// button into the board for a moment on press.
const LB_PRESS_MS    = 160
const LB_PRESS_DEPTH = 0.06
type ArrowState = { entity: Entity; pressedAt: number; restZ: number }
const arrowStates: ArrowState[] = []

type LbCategory = {
  key:         string
  title:       string
  scoreHeader: string
  entries:     Array<{ displayName: string; score: string }>
}

let categories: LbCategory[] = []
let categoryIndex = 0
let cycleAcc = 0
let headerNameEntity:  Entity | undefined
let headerScoreEntity: Entity | undefined

function renderCategory(cat: LbCategory | undefined): void {
  if (headerNameEntity !== undefined) {
    TextShape.getMutable(headerNameEntity).text = cat ? cat.title : LB_HEADER_NAME
  }
  if (headerScoreEntity !== undefined) {
    TextShape.getMutable(headerScoreEntity).text = cat ? cat.scoreHeader : LB_HEADER_SCORE
  }
  for (let i = 0; i < LB_ENTRIES; i++) {
    const entry = cat?.entries[i]
    const { name, score } = getLabels(i)
    if (!name || !score) continue
    TextShape.getMutable(name).text  = entry ? `${i + 1}.  ${entry.displayName}` : ''
    TextShape.getMutable(score).text = entry ? entry.score : ''
  }
}

/**
 * Accepts either the V2 category payload or the legacy flat array, so a client and
 * server on different versions still render something sensible rather than a blank
 * board — they can be deployed independently.
 */
export function updateLeaderboardDisplay(payload: unknown): void {
  if (Array.isArray(payload)) {
    categories = [{
      key: 'cleaned', title: LB_HEADER_NAME, scoreHeader: LB_HEADER_SCORE,
      entries: (payload as Array<{ displayName: string; count: number }>)
        .map((e) => ({ displayName: e.displayName, score: String(e.count) })),
    }]
  } else {
    const cats = (payload as { categories?: LbCategory[] })?.categories
    // Drop empty categories so the board never cycles to a blank panel — an empty
    // board reads as broken rather than as "nobody has earned this yet".
    categories = Array.isArray(cats) ? cats.filter((c) => c.entries.length > 0) : []
  }
  if (categoryIndex >= categories.length) categoryIndex = 0
  renderCategory(categories[categoryIndex])
}

/** Advances the board on a timer. Started once from initLeaderboardSystem. */
/** Eases each pressed arrow back out of the board. */
function arrowPressSystem(): void {
  for (const a of arrowStates) {
    if (a.pressedAt < 0) continue
    const t = (Date.now() - a.pressedAt) / LB_PRESS_MS
    const tf = Transform.getMutableOrNull(a.entity)
    if (!tf) continue
    if (t >= 1) {
      tf.position = { ...tf.position, z: a.restZ }
      a.pressedAt = -1
      continue
    }
    // In fast, out slow — a button being pushed and springing back.
    const dip = Math.sin(Math.min(1, t) * Math.PI) * LB_PRESS_DEPTH
    tf.position = { ...tf.position, z: a.restZ + dip }
  }
}

function startCategoryCycle(): void {
  engine.addSystem((dt: number) => {
    if (categories.length <= 1) return   // nothing to cycle between
    if (isManual()) { cycleAcc = 0; return }   // a player is driving
    cycleAcc += dt
    if (cycleAcc < LB_CYCLE_SECONDS) return
    cycleAcc = 0
    categoryIndex = (categoryIndex + 1) % categories.length
    renderCategory(categories[categoryIndex])
  })
}

// ── Leaderboard system init ───────────────────────────────────
// Call once from setup.ts. Creates the in-world board, registers the server
// message handler, and sends the player's display name to the server so it
// can map address → name for the leaderboard.
export function initLeaderboardSystem(): void {
  setupLeaderboardBoard()
  startCategoryCycle()
  engine.addSystem(arrowPressSystem)

  // Wake the server immediately — sent synchronously before any async getUserData call.
  // The server shuts down when the scene is empty; this message ensures it starts up
  // ASAP so the first round of player interactions isn't delayed by cold-start latency.
  room.send('ping', { dummy: true })

  // ...and keep pinging as a presence heartbeat. The server counts a player as
  // in-scene while it keeps hearing from them (see the presence block in
  // server.ts) — the message channel is the only player-presence signal that
  // reliably reaches the server runtime. A dt-accumulator system rather than
  // setInterval, so the heartbeat can never outlive the scene context.
  // 12s, not 5: pings are the scene's largest steady message source (they run
  // forever, even idle), and the Foundation flagged excessive server calls. The
  // presence timeout scales with this (see PRESENCE_TIMEOUT_MS) — and players
  // who are actually cleaning refresh their presence through cleanItem anyway.
  const PING_INTERVAL_S = 12
  let pingAcc = 0
  engine.addSystem((dt: number) => {
    pingAcc += dt
    if (pingAcc < PING_INTERVAL_S) return
    pingAcc = 0
    room.send('ping', { dummy: true })
  })

  // Handle real-time leaderboard updates pushed from the server
  room.onMessage('leaderboardUpdate', (data) => {
    try {
      updateLeaderboardDisplay(JSON.parse(data.entriesJson))
    } catch {
      console.log('[Leaderboard] Failed to parse leaderboardUpdate')
    }
  })

  // Send display name to server so leaderboard shows real names, not addresses.
  // Two async gates must both pass before sending:
  //   1. getUserData resolves (identity service call — happens first, stores name here)
  //   2. isStateSyncronized() — CRDT snapshot received from server (checked by a system)
  // Sending registerPlayer before CRDT sync can race the server's cold-start state.
  let pendingDisplayName: string | null = null

  executeTask(async () => {
    try {
      const { data } = await getUserData({})
      if (data?.displayName) pendingDisplayName = data.displayName
    } catch {
      console.log('[Leaderboard] Could not get user data for registration')
    }
  })

  // One-shot system: fires registerPlayer once BOTH conditions are met.
  // Removes itself immediately so the send happens exactly once.
  const registerSystem = () => {
    if (!isStateSyncronized() || pendingDisplayName === null) return
    engine.removeSystem(registerSystem)
    room.send('registerPlayer', { displayName: pendingDisplayName })
  }
  engine.addSystem(registerSystem)

  console.log('[Leaderboard] System ready')
}
