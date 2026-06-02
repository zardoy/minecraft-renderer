/* eslint-disable guard-for-in */
import { EventEmitter } from 'events'
import { Vec3 } from 'vec3'
import TypedEmitter from 'typed-emitter'
import { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import { subscribeKey } from 'valtio/utils'
import { proxy, subscribe } from 'valtio'
import type { ResourcesManagerTransferred } from '../resourcesManager/resourcesManager'
import { dynamicMcDataFiles } from './buildSharedConfig.mjs'
import { DisplayWorldOptions, GraphicsInitOptions, RendererReactiveState, SoundSystem } from '../graphicsBackend/types'
import { HighestBlockInfo, CustomBlockModels, BlockStateModelInfo, getBlockAssetsCacheKey, MesherConfig, MesherMainEvent, SECTION_HEIGHT } from '../mesher-shared/shared'
import { chunkPos } from './simpleUtils'
import { addNewStat, MC_RENDERER_DEBUG_OVERLAY_CLASS, removeAllStats, updatePanesVisibility, updateStatText } from './ui/newStats'
import { getPlayerStateUtils } from '../graphicsBackend/playerState'
// TODO: Fix PlayerStateRenderer and PlayerStateUtils imports
type PlayerStateUtils = ReturnType<typeof getPlayerStateUtils>
import { MesherLogReader } from './mesherlogReader'
import { setSkinsConfig } from './utils/skins'
import { calculateSkyLightSimple } from './skyLight'
import { WorldViewWorker } from '../worldView'
import { generateSpiralMatrix } from './spiral'
import { PlayerStateReactive } from '../playerState/playerState'
import { IndexedData } from 'minecraft-data'
import { WorldRendererConfig } from '../graphicsBackend/config'
import { markChunkLoaded, removeRendererHeightmap, setRendererField, setRendererHeightmap } from './rendererStateBridge'

function mod(x, n) {
  return ((x % n) + n) % n
}

export abstract class WorldRendererCommon<WorkerSend = any, WorkerReceive = any> {
  worldReadyResolvers = Promise.withResolvers<void>()
  worldReadyPromise = this.worldReadyResolvers.promise
  timeOfTheDay = 0
  worldSizeParams = { minY: 0, worldHeight: 256 }
  reactiveDebugParams = proxy({
    stopRendering: false,
    chunksRenderAboveOverride: undefined as number | undefined,
    chunksRenderAboveEnabled: false,
    chunksRenderBelowOverride: undefined as number | undefined,
    chunksRenderBelowEnabled: false,
    chunksRenderDistanceOverride: undefined as number | undefined,
    chunksRenderDistanceEnabled: false,
    disableEntities: false,
    // disableParticles: false
  })

  active = false

  // #region CHUNK & SECTIONS TRACKING
  loadedChunks = {} as Record<string, boolean> // data is added for these chunks and they might be still processing

  finishedChunks = {} as Record<string, boolean> // these chunks are fully loaded into the world (scene)

  finishedSections = {} as Record<string, boolean> // these sections are fully loaded into the world (scene)

  // loading sections (chunks)
  sectionsWaiting = new Map<string, number>()

  queuedChunks = new Set<string>()
  queuedFunctions = [] as Array<() => void>
  // #endregion

  renderUpdateEmitter = new EventEmitter() as unknown as TypedEmitter<{
    dirty(pos: Vec3, value: boolean): void
    update(/* pos: Vec3, value: boolean */): void
    chunkFinished(key: string): void
    heightmap(key: string, heightmap: Int16Array): void
  }>
  customTexturesDataUrl = undefined as string | undefined
  workers: any[] = []
  viewerChunkPosition?: Vec3
  // Last viewer chunk-grid coords for which `onViewerChunkPositionChanged`
  // fired — throttles the hook to chunk-grid changes.
  private lastViewerChunkGridX?: number
  private lastViewerChunkGridZ?: number
  lastCamUpdate = 0
  droppedFpsPercentage = 0
  initialChunkLoadWasStartedIn: number | undefined
  initialChunksLoad = true
  enableChunksLoadDelay = false
  texturesVersion?: string
  viewDistance = -1
  onRenderDistanceChanged?: (viewDistance: number) => void
  chunksLength = 0
  allChunksFinished = false
  messageQueue: any[] = []
  isProcessingQueue = false
  ONMESSAGE_TIME_LIMIT = 30 // ms

  handleResize = () => { }
  highestBlocksByChunks = new Map<string, { [chunkKey: string]: HighestBlockInfo }>()
  blockEntities = {}

  workersProcessAverageTime = 0
  workersProcessAverageTimeCount = 0
  maxWorkersProcessTime = 0
  workersPreAverageTime = 0
  workersWasmAverageTime = 0
  workersPostAverageTime = 0
  workersPhaseSampleCount = 0
  // Pre-stage substage averages (column-mode perf instrumentation).
  workersPreTargetConvertAverageTime = 0
  workersPreNeighborConvertAverageTime = 0
  workersPreNeighborCountAverage = 0
  workersPreTypedArrayBuildAverageTime = 0
  workersPreOtherAverageTime = 0
  // Cumulative cache hit/miss counters (column-mode conversion cache).
  workersPreCacheHitsTotal = 0
  workersPreCacheMissesTotal = 0
  private static readonly PHASE_PERF_LOG_INTERVAL = 64
  geometryReceiveCount = {} as Record<number, number>
  allLoadedIn: undefined | number
  onWorldSwitched = [] as Array<() => void>
  renderTimeMax = 0
  renderTimeAvg = 0
  renderTimeAvgCount = 0
  edgeChunks = {} as Record<string, boolean>
  lastAddChunk = null as null | {
    timeout: any
    x: number
    z: number
  }
  neighborChunkUpdates = true
  lastChunkDistance = 0
  debugStopGeometryUpdate = false

  protocolCustomBlocks = new Map<string, CustomBlockModels>()
  private heightmapDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Geometry throttle: first dirty per section is instant, subsequent within window are grouped
  private sectionDirtyCount = new Map<string, number>()
  private sectionDirtyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sectionDirtyPendingArgs = new Map<string, { pos: Vec3; value: boolean; useChangeWorker: boolean }>()
  private static readonly GEOMETRY_THROTTLE_THRESHOLD = 1
  private static readonly GEOMETRY_THROTTLE_DELAY = 100 // ms

  blockStateModelInfo = new Map<string, BlockStateModelInfo>()

  abstract outputFormat: 'threeJs' | 'webgpu'
  worldBlockProvider!: WorldBlockProvider
  soundSystem: SoundSystem | undefined

  abstract changeBackgroundColor(color: [number, number, number]): void
  abstract changeCardinalLight(cardinalLight: string): void

  /** Override in subclass to check if any enabled module requires heightmap data */
  protected anyModuleRequiresHeightmap(): boolean {
    return false
  }

  /**
   * Effective instanced cube-shader path (config + runtime caps).
   * WorldRendererThree adds WebGL2; worker uses {@link getMesherConfig}.shaderCubeBlocks.
   */
  protected isShaderCubeBlocksEnabled(): boolean {
    return this.worldRendererConfig.shaderCubeBlocks === true
  }

  shaderCubeBlocksEnabled(): boolean {
    return this.isShaderCubeBlocksEnabled()
  }

  worldRendererConfig: WorldRendererConfig
  playerStateReactive: PlayerStateReactive
  playerStateUtils: PlayerStateUtils
  reactiveState: RendererReactiveState
  mesherLogReader: MesherLogReader | undefined
  forceCallFromMesherReplayer = false
  stopMesherMessagesProcessing = false

  abortController = new AbortController()
  lastRendered = 0
  renderingActive = true
  geometryReceiveCountPerSec = 0
  mesherLogger = {
    contents: [] as string[],
    active: new URL(location.href).searchParams.get('mesherlog') === 'true'
  }
  currentRenderedFrames = 0
  fpsAverage = 0
  lastFps = 0
  fpsWorst = undefined as number | undefined
  fpsSamples = 0
  backendInfoReport = '-'
  chunksFullInfo = '-'
  workerCustomHandleTime = 0

  get version() {
    return this.displayOptions.version
  }

  get displayAdvancedStats() {
    return (this.initOptions.config.statsVisible ?? 0) > 1
  }

  constructor(public readonly resourcesManager: ResourcesManagerTransferred, public displayOptions: DisplayWorldOptions, public initOptions: GraphicsInitOptions) {
    this.snapshotInitialValues()
    this.worldRendererConfig = displayOptions.inWorldRenderingConfig
    this.playerStateReactive = displayOptions.playerStateReactive!
    this.playerStateUtils = getPlayerStateUtils(this.playerStateReactive)
    this.reactiveState = displayOptions.rendererState!
    // this.mesherLogReader = new MesherLogReader(this)
    this.renderUpdateEmitter.on('update', () => {
      const loadedChunks = Object.keys(this.finishedChunks).length
      updateStatText('loaded-chunks', `${loadedChunks}/${this.chunksLength} chunks (${this.lastChunkDistance}/${this.viewDistance})`)
    })

    addNewStat('downloaded-chunks', 100, 140, 20, { className: MC_RENDERER_DEBUG_OVERLAY_CLASS })

    this.connect(this.displayOptions.worldView as any)

    const chunksUpdateInterval = setInterval(() => {
      this.geometryReceiveCountPerSec = Object.values(this.geometryReceiveCount).reduce((acc, curr) => acc + curr, 0)
      this.geometryReceiveCount = {}
      updatePanesVisibility(this.displayAdvancedStats)
      this.updateChunksStats()
    }, 500)
    const fpsUpdateInterval = setInterval(() => {
      this.fpsUpdate()
    }, 1000)
    this.abortController.signal.addEventListener('abort', () => {
      clearInterval(chunksUpdateInterval)
      clearInterval(fpsUpdateInterval)
    })
  }

  fpsUpdate() {
    this.fpsSamples++
    this.fpsAverage = (this.fpsAverage * (this.fpsSamples - 1) + this.currentRenderedFrames) / this.fpsSamples
    if (this.fpsWorst === undefined) {
      this.fpsWorst = this.currentRenderedFrames
    } else {
      this.fpsWorst = Math.min(this.fpsWorst, this.currentRenderedFrames)
    }
    this.lastFps = this.currentRenderedFrames
    this.displayOptions.nonReactiveState.fps = this.currentRenderedFrames
    this.displayOptions.nonReactiveState.worstRenderTime = this.renderTimeMax
    this.displayOptions.nonReactiveState.avgRenderTime = this.renderTimeAvg
    this.currentRenderedFrames = 0
  }

  logWorkerWork(message: string | (() => string)) {
    if (!this.mesherLogger.active) return
    this.mesherLogger.contents.push(typeof message === 'function' ? message() : message)
  }

  async init() {
    if (this.active) throw new Error('WorldRendererCommon is already initialized')

    await Promise.all([
      this.resetWorkers(),
      (async () => {
        if (this.resourcesManager.currentResources?.allReady) {
          await this.updateAssetsData()
        }
      })()
    ])

    this.resourcesManager.on('assetsTexturesUpdated', async () => {
      if (!this.active) return
      await this.updateAssetsData()
    })

    this.watchReactivePlayerState()
    this.watchReactiveConfig()
    this.worldReadyResolvers.resolve()
  }

  snapshotInitialValues() { }

  wasChunkSentToWorker(chunkKey: string) {
    return this.loadedChunks[chunkKey]
  }

  async getHighestBlocks(chunkKey: string) {
    return this.highestBlocksByChunks.get(chunkKey)
  }

  updateCustomBlock(chunkKey: string, blockPos: string, model: string) {
    this.protocolCustomBlocks.set(chunkKey, {
      ...this.protocolCustomBlocks.get(chunkKey),
      [blockPos]: model
    })
    this.logWorkerWork(() => `-> updateCustomBlock ${chunkKey} ${blockPos} ${model} ${this.wasChunkSentToWorker(chunkKey)}`)
    if (this.wasChunkSentToWorker(chunkKey)) {
      const [x, y, z] = blockPos.split(',').map(Number)
      this.setBlockStateId(new Vec3(x, y, z), undefined)
    }
  }

  async getBlockInfo(blockPos: { x: number, y: number, z: number }, stateId: number) {
    const CHUNK_SIZE = 16
    const chunkKey = `${Math.floor(blockPos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(blockPos.z / CHUNK_SIZE) * CHUNK_SIZE}`
    const customBlockName = this.protocolCustomBlocks.get(chunkKey)?.[`${blockPos.x},${blockPos.y},${blockPos.z}`]
    const cacheKey = getBlockAssetsCacheKey(stateId, customBlockName)
    const modelInfo = this.blockStateModelInfo.get(cacheKey)
    return {
      customBlockName,
      modelInfo
    }
  }

  initWorkers(numWorkers = this.worldRendererConfig.mesherWorkers) {
    // init workers
    for (let i = 0; i < numWorkers + 0; i++) {
      const worker = initMesherWorker((data) => {
        if (Array.isArray(data)) {
          this.messageQueue.push(...data)
        } else {
          this.messageQueue.push(data)
        }
        void this.processMessageQueue('worker')
      }, this.worldRendererConfig.wasmMesher ? 'mesherWasm.js' : 'mesher.js')
      this.workers.push(worker)
    }
  }

  onReactivePlayerStateUpdated<T extends keyof PlayerStateReactive>(key: T, callback: (value: PlayerStateReactive[T]) => void, initial = true) {
    if (initial) {
      callback(this.playerStateReactive[key])
    }
    return subscribeKey(this.playerStateReactive, key, callback)
  }

  onReactiveConfigUpdated<T extends keyof typeof this.worldRendererConfig>(key: T, callback: (value: typeof this.worldRendererConfig[T]) => void) {
    callback(this.worldRendererConfig[key])
    if ((key as any) === '*') {
      subscribe(this.worldRendererConfig, callback as any)
    } else {
      subscribeKey(this.worldRendererConfig, key, callback)
    }
  }

  onReactiveDebugUpdated<T extends keyof typeof this.reactiveDebugParams>(key: T, callback: (value: typeof this.reactiveDebugParams[T]) => void) {
    callback(this.reactiveDebugParams[key])
    subscribeKey(this.reactiveDebugParams, key, callback)
  }

  watchReactivePlayerState() {
    this.onReactivePlayerStateUpdated('backgroundColor', (value) => {
      this.changeBackgroundColor(value)
    })
    this.onReactivePlayerStateUpdated('cardinalLight', (value) => {
      this.changeCardinalLight(value)
    })
  }

  watchReactiveConfig() {
    this.onReactiveConfigUpdated('fetchPlayerSkins', (value) => {
      setSkinsConfig({ apiEnabled: value })
    })
  }

  async processMessageQueue(source: string) {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return
    this.logWorkerWork(`# ${source} processing queue`)
    if (this.lastRendered && performance.now() - this.lastRendered > this.ONMESSAGE_TIME_LIMIT && this.worldRendererConfig._experimentalSmoothChunkLoading && this.renderingActive) {
      const start = performance.now()
      await new Promise(resolve => {
        requestAnimationFrame(resolve)
      })
      this.logWorkerWork(`# processing got delayed by ${performance.now() - start}ms`)
    }
    this.isProcessingQueue = true

    const startTime = performance.now()
    let processedCount = 0

    while (this.messageQueue.length > 0) {
      const processingStopped = this.stopMesherMessagesProcessing
      if (!processingStopped) {
        const data = this.messageQueue.shift()!
        this.handleMessage(data)
        processedCount++
      }

      // Check if we've exceeded the time limit
      if (processingStopped || (performance.now() - startTime > this.ONMESSAGE_TIME_LIMIT && this.renderingActive && this.worldRendererConfig._experimentalSmoothChunkLoading)) {
        // If we have more messages and exceeded time limit, schedule next batch
        if (this.messageQueue.length > 0) {
          requestAnimationFrame(async () => {
            this.isProcessingQueue = false
            void this.processMessageQueue('queue-delay')
          })
          return
        }
        break
      }
    }

    this.isProcessingQueue = false
  }

  handleMessage(rawData: any) {
    const data = rawData as MesherMainEvent
    if (!this.active) return
    this.mesherLogReader?.workerMessageReceived(data.type, data)
    if (data.type !== 'geometry' || !this.debugStopGeometryUpdate) {
      const start = performance.now()
      this.handleWorkerMessage(data as WorkerReceive)
      this.workerCustomHandleTime += performance.now() - start
    }
    if (data.type === 'geometry') {
      this.logWorkerWork(() => `-> ${data.workerIndex} geometry ${data.key} ${JSON.stringify({ dataSize: JSON.stringify(data).length })}`)
      this.geometryReceiveCount[data.workerIndex] ??= 0
      this.geometryReceiveCount[data.workerIndex]++
      const chunkCoords = data.key.split(',').map(Number)
      this.lastChunkDistance = Math.max(...this.getDistance(new Vec3(chunkCoords[0], 0, chunkCoords[2])))
    }
    if (data.type === 'sectionFinished') { // on after load & unload section
      this.logWorkerWork(`<- ${data.workerIndex} sectionFinished ${data.key} ${JSON.stringify({ processTime: data.processTime })}`)
      if (!this.sectionsWaiting.has(data.key)) throw new Error(`sectionFinished event for non-outstanding section ${data.key}`)
      this.sectionsWaiting.set(data.key, this.sectionsWaiting.get(data.key)! - 1)
      if (this.sectionsWaiting.get(data.key) === 0) {
        this.sectionsWaiting.delete(data.key)
        this.finishedSections[data.key] = true
      }

      const chunkCoords = data.key.split(',').map(Number)
      const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`
      if (this.loadedChunks[chunkKey]) { // ensure chunk data was added, not a neighbor chunk update
        let loaded = true
        const sectionHeight = this.getSectionHeight()
        for (let y = this.worldMinYRender; y < this.worldSizeParams.worldHeight; y += sectionHeight) {
          if (!this.finishedSections[`${chunkCoords[0]},${y},${chunkCoords[2]}`]) {
            loaded = false
            break
          }
        }
        if (loaded) {
          // CHUNK FINISHED
          this.finishedChunks[chunkKey] = true
          const CHUNK_SIZE = 16
          const gridKey = `${Math.floor(chunkCoords[0] / CHUNK_SIZE)},${Math.floor(chunkCoords[2] / CHUNK_SIZE)}`
          markChunkLoaded(this.reactiveState, gridKey)
          this.renderUpdateEmitter.emit(`chunkFinished`, `${chunkCoords[0]},${chunkCoords[2]}`)
          this.checkAllFinished()
          // merge highest blocks by sections into highest blocks by chunks
          // for (let y = this.worldMinYRender; y < this.worldSizeParams.worldHeight; y += 16) {
          //   const sectionKey = `${chunkCoords[0]},${y},${chunkCoords[2]}`
          //   for (let x = 0; x < 16; x++) {
          //     for (let z = 0; z < 16; z++) {
          //       const posInsideKey = `${chunkCoords[0] + x},${chunkCoords[2] + z}`
          //       let block = null as HighestBlockInfo | null
          //       const highestBlock = this.highestBlocksBySections[sectionKey]?.[posInsideKey]
          //       if (!highestBlock) continue
          //       if (!block || highestBlock.y > block.y) {
          //         block = highestBlock
          //       }
          //       if (block) {
          //         this.highestBlocksByChunks[chunkKey] ??= {}
          //         this.highestBlocksByChunks[chunkKey][posInsideKey] = block
          //       }
          //     }
          //   }
          //   delete this.highestBlocksBySections[sectionKey]
          // }
        }
      }

      this.renderUpdateEmitter.emit('update')
      if (data.processTime) {
        this.workersProcessAverageTimeCount++
        this.workersProcessAverageTime = ((this.workersProcessAverageTime * (this.workersProcessAverageTimeCount - 1)) + data.processTime) / this.workersProcessAverageTimeCount
        this.maxWorkersProcessTime = Math.max(this.maxWorkersProcessTime, data.processTime)
      }
      if (typeof data.pre === 'number' && typeof data.wasm === 'number' && typeof data.post === 'number'
          && (data.pre > 0 || data.wasm > 0 || data.post > 0)) {
        const n = ++this.workersPhaseSampleCount
        this.workersPreAverageTime = ((this.workersPreAverageTime * (n - 1)) + data.pre) / n
        this.workersWasmAverageTime = ((this.workersWasmAverageTime * (n - 1)) + data.wasm) / n
        this.workersPostAverageTime = ((this.workersPostAverageTime * (n - 1)) + data.post) / n
        // Pre-stage substages — additive schema; treat undefined as 0 so
        // events from older mesher builds don't poison the running mean.
        const ptc = typeof data.preTargetConvert === 'number' ? data.preTargetConvert : 0
        const pnc = typeof data.preNeighborConvert === 'number' ? data.preNeighborConvert : 0
        const pncn = typeof data.preNeighborCount === 'number' ? data.preNeighborCount : 0
        const ptab = typeof data.preTypedArrayBuild === 'number' ? data.preTypedArrayBuild : 0
        const po = typeof data.preOther === 'number' ? data.preOther : 0
        const pch = typeof data.preCacheHits === 'number' ? data.preCacheHits : 0
        const pcm = typeof data.preCacheMisses === 'number' ? data.preCacheMisses : 0
        this.workersPreTargetConvertAverageTime = ((this.workersPreTargetConvertAverageTime * (n - 1)) + ptc) / n
        this.workersPreNeighborConvertAverageTime = ((this.workersPreNeighborConvertAverageTime * (n - 1)) + pnc) / n
        this.workersPreNeighborCountAverage = ((this.workersPreNeighborCountAverage * (n - 1)) + pncn) / n
        this.workersPreTypedArrayBuildAverageTime = ((this.workersPreTypedArrayBuildAverageTime * (n - 1)) + ptab) / n
        this.workersPreOtherAverageTime = ((this.workersPreOtherAverageTime * (n - 1)) + po) / n
        this.workersPreCacheHitsTotal += pch
        this.workersPreCacheMissesTotal += pcm
        if (this.worldRendererConfig.debugWasmPerf && n % WorldRendererCommon.PHASE_PERF_LOG_INTERVAL === 0) {
          const total = this.workersPreAverageTime + this.workersWasmAverageTime + this.workersPostAverageTime
          const prePct = total > 0 ? (this.workersPreAverageTime / total) * 100 : 0
          const wasmPct = total > 0 ? (this.workersWasmAverageTime / total) * 100 : 0
          const postPct = total > 0 ? (this.workersPostAverageTime / total) * 100 : 0
          const preAvg = this.workersPreAverageTime
          const tgtPct = preAvg > 0 ? (this.workersPreTargetConvertAverageTime / preAvg) * 100 : 0
          const nbrPct = preAvg > 0 ? (this.workersPreNeighborConvertAverageTime / preAvg) * 100 : 0
          const tabPct = preAvg > 0 ? (this.workersPreTypedArrayBuildAverageTime / preAvg) * 100 : 0
          const othPct = preAvg > 0 ? (this.workersPreOtherAverageTime / preAvg) * 100 : 0
          const nbrCnt = this.workersPreNeighborCountAverage
          const nbrPerAvg = nbrCnt > 0 ? this.workersPreNeighborConvertAverageTime / nbrCnt : 0
          const cacheTotal = this.workersPreCacheHitsTotal + this.workersPreCacheMissesTotal
          const cacheHitPct = cacheTotal > 0 ? (this.workersPreCacheHitsTotal / cacheTotal) * 100 : 0
          // eslint-disable-next-line no-console
          console.log(`[wasm-mesher perf] n=${n} pre=${this.workersPreAverageTime.toFixed(2)}ms (${prePct.toFixed(1)}%) wasm=${this.workersWasmAverageTime.toFixed(2)}ms (${wasmPct.toFixed(1)}%) post=${this.workersPostAverageTime.toFixed(2)}ms (${postPct.toFixed(1)}%) | pre.targetConvert=${this.workersPreTargetConvertAverageTime.toFixed(2)}ms (${tgtPct.toFixed(1)}%) pre.neighborConvert=${this.workersPreNeighborConvertAverageTime.toFixed(2)}ms (${nbrPct.toFixed(1)}%) [n̄=${nbrCnt.toFixed(2)}, per-nbr=${nbrPerAvg.toFixed(2)}ms] pre.typedArrayBuild=${this.workersPreTypedArrayBuildAverageTime.toFixed(2)}ms (${tabPct.toFixed(1)}%) pre.other=${this.workersPreOtherAverageTime.toFixed(2)}ms (${othPct.toFixed(1)}%) | pre.cache hits=${this.workersPreCacheHitsTotal} misses=${this.workersPreCacheMissesTotal} (${cacheHitPct.toFixed(1)}% hit)`)
        }
      }
    }

    if (data.type === 'blockStateModelInfo') {
      for (const [cacheKey, info] of Object.entries(data.info)) {
        this.blockStateModelInfo.set(cacheKey, info)
      }
    }

    if (data.type === 'heightmap') {
      const heightmap = new Int16Array(data.heightmap)
      setRendererHeightmap(this.reactiveState, data.key, heightmap)
    }
  }

  downloadMesherLog() {
    const a = document.createElement('a')
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(this.mesherLogger.contents.join('\n'))
    a.download = 'mesher.log'
    a.click()
  }

  checkAllFinished() {
    if (this.sectionsWaiting.size === 0) {
      setRendererField(this.reactiveState, 'world.mesherWork', false)
    }
    // todo check exact surrounding chunks
    const allFinished = Object.keys(this.finishedChunks).length >= this.chunksLength
    if (allFinished) {
      this.allChunksLoaded?.()
      this.allChunksFinished = true
      this.allLoadedIn ??= Date.now() - this.initialChunkLoadWasStartedIn!
    }
    this.updateChunksStats()
  }

  changeHandSwingingState(isAnimationPlaying: boolean, isLeftHand: boolean): void { }

  abstract handleWorkerMessage(data: WorkerReceive): void

  abstract updateCamera(pos: Vec3 | null, yaw: number, pitch: number): void

  abstract render(): void

  /**
   * Optionally update data that are depedendent on the viewer position
   */
  updatePosDataChunk?(key: string): void

  allChunksLoaded?(): void

  timeUpdated?(newTime: number): void

  biomeUpdated?(biome: any): void

  biomeReset?(): void

  updateViewerPosition(pos: Vec3) {
    this.viewerChunkPosition = pos
    for (const [key, value] of Object.entries(this.loadedChunks)) {
      if (!value) continue
      this.updatePosDataChunk?.(key)
    }
    const gridX = Math.floor(pos.x / 16)
    const gridZ = Math.floor(pos.z / 16)
    if (gridX !== this.lastViewerChunkGridX || gridZ !== this.lastViewerChunkGridZ) {
      this.lastViewerChunkGridX = gridX
      this.lastViewerChunkGridZ = gridZ
      this.onViewerChunkPositionChanged()
    }
  }

  /**
   * Fired only when the viewer crosses a chunk-grid boundary.
   * Three subclass overrides this to refresh the near-first reveal gate.
   */
  protected onViewerChunkPositionChanged(): void {
    // overridden by WorldRendererThree
  }

  sendWorkers(message: WorkerSend) {
    for (const worker of this.workers) {
      worker.postMessage(message)
    }
  }

  getDistance(posAbsolute: Vec3) {
    const [botX, botZ] = chunkPos(this.viewerChunkPosition!)
    const CHUNK_SIZE = 16
    const dx = Math.abs(botX - Math.floor(posAbsolute.x / CHUNK_SIZE))
    const dz = Math.abs(botZ - Math.floor(posAbsolute.z / CHUNK_SIZE))
    return [dx, dz] as [number, number]
  }

  abstract updateShowChunksBorder(value: boolean): void

  resetWorld() {
    // destroy workers
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []
  }

  async resetWorkers() {
    this.resetWorld()

    // for workers in single file build
    if (typeof document !== 'undefined' && document?.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve)
      })
    }

    this.initWorkers()
    this.active = true

    this.sendMesherMcData()
  }

  getMesherConfig(): MesherConfig {
    const timeOfDay = this.timeOfTheDay
    const skyLight = (timeOfDay < 0 || timeOfDay > 24_000) ? 15 : calculateSkyLightSimple(timeOfDay)
    return {
      version: this.version,
      enableLighting: this.worldRendererConfig.enableLighting,
      skyLight,
      smoothLighting: this.worldRendererConfig.smoothLighting,
      shadingTheme: this.worldRendererConfig.shadingTheme,
      cardinalLight: this.worldRendererConfig.cardinalLight,
      outputFormat: this.outputFormat,
      // textureSize: this.resourcesManager.currentResources!.blocksAtlasParser.atlas.latest.width,
      debugModelVariant: this.worldRendererConfig.debugModelVariant,
      clipWorldBelowY: this.worldRendererConfig.clipWorldBelowY,
      disableBlockEntityTextures: !this.worldRendererConfig.extraBlockRenderers,
      worldMinY: this.worldMinYRender,
      worldMaxY: this.worldMinYRender + this.worldSizeParams.worldHeight,
      disableConversionCache: this.worldRendererConfig.disableMesherConversionCache,
      computeWireframeEdges: this.worldRendererConfig.futuristicReveal === true,
      shaderCubeBlocks: this.isShaderCubeBlocksEnabled(),
    }
  }

  sendMesherMcData() {
    const allMcData = this.resourcesManager.currentResources.mcData
    meshersSendMcData(this.workers, this.version, dynamicMcDataFiles, allMcData)
    this.logWorkerWork('# mcData sent')
  }

  async updateAssetsData() {
    const resources = this.resourcesManager.currentResources

    if (this.workers.length === 0) throw new Error('workers not initialized yet')
    for (const [i, worker] of this.workers.entries()) {
      const { blockstatesModels } = resources

      worker.postMessage({
        type: 'mesherData',
        workerIndex: i,
        blocksAtlas: {
          latest: resources.blocksAtlasJson
        },
        blockstatesModels,
        config: this.getMesherConfig(),
      })
    }

    this.logWorkerWork('# mesherData sent')
    console.log('textures loaded')
  }

  getSectionHeight() {
    return SECTION_HEIGHT
  }

  get worldMinYRender() {
    const sectionHeight = this.getSectionHeight()
    return Math.floor(Math.max(this.worldSizeParams.minY, this.worldRendererConfig.clipWorldBelowY ?? -Infinity) / sectionHeight) * sectionHeight
  }

  updateChunksStats() {
    const loadedChunks = Object.keys(this.finishedChunks)
    this.displayOptions.nonReactiveState.world.chunksLoadedCount = loadedChunks.length
    this.displayOptions.nonReactiveState.world.chunksTotalNumber = this.chunksLength
    setRendererField(this.reactiveState, 'world.allChunksLoaded', this.allChunksFinished)

    const text = `Q: ${this.messageQueue.length} ${Object.keys(this.loadedChunks).length}/${Object.keys(this.finishedChunks).length}/${this.chunksLength} chunks (${this.workers.length}:${this.workersProcessAverageTime.toFixed(0)}ms/${this.geometryReceiveCountPerSec}ss/${this.allLoadedIn?.toFixed(1) ?? '-'}s)`
    this.chunksFullInfo = text
    this.displayOptions.nonReactiveState.world.chunksFullInfo = text
    updateStatText('downloaded-chunks', text)
  }

  addColumn(x: number, z: number, chunk: any, isLightUpdate: boolean) {
    if (!this.active) return
    if (this.workers.length === 0) throw new Error('workers not initialized yet')
    this.initialChunksLoad = false
    this.initialChunkLoadWasStartedIn ??= Date.now()
    this.loadedChunks[`${x},${z}`] = true
    this.updateChunksStats()

    const chunkKey = `${x},${z}`
    const customBlockModels = this.protocolCustomBlocks.get(chunkKey)

    for (const worker of this.workers) {
      worker.postMessage({
        type: 'chunk',
        x,
        z,
        chunk,
        customBlockModels: customBlockModels || undefined
      })
    }
    // WASM mesher pushes heightmaps from `processColumnTick` after each
    // column tick — the main thread no longer requests them on chunk load
    // (would double-compute and starve the WASM hot loop). The JS mesher
    // still needs the explicit request because it has no per-tick column
    // pass.
    if (!this.worldRendererConfig.wasmMesher) {
      this.workers[0].postMessage({
        type: 'getHeightmap',
        x,
        z,
      })
    }
    this.logWorkerWork(() => `-> chunk ${JSON.stringify({ x, z, chunkLength: chunk.length, customBlockModelsLength: customBlockModels ? Object.keys(customBlockModels).length : 0 })}`)
    this.mesherLogReader?.chunkReceived(x, z, chunk.length)
    const sectionHeight = this.getSectionHeight()
    const CHUNK_SIZE = 16

    for (let y = this.worldMinYRender; y < this.worldSizeParams.worldHeight; y += sectionHeight) {
      const loc = new Vec3(x, y, z)
      this.setSectionDirty(loc)
      if (this.neighborChunkUpdates && (!isLightUpdate || this.worldRendererConfig.smoothLighting)) {
        this.setSectionDirty(loc.offset(-CHUNK_SIZE, 0, 0))
        this.setSectionDirty(loc.offset(CHUNK_SIZE, 0, 0))
        this.setSectionDirty(loc.offset(0, 0, -CHUNK_SIZE))
        this.setSectionDirty(loc.offset(0, 0, CHUNK_SIZE))
      }
    }
  }

  markAsLoaded(x, z) {
    this.loadedChunks[`${x},${z}`] = true
    this.finishedChunks[`${x},${z}`] = true
    this.logWorkerWork(`-> markAsLoaded ${JSON.stringify({ x, z })}`)
    // Mirror the main meshing path so the near-first reveal gate can
    // re-evaluate any farther chunks blocked by this column.
    this.renderUpdateEmitter.emit('chunkFinished', `${x},${z}`)
    this.checkAllFinished()
  }

  removeColumn(x, z) {
    delete this.loadedChunks[`${x},${z}`]
    // Cancel any pending heightmap debounce for this chunk
    const debounceKey = `${x},${z}`
    const pendingTimer = this.heightmapDebounceTimers.get(debounceKey)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.heightmapDebounceTimers.delete(debounceKey)
    }
    // Cancel any pending geometry throttle timers for sections in this chunk
    for (const [key, timer] of this.sectionDirtyTimers) {
      if (key.startsWith(`${x},`) && key.endsWith(`,${z}`)) {
        clearTimeout(timer)
        this.sectionDirtyTimers.delete(key)
        this.sectionDirtyCount.delete(key)
        this.sectionDirtyPendingArgs.delete(key)
      }
    }
    for (const worker of this.workers) {
      worker.postMessage({ type: 'unloadChunk', x, z })
    }
    this.logWorkerWork(`-> unloadChunk ${JSON.stringify({ x, z })}`)
    delete this.finishedChunks[`${x},${z}`]
    this.allChunksFinished = Object.keys(this.finishedChunks).length === this.chunksLength
    if (Object.keys(this.finishedChunks).length === 0) {
      this.allLoadedIn = undefined
      this.initialChunkLoadWasStartedIn = undefined
    }
    const sectionHeight = this.getSectionHeight()
    for (let y = this.worldSizeParams.minY; y < this.worldSizeParams.worldHeight; y += sectionHeight) {
      this.setSectionDirty(new Vec3(x, y, z), false)
      delete this.finishedSections[`${x},${y},${z}`]
    }
    this.highestBlocksByChunks.delete(`${x},${z}`)
    const heightmapKey = `${Math.floor(x / 16)},${Math.floor(z / 16)}`
    removeRendererHeightmap(this.reactiveState, heightmapKey)

    this.updateChunksStats()

    if (Object.keys(this.loadedChunks).length === 0) {
      this.mesherLogger.contents = []
      this.logWorkerWork('# all chunks unloaded. New log started')
      void this.mesherLogReader?.maybeStartReplay()
    }
  }

  setBlockStateId(pos: Vec3, stateId: number | undefined, needAoRecalculation = true) {
    const set = async () => {
      const CHUNK_SIZE = 16
      const sectionX = Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE
      const sectionZ = Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE
      if (this.queuedChunks.has(`${sectionX},${sectionZ}`)) {
        await new Promise<void>(resolve => {
          this.queuedFunctions.push(() => {
            resolve()
          })
        })
      }
      if (!this.loadedChunks[`${sectionX},${sectionZ}`]) {
        // console.debug('[should be unreachable] setBlockStateId called for unloaded chunk', pos)
      }
      this.setBlockStateIdInner(pos, stateId, needAoRecalculation)
    }
    void set()
  }

  updateEntity(e: any, isUpdate = false) { }

  abstract updatePlayerEntity?(e: any): void

  lightUpdate(chunkX: number, chunkZ: number) { }

  connect(worldView: WorldViewWorker) {
    const worldEmitter = worldView

    worldEmitter.on('entity', (e) => {
      this.updateEntity(e, false)
    })
    worldEmitter.on('entityMoved', (e) => {
      this.updateEntity(e, true)
    })
    worldEmitter.on('playerEntity', (e) => {
      this.updatePlayerEntity?.(e)
    })

    let currentLoadChunkBatch = null as {
      timeout
      data
    } | null
    worldEmitter.on('loadChunk', ({ x, z, chunk, worldConfig, isLightUpdate }) => {
      this.worldSizeParams = worldConfig
      this.queuedChunks.add(`${x},${z}`)
      const args = [x, z, chunk, isLightUpdate]
      if (!currentLoadChunkBatch) {
        // add a setting to use debounce instead
        currentLoadChunkBatch = {
          data: [],
          timeout: setTimeout(() => {
            for (const args of currentLoadChunkBatch!.data) {
              this.queuedChunks.delete(`${args[0]},${args[1]}`)
              this.addColumn(...args as Parameters<typeof this.addColumn>)
            }
            for (const fn of this.queuedFunctions) {
              fn()
            }
            this.queuedFunctions = []
            currentLoadChunkBatch = null
          }, this.worldRendererConfig.addChunksBatchWaitTime)
        }
      }
      currentLoadChunkBatch.data.push(args)
    })
    // todo remove and use other architecture instead so data flow is clear
    worldEmitter.on('blockEntities', (blockEntities) => {
      this.blockEntities = blockEntities
    })

    worldEmitter.on('unloadChunk', ({ x, z }) => {
      this.removeColumn(x, z)
    })

    worldEmitter.on('blockUpdate', ({ pos, stateId }) => {
      this.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateId)
    })

    worldEmitter.on('chunkPosUpdate', ({ pos }) => {
      this.updateViewerPosition(pos)
    })

    worldEmitter.on('end', () => {
      this.worldStop?.()
    })


    worldEmitter.on('renderDistance', (d) => {
      this.viewDistance = d
      this.chunksLength = d === 0 ? 1 : generateSpiralMatrix(d).length
      this.allChunksFinished = Object.keys(this.finishedChunks).length === this.chunksLength
      this.onRenderDistanceChanged?.(d)
    })

    worldEmitter.on('markAsLoaded', ({ x, z }) => {
      this.markAsLoaded(x, z)
    })

    worldEmitter.on('updateLight', ({ pos }) => {
      this.lightUpdate(pos.x, pos.z)
    })

    worldEmitter.on('onWorldSwitch', () => {
      for (const fn of this.onWorldSwitched) {
        try {
          fn()
        } catch (e) {
          setTimeout(() => {
            console.log('[Renderer Backend] Error in onWorldSwitched:')
            throw e
          }, 0)
        }
      }
    })

    worldEmitter.on('time', (timeOfDay) => {
      if (!this.worldRendererConfig.dayCycle) return
      this.timeUpdated?.(timeOfDay)

      this.timeOfTheDay = timeOfDay

      // if (this.worldRendererConfig.skyLight === skyLight) return
      // this.worldRendererConfig.skyLight = skyLight
      // if (this instanceof WorldRendererThree) {
      //   (this).rerenderAllChunks?.()
      // }
    })

    worldEmitter.on('biomeUpdate', ({ biome }) => {
      this.biomeUpdated?.(biome)
    })

    worldEmitter.on('biomeReset', () => {
      this.biomeReset?.()
    })
  }

  setBlockStateIdInner(pos: Vec3, stateId: number | undefined, needAoRecalculation = true) {
    const CHUNK_SIZE = 16
    const chunkKey = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`
    const blockPosKey = `${pos.x},${pos.y},${pos.z}`
    const customBlockModels = this.protocolCustomBlocks.get(chunkKey) || {}

    for (const worker of this.workers) {
      worker.postMessage({
        type: 'blockUpdate',
        pos,
        stateId,
        customBlockModels
      })
    }
    // Re-request heightmap for the affected chunk after block change (debounced)
    if (this.anyModuleRequiresHeightmap()) {
      const chunkCornerX = Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE
      const chunkCornerZ = Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE
      const chunkKey2 = `${chunkCornerX},${chunkCornerZ}`
      // WASM mesher pushes heightmaps from `processColumnTick`, so the
      // block-update path doesn't need an explicit re-request — the next
      // column tick will repush the recomputed heightmap.
      if (!this.worldRendererConfig.wasmMesher) {
        const existing = this.heightmapDebounceTimers.get(chunkKey2)
        if (existing) clearTimeout(existing)
        this.heightmapDebounceTimers.set(chunkKey2, setTimeout(() => {
          this.heightmapDebounceTimers.delete(chunkKey2)
          this.workers[0]?.postMessage({ type: 'getHeightmap', x: chunkCornerX, z: chunkCornerZ })
        }, 100))
      }
    }
    this.logWorkerWork(`-> blockUpdate ${JSON.stringify({ pos, stateId, customBlockModels })}`)
    this.setSectionDirty(pos, true, true)
    if (this.neighborChunkUpdates) {
      const CHUNK_SIZE = 16
      const sectionHeight = this.getSectionHeight()
      if ((pos.x & 15) === 0) this.setSectionDirty(pos.offset(-CHUNK_SIZE, 0, 0), true, true)
      if ((pos.x & 15) === 15) this.setSectionDirty(pos.offset(CHUNK_SIZE, 0, 0), true, true)
      if ((pos.y & (sectionHeight - 1)) === 0) this.setSectionDirty(pos.offset(0, -sectionHeight, 0), true, true)
      if ((pos.y & (sectionHeight - 1)) === (sectionHeight - 1)) this.setSectionDirty(pos.offset(0, sectionHeight, 0), true, true)
      if ((pos.z & 15) === 0) this.setSectionDirty(pos.offset(0, 0, -CHUNK_SIZE), true, true)
      if ((pos.z & 15) === 15) this.setSectionDirty(pos.offset(0, 0, CHUNK_SIZE), true, true)

      if (needAoRecalculation) {
        // top view neighbors
        if ((pos.x & 15) === 0 && (pos.z & 15) === 0) this.setSectionDirty(pos.offset(-CHUNK_SIZE, 0, -CHUNK_SIZE), true, true)
        if ((pos.x & 15) === 15 && (pos.z & 15) === 0) this.setSectionDirty(pos.offset(CHUNK_SIZE, 0, -CHUNK_SIZE), true, true)
        if ((pos.x & 15) === 0 && (pos.z & 15) === 15) this.setSectionDirty(pos.offset(-CHUNK_SIZE, 0, CHUNK_SIZE), true, true)
        if ((pos.x & 15) === 15 && (pos.z & 15) === 15) this.setSectionDirty(pos.offset(CHUNK_SIZE, 0, CHUNK_SIZE), true, true)

        // side view neighbors (but ignore updates above)
        // z view neighbors
        if ((pos.x & 15) === 0 && (pos.y & (sectionHeight - 1)) === 0) this.setSectionDirty(pos.offset(-CHUNK_SIZE, -sectionHeight, 0), true, true)
        if ((pos.x & 15) === 15 && (pos.y & (sectionHeight - 1)) === 0) this.setSectionDirty(pos.offset(CHUNK_SIZE, -sectionHeight, 0), true, true)

        // x view neighbors
        if ((pos.z & 15) === 0 && (pos.y & (sectionHeight - 1)) === 0) this.setSectionDirty(pos.offset(0, -sectionHeight, -CHUNK_SIZE), true, true)
        if ((pos.z & 15) === 15 && (pos.y & (sectionHeight - 1)) === 0) this.setSectionDirty(pos.offset(0, -sectionHeight, CHUNK_SIZE), true, true)

        // x & z neighbors
        if ((pos.y & (sectionHeight - 1)) === 0 && (pos.x & 15) === 0 && (pos.z & 15) === 0) this.setSectionDirty(pos.offset(-CHUNK_SIZE, -sectionHeight, -CHUNK_SIZE), true, true)
        if ((pos.y & (sectionHeight - 1)) === 0 && (pos.x & 15) === 15 && (pos.z & 15) === 0) this.setSectionDirty(pos.offset(CHUNK_SIZE, -sectionHeight, -CHUNK_SIZE), true, true)
        if ((pos.y & (sectionHeight - 1)) === 0 && (pos.x & 15) === 0 && (pos.z & 15) === 15) this.setSectionDirty(pos.offset(-CHUNK_SIZE, -sectionHeight, CHUNK_SIZE), true, true)
        if ((pos.y & (sectionHeight - 1)) === 0 && (pos.x & 15) === 15 && (pos.z & 15) === 15) this.setSectionDirty(pos.offset(CHUNK_SIZE, -sectionHeight, CHUNK_SIZE), true, true)
      }
    }
  }

  abstract worldStop?()

  queueAwaited = false
  toWorkerMessagesQueue = {} as { [workerIndex: string]: any[] }

  getWorkerNumber(pos: Vec3, updateAction = false) {
    const CHUNK_SIZE = 16
    const sectionHeight = this.getSectionHeight()
    const dedicated = this.worldRendererConfig.dedicatedChangeWorker

    if (dedicated && this.workers.length > 1) {
      // WASM column meshing must keep all vertical sections of a chunk
      // column on one worker — skip dedicated change worker to avoid
      // concurrent column meshing across different workers.
      if (this.worldRendererConfig.wasmMesher) {
        return mod(Math.floor(pos.x / CHUNK_SIZE) + Math.floor(pos.z / CHUNK_SIZE), this.workers.length)
      }
      if (updateAction) {
        const key = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.y / sectionHeight) * sectionHeight},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`
        const busy = this.sectionsWaiting.get(key) && !this.finishedSections[key]
        if (busy) {
          // Section is already being meshed by a general worker — route
          // the update to the same worker to avoid concurrent meshing.
          const generalWorkers = this.workers.length - 1
          return mod(Math.floor(pos.x / CHUNK_SIZE) + Math.floor(pos.y / sectionHeight) + Math.floor(pos.z / CHUNK_SIZE), generalWorkers)
        }
        return this.workers.length - 1
      }
      const generalWorkers = this.workers.length - 1
      return mod(Math.floor(pos.x / CHUNK_SIZE) + Math.floor(pos.y / sectionHeight) + Math.floor(pos.z / CHUNK_SIZE), generalWorkers)
    }

    if (this.worldRendererConfig.wasmMesher) {
      // WASM column meshing must keep all vertical sections of a chunk column
      // on one worker. Hash by x/z only and bypass the change-worker shortcut
      // so block edits cannot remesh the same column concurrently on worker 0.
      return mod(Math.floor(pos.x / CHUNK_SIZE) + Math.floor(pos.z / CHUNK_SIZE), this.workers.length)
    }
    if (updateAction) {
      const key = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.y / sectionHeight) * sectionHeight},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`
      const cantUseChangeWorker = this.sectionsWaiting.get(key) && !this.finishedSections[key]
      if (!cantUseChangeWorker) return 0
    }

    return mod(Math.floor(pos.x / CHUNK_SIZE) + Math.floor(pos.y / sectionHeight) + Math.floor(pos.z / CHUNK_SIZE), this.workers.length)
  }

  async debugGetWorkerCustomBlockModel(pos: Vec3) {
    const data = [] as Array<Promise<string>>
    for (const worker of this.workers) {
      data.push(new Promise((resolve) => {
        worker.addEventListener('message', (e) => {
          if (e.data.type === 'customBlockModel') {
            resolve(e.data.customBlockModel)
          }
        })
      }))
      worker.postMessage({
        type: 'getCustomBlockModel',
        pos
      })
    }
    return Promise.all(data)
  }

  setSectionDirty(pos: Vec3, value = true, useChangeWorker = false) { // value false is used for unloading chunks
    if (!this.forceCallFromMesherReplayer && this.mesherLogReader) return

    if (this.viewDistance === -1) throw new Error('viewDistance not set')

    const distance = this.getDistance(pos)
    // todo shouldnt we check loadedChunks instead?
    if (!this.workers.length || distance[0] > this.viewDistance || distance[1] > this.viewDistance) return

    // When unloading chunks (value=false) — always immediate, no throttle
    if (!value) {
      this._dispatchDirtyImmediate(pos, value, useChangeWorker)
      return
    }

    const CHUNK_SIZE = 16
    const sectionHeight = this.getSectionHeight()
    const key = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.y / sectionHeight) * sectionHeight},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`

    const currentCount = (this.sectionDirtyCount.get(key) ?? 0) + 1
    this.sectionDirtyCount.set(key, currentCount)

    if (currentCount <= WorldRendererCommon.GEOMETRY_THROTTLE_THRESHOLD) {
      // First request in window — dispatch immediately for instant feedback
      this._dispatchDirtyImmediate(pos, value, useChangeWorker)

      // Schedule trailing dispatch after throttle window
      if (!this.sectionDirtyTimers.has(key)) {
        this.sectionDirtyTimers.set(key, setTimeout(() => {
          const args = this.sectionDirtyPendingArgs.get(key)
          this.sectionDirtyCount.delete(key)
          this.sectionDirtyTimers.delete(key)
          this.sectionDirtyPendingArgs.delete(key)
          if (args) {
            this._dispatchDirtyImmediate(args.pos, args.value, args.useChangeWorker)
          }
        }, WorldRendererCommon.GEOMETRY_THROTTLE_DELAY))
      }
    } else {
      // Subsequent requests — throttle: store latest args, existing timer will dispatch
      this.sectionDirtyPendingArgs.set(key, { pos, value, useChangeWorker })

      if (!this.sectionDirtyTimers.has(key)) {
        this.sectionDirtyTimers.set(key, setTimeout(() => {
          const args = this.sectionDirtyPendingArgs.get(key)
          this.sectionDirtyCount.delete(key)
          this.sectionDirtyTimers.delete(key)
          this.sectionDirtyPendingArgs.delete(key)
          if (args) {
            this._dispatchDirtyImmediate(args.pos, args.value, args.useChangeWorker)
          }
        }, WorldRendererCommon.GEOMETRY_THROTTLE_DELAY))
      }
    }
  }

  /** Dispatch dirty message to worker without throttle (original logic) */
  private _dispatchDirtyImmediate(pos: Vec3, value: boolean, useChangeWorker: boolean) {
    setRendererField(this.reactiveState, 'world.mesherWork', true)
    const CHUNK_SIZE = 16
    const sectionHeight = this.getSectionHeight()
    const key = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.y / sectionHeight) * sectionHeight},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`

    this.renderUpdateEmitter.emit('dirty', pos, value)
    // Dispatch sections to workers based on position
    // This guarantees uniformity accross workers and that a given section
    // is always dispatched to the same worker
    const hash = this.getWorkerNumber(pos, useChangeWorker && (this.mesherLogger.active || this.worldRendererConfig.dedicatedChangeWorker))
    this.sectionsWaiting.set(key, (this.sectionsWaiting.get(key) ?? 0) + 1)
    if (this.forceCallFromMesherReplayer) {
      this.workers[hash].postMessage({
        type: 'dirty',
        x: pos.x,
        y: pos.y,
        z: pos.z,
        value,
        config: this.getMesherConfig(),
      })
    } else {
      this.toWorkerMessagesQueue[hash] ??= []
      this.toWorkerMessagesQueue[hash].push({
        type: 'dirty',
        x: pos.x,
        y: pos.y,
        z: pos.z,
        value,
        config: this.getMesherConfig(),
      })
      this.dispatchMessages()
    }
  }

  dispatchMessages() {
    if (this.queueAwaited) return
    this.queueAwaited = true
    setTimeout(() => {
      // group messages and send as one
      for (const workerIndex in this.toWorkerMessagesQueue) {
        const worker = this.workers[Number(workerIndex)]
        const messages = this.toWorkerMessagesQueue[workerIndex]
        worker.postMessage(messages)
        for (const message of messages) {
          this.logWorkerWork(`-> ${workerIndex} dispatchMessages ${message.type} ${JSON.stringify({ x: message.x, y: message.y, z: message.z, value: message.value })}`)
        }
      }
      this.toWorkerMessagesQueue = {}
      this.queueAwaited = false
    })
  }

  // Listen for chunk rendering updates emitted if a worker finished a render and resolve if the number
  // of sections not rendered are 0
  async waitForChunksToRender() {
    return new Promise<void>((resolve, reject) => {
      if ([...this.sectionsWaiting].length === 0) {
        resolve()
        return
      }

      const updateHandler = () => {
        if (this.sectionsWaiting.size === 0) {
          this.renderUpdateEmitter.removeListener('update', updateHandler)
          resolve()
        }
      }
      this.renderUpdateEmitter.on('update', updateHandler)
    })
  }

  async waitForChunkToLoad(pos: Vec3) {
    return new Promise<void>((resolve, reject) => {
      const CHUNK_SIZE = 16
      const key = `${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`
      if (this.loadedChunks[key]) {
        resolve()
        return
      }
      const updateHandler = () => {
        if (this.loadedChunks[key]) {
          this.renderUpdateEmitter.removeListener('update', updateHandler)
          resolve()
        }
      }
      this.renderUpdateEmitter.on('update', updateHandler)
    })
  }

  destroy() {
    // Cancel all pending heightmap debounce timers
    for (const timer of this.heightmapDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.heightmapDebounceTimers.clear()

    // Cancel all pending geometry throttle timers
    for (const timer of this.sectionDirtyTimers.values()) {
      clearTimeout(timer)
    }
    this.sectionDirtyTimers.clear()
    this.sectionDirtyCount.clear()
    this.sectionDirtyPendingArgs.clear()

    // Stop all workers
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []

    // Stop and destroy sound system
    if (this.soundSystem) {
      this.soundSystem.destroy()
      this.soundSystem = undefined
    }

    this.active = false

    // Clear chunk and section tracking (previously handled by @worldCleanup decorator)
    this.loadedChunks = {}
    this.finishedChunks = {}
    this.finishedSections = {}
    this.sectionsWaiting.clear()
    this.queuedChunks.clear()
    this.blockStateModelInfo.clear()

    this.renderUpdateEmitter.removeAllListeners()
    this.abortController.abort()
    removeAllStats()
  }
}

