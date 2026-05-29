// =============================================================
// Clean The Club — Leaderboard System
//
// One board displayed above the video screen showing the top-10
// all-time cleaners. All layout, style, and position config lives
// in the block below — no Creator Hub entities required.
// =============================================================

import {
  engine,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
  executeTask,
} from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { Quaternion } from '@dcl/sdk/math'
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

  // Show mock data immediately so the board looks populated before
  // the server sends its first leaderboardUpdate message
  updateLeaderboardDisplay(LB_MOCK_DATA)
}

export function updateLeaderboardDisplay(entries: Array<{ displayName: string; count: number }>): void {
  for (let i = 0; i < LB_ENTRIES; i++) {
    const entry = entries[i]
    const { name, score } = getLabels(i)
    if (!name || !score) continue
    TextShape.getMutable(name).text  = entry ? `${i + 1}.  ${entry.displayName}` : ''
    TextShape.getMutable(score).text = entry ? `${entry.count}` : ''
  }
}

// ── Leaderboard system init ───────────────────────────────────
// Call once from setup.ts. Creates the in-world board, registers the server
// message handler, and sends the player's display name to the server so it
// can map address → name for the leaderboard.
export function initLeaderboardSystem(): void {
  setupLeaderboardBoard()

  // Wake the server immediately — sent synchronously before any async getUserData call.
  // The server shuts down when the scene is empty; this message ensures it starts up
  // ASAP so the first round of player interactions isn't delayed by cold-start latency.
  room.send('ping', { dummy: true })

  // Handle real-time leaderboard updates pushed from the server
  room.onMessage('leaderboardUpdate', (data) => {
    try {
      const entries = JSON.parse(data.entriesJson)
      updateLeaderboardDisplay(entries)
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
