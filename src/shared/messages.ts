import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Define your client → server and server → client messages here
  // Example:
  // playerAction: Schemas.Map({ action: Schemas.String }),
  // stateUpdate: Schemas.Map({ value: Schemas.Int }),
}

export const room = registerMessages(Messages)
