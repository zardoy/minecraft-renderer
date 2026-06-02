import { describe, expect, it, vi } from 'vitest'
import blocksAtlases from 'mc-assets/dist/blocksAtlases.json'
import itemsAtlases from 'mc-assets/dist/itemsAtlases.json'
import blockstatesModels from 'mc-assets/dist/blockStatesModels.json'
import { AtlasParser } from 'mc-assets/dist/atlasParser'
import {
  getItemsDefinitionsStoreForRender,
  LoadedResourcesTransferrable,
  ResourcesManager,
} from './resourcesManager'

vi.mock('../three/documentRenderer', () => ({
  isWebWorker: true,
}))

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
      allReady: true,
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
      blocksAtlasJson: (new AtlasParser(blocksAtlases as any, '')).atlas.latest,
      itemsDefinitionsStore: { data: { latest: {} }, inclusive: false },
    })
    const store = getItemsDefinitionsStoreForRender(resources)
    expect(typeof store.get).toBe('function')
  })

  it('falls back to bundled items atlas when itemsAtlasJson is missing', () => {
    const resources = new LoadedResourcesTransferrable({
      version: '1.21.4',
      blockstatesModels,
      blocksAtlasJson: (new AtlasParser(blocksAtlases as any, '')).atlas.latest,
    })
    const manager = new ResourcesManager()
    manager.rebuildWorkerRenderers(resources)
    expect(resources.itemsRenderer).toBeDefined()
    expect(resources.itemsRenderer!.getItemTexture('item/missing_texture')).toBeDefined()
  })
})
