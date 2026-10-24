import { createRequire } from 'module'
import { afterEach, describe, expect, it } from 'vitest'
import MinecraftData from 'minecraft-data'
import { getMesherVersionTables } from '../lib/mesherMcDataSupply'

const require = createRequire(import.meta.url)
const loadShim = () => {
  delete require.cache[require.resolve('./mcDataWorkerShim.cjs')]
  return require('./mcDataWorkerShim.cjs') as (version: string) => any
}

/** What `meshersSendMcData` sends to the workers */
const supplyFor = (version: string) => {
  const full = MinecraftData(version)
  return {
    full,
    mcData: {
      version: JSON.parse(JSON.stringify(full.version)),
      ...getMesherVersionTables(full),
      blocks: full.blocksArray,
      biomes: full.biomesArray,
      blockCollisionShapes: full.blockCollisionShapes
    }
  }
}

describe('mesher worker minecraft-data shim', () => {
  afterEach(() => {
    delete (globalThis as any).mcData
  })

  it('returns null until data is supplied', () => {
    expect(loadShim()('1.20.4')).toBeNull()
  })

  it.each(['1.8.8', '1.16.5', '1.20.4', '1.21.8'])('behaves like minecraft-data for %s', version => {
    const { full, mcData } = supplyFor(version)
    ;(globalThis as any).mcData = mcData
    const shimmed = loadShim()(version)

    expect(shimmed.version.minecraftVersion).toBe(version)
    expect(shimmed.type).toBe('pc')
    expect(shimmed.blocksByName.stone.id).toBe(full.blocksByName.stone.id)
    expect(shimmed.blocksByStateId[full.blocksByName.stone.defaultState].name).toBe('stone')
    expect(shimmed.biomes[full.biomesArray[0].id].name).toBe(full.biomesArray[0].name)
    for (const feature of ['blockStateId', 'theFlattening', 'usesBlockStates', 'itemsAreNotBlocks', 'sendsClientTickEndPacket']) {
      expect(shimmed.supportFeature(feature)).toBe(full.supportFeature(feature as any))
    }
    for (const other of ['1.8', '1.12.2', '1.16.5', '1.21.1']) {
      expect(shimmed.isNewerOrEqualTo(other)).toBe(full.isNewerOrEqualTo(other))
      expect(shimmed.isOlderThan(other)).toBe(full.isOlderThan(other))
    }
    expect(shimmed.supportFeature('unknownFeature')).toBe(false)
  })

  it('works with a version that is not in anything bundled with the worker', () => {
    const { mcData } = supplyFor('1.21.8')
    const newest = mcData.protocolVersions[0]
    // a version from the future: only the main thread knows it
    const future = { ...mcData.version, minecraftVersion: '99.9', majorVersion: '99', dataVersion: newest.dataVersion + 1000, version: 9999 }
    ;(globalThis as any).mcData = {
      ...mcData,
      version: future,
      protocolVersions: [{ ...future }, ...mcData.protocolVersions],
      features: { ...mcData.features, someFutureFeature: true }
    }
    const shimmed = loadShim()('99.9')

    expect(shimmed).not.toBeNull()
    expect(shimmed.version.minecraftVersion).toBe('99.9')
    expect(shimmed.isNewerOrEqualTo('1.21.8')).toBe(true)
    expect(shimmed.isOlderThan('1.21.8')).toBe(false)
    expect(shimmed.supportFeature('someFutureFeature')).toBe(true)
    // the worker only knows the version it was supplied
    expect(loadShim()('1.21.8')).toBeNull()
  })

  it('picks up newly supplied data (worker reconfigure)', () => {
    ;(globalThis as any).mcData = supplyFor('1.16.5').mcData
    const shim = loadShim()
    expect(shim('1.16.5').version.minecraftVersion).toBe('1.16.5')
    ;(globalThis as any).mcData = supplyFor('1.20.4').mcData
    expect(shim('1.20.4').version.minecraftVersion).toBe('1.20.4')
    expect(shim('1.16.5')).toBeNull()
  })
})
