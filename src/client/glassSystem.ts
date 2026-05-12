import { discoverGlasses, GLASS_ID_PREFIX } from '../shared/glassDiscovery'
import { initCollectibleGroup } from './collectibleSystem'

export function initGlassSystem() {
  initCollectibleGroup({
    items:      discoverGlasses(),
    idPrefix:   GLASS_ID_PREFIX,
    toastKind:  'glasses',
  })
}
