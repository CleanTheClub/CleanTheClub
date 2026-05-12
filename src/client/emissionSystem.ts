// Adjusts emissive material properties on designated scene entities in response
// to the overall cleanliness percentage. Each client applies GltfNodeModifiers
// locally — it's not in the syncEntity list so no CRDT conflicts.
//
// HOW TO ADD TARGETS
// ──────────────────
// 1. Place your emissive entity in Creator Hub and give it a Name.
// 2. (Optional) Open the GLB in Babylon Sandbox to find specific mesh node paths.
//    Use path '' to override the entire model — fine for dedicated light/sign entities.
// 3. Add an entry to EMISSION_TARGETS below.
//
// STATES → THRESHOLDS (from shared/config.ts)
// ────────────────────────────────────────────
//  grungy : pct < TRANSFORM_DIM    (0.30) — barely lit, grimy
//  dim    : pct < TRANSFORM_MID    (0.60) — dim, still dirty
//  mid    : pct < TRANSFORM_BRIGHT (0.80) — getting cleaner
//  bright : pct ≥ TRANSFORM_BRIGHT        — nearly spotless
//  vivid  : phase === 'open'              — club is open, full celebration

import { engine, Entity, GltfNodeModifiers, Name } from '@dcl/sdk/ecs'
import { GameState } from '../shared/schemas'
import { TRANSFORM_DIM, TRANSFORM_MID, TRANSFORM_BRIGHT } from '../shared/config'

// ─────────────────────────────────────────────────────────────────────────────
// ── Target config ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Each entry is a named scene entity + the mesh node paths to override.
// 'paths: [""]'  → override the whole model (ideal for pure-emissive entities).
// 'paths: ["LightMesh", "GlowRing"]' → override only specific nodes.
export const EMISSION_TARGETS: { name: string; paths: string[] }[] = [
  // { name: 'NeonSign_Bar',  paths: [''] },
  // { name: 'FloorLights',   paths: ['LightStrip'] },
  // { name: 'StageRig',      paths: ['SpotLight_L', 'SpotLight_R'] },
]

// ─────────────────────────────────────────────────────────────────────────────
// ── Emission level config ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Full material override — albedo and emissive are set to the same colour so
// the entity glows with a pure-colour look (no albedo lighting artefacts).
// Tune intensity and colour per state to match the club's visual design.

type EmissionState = 'grungy' | 'dim' | 'mid' | 'bright' | 'vivid'
type EmissionLevel = {
  intensity: number       // emissiveIntensity — controls glow strength
  r: number; g: number; b: number  // emissive (and albedo) colour 0–1
}

const EMISSION_LEVELS: Record<EmissionState, EmissionLevel> = {
  //              intensity   r      g      b
  grungy: {  intensity: 0.05, r: 0.40, g: 0.10, b: 0.15 },  // barely lit, reddish-dim
  dim:    {  intensity: 0.25, r: 0.55, g: 0.15, b: 0.40 },  // dim purple/magenta
  mid:    {  intensity: 0.55, r: 0.70, g: 0.30, b: 0.70 },  // medium purple
  bright: {  intensity: 0.90, r: 0.85, g: 0.50, b: 1.00 },  // bright purple/pink
  vivid:  {  intensity: 1.40, r: 1.00, g: 0.70, b: 1.00 },  // celebration — full vivid
}

// How often to sample GameState and check for a state transition (seconds).
// Keeps the system cheap — emission changes are infrequent by nature.
const CHECK_INTERVAL_S = 0.5

// ─────────────────────────────────────────────────────────────────────────────
// ── Internals ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function getEmissionState(pct: number, phase: string): EmissionState {
  if (phase === 'open')        return 'vivid'
  if (pct < TRANSFORM_DIM)    return 'grungy'
  if (pct < TRANSFORM_MID)    return 'dim'
  if (pct < TRANSFORM_BRIGHT) return 'mid'
  return 'bright'
}

function applyToEntity(entity: Entity, paths: string[], level: EmissionLevel): void {
  GltfNodeModifiers.createOrReplace(entity, {
    modifiers: paths.map(path => ({
      path,
      material: {
        material: {
          $case: 'pbr' as const,
          pbr: {
            albedoColor:       { r: level.r, g: level.g, b: level.b, a: 1 },
            emissiveColor:     { r: level.r, g: level.g, b: level.b },
            emissiveIntensity: level.intensity,
          },
        },
      },
    })),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Init ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function initEmissionSystem(): void {
  if (EMISSION_TARGETS.length === 0) {
    console.log('[Emission] No targets configured — add entries to EMISSION_TARGETS to enable')
    return
  }

  // Discovered entities: name → { entity, paths }
  type DiscoveredEntry = { entity: Entity; paths: string[] }
  const discovered = new Map<string, DiscoveredEntry>()
  const needsDiscovery = new Set(EMISSION_TARGETS.map(t => t.name))

  // One-shot setup: scan Name components each frame until all targets are found.
  const discoverSystem = () => {
    for (const [entity] of engine.getEntitiesWith(Name)) {
      const entityName = Name.get(entity).value
      if (!needsDiscovery.has(entityName)) continue
      const cfg = EMISSION_TARGETS.find(t => t.name === entityName)!
      discovered.set(entityName, { entity, paths: cfg.paths })
      needsDiscovery.delete(entityName)
      console.log(`[Emission] Found "${entityName}" (entity ${entity})`)
    }
    if (needsDiscovery.size === 0) engine.removeSystem(discoverSystem)
  }
  engine.addSystem(discoverSystem)

  // State watcher: throttled check, only writes GltfNodeModifiers on state transition.
  let lastState: EmissionState | null = null
  let timer = 0

  engine.addSystem((dt: number) => {
    timer += dt
    if (timer < CHECK_INTERVAL_S) return
    timer = 0

    if (discovered.size === 0) return

    // Read GameState (synced from server — safe to read on client)
    let pct   = 0
    let phase = 'playing'
    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      pct   = Math.min(1, gs.cleanedCount / Math.max(1, gs.totalCount))
      phase = gs.phase
      break
    }

    const state = getEmissionState(pct, phase)
    if (state === lastState) return   // nothing changed — skip
    lastState = state

    const level = EMISSION_LEVELS[state]
    console.log(`[Emission] → "${state}"  pct=${Math.round(pct * 100)}%  phase=${phase}`)

    for (const { entity, paths } of discovered.values()) {
      applyToEntity(entity, paths, level)
    }
  })

  console.log(`[Emission] Watching ${EMISSION_TARGETS.length} target(s)`)
}
