import { EventEmitter } from 'events'
import TypedEmitter from 'typed-emitter'
import MinecraftData, { IndexedData } from 'minecraft-data'
import blocksAtlases from 'mc-assets/dist/blocksAtlases.json'
import itemsAtlases from 'mc-assets/dist/itemsAtlases.json'
import itemDefinitionsJson from 'mc-assets/dist/itemDefinitions.json'
import blocksAtlasLatest from 'mc-assets/dist/blocksAtlasLatest.png'
import blocksAtlasLegacy from 'mc-assets/dist/blocksAtlasLegacy.png'
import itemsAtlasLatest from 'mc-assets/dist/itemsAtlasLatest.png'
import itemsAtlasLegacy from 'mc-assets/dist/itemsAtlasLegacy.png'
import christmasPack from 'mc-assets/dist/textureReplacements/christmas'
import { AtlasParser, ItemsAtlasesOutputJson } from 'mc-assets/dist/atlasParser'
import worldBlockProvider, { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import { ItemsRenderer } from 'mc-assets/dist/itemsRenderer'
import { getLoadedItemDefinitionsStore } from 'mc-assets'

type ResourceManagerEvents = {
  assetsTexturesUpdated: () => void
  assetsInventoryStarted: () => void
  assetsInventoryReady: () => void
}

export class LoadedResourcesTransferrable {
  // todo transfer instead!
  readonly sourceItemDefinitionsJson: any = itemDefinitionsJson
  readonly itemsDefinitionsStore = getLoadedItemDefinitionsStore(this.sourceItemDefinitionsJson)

  allReady = false
  // Atlas parsers
  itemsAtlasImage!: ImageBitmap
  blocksAtlasImage!: ImageBitmap
  blocksAtlasJson!: ItemsAtlasesOutputJson
  // User data (specific to current resourcepack/version)
  customBlockStates?: Record<string, any>
  customModels?: Record<string, any>
  /** array where the index represents the custom model data value, and the element at that index is the model path to use */
  customItemModelNames: Record<string, string[]> = {}
  customTextures: {
    items?: { tileSize: number | undefined, textures: Record<string, HTMLImageElement> }
    blocks?: { tileSize: number | undefined, textures: Record<string, HTMLImageElement> }
    armor?: { tileSize: number | undefined, textures: Record<string, HTMLImageElement> }
  } = {}
  guiAtlas: { json: any, image: ImageBitmap } | null = null
  guiAtlasVersion = 0

  itemsRenderer: ItemsRenderer | undefined
  worldBlockProvider?: WorldBlockProvider
  blockstatesModels: any = null

  version!: string
  texturesVersion!: string
  mcData!: IndexedData

  constructor(data?: any) {
    if (data) {
      Object.assign(this, data)
      this.mcData = MinecraftData(this.version)
      // this.itemsRenderer = new ItemsRenderer(
      //   this.version,
      //   this.blockstatesModels,
      //   this.itemsAtlasParser,
      //   this.blocksAtlasParser
      // )
    }
  }

  prepareForTransfer() {
    const cloned: any = {}
    for (const key in this) {
      if (!Object.prototype.hasOwnProperty.call(this, key)) continue
      if (typeof this[key] === 'function') continue
      if (key === 'itemsRenderer' || key === 'worldBlockProvider' || key === 'mcData') {
        // Skip these fields
        continue
      }
      cloned[key] = this[key as keyof this]
    }

    cloned.customTextures = {}
    return cloned as LoadedResourcesTransferrable
  }

}

export interface ResourcesCurrentConfig {
  version: string
  texturesVersion?: string
  // noBlockstatesModels?: boolean
  noInventoryGui?: boolean
  includeOnlyBlocks?: string[]
}

export interface UpdateAssetsRequest {
  _?: false
}

export interface ResourcesManagerTransferred extends TypedEmitter<ResourceManagerEvents> {
  currentResources: LoadedResourcesTransferrable
}
export interface ResourcesManagerCommon extends TypedEmitter<ResourceManagerEvents> {
  currentResources: LoadedResourcesTransferrable | undefined
}

const STABLE_MODELS_VERSION = '1.21.4'
export class ResourcesManager extends (EventEmitter as new () => TypedEmitter<ResourceManagerEvents>) {
  static restorerName = 'ResourcesManager'

  static restoreTransferred(data: any, worker?: Worker) {
    const resourcesManager = new ResourcesManager()
    const upResources = (data) => {
      resourcesManager.currentResources = new LoadedResourcesTransferrable(data)
    }
    upResources(data.currentResources)
    if (worker) {
      worker.addEventListener('message', ({ data }) => {
        if (data.class === ResourcesManager.restorerName) {
          if (data.type === 'newResources') {
            console.log('[worker] got new resources')
            upResources(data.currentResources)
          }
          if (data.type === 'event') {
            resourcesManager.emit(data.eventName, ...data.args)
          }
        }
      })
    }
    return resourcesManager
  }

  prepareForTransfer(worker?: Worker) {
    if (worker) {
      // todo do it automatically
      const oldEmit = this.emit.bind(this) as any
      this.emit = ((eventName: keyof ResourceManagerEvents, ...args: any[]) => {
        oldEmit(eventName, ...args)
        worker.postMessage({
          class: ResourcesManager.restorerName,
          type: 'event',
          eventName,
          args,
        })
        // todo handle assetsInventoryReady
        if (eventName === 'assetsTexturesUpdated' || eventName === 'assetsInventoryReady') {
          worker.postMessage({
            class: ResourcesManager.restorerName,
            type: 'newResources',
            currentResources: this.currentResources?.prepareForTransfer(),
          })
        }
      }) as any
    }
    return {
      __restorer: ResourcesManager.restorerName,
      currentResources: this.currentResources?.prepareForTransfer(),
    }
  }

  // Source data (imported, not changing)
  sourceBlockStatesModels: any = null
  readonly sourceBlocksAtlases: any = blocksAtlases
  readonly sourceItemsAtlases: any = itemsAtlases

  currentResources: LoadedResourcesTransferrable | undefined
  itemsAtlasParser!: AtlasParser
  blocksAtlasParser!: AtlasParser
  currentConfig: ResourcesCurrentConfig | undefined
  abortController = new AbortController()
  _promiseAssetsReadyResolvers = Promise.withResolvers<void>()
  get promiseAssetsReady() {
    return this._promiseAssetsReadyResolvers.promise
  }

  async loadSourceData(version = this.currentConfig?.version) {
    if (!version) throw new Error('No version loaded')
    // TODO
    this.sourceBlockStatesModels ??= (await import('mc-assets/dist/blockStatesModels.json')).default
  }

  resetResources() {
    this.currentResources = new LoadedResourcesTransferrable()
  }

  async updateAssetsData(request: UpdateAssetsRequest, unstableSkipEvent = false) {
    if (!this.currentConfig) throw new Error('No config loaded')
    this._promiseAssetsReadyResolvers = Promise.withResolvers()
    const abortController = new AbortController()
    await this.loadSourceData(this.currentConfig.version)
    if (abortController.signal.aborted) return

    const resources = this.currentResources ?? new LoadedResourcesTransferrable()
    resources.version = this.currentConfig.version
    resources.texturesVersion = this.currentConfig.texturesVersion ?? resources.version

    // Load minecraft data
    resources.mcData = MinecraftData(resources.version)

    resources.blockstatesModels = {
      blockstates: {},
      models: {}
    }
    // todo-low resolve version
    resources.blockstatesModels.blockstates.latest = {
      ...this.sourceBlockStatesModels.blockstates.latest,
      ...resources.customBlockStates
    }

    resources.blockstatesModels.models.latest = {
      ...this.sourceBlockStatesModels.models.latest,
      ...resources.customModels
    }

    console.time('recreateAtlases')
    await Promise.all([
      this.recreateBlockAtlas(resources),
      this.recreateItemsAtlas(resources)
    ])
    console.timeEnd('recreateAtlases')

    if (abortController.signal.aborted) return

    if (resources.version && resources.blockstatesModels && this.itemsAtlasParser && this.blocksAtlasParser) {
      resources.itemsRenderer = new ItemsRenderer(
        resources.version,
        resources.blockstatesModels,
        this.itemsAtlasParser,
        this.blocksAtlasParser
      )
    }

    if (abortController.signal.aborted) return

    this.currentResources = resources
    resources.allReady = true
    if (!unstableSkipEvent) { // todo rework resourcepack optimization
      this.emit('assetsTexturesUpdated')
    }

    if (this.currentConfig.noInventoryGui) {
      this._promiseAssetsReadyResolvers.resolve()
    } else {
      this.emit('assetsInventoryStarted')
      void this.generateGuiTextures().then(() => {
        if (abortController.signal.aborted) return
        if (!unstableSkipEvent) {
          this.emit('assetsInventoryReady')
        }
        this._promiseAssetsReadyResolvers.resolve()
      })
    }
  }

  async recreateBlockAtlas(resources: LoadedResourcesTransferrable = this.currentResources!) {
    const blockTexturesChanges = {} as Record<string, string>
    const date = new Date()
    if ((date.getMonth() === 11 && date.getDate() >= 24) || (date.getMonth() === 0 && date.getDate() <= 6)) {
      Object.assign(blockTexturesChanges, christmasPack)
    }

    const blocksAssetsParser = new AtlasParser(this.sourceBlocksAtlases, blocksAtlasLatest, blocksAtlasLegacy)

    const customBlockTextures = Object.keys(resources.customTextures.blocks?.textures ?? {})
    console.time('createBlocksAtlas')
    const { atlas: blocksAtlas, canvas: blocksCanvas } = await blocksAssetsParser.makeNewAtlas(
      resources.texturesVersion,
      (textureName) => {
        if (this.currentConfig!.includeOnlyBlocks && !this.currentConfig!.includeOnlyBlocks.includes(textureName)) return false
        const texture = resources.customTextures.blocks?.textures[textureName]
        return blockTexturesChanges[textureName] ?? texture
      },
      undefined,
      undefined,
      customBlockTextures,
      {
        needHorizontalIndexes: !!this.currentConfig!.includeOnlyBlocks,
      }
    )
    console.timeEnd('createBlocksAtlas')

    this.blocksAtlasParser = new AtlasParser({ latest: blocksAtlas }, blocksCanvas.toDataURL())
    resources.blocksAtlasImage = await createImageBitmap(blocksCanvas)
    resources.blocksAtlasJson = this.blocksAtlasParser.atlas.latest

    resources.worldBlockProvider = worldBlockProvider(
      resources.blockstatesModels,
      this.blocksAtlasParser.atlas,
      STABLE_MODELS_VERSION
    )
  }

  async recreateItemsAtlas(resources: LoadedResourcesTransferrable = this.currentResources!) {
    const itemsAssetsParser = new AtlasParser(this.sourceItemsAtlases, itemsAtlasLatest, itemsAtlasLegacy)
    const customItemTextures = Object.keys(resources.customTextures.items?.textures ?? {})
    const { atlas: itemsAtlas, canvas: itemsCanvas } = await itemsAssetsParser.makeNewAtlas(
      resources.texturesVersion,
      (textureName) => {
        const texture = resources.customTextures.items?.textures[textureName]
        if (!texture) return
        return texture
      },
      resources.customTextures.items?.tileSize,
      undefined,
      customItemTextures
    )

    this.itemsAtlasParser = new AtlasParser({ latest: itemsAtlas }, itemsCanvas.toDataURL())
    resources.itemsAtlasImage = await createImageBitmap(itemsCanvas)
  }

  async generateGuiTextures() {
    // todo-low handled now in the client
  }

  async downloadDebugAtlas(isItems = false) {
    const resources = this.currentResources
    if (!resources) throw new Error('No resources loaded')
    const atlasParser = (isItems ? this.itemsAtlasParser : this.blocksAtlasParser)!
    const dataUrl = await atlasParser.createDebugImage(true)
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `atlas-debug-${isItems ? 'items' : 'blocks'}.png`
    a.click()
  }

  destroy() {
    this.abortController.abort()
    this.currentResources = undefined
    this.abortController = new AbortController()
  }
}
