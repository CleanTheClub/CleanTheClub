// Wall art — replaces the template's NFT frames with local club posters.
//
// The scene shipped with three core::NftShape displays (NFT_1..3) pointing at an
// Ethereum ERC721 contract. An NftShape fetches its image from the marketplace
// at runtime, and when that fetch fails the explorer renders an "Image Format
// Not Supported" placeholder — which is what showed on mobile while desktop
// quietly got away with it.
//
// Done in code rather than by editing main.composite: that file is managed by
// Creator Hub, and hand-editing component maps risks corrupting the scene for a
// purely visual swap. This removes the NftShape at runtime and paints the same
// frame with a local texture, so the fix is contained and trivially reversible.
// The NFT items can be deleted properly in Creator Hub whenever convenient.
//
// These frames are also the natural home for the "Cleaner of the Night" podium
// (top three cleaners on the club wall) — the third poster is a placeholder for
// exactly that.

import {
  engine, Entity, Name, NftShape, MeshRenderer, Material,
  MaterialTransparencyMode,
} from '@dcl/sdk/ecs'
import { Color3, Color4 } from '@dcl/sdk/math'

const WALL_ART: Record<string, string> = {
  NFT_1: 'assets/scene/UI/poster_staff1.png',
  NFT_2: 'assets/scene/UI/poster_staff2.png',
  NFT_3: 'assets/scene/UI/poster_staff3.png',
}

export function initWallArtSystem(): void {
  let swapped = 0
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const src = WALL_ART[Name.get(entity).value]
    if (!src) continue

    // Drop the remote NFT display before painting over it, or both would render.
    if (NftShape.getOrNull(entity)) NftShape.deleteFrom(entity)

    MeshRenderer.setPlane(entity as Entity)
    const tex = Material.Texture.Common({ src })
    Material.setPbrMaterial(entity as Entity, {
      texture:           tex,
      alphaTexture:      tex,
      // Emissive so the poster reads under the club's coloured lighting rather
      // than going muddy like an unlit surface would.
      emissiveTexture:   tex,
      emissiveColor:     Color3.White(),
      emissiveIntensity: 0.6,
      albedoColor:       Color4.White(),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      specularIntensity: 0,
      metallic:  0,
      roughness: 1,
    })
    swapped++
  }
  console.log(`[WALL ART] replaced ${swapped} NFT frames with local posters`)
}
