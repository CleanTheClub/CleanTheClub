// Adjusts emissive material properties on designated scene entities in response
// to the overall cleanliness percentage. Each client applies GltfNodeModifiers
// locally — it's not in the syncEntity list so no CRDT conflicts.
//
// HOW TO ADD TARGETS
// ──────────────────
// 1. Place your emissive entity in Creator Hub and give it a Name.
// 2. Find the node name in the GLB (Blender object name, not mesh name).
// 3. Add an entry to EMISSION_TARGETS below with the matching colour constant.
//
// STATES → THRESHOLDS (from shared/config.ts)
// ────────────────────────────────────────────
//  grungy : pct < TRANSFORM_DIM    (0.30) — barely lit, grimy
//  dim    : pct < TRANSFORM_MID    (0.60) — dim, still dirty
//  mid    : pct < TRANSFORM_BRIGHT (0.80) — getting cleaner
//  bright : pct ≥ TRANSFORM_BRIGHT        — authored values fully restored
//  vivid  : phase === 'open'              — authored values fully restored (party mode)

import { engine, Entity, GltfNodeModifiers, Name } from '@dcl/sdk/ecs'
import { gameState } from './phaseGate'
import { TRANSFORM_DIM, TRANSFORM_MID, TRANSFORM_BRIGHT } from '../shared/config'

// ─────────────────────────────────────────────────────────────────────────────
// ── Colour palette — exact emissiveFactor values from the GLB materials ───────
// ─────────────────────────────────────────────────────────────────────────────
// Sourced directly from the GLB binary (emissiveFactor × KHR_emissive_strength).
// albedoColor is set to black so scene lighting adds no unwanted contribution —
// these are pure-emissive nodes; only the glow should be visible.

const PINK   = { r: 1.0000, g: 0.0000, b: 0.3042 }
const BLUE   = { r: 0.0000, g: 0.0761, b: 0.7989 }
const PURPLE = { r: 0.3273, g: 0.0000, b: 0.7989 }
const ORANGE = { r: 0.7989, g: 0.1135, b: 0.0000 }
const SIGN   = { r: 1.9822, g: 0.0006, b: 0.8251 }  // 5em.001 — strength ×1.98

// ─────────────────────────────────────────────────────────────────────────────
// ── Target config ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

type PathEntry = { path: string; r: number; g: number; b: number }

