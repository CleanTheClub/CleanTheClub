import { setupUi } from '../ui'
import { initCleaningSystem } from '../cleaningSystem'

export function initClient() {
  console.log('[CLIENT] started')
  setupUi()
  initCleaningSystem()
}
