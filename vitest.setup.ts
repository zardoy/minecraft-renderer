/**
 * Vitest: `shaderCubeBridge` reads tints from globalThis.loadedData.
 */
import path from 'node:path'
import { createRequire } from 'node:module'

const setupRequire = createRequire(import.meta.url)
const pkgRoot = path.dirname(setupRequire.resolve('minecraft-data/package.json'))
const tints = setupRequire(path.join(pkgRoot, 'minecraft-data', 'data', 'pc', '1.16.2', 'tints.json'))

;(globalThis as any).loadedData = { tints }
