import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  cleanItem:     Schemas.Map({ itemId: Schemas.String }),
  cleanRejected: Schemas.Map({ itemId: Schemas.String }),
}

export const room = registerMessages(Messages)
