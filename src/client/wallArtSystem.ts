// Wall of Fame — "TOP CLEANERS" on the west wall: a title plus a row of six
// profile portraits of the all-time top cleaners (playtest: one giant 4m face
// read as odd; smaller pics + more players + explainer text is the ask).
//
// The wall replaces the template's three core::NftShape displays (NFT_1..3,
// since deleted in Creator Hub — a startup sweep still strips any that
// reappear). Slot #1 is at the viewer's left, reading order #1..#6.
//
// Portraits come from the catalyst's pre-rendered profile snapshots:
//   lambdas/profiles/{address} → avatar.snapshots.face256 (256×256 face PNG,
//   transparent background). See mediaSafeUrl for how the URL is kept inside
//   scene.json's allowedMediaHostnames whatever host the lambda answers with.
//
// Slots without a qualifying player stay hidden; a slot whose portrait hasn't
// arrived (fetch in flight, or a guest with no catalyst profile) shows a dark
// placeholder tile under its caption, so the ranking is never wrong even when
// a face is missing.

import {
  engine, Entity, Name, NftShape, MeshRenderer, Material,
  MaterialTransparencyMode, TextShape, Transform, VisibilityComponent,
  executeTask,
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'

export type PodiumEntry = { address: string; displayName: string; total: number }

// ── Wall layout ───────────────────────────────────────────────────────────────
// Same west-wall placement the NFT displays were authored at (x pushed off
// 2.799 so the flat planes clear the wall mesh; the NftShape's physical frame
// model used to provide that depth). Yaw −90° faces +X into the room, which
// puts TextShape's readable face on local −Z.
const WALL_ROTATION = Quaternion.create(0, 0.707099974155426, 0, -0.707099974155426)
const WALL_X       = 2.95
const WALL_CENTRE_Z = 15

const TITLE_TEXT = 'TOP CLEANERS'
const TITLE_Y    = 11.0
const TITLE_FONT = 4

const SLOT_COUNT = 6
const SLOT_SIZE  = 1.5    // portrait plane, metres
const SLOT_PITCH = 1.8    // centre-to-centre; 6 slots span the old frames' footprint
const SLOT_Y     = 9.4
// Viewer facing the wall has world −Z on their left, so ascending z reads
// left → right: #1 first.
const SLOT_Z = (slot: number): number =>
  WALL_CENTRE_Z + (slot - (SLOT_COUNT - 1) / 2) * SLOT_PITCH

// Caption, in the portrait's LOCAL units (parent scale ×1.5).
const CAPTION_FONT = 0.35
const CAPTION_Y    = -0.63
const CAPTION_Z    = -0.03
const CAPTION_MAX_CHARS = 12

// Gold / silver / bronze for the podium places, white for 4–6.
const SLOT_COLORS: Color4[] = [
  Color4.create(1.00, 0.82, 0.30, 1),
  Color4.create(0.86, 0.90, 0.95, 1),
  Color4.create(0.91, 0.64, 0.36, 1),
  Color4.White(), Color4.White(), Color4.White(),
]

const profileUrl = (address: string) => `https://peer.decentraland.org/lambdas/profiles/${address}`
const contentUrl = (hash: string) => `https://peer.decentraland.org/content/contents/${hash}`

// Hosts in scene.json's allowedMediaHostnames — the renderer refuses external
// textures from anywhere else. Modern profiles snapshot to the profile-images
// CDN (…/entities/<id>/face.png — an entity id, NOT a content-file hash, so it
// cannot be re-rooted onto a content server); older ones to a catalyst's
// …/contents/<hash>, which CAN be re-rooted if it's on an unlisted host.
const MEDIA_HOSTS = ['peer.decentraland.org', 'profile-images.decentraland.org']

function mediaSafeUrl(raw: string): string | null {
  const host = raw.match(/^https:\/\/([^/]+)\//)?.[1]
  if (host && MEDIA_HOSTS.includes(host)) return raw
  const hash = raw.match(/\/contents\/([A-Za-z0-9]+)$/)?.[1]
  return hash ? contentUrl(hash) : null
}

type Slot = {
  portrait: Entity
  caption:  Entity
  painted:  string   // address whose face is on the tile ('' = placeholder)
  fetching: string   // address with a profile fetch in flight ('' = none)
}
const slots: Slot[] = []

// address → face URL, shared with the leaderboard rows so a player appearing
// on several surfaces is looked up once. '' caches a known-missing profile
// (guests never grow one mid-session); transient errors are NOT cached, so
// they retry on the next request.
const faceCache = new Map<string, string>()

/** Cached face-snapshot URL for an address, or null (no profile / lookup failed). */
export async function faceUrlFor(address: string): Promise<string | null> {
  const hit = faceCache.get(address)
  if (hit !== undefined) return hit || null
  let url: string | null = null
  try {
    url = await fetchFaceUrl(address)
  } catch (e) {
    console.log(`[WALL OF FAME] profile fetch failed for ${address}:`, e)
    return null
  }
  faceCache.set(address, url ?? '')
  return url
}

export function paintFace(entity: Entity, src: string): void {
  const tex = Material.Texture.Common({ src })
  Material.setPbrMaterial(entity, {
    texture:           tex,
    alphaTexture:      tex,
    // Emissive so the portrait reads under the club's coloured lighting
    // rather than going muddy like an unlit surface would.
    emissiveTexture:   tex,
    emissiveColor:     Color3.White(),
    emissiveIntensity: 0.6,
    albedoColor:       Color4.White(),
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })
}

/** Dark tile shown while a portrait is missing (fetch pending, or a guest). */
export function paintPlaceholder(entity: Entity): void {
  Material.setPbrMaterial(entity, {
    albedoColor:      Color4.create(0.04, 0.04, 0.08, 0.85),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })
}

function setVisible(s: Slot, visible: boolean): void {
  // VisibilityComponent doesn't cascade — the caption needs its own.
  VisibilityComponent.createOrReplace(s.portrait, { visible })
  VisibilityComponent.createOrReplace(s.caption,  { visible })
}

function setCaption(s: Slot, slot: number, entry: PodiumEntry): void {
  let name = entry.displayName.toUpperCase()
  if (name.length > CAPTION_MAX_CHARS) name = name.slice(0, CAPTION_MAX_CHARS - 1) + '…'
  const ts = TextShape.getMutable(s.caption)
  ts.text      = `#${slot + 1}  ${name}`
  ts.textColor = SLOT_COLORS[slot]
}

/** Fetch the pre-rendered face snapshot for an address, or null (e.g. guests). */
async function fetchFaceUrl(address: string): Promise<string | null> {
  const res = await fetch(profileUrl(address))
  if (!res.ok) {
    console.log(`[WALL OF FAME] profile lookup ${res.status} for ${address}`)
    return null
  }
  const json = (await res.json()) as {
    avatars?: Array<{ avatar?: { snapshots?: { face256?: string; face?: string } } }>
  }
  const snap = json.avatars?.[0]?.avatar?.snapshots
  const raw  = snap?.face256 ?? snap?.face
  if (!raw) {
    console.log(`[WALL OF FAME] no snapshot in profile for ${address} (guest?)`)
    return null
  }
  const safe = mediaSafeUrl(raw)
  console.log(`[WALL OF FAME] ${address} snapshot: ${raw} → ${safe ?? 'REJECTED (host not in allowlist)'}`)
  return safe
}

// Log the podium only when it changes — broadcasts fire on every score tick.
let lastPodiumKey = '\0'

/**
 * Called with the podium from every leaderboardUpdate. Captions always follow
 * the broadcast; portraits are fetched once per address change. A failed fetch
 * leaves the placeholder up with `painted` still '', so the next broadcast
 * retries naturally — no timer, and a guest with no profile just costs one
 * refetch per (debounced) update.
 */
export function updateWallOfFame(podium: PodiumEntry[]): void {
  const key = podium.map((e) => e.address).join(',')
  if (key !== lastPodiumKey) {
    lastPodiumKey = key
    console.log(`[WALL OF FAME] podium: ${podium.map((e) => e.displayName).join(', ') || '(empty — no leaderboard data)'}`)
  }

  for (let slot = 0; slot < slots.length; slot++) {
    const s = slots[slot]
    const entry = podium[slot]

    if (!entry) {
      if (s.painted !== '') { s.painted = ''; paintPlaceholder(s.portrait) }
      setVisible(s, false)
      continue
    }

    setVisible(s, true)
    setCaption(s, slot, entry)
    if (s.painted === entry.address || s.fetching === entry.address) continue

    // Blank the tile the moment the occupant changes, so an old face never
    // sits under the new name while the fetch is in flight.
    if (s.painted !== '') { s.painted = ''; paintPlaceholder(s.portrait) }

    s.fetching = entry.address
    executeTask(async () => {
      const faceUrl = await faceUrlFor(entry.address)
      if (s.fetching === entry.address) s.fetching = ''
      // The podium may have changed while the fetch was in flight.
      if (!faceUrl || s.painted === entry.address) return
      s.painted = entry.address
      paintFace(s.portrait, faceUrl)
    })
  }
}

export function initWallArtSystem(): void {
  const title = engine.addEntity()
  Transform.create(title, {
    position: Vector3.create(WALL_X, TITLE_Y, WALL_CENTRE_Z),
    rotation: WALL_ROTATION,
  })
  TextShape.create(title, {
    text: TITLE_TEXT, fontSize: TITLE_FONT,
    textColor: SLOT_COLORS[0],
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const portrait = engine.addEntity()
    Transform.create(portrait, {
      position: Vector3.create(WALL_X, SLOT_Y, SLOT_Z(slot)),
      rotation: WALL_ROTATION,
      scale:    Vector3.create(SLOT_SIZE, SLOT_SIZE, SLOT_SIZE),
    })
    MeshRenderer.setPlane(portrait)
    paintPlaceholder(portrait)

    const caption = engine.addEntity()
    Transform.create(caption, {
      parent: portrait,
      position: { x: 0, y: CAPTION_Y, z: CAPTION_Z },
    })
    TextShape.create(caption, {
      text: '', fontSize: CAPTION_FONT, textColor: SLOT_COLORS[slot],
      outlineColor: Color4.Black(), outlineWidth: 0.12,
    })

    const s: Slot = { portrait, caption, painted: '', fetching: '' }
    setVisible(s, false)   // hidden until the podium fills the slot
    slots.push(s)
  }

  // Strip any NFT displays still authored in the composite (harmless no-op
  // now the NFT_1..3 items are deleted in Creator Hub).
  let stripped = 0
  for (const [entity] of engine.getEntitiesWith(Name, NftShape)) {
    if (!Name.get(entity).value.startsWith('NFT')) continue
    NftShape.deleteFrom(entity)
    stripped++
  }
  console.log(`[WALL OF FAME] title + ${SLOT_COUNT} slots armed (${stripped} authored NftShapes stripped)`)
}
