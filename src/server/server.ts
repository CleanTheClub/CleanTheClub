import { isServer } from '@dcl/sdk/network'
import { room } from '../shared/messages'

export function initServer() {
  console.log('[SERVER] started')
  // Server-side game logic goes here
  // Example: room.onMessage('playerAction', (data, context) => { ... })
}
