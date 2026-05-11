import { engine, Entity, MeshRenderer, MeshCollider, ColliderLayer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { CLUTTER_DEFS } from './shared/config'
import { initInteractionManager } from './client/InteractionManager'

const visualEntities = new Map<string, Entity>()

export function setVisible(entity: Entity, visible: boolean) {
  VisibilityComponent.createOrReplace(entity, { visible })
}

export function initCleaningSystem() {
  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    MeshRenderer.setBox(entity)
    MeshCollider.setBox(entity, ColliderLayer.CL_POINTER)
    Transform.create(entity, {
      position: Vector3.create(def.position.x, def.position.y, def.position.z),
      scale: def.scale
        ? Vector3.create(def.scale.x, def.scale.y, def.scale.z)
        : Vector3.One(),
    })
    visualEntities.set(def.id, entity)
  }

  initInteractionManager(visualEntities, setVisible)
}
