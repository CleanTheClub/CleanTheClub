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

// Whole wall raised +0.75m (KJ, 2026-08-16 screenshot): with the CLUB OWNERS
// row added below, the owners' captions sat right ON the upper-floor surface.
// All four Y constants moved together so the sections keep their spacing.
const TITLE_TEXT = 'TOP CLEANERS'
const TITLE_Y    = 11.75
const TITLE_FONT = 4

const SLOT_COUNT = 6
const SLOT_SIZE  = 1.5    // portrait plane, metres
const SLOT_PITCH = 1.8    // centre-to-centre; 6 slots span the old frames' footprint
const SLOT_Y     = 10.15
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
  if (!safe) return null

  // PROBE before painting (feedback 2026-08-15: "some pfps showing as white
  // squares"). The renderer paints a plane WHITE when its texture fetch fails
  // and gives the scene no failure callback — so a snapshot URL that 404s
  // (a re-rooted content hash the peer never synced, or a stale
  // profile-images entity) skipped the placeholder and rendered as a blank
  // tile. One small GET decides it up front: bad snapshot → null → the dark
  // placeholder stays, which is the designed missing-face presentation.
  // A 404 returns null and gets negative-cached by faceUrlFor (that snapshot
  // is not appearing mid-session); a network error THROWS so faceUrlFor's
  // catch skips caching and the next broadcast retries.
  const probe = await fetch(safe)
  if (!probe.ok) {
    console.log(`[WALL OF FAME] snapshot fetch ${probe.status} for ${address} — keeping placeholder`)
    return null
  }
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

// ── CLUB OWNERS roll of honor ─────────────────────────────────────────────────
// Below the TOP CLEANERS row: everyone who has reached the ladder's last rung,
// founding owner first (server-ordered by ownerSinceMs). Smaller than the
// cleaners' portraits — it's a plaque, not a scoreboard — and the whole section
// stays hidden until the club has its first owner, so the wall never advertises
// an empty honor. Y verified in-world 2026-08-16: the first blind placement put
// the captions on the upper-floor surface; the +0.75m wall shift fixed it.
const OWNER_SLOT_COUNT   = 4
const OWNER_SLOT_SIZE    = 0.8
const OWNER_SLOT_PITCH   = 1.05
const OWNER_TITLE_TEXT   = 'CLUB OWNERS'
const OWNER_TITLE_Y      = 9.17
const OWNER_TITLE_FONT   = 1.6
const OWNER_SLOT_Y       = 8.53
const OWNER_CAPTION_FONT = 0.42   // local units (parent scale 0.8)
const OWNER_GOLD         = Color4.create(1, 0.85, 0.35, 1)

type OwnerEntry = { address: string; displayName: string }
let ownerTitleEnt: Entity | null = null
const ownerSlots: Slot[] = []
let lastOwnersKey = ' '

/** Slot centres re-pack around the wall centre for however many owners exist,
 *  so one owner hangs centred rather than stranded at the left edge. */
const ownerSlotZ = (slot: number, count: number): number =>
  WALL_CENTRE_Z + (slot - (count - 1) / 2) * OWNER_SLOT_PITCH

function buildOwnersWall(): void {
  ownerTitleEnt = engine.addEntity()
  Transform.create(ownerTitleEnt, {
    position: Vector3.create(WALL_X, OWNER_TITLE_Y, WALL_CENTRE_Z),
    rotation: WALL_ROTATION,
  })
  TextShape.create(ownerTitleEnt, {
    text: OWNER_TITLE_TEXT, fontSize: OWNER_TITLE_FONT,
    textColor: OWNER_GOLD,
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  for (let slot = 0; slot < OWNER_SLOT_COUNT; slot++) {
    const portrait = engine.addEntity()
    Transform.create(portrait, {
      position: Vector3.create(WALL_X, OWNER_SLOT_Y, ownerSlotZ(slot, OWNER_SLOT_COUNT)),
      rotation: WALL_ROTATION,
      scale:    Vector3.create(OWNER_SLOT_SIZE, OWNER_SLOT_SIZE, OWNER_SLOT_SIZE),
    })
    MeshRenderer.setPlane(portrait)
    paintPlaceholder(portrait)

    const caption = engine.addEntity()
    Transform.create(caption, {
      parent: portrait,
      position: { x: 0, y: CAPTION_Y, z: CAPTION_Z },
    })
    TextShape.create(caption, {
      text: '', fontSize: OWNER_CAPTION_FONT, textColor: OWNER_GOLD,
      outlineColor: Color4.Black(), outlineWidth: 0.12,
    })

    const s: Slot = { portrait, caption, painted: '', fetching: '' }
    setVisible(s, false)
    ownerSlots.push(s)
  }
  console.log(`[WALL OF FAME] CLUB OWNERS plaque armed (${OWNER_SLOT_COUNT} slots)`)
}

/**
 * Called with the owners list from every leaderboardUpdate (same cadence as the
 * podium). Entities are built lazily on the FIRST non-empty list — most
 * sessions before anyone tops the ladder never pay for the plaque at all.
 */
export function updateOwnersWall(owners: OwnerEntry[]): void {
  const key = owners.map((o) => o.address).join(',')
  if (key === lastOwnersKey) return
  lastOwnersKey = key
  if (ownerTitleEnt === null) {
    if (owners.length === 0) return
    buildOwnersWall()
    console.log(`[WALL OF FAME] owners: ${owners.map((o) => o.displayName).join(', ')}`)
  }
  if (ownerTitleEnt) {
    VisibilityComponent.createOrReplace(ownerTitleEnt, { visible: owners.length > 0 })
  }

  const shown = Math.min(owners.length, OWNER_SLOT_COUNT)
  for (let slot = 0; slot < OWNER_SLOT_COUNT; slot++) {
    const s = ownerSlots[slot]
    const entry = owners[slot]
    if (!entry) {
      if (s.painted !== '') { s.painted = ''; paintPlaceholder(s.portrait) }
      setVisible(s, false)
      continue
    }
    setVisible(s, true)
    Transform.getMutable(s.portrait).position =
      Vector3.create(WALL_X, OWNER_SLOT_Y, ownerSlotZ(slot, shown))

    let name = entry.displayName.toUpperCase()
    if (name.length > CAPTION_MAX_CHARS) name = name.slice(0, CAPTION_MAX_CHARS - 1) + '…'
    const ts = TextShape.getMutable(s.caption)
    // The star marks the FOUNDING owner — the roll's first entry by server order.
    ts.text = slot === 0 ? `★ ${name}` : name
    ts.textColor = OWNER_GOLD

    if (s.painted === entry.address || s.fetching === entry.address) continue
    if (s.painted !== '') { s.painted = ''; paintPlaceholder(s.portrait) }
    s.fetching = entry.address
    executeTask(async () => {
      const faceUrl = await faceUrlFor(entry.address)
      if (s.fetching === entry.address) s.fetching = ''
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