export const initMesherWorker = (onGotMessage: (data: any) => void, workerName = 'mesher.js') => {
  // Node environment needs an absolute path, but browser needs the url of the file

  let worker: any
  if (process.env.SINGLE_FILE_BUILD) {
    const workerCode = document.getElementById('mesher-worker-code')!.textContent!
    const blob = new Blob([workerCode], { type: 'text/javascript' })
    worker = new Worker(window.URL.createObjectURL(blob))
  } else {
    worker = new Worker(workerName)
  }

  worker.onmessage = ({ data }) => {
    onGotMessage(data)
  }
  if (worker.on) worker.on('message', (data) => { worker.onmessage({ data }) })
  return worker
}

let mesherMcDataTintsMissingWarned = false

export const meshersSendMcData = (workers: Worker[], version: string, mcDataKeys = dynamicMcDataFiles, mcDataFull: IndexedData) => {
  const mcData = {
    version: JSON.parse(JSON.stringify(mcDataFull.version))
  }
  for (const [finalKey, sourceKey] of Object.entries(mcDataKeys)) {
    mcData[finalKey] = mcDataFull[sourceKey]
  }
  if ('tints' in mcDataKeys && !mcData.tints && !mesherMcDataTintsMissingWarned) {
    mesherMcDataTintsMissingWarned = true
    console.warn(`[meshersSendMcData] mcData.tints missing for version ${version}; shader cubes will use legacy path in worker`)
  }

  for (const worker of workers) {
    worker.postMessage({ type: 'mcData', mcData })
  }
}

/** Wait for worker `mcDataApplied` after {@link meshersSendMcData}. */
export const meshersSendMcDataAwait = (
  workers: Worker[],
  version: string,
  mcDataKeys = dynamicMcDataFiles,
  mcDataFull: IndexedData,
  timeoutMs = 10_000
): Promise<void> => {
  return Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', handler as EventListener)
      reject(new Error(`mcData transfer timeout (${timeoutMs}ms)`))
    }, timeoutMs)
    const handler = ({ data }: MessageEvent) => {
      if (data?.type === 'mcDataApplied') {
        clearTimeout(timeout)
        worker.removeEventListener('message', handler as EventListener)
        resolve()
      }
    }
    worker.addEventListener('message', handler as EventListener)
    meshersSendMcData([worker], version, mcDataKeys, mcDataFull)
  }))).then(() => undefined)
}
