import { describe, expect, it, vi } from 'vitest'
import blocksAtlases from 'mc-assets/dist/blocksAtlases.json'
import itemsAtlases from 'mc-assets/dist/itemsAtlases.json'
import blockstatesModels from 'mc-assets/dist/blockStatesModels.json'
import { AtlasParser } from 'mc-assets/dist/atlasParser'
import { publishGuiAtlas } from '../lib/guiAtlasGeneration'
import { getItemsDefinitionsStoreForRender, LoadedResourcesTransferrable, ResourcesManager } from './resourcesManager'

vi.mock('../three/documentRenderer', () => ({
  isWebWorker: true
}))

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('ResourcesManager.rebuildWorkerRenderers', () => {
  it('creates ItemsRenderer with working modelsStore.get in worker context', () => {
    const blocksAtlasParser = new AtlasParser(blocksAtlases as any, '')
    const itemsAtlasParser = new AtlasParser(itemsAtlases as any, '')
    const resources = new LoadedResourcesTransferrable({
      version: '1.21.4',
      texturesVersion: '1.21.4',
      blockstatesModels,
      blocksAtlasJson: blocksAtlasParser.atlas.latest,
      itemsAtlasJson: itemsAtlasParser.atlas.latest,
      allReady: true
    })

    const manager = new ResourcesManager()
    manager.rebuildWorkerRenderers(resources)

    expect(resources.itemsRenderer).toBeDefined()
    expect(resources.worldBlockProvider).toBeDefined()
    const tex = resources.itemsRenderer!.getItemTexture('item/missing_texture')
    expect(tex).toBeDefined()
  })

  it('getItemsDefinitionsStoreForRender returns store with .get in worker', () => {
    const resources = new LoadedResourcesTransferrable({
      version: '1.21.4',
      blockstatesModels,
      blocksAtlasJson: new AtlasParser(blocksAtlases as any, '').atlas.latest,
      itemsDefinitionsStore: { data: { latest: {} }, inclusive: false }
    })
    const store = getItemsDefinitionsStoreForRender(resources)
    expect(typeof store.get).toBe('function')
  })

  it('falls back to bundled items atlas when itemsAtlasJson is missing', () => {
    const resources = new LoadedResourcesTransferrable({
      version: '1.21.4',
      blockstatesModels,
      blocksAtlasJson: new AtlasParser(blocksAtlases as any, '').atlas.latest
    })
    const manager = new ResourcesManager()
    manager.rebuildWorkerRenderers(resources)
    expect(resources.itemsRenderer).toBeDefined()
    expect(resources.itemsRenderer!.getItemTexture('item/missing_texture')).toBeDefined()
  })
})

describe('ResourcesManager.updateAssetsData generation ownership', () => {
  it('invalidates stale atlas work before it can start GUI generation on the next update', async () => {
    const manager = new ResourcesManager()
    manager.currentConfig = { version: '1.21.4' }
    manager.sourceBlockStatesModels = blockstatesModels
    const currentResources = new LoadedResourcesTransferrable({ version: '1.21.4' })
    manager.currentResources = currentResources
    manager.itemsAtlasParser = undefined as any
    manager.blocksAtlasParser = undefined as any
    vi.spyOn(manager, 'loadSourceData').mockResolvedValue(undefined)

    const firstAtlasStarted = deferred()
    const secondAtlasStarted = deferred()
    const atlasGates = [deferred(), deferred()]
    let atlasCallCount = 0
    const recreateAtlas = vi.fn(async () => {
      const updateIndex = Math.floor(atlasCallCount++ / 2)
      if (updateIndex === 0) firstAtlasStarted.resolve()
      else if (updateIndex === 1) secondAtlasStarted.resolve()
      await atlasGates[updateIndex].promise
    })
    vi.spyOn(manager, 'recreateBlockAtlas').mockImplementation(recreateAtlas)
    vi.spyOn(manager, 'recreateItemsAtlas').mockImplementation(recreateAtlas)
    const generateGuiTextures = vi.spyOn(manager, 'generateGuiTextures').mockResolvedValue(undefined)

    const firstUpdate = manager.updateAssetsData({})
    await firstAtlasStarted.promise
    expect(manager.resourcesGeneration).toBe(1)
    const firstGeneration = manager.resourcesGeneration

    const secondUpdate = manager.updateAssetsData({})
    await secondAtlasStarted.promise
    expect(manager.resourcesGeneration).toBe(2)
    expect(manager.currentResources).toBe(currentResources)

    const published = publishGuiAtlas(manager, currentResources, firstGeneration, {
      json: {},
      image: {} as ImageBitmap
    })
    expect(published).toBe(false)

    atlasGates[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(generateGuiTextures).not.toHaveBeenCalled()

    atlasGates[1].resolve()
    await Promise.all([firstUpdate, secondUpdate])
    expect(generateGuiTextures).toHaveBeenCalledOnce()
  })
})