export const EMISSION_TARGETS: { name: string; paths: PathEntry[] }[] = [
  {
    name: 'MainStructure',
    paths: [
      // ── Structure / ambient ───────────────────────────────────────────────────
      { path: 'collis',                        ...SIGN   },  // signage
      { path: 'Roof.001',                      ...BLUE   },  // roof glow
      { path: 'Walls.001',                     ...BLUE   },  // wall panels
      { path: 'SkirtingBoard_GroundFloor.001', ...BLUE   },  // skirting blue
      { path: 'SkirtingBoard_GroundFloor.002', ...ORANGE },  // skirting orange
      { path: 'InnerCorners.001',              ...PINK   },  // inner corner accents
      { path: 'InnerCornersSpeakers.001',      ...BLUE   },  // speaker corner accents
      { path: 'InnerCornersSpeakers.002',      ...BLUE   },

      // ── Entrance ─────────────────────────────────────────────────────────────
      { path: 'SideEntranceGlowR',             ...BLUE   },  // entrance glow blue
      { path: 'SideEntranceGlowR.001',         ...PINK   },  // entrance glow pink
      { path: 'Arrow.002',                     ...PINK   },  // directional arrow

      // ── Dance floor ──────────────────────────────────────────────────────────
      { path: 'DanceFloorTop',                 ...PINK   },  // floor rings pink
      { path: 'DanceFloorTop.001',             ...PURPLE },  // floor rings purple
      { path: 'DanceFloor.002',                ...PINK   },  // floor surface
      { path: 'DanceAreaTubes',                ...ORANGE },  // tubes orange
      { path: 'DanceAreaTubes.001',            ...PINK   },  // tubes pink
      { path: 'SpeakerGlow',                   ...PINK   },  // speaker glow rings
      { path: 'ChillGlow',                     ...PINK   },  // chill-zone glow
      { path: 'heart',                         ...ORANGE },  // heart accent
      { path: 'Cylinder.002',                  ...ORANGE },  // dance area accent
      { path: 'Cylinder.003',                  ...PINK   },
      { path: 'Cylinder.004',                  ...PINK   },
      { path: 'Cylinder.005',                  ...BLUE   },
      { path: 'Cylinder.006',                  ...PINK   },
      { path: 'Cylinder.007',                  ...BLUE   },
      { path: 'Cylinder.011',                  ...PURPLE },  // pillar cylinder

      // ── Speakers / AV ────────────────────────────────────────────────────────
      { path: 'Speakers.001',                  ...PINK   },  // main subwoofers
      { path: 'SpeakerBase.001',               ...PINK   },  // speaker bases
      { path: 'Spotlights.001',                ...PINK   },  // DJ floor spotlights
      { path: 'screen.003',                    ...PINK   },  // screen surrounds
      { path: 'screen.004',                    ...PINK   },
      { path: 'screen.005',                    ...PINK   },

      // ── Mezzanine ────────────────────────────────────────────────────────────
      { path: 'MezzTubeFloorCeiling',          ...ORANGE },  // mezzanine tube strip
      { path: 'MezzTubeRail',                  ...ORANGE },  // mezzanine railing

      // ── VIP area ─────────────────────────────────────────────────────────────
      { path: 'Cube.001',                      ...ORANGE },  // VIP accent
      { path: 'PendantLight.001',              ...ORANGE },  // VIP pendant lamp
      { path: 'SideTable.001',                 ...BLUE   },  // VIP side table
      { path: 'Lamp.001',                      ...BLUE   },  // VIP lamp

      // ── Seating ──────────────────────────────────────────────────────────────
      { path: 'sofa-113.002',                  ...BLUE   },  // main sofa glow
      { path: 'sofa.002',                      ...BLUE   },  // secondary sofa

      // ── Hanging lights ───────────────────────────────────────────────────────
      { path: 'HangingLightbulb.004',          ...PINK   },
      { path: 'HangingLightbulb.006',          ...PURPLE },
      { path: 'HangingLightbulb.007',          ...BLUE   },
      { path: 'HangingLightbulb.008',          ...PINK   },
      { path: 'HangingLightbulb.009',          ...PURPLE },

      // ── Bar ──────────────────────────────────────────────────────────────────
      { path: 'Bar.001',                       ...BLUE   },  // bar counter
      { path: 'stool-046.001',                 ...BLUE   },  // bar stool
      { path: 'cap.002',                       ...PINK   },  // bottle cap
      { path: 'beaker-glass-001.006',          ...PINK   },  // bar glassware
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ── Emission level config ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// null = GltfNodeModifiers.deleteFrom() → authored GLB values fully restored.
// Used for both 'bright' (nearly clean) and 'vivid' (party mode) so the club
// looks exactly as designed at its best — no blowout.

type EmissionState = 'grungy' | 'dim' | 'mid' | 'bright' | 'vivid'
type EmissionLevel = { intensity: number } | null

const EMISSION_LEVELS: Record<EmissionState, EmissionLevel> = {
  grungy: { intensity: 0.00 },  // no glow — colour visible via scene lighting only
  dim:    { intensity: 0.15 },  // glow emerging — still dirty
  mid:    { intensity: 0.50 },  // club coming alive
  bright: null,                 // authored values restored — nearly spotless
  vivid:  null,                 // authored values restored — party mode, no blowout
}

// How often to sample GameState and check for a state transition (seconds).
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

function applyToEntity(entity: Entity, paths: PathEntry[], level: EmissionLevel): void {
  if (level === null) {
    // Restore authored GLB material completely.
    GltfNodeModifiers.deleteFrom(entity)
    return
  }
  GltfNodeModifiers.createOrReplace(entity, {
    modifiers: paths.map(({ path, r, g, b }) => ({
      path,
      material: {
        material: {
          $case: 'pbr' as const,
          pbr: {
            // albedoColor = authored colour (clamped to [0,1] — some emissives have
            // KHR_emissive_strength > 1 which would be invalid for albedo).
            // This makes the material visible via scene lighting even at intensity 0,
            // so colour is always present and glow builds on top as the club gets cleaner.
            albedoColor:       { r: Math.min(1, r), g: Math.min(1, g), b: Math.min(1, b), a: 1 },
            emissiveColor:     { r, g, b },
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
  console.log('[Emission] initEmissionSystem called')
  if (EMISSION_TARGETS.length === 0) {
    console.log('[Emission] No targets configured — add entries to EMISSION_TARGETS to enable')
    return
  }

  type DiscoveredEntry = { entity: Entity; paths: PathEntry[] }
  const discovered = new Map<string, DiscoveredEntry>()
  const needsDiscovery = new Set(EMISSION_TARGETS.map(t => t.name))

  // 10s bail-out (same pattern as restoreSystem): without it, a renamed or
  // missing target meant a full engine Name scan EVERY FRAME for the whole
  // session — a permanent hidden cost triggered by a Creator Hub rename.
  let discoverForS = 0
  const discoverSystem = (dt: number) => {
    discoverForS += dt
    for (const [entity] of engine.getEntitiesWith(Name)) {
      const entityName = Name.get(entity).value
      if (!needsDiscovery.has(entityName)) continue
      const cfg = EMISSION_TARGETS.find(t => t.name === entityName)!
      discovered.set(entityName, { entity, paths: cfg.paths })
      needsDiscovery.delete(entityName)
      console.log(`[Emission] Found "${entityName}" (entity ${entity})`)
    }
    if (needsDiscovery.size === 0) {
      engine.removeSystem(discoverSystem)
    } else if (discoverForS > 10) {
      console.log(`[Emission] gave up after 10s — missing: ${[...needsDiscovery].join(', ')} (renamed in Creator Hub?)`)
      engine.removeSystem(discoverSystem)
    }
  }
  engine.addSystem(discoverSystem)

  let lastState: EmissionState | null = null
  let lastRoundNumber = -1
  let timer = CHECK_INTERVAL_S

  engine.addSystem((dt: number) => {
    timer += dt
    if (timer < CHECK_INTERVAL_S) return
    timer = 0

    if (discovered.size === 0) return

    const gs          = gameState()
    const pct         = gs ? Math.min(1, gs.cleanedCount / Math.max(1, gs.totalCount)) : 0
    const phase       = gs?.phase ?? 'playing'
    const roundNumber = gs?.roundNumber ?? 0

    // Round transition — force re-apply in case the renderer cleared the component.
    if (roundNumber !== lastRoundNumber) {
      if (lastRoundNumber !== -1) {
        console.log(`[Emission] Round ${lastRoundNumber} → ${roundNumber}, forcing re-apply`)
      }
      lastRoundNumber = roundNumber
      lastState = null
    }

    const state = getEmissionState(pct, phase)
    if (state === lastState) return
    lastState = state

    const level = EMISSION_LEVELS[state]
    const intensityStr = level === null ? 'restore authored' : `intensity=${level.intensity}`
    console.log(`[Emission] → "${state}"  ${intensityStr}  pct=${Math.round(pct * 100)}%`)

    for (const { entity, paths } of discovered.values()) {
      applyToEntity(entity, paths, level)
    }
  })

  console.log(`[Emission] Watching ${EMISSION_TARGETS.length} target(s)`)
}
