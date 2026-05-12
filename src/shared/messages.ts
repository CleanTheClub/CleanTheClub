import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  cleanItem:      Schemas.Map({ itemId: Schemas.String }),
  cleanRejected:  Schemas.Map({ itemId: Schemas.String }),
  adminReset:     Schemas.Map({ dummy: Schemas.Boolean }),  // client → server, admin only
  startNextRound: Schemas.Map({ dummy: Schemas.Boolean }),  // client → server, any player
}

export const room = registerMessages(Messages)
