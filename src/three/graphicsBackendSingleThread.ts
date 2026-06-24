/**
 * Single-Thread Graphics Backend - Main thread Three.js implementation.
 *
 * This is the standard graphics backend that runs entirely on the main thread.
 * It provides direct access to the Three.js renderer and world renderer.
 */

import type { GraphicsBackendLoader, GraphicsInitOptions } from '../graphicsBackend'
import { createGraphicsBackendBase } from './graphicsBackendBase'

/**
 * Creates a single-thread graphics backend.
 */
const createGraphicsBackendSingleThread: GraphicsBackendLoader = (initOptions: GraphicsInitOptions) => {
  const { main } = createGraphicsBackendBase()
  main.init(initOptions)
  return main.backend
}

createGraphicsBackendSingleThread.id = 'threejs'
createGraphicsBackendSingleThread.displayName = 'three.js Blocking'
createGraphicsBackendSingleThread.description = 'Simple, old and stable main thread graphics backend providing balanced performance on top of WebGL2.'

export default createGraphicsBackendSingleThread
export { createGraphicsBackendSingleThread }
