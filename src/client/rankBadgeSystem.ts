// Career plate — the player's job title on a nametag-style pill, floating just
// above their real nametag.
//
// The scene cannot change a player's actual wearables, so this is how a rank
// reads at a glance. Styled to match the explorer's own nametag (translucent
// dark pill, clean text) rather than an iconographic badge — playtest verdict
// on the medallion: "replicate the player's actual nametag style … that would
// look nicer". The title text takes the career tier's colour, so the ladder
// still reads bronze → silver → teal → purple → gold.
//
// LOCAL ONLY for now: entities a client creates aren't replicated, so other
// players can't see your plate yet. Making it social needs the server to
// broadcast everyone's rank — planned once the look is signed off.

import { engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode, TextShape, AvatarAttach, AvatarAnchorPointType, Billboard } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getCareer } from './progressionStore'

// Rank index → tier colour. Tiers group the ladder: janitors (0-2), senior
// cleaners (3-4), supervisors (5-6), managers (7-9), the top (10-11).
const TIER_FOR_RANK = [0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4]
const TIER_COLORS: Color4[] = [
  Color4.create(0.91, 0.64, 0.36, 1),   // bronze
  Color4.create(0.86, 0.90, 0.95, 1),   // silver
  Color4.create(0.29, 0.88, 1.00, 1),   // teal
  Color4.create(0.64, 0.55, 1.00, 1),   // purple
  Color4.create(1.00, 0.82, 0.30, 1),   // gold
]

// Sized and positioned to read as a second line of the explorer's own nametag
// stack (playtest: "same size as the name tag… fully in tandem"). Tune here.
const PLATE_Y_OFFSET = 0.24   // metres above the name-tag anchor
const PLATE_HEIGHT   = 0.16   // world metres — pill height ≈ the real tag's
const TITLE_FONT     = 1.0
// Pill width tracks title length: perChar + padding, in world metres.
const PILL_W_PER_CHAR = 0.055
const PILL_W_PAD      = 0.14

let plateRoot: Entity | null = null
let pillPlane: Entity | null = null
let titleText: Entity | null = null
let currentTitle = ''
let currentColor = Color4.White()
let lastFade     = -1

// ── Native-tag behaviour ──────────────────────────────────────────────────────
// The explorer's real nametag keeps a near-constant SCREEN size (it scales with
// camera distance) and fades out at range. A fixed world-size plate visibly
// shrinks/grows against it — the "doesn't behave the same" feedback — so the
// plate mirrors both behaviours: authored sizes are correct at REF_DIST_M and
// scale linearly with camera distance, then fade to nothing at range.
const REF_DIST_M   = 4
const SCALE_MIN    = 0.8
const SCALE_MAX    = 3.0
const FADE_START_M = 12
const FADE_END_M   = 18

function applyFade(fade: number): void {
  if (!pillPlane || !titleText) return
  Material.setPbrMaterial(pillPlane, {
    albedoColor:      Color4.create(0, 0, 0, 0.55 * fade),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })
  const ts = TextShape.getMutable(titleText)
  ts.textColor    = Color4.create(currentColor.r, currentColor.g, currentColor.b, fade)
  ts.outlineColor = Color4.create(0, 0, 0, fade)
}

function tagBehaviourSystem(): void {
  if (!plateRoot) return
  const cam = Transform.getOrNull(engine.CameraEntity)?.position
  const ply = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!cam || !ply) return
  const dx = cam.x - ply.x, dy = cam.y - (ply.y + 2), dz = cam.z - ply.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, dist / REF_DIST_M))
  Transform.getMutable(plateRoot).scale = { x: s, y: s, z: s }

  const fade = dist <= FADE_START_M
    ? 1
    : Math.max(0, 1 - (dist - FADE_START_M) / (FADE_END_M - FADE_START_M))
  if (Math.abs(fade - lastFade) > 0.02) {
    lastFade = fade
    applyFade(fade)
  }
}

function buildPlate(): void {
  const root = engine.addEntity()
  AvatarAttach.create(root, { anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG })

  // One billboarded carrier so pill + text always turn together.
  plateRoot = engine.addEntity()
  Transform.create(plateRoot, { parent: root, position: { x: 0, y: PLATE_Y_OFFSET, z: 0 } })
  Billboard.create(plateRoot, {})

  // Plain translucent quad, coloured in-material rather than textured: the 3D
  // texture path ignored the pill PNG's alpha and rendered a white plane, and a
  // colour-only material can't fail that way. Square corners at 0.16m tall are
  // indistinguishable from the real tag's rounding at any normal distance.
  pillPlane = engine.addEntity()
  Transform.create(pillPlane, { parent: plateRoot })
  MeshRenderer.setPlane(pillPlane)
  Material.setPbrMaterial(pillPlane, {
    albedoColor:      Color4.create(0, 0, 0, 0.55),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })

  titleText = engine.addEntity()
  // Slightly in front of the pill along the billboard axis so it can't z-fight.
  Transform.create(titleText, { parent: plateRoot, position: { x: 0, y: 0, z: -0.012 } })
  TextShape.create(titleText, {
    text:         '',
    fontSize:     TITLE_FONT,
    textColor:    Color4.White(),
    outlineColor: Color4.Black(),
    outlineWidth: 0.1,
  })
}

function applyTitle(title: string, tier: number): void {
  if (!pillPlane || !titleText) return
  currentColor = TIER_COLORS[tier]
  const ts = TextShape.getMutable(titleText)
  ts.text      = title
  ts.textColor = currentColor

  // Pill width tracks the title length ("Junior Janitor" vs shorter titles).
  const pillW = PILL_W_PER_CHAR * title.length + PILL_W_PAD
  Transform.getMutable(pillPlane).scale = { x: pillW, y: PLATE_HEIGHT, z: 1 }
}

export function initRankBadgeSystem(): void {
  engine.addSystem(tagBehaviourSystem)   // per-frame distance scale + range fade

  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < 0.5) return   // title changes are rare — no need to check per frame
    acc = 0

    const c = getCareer()
    if (!c) return   // no career yet — no plate rather than a wrong one
    if (c.title === currentTitle && plateRoot !== null) return
    currentTitle = c.title

    if (plateRoot === null) buildPlate()
    const tier = TIER_FOR_RANK[Math.max(0, Math.min(c.rank, TIER_FOR_RANK.length - 1))]
    applyTitle(c.title, tier)
    console.log(`[BADGE] career plate → "${c.title}" (tier ${tier + 1})`)
  })
}
