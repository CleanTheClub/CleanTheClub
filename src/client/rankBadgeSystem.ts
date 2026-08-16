// Career nametags — the scene's replacement for the explorer's own nametags.
//
// The scene hides real nametags inside the club (AMT_HIDE_NAMETAGS, see
// initNametagHideArea) and renders these plates instead: the player's name on
// the first line, their job title on the second in their career-tier colour.
// That's the "put their career in the nametag" idea — the SDK still can't edit
// the real tag, but with hiding available we can own the whole thing rather
// than stacking a second label above it.
//
// Plates are rendered for EVERY player in the scene, not just the local one:
// hiding nametags without that would leave everyone else anonymous. Ranks come
// from the server's ranksUpdate broadcast; a player we have no rank for yet
// still gets their name, so nobody is ever nameless.

import {
  engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode,
  TextShape, AvatarAttach, AvatarAnchorPointType, Billboard, BillboardMode, PlayerIdentityData,
  AvatarModifierArea, AvatarModifierType,
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { onLocalEnterScene } from './localPlayer'
import { gameState } from './phaseGate'
import { room } from '../shared/messages'

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

// CLUB OWNER (the ladder's last rung) gets its own treatment on top of the
// shared gold tier: a brighter gold and star-framed title, so an owner reads
// differently from a rank-10 manager at a glance — with zero per-frame cost
// (renderPlate only runs on content change).
const OWNER_RANK = TIER_FOR_RANK.length - 1
const OWNER_GOLD = Color4.create(1, 0.9, 0.45, 1)

/** Tier colour for a rank — exported so the promotion banner matches the plates. */
export function tierColorForRank(rank: number): Color4 {
  if (rank >= OWNER_RANK) return OWNER_GOLD
  return TIER_COLORS[TIER_FOR_RANK[Math.max(0, Math.min(rank, TIER_FOR_RANK.length - 1))]]
}

// Sized to sit where the real nametag did. Authored at REF_DIST_M and scaled by
// camera distance so the plate keeps a near-constant screen size, then faded at
// range — both behaviours copied from the explorer's own tag.
const PLATE_Y      = 0.10
const NAME_FONT    = 0.95
const TITLE_FONT   = 0.8
const PILL_H       = 0.30
// The pill texture is a white stadium drawn in the middle 25% band of a square
// PNG (the rest transparent), so the quad is scaled 4× the visible height and
// the shape supplies the rounded corners. White on purpose: albedoColor tints
// it, so one texture serves every colour.
const PILL_TEX       = 'assets/scene/UI/plate_pill.png'
const PILL_BAND      = 0.25
const PILL_PER_CHAR = 0.052
const PILL_PAD     = 0.16
const REF_DIST_M   = 6
const SCALE_MIN    = 0.7
const SCALE_MAX    = 2.6
const FADE_START_M = 14
const FADE_END_M   = 20

// `cleaning` mirrors the roster's `c` flag — whether that player is enrolled in
// the CURRENT round. Optional: an older server omits it, and consumers (the
// spectate target picker) must treat "unknown" differently from "no".
type RankInfo = { name: string; title: string; rank: number; cleaning?: boolean }
const ranks = new Map<string, RankInfo>()   // lowercased address → career info

/** Career info for a player by (lowercased) address — shared with spectate. */
export function rankInfoFor(address: string): RankInfo | undefined {
  return ranks.get(address.toLowerCase())
}

type Plate = {
  root:    Entity   // AvatarAttach'd to the player
  carrier: Entity   // billboarded holder — animated (float + promotion pop)
  pill:    Entity
  nameT:   Entity
  titleT:  Entity
  avatar:  Entity   // the PlayerIdentityData entity, for distance/fade
  key:     string   // last rendered content, so we only rebuild on change
  fade:    number
  scale:   number   // last distance-derived scale, reused by the animator
  rank:    number   // to detect promotions
  popMs:   number   // >=0 while a promotion pop is playing
  appliedScale: number   // last scale actually written — skip no-op writes
}

// ── Cuteness knobs ────────────────────────────────────────────────────────────
// The plate keeps a flat dark pill for legibility (a coloured glow washed the
// text out), and earns its character from motion instead: it drifts gently and
// pops on promotion. Rank colour lives in the title text.
const POP_MS          = 700
const POP_SCALE       = 0.45   // extra scale at the peak of a promotion pop
const plates = new Map<string, Plate>()   // lowercased address → plate

function buildPlate(address: string, avatar: Entity): Plate {
  const root = engine.addEntity()
  // avatarId targets a specific player; without it AvatarAttach binds to the
  // local player, which is why the old single-plate version was local-only.
  AvatarAttach.create(root, {
    avatarId:      address,
    anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG,
  })

  const carrier = engine.addEntity()
  Transform.create(carrier, { parent: root, position: { x: 0, y: PLATE_Y, z: 0 } })
  // Full billboard — always square to the camera. BM_Y (yaw only) keeps the
  // plate upright but makes it skew away as the camera pitches, which read
  // worse than the tilt it was meant to fix.
  Billboard.create(carrier, { billboardMode: BillboardMode.BM_ALL })

  const pill = engine.addEntity()
  Transform.create(pill, { parent: carrier })
  MeshRenderer.setPlane(pill)

  const nameT = engine.addEntity()
  Transform.create(nameT, { parent: carrier, position: { x: 0, y: 0.062, z: -0.012 } })
  TextShape.create(nameT, {
    text: '', fontSize: NAME_FONT, textColor: Color4.White(),
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  const titleT = engine.addEntity()
  Transform.create(titleT, { parent: carrier, position: { x: 0, y: -0.075, z: -0.012 } })
  // Same sans family as the name (serif read as too formal for the club); the
  // rank is distinguished by caps, size and tier colour instead.
  TextShape.create(titleT, {
    text: '', fontSize: TITLE_FONT, textColor: Color4.White(),
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  return {
    root, carrier, pill, nameT, titleT, avatar,
    key: '', fade: -1, scale: 1, rank: -1, popMs: -1,
    appliedScale: -1,
  }
}

function destroyPlate(p: Plate): void {
  for (const e of [p.pill, p.nameT, p.titleT, p.carrier, p.root]) engine.removeEntity(e)
}

/**
 * Pill paint — rounded shape from the texture's alpha over a flat dark base.
 *
 * NO emissive. A tier-coloured emissive ADDS light on top of the albedo, so a
 * bronze tier over black produced a tan slab that swallowed the text. Rank
 * identity lives in the title's text colour instead, where it can't fight
 * legibility. `alphaTexture` is set explicitly: without it the quad's
 * transparent region is still shaded and the pill reads as a rectangle.
 */
function paintPill(p: Plate, fade: number): void {
  const tex = Material.Texture.Common({ src: PILL_TEX })
  Material.setPbrMaterial(p.pill, {
    texture:           tex,
    alphaTexture:      tex,
    albedoColor:       Color4.create(0, 0, 0, 0.85 * fade),
    emissiveColor:     Color3.Black(),
    emissiveIntensity: 0,
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })
}

/** Applies name/title/colour + pill width. Only called when the content changes. */
function renderPlate(p: Plate, info: RankInfo): void {
  p.fade = -1   // force a repaint so the new tier's glow is applied
  const nt = TextShape.getMutable(p.nameT)
  nt.text = info.name
  // Owner plates: star-framed title in the brighter owner gold (see OWNER_RANK).
  const isOwner = info.rank >= OWNER_RANK && info.title !== ''
  const title = isOwner ? `★ ${info.title.toUpperCase()} ★` : info.title.toUpperCase()
  const tt = TextShape.getMutable(p.titleT)
  tt.text = title
  tt.textColor = tierColorForRank(info.rank)

  // Y is divided by the band fraction because the stadium only occupies the
  // middle quarter of the texture; the rest is transparent padding.
  // Caps run wider than lowercase, so the title's contribution is padded —
  // measured from the RENDERED title, stars included, so the pill fits them.
  const chars = Math.max(info.name.length, Math.round(title.length * 1.15))
  Transform.getMutable(p.pill).scale = {
    x: PILL_PER_CHAR * chars + PILL_PAD,
    y: (info.title ? PILL_H : PILL_H * 0.6) / PILL_BAND,
    z: 1,
  }
}

/** Distance-compensated scale + range fade, per plate (each has its own owner). */
function applyDistance(p: Plate): void {
  const cam = Transform.getOrNull(engine.CameraEntity)?.position
  const pos = Transform.getOrNull(p.avatar)?.position
  if (!cam || !pos) return
  const dx = cam.x - pos.x, dy = cam.y - (pos.y + 2), dz = cam.z - pos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  // Stored, not applied: the per-frame animator combines it with the float and
  // any promotion pop so the two can't fight over the transform.
  p.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, dist / REF_DIST_M))

  const fade = dist <= FADE_START_M
    ? 1
    : Math.max(0, 1 - (dist - FADE_START_M) / (FADE_END_M - FADE_START_M))
  if (Math.abs(fade - p.fade) <= 0.03) return
  p.fade = fade

  paintPill(p, fade)
  const nt = TextShape.getMutable(p.nameT)
  nt.textColor    = Color4.create(1, 1, 1, fade)
  nt.outlineColor = Color4.create(0, 0, 0, fade)
  const tier = TextShape.get(p.titleT).textColor ?? Color4.White()
  TextShape.getMutable(p.titleT).textColor = Color4.create(tier.r, tier.g, tier.b, fade)
}

/**
 * Hides the explorer's own nametags across the club, so our plates replace them
 * rather than stacking under them.
 *
 * The volume must cover the WHOLE 16-parcel scene (64×64m), not just the club
 * interior: the modifier hides the tag OF each avatar that is itself inside the
 * volume, and the haul loop sends players to the dumpsters at x≈62 — outside
 * the old 40m box, where their real tag popped back under our plate ("nametags
 * sometimes visible", worst for haulers). Generous vertically too: the docs
 * warn the tag reappears if a player's head leaves the area.
 */
let hideArea: Entity | null = null

// While a round is live, clicking another avatar must not open the passport UI
// (bio/inventory popup) — mid-haul it steals the pointer and the whole screen.
// Passports come back in the lobby and celebration, where socialising is the
// point.
let passportsOff = false

function armNametagHideArea(): void {
  if (!hideArea) {
    hideArea = engine.addEntity()
    Transform.create(hideArea, { position: Vector3.create(32, 16, 32) })
  }
  AvatarModifierArea.createOrReplace(hideArea, {
    area:       Vector3.create(68, 48, 68),   // all 16 parcels + margin, both storeys
    modifiers:  passportsOff
      ? [AvatarModifierType.AMT_HIDE_NAMETAGS, AvatarModifierType.AMT_DISABLE_PASSPORTS]
      : [AvatarModifierType.AMT_HIDE_NAMETAGS],
    excludeIds: [],
  })
}

function initNametagHideArea(): void {
  armNametagHideArea()
  // Re-arm on our own re-entry: a mobile app suspend/resume can drop runtime
  // state without reloading the scene (same failure class the emote preload
  // re-warms for), and a dead modifier area = real nametags back for everyone.
  onLocalEnterScene(armNametagHideArea)

  engine.addSystem(() => {
    const off = gameState()?.phase === 'playing'
    if (off === passportsOff) return
    passportsOff = off
    armNametagHideArea()
  })
}

/**
 * Plate animation: a springy pop when a player is promoted, plus applying the
 * distance-derived scale. Writes the Transform ONLY when the value changes —
 * the old version also drove a 0.012m idle bob, which was invisible motion at
 * the cost of one dirty Transform per player every frame, forever.
 */
function animatePlates(dt: number): void {
  for (const [, p] of plates) {
    let scale = p.scale
    let popping = false

    if (p.popMs >= 0) {
      popping = true
      p.popMs += dt * 1000
      const t = Math.min(1, p.popMs / POP_MS)
      // Out-and-back: swells fast, settles slow.
      scale += POP_SCALE * Math.sin(t * Math.PI) * (1 - t * 0.35)
      if (t >= 1) p.popMs = -1
    }

    if (!popping && Math.abs(scale - p.appliedScale) < 0.001) continue
    const ct = Transform.getMutableOrNull(p.carrier)
    if (!ct) continue
    p.appliedScale = scale
    ct.scale    = { x: scale, y: scale, z: scale }
    ct.position = { x: 0, y: PLATE_Y, z: 0 }
  }
}

export function initRankBadgeSystem(): void {
  initNametagHideArea()
  engine.addSystem(animatePlates)

  room.onMessage('ranksUpdate', (data) => {
    try {
      const roster = JSON.parse(data.rosterJson) as Array<{ a: string; n: string; t: string; r: number; c?: number }>
      ranks.clear()
      for (const e of roster) {
        ranks.set(e.a.toLowerCase(), {
          name: e.n, title: e.t, rank: e.r,
          cleaning: e.c === undefined ? undefined : e.c === 1,
        })
      }
    } catch (e) {
      console.log('[BADGE] failed to parse ranksUpdate:', e)
    }
  })

  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < 0.4) return   // roster changes are rare; no need to scan per frame
    acc = 0

    // Reconcile plates against who is actually in the scene.
    const present = new Set<string>()
    for (const [avatar, data] of engine.getEntitiesWith(PlayerIdentityData)) {
      const key = data.address.toLowerCase()
      present.add(key)

      let plate = plates.get(key)
      if (!plate) {
        plate = buildPlate(data.address, avatar)
        plates.set(key, plate)
      }

      // No rank yet (broadcast in flight) → show the name alone rather than
      // leaving a player anonymous behind a hidden nametag.
      // PlayerIdentityData carries no display name, so the stand-in is a short
      // address — replaced the moment the roster broadcast lands.
      const info = ranks.get(key) ?? { name: `${data.address.slice(0, 6)}…`, title: '', rank: 0 }
      const contentKey = `${info.name}|${info.title}|${info.rank}`
      if (contentKey !== plate.key) {
        // A rank that went UP is a promotion — celebrate it on the plate, so
        // everyone nearby sees the moment, not just the promoted player.
        if (plate.rank >= 0 && info.rank > plate.rank) plate.popMs = 0
        plate.rank = info.rank
        plate.key  = contentKey
        renderPlate(plate, info)
      }
      applyDistance(plate)
    }

    for (const [key, plate] of plates) {
      if (present.has(key)) continue
      destroyPlate(plate)
      plates.delete(key)
    }
  })
}
