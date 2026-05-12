import { setupUi } from '../ui'
import { initCleaningSystem } from '../cleaningSystem'
import { initSoundManager } from './soundManager'
import { initGlassSystem } from './glassSystem'

export function initClient() {
  console.log('[CLIENT] started')
  initSoundManager()
  setupUi()
  initCleaningSystem()
  initGlassSystem()
}
