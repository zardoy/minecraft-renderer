import * as THREE from 'three'
import { Vec3 } from 'vec3'
import nbt from 'prismarine-nbt'
import PrismarineChatLoader from 'prismarine-chat'
import * as tweenJs from '@tweenjs/tween.js'
import { Biome } from 'minecraft-data'
import { renderSign } from '../sign-renderer'
import { DisplayWorldOptions, GraphicsInitOptions } from '../graphicsBackend/types'
import { chunkPos, sectionPos } from '../lib/simpleUtils'
import { WorldRendererCommon } from '../lib/worldrendererCommon'
import { addNewStat } from '../lib/ui/newStats'
import { MesherGeometryOutput } from '../mesher/shared'
import { ItemSpecificContextProperties } from '../playerState/types'
import { setBlockPosition } from '../mesher/standaloneRenderer'
import { getMyHand } from './hand'
import { createHoldingBlock } from './holdingBlockFactory'
import type { IHoldingBlock } from './holdingBlockTypes'
import { getMesh } from './entity/EntityMesh'
import { armorModel } from './entity/armorModels'
import { disposeObject, loadThreeJsTextureFromBitmap } from './threeJsUtils'
import { CursorBlock } from './world/cursorBlock'
import { getItemUv } from './appShared'
import { Entities } from './entities'
import { ThreeJsSound } from './threeJsSound'
import { CameraShake } from './cameraShake'
import { ThreeJsMedia } from './threeJsMedia'
import { Fountain } from './threeJsParticles'
import { WaypointsRenderer } from './waypoints'
import { FireworksRenderer } from './fireworksRenderer'
import { CinimaticScriptRunner, CinimaticScript } from './cinimaticScript'
import { DEFAULT_TEMPERATURE, SkyboxRenderer } from './skyboxRenderer'
import { FireworksManager } from './fireworks'
import { SceneOrigin } from './sceneOrigin'
import { downloadWorldGeometry } from './worldGeometryExport'
import { ChunkMeshManager } from './chunkMeshManager'
import type { RendererModuleManifest, RegisteredModule, RendererModuleController } from './rendererModuleSystem'
import { BUILTIN_MODULES } from './modules/index'

type SectionKey = string

export class WorldRendererThree extends WorldRendererCommon {
  outputFormat = 'threeJs' as const
  chunkMeshManager: ChunkMeshManager
  get sectionObjects() {
    return this.chunkMeshManager.sectionObjects
  }
  chunkTextures = new Map<string, { [pos: string]: THREE.Texture }>()
  signsCache = new Map<string, any>()
  cameraSectionPos: Vec3 = new Vec3(0, 0, 0)
  holdingBlock: IHoldingBlock
  holdingBlockLeft: IHoldingBlock
  scene = new THREE.Scene()
  get realScene() {
    return this.scene
  }
  ambientLight = new THREE.AmbientLight(0xcc_cc_cc)
  directionalLight = new THREE.DirectionalLight(0xff_ff_ff, 0.5)
  entities = new Entities(this, (globalThis as any).mcData)
  cameraGroupVr?: THREE.Object3D
  material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1 })
  itemsTexture!: THREE.Texture
  cursorBlock: CursorBlock
  onRender: Array<(deltaTime: number) => void> = []
  private lastRenderTime = 0
  cameraShake: CameraShake
  cameraContainer!: THREE.Object3D
  media: ThreeJsMedia
  get waitingChunksToDisplay() {
    return this.chunkMeshManager.waitingChunksToDisplay
  }
  waypoints: WaypointsRenderer
  cinimaticScript: CinimaticScriptRunner
  /**
   * Three.js camera used for rendering.
   *
   * **WARNING:** `camera.position` is scene-local (near origin due to sceneOrigin rebasing),
   * NOT world-space. In first-person mode it's `(0,0,0)`; in third-person it's `(0,0,zOffset)`.
   *
   * Use `getCameraPosition()` or `cameraWorldPos` for actual world-space coordinates.
   */
  camera!: THREE.PerspectiveCamera
  renderTimeAvg = 0
  private pendingSectionUpdates = new Map<string, { geometry: MesherGeometryOutput, key: string, type: string }>()
  /**
   * Per-section buffering timestamps for `applyPendingSectionUpdates`.
   * Each section gets its own deadline so a continuous stream of updates
   * (e.g. server-side block changes from explosions, pistons, fluid ticks)
   * does not flush freshly added sections together with stale ones via a
   * single global timer.
   */
  private pendingSectionBufferStartTimes = new Map<string, number>()
  private static readonly MAX_SECTION_UPDATE_BUFFER_MS = 500
  // Memory usage tracking (in bytes)
  get estimatedMemoryUsage() {
    return this.chunkMeshManager.getEstimatedMemoryUsage().total
  }
  // Module system
  private modules = {} as Record<string, RegisteredModule>
  sectionsOffsetsAnimations = {} as {
    [chunkKey: string]: {
      time: number,
      // also specifies direction
      speedX: number,
      speedY: number,
      speedZ: number,

      currentOffsetX: number,
      currentOffsetY: number,
      currentOffsetZ: number,

      limitX?: number,
      limitY?: number,
      limitZ?: number,
    }
  }
  fountains: Fountain[] = []
  fireworksLegacy: FireworksRenderer
  DEBUG_RAYCAST = false
  skyboxRenderer: SkyboxRenderer
  fireworks: FireworksManager
  sceneOrigin = new SceneOrigin(this.scene)
  /** Camera world position stored in float64 (JS number) for precision */
  cameraWorldPos = { x: 0, y: 0, z: 0 }

  /** Whether we've warned about camera.position access (one-time dev warning) */
  private _cameraPositionAccessWarned = false

  private readonly _tmpCameraPos = new THREE.Vector3()

  private currentPosTween?: tweenJs.Tween<{ x: number, y: number, z: number }>
  private currentRotTween?: tweenJs.Tween<{ pitch: number, yaw: number }>

  // Pre-allocated objects for getThirdPersonCamera (avoid per-frame allocs)
  private readonly _tpDirection = new THREE.Vector3()
  private readonly _tpPitchQuat = new THREE.Quaternion()
  private readonly _tpYawQuat = new THREE.Quaternion()
  private readonly _tpFinalQuat = new THREE.Quaternion()
  private readonly _tpScenePos = new THREE.Vector3()
  private readonly _tpAxisX = new THREE.Vector3(1, 0, 0)
  private readonly _tpAxisY = new THREE.Vector3(0, 1, 0)
  private readonly _tpRaycaster = new THREE.Raycaster()
  private readonly _tpChunkWorldPos = new THREE.Vector3()

  get tilesRendered() {
    return this.chunkMeshManager.getTotalTiles()
  }

  get blocksRendered() {
    return this.chunkMeshManager.getTotalBlocks()
  }

  constructor(public renderer: THREE.WebGLRenderer, public initOptions: GraphicsInitOptions, public displayOptions: DisplayWorldOptions) {
    if (!displayOptions.resourcesManager) throw new Error('resourcesManager is required in displayOptions')
    super(displayOptions.resourcesManager, displayOptions, initOptions)

    this.renderer = renderer
    displayOptions.rendererState.renderer = WorldRendererThree.getRendererInfo(renderer) ?? '...'

    // Initialize chunk mesh manager
    this.chunkMeshManager = new ChunkMeshManager(this, this.scene, this.material, this.worldSizeParams.worldHeight, this.viewDistance)
    this.onRenderDistanceChanged = (viewDistance) => {
      this.chunkMeshManager.updateViewDistance(viewDistance)
    }

    this.cursorBlock = new CursorBlock(this)
    this.holdingBlock = createHoldingBlock(this)
    this.holdingBlockLeft = createHoldingBlock(this, true)

    // Register built-in modules
    for (const manifest of Object.values(BUILTIN_MODULES)) {
      this.registerModule(manifest as RendererModuleManifest)
    }

    // Initialize skybox renderer
    this.skyboxRenderer = new SkyboxRenderer(this.realScene, false, null)
    void this.skyboxRenderer.init()

    this.addDebugOverlay()
    this.resetScene()
    void this.init()

    this.soundSystem = new ThreeJsSound(this)
    this.cameraShake = new CameraShake(this, this.onRender)
    this.media = new ThreeJsMedia(this)
    this.fireworksLegacy = new FireworksRenderer(this)
    this.waypoints = new WaypointsRenderer(this)
    this.cinimaticScript = new CinimaticScriptRunner(
      this,
      (pos, yaw, pitch) => this.setCinimaticCamera(pos, yaw, pitch),
      (fov) => this.setCinimaticFov(fov),
      () => ({
        position: new Vec3(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z),
        yaw: this.cameraShake.getBaseRotation().yaw,
        pitch: this.cameraShake.getBaseRotation().pitch,
        fov: this.camera.fov
      })
    )
    this.fireworks = new FireworksManager(this.realScene, this.sceneOrigin)

    // this.fountain = new Fountain(this.scene, this.scene, {
    //   position: new THREE.Vector3(0, 10, 0),
    // })

    this.renderUpdateEmitter.on('chunkFinished', (chunkKey: string) => {
      this.finishChunk(chunkKey)
    })
    this.worldSwitchActions()

    // Initialize modules
    this.initializeModules()
  }

  /**
   * Register a renderer module
   */
  registerModule(manifest: RendererModuleManifest): void {
    if (manifest.id in this.modules) {
      console.warn(`Module ${manifest.id} is already registered`)
      return
    }

    const controller = new manifest.controller(this)

    const registered: RegisteredModule = {
      manifest,
      controller,
      enabled: false,
      toggle: () => this.toggleModule(manifest.id),
    }

    this.modules[manifest.id] = registered

    if (manifest.enabledDefault) {
      this.toggleModule(manifest.id, true)
    }
  }


  /**
   * Enable a module
   */
  enableModule(moduleId: string): void {
    const module = this.modules[moduleId]
    if (!module) {
      console.warn(`Module ${moduleId} not found`)
      return
    }

    if (module.enabled) return

    module.enabled = true
    module.controller.enable()

    // Register render callback if provided
    if (module.controller.render) {
      this.onRender.push(module.controller.render)
    }
  }

  /**
   * Disable a module
   */
  disableModule(moduleId: string): void {
    const module = this.modules[moduleId]
    if (!module) {
      console.warn(`Module ${moduleId} not found`)
      return
    }

    if (module.manifest.cannotBeDisabled) {
      console.warn(`Module ${moduleId} cannot be disabled`)
      return
    }

    if (!module.enabled) return

    module.enabled = false
    module.controller.disable()

    // Unregister render callback if provided
    if (module.controller.render) {
      const index = this.onRender.indexOf(module.controller.render)
      if (index > -1) {
        this.onRender.splice(index, 1)
      }
    }
  }

  /**
   * Toggle a module on/off, or force a specific state
   */
  toggleModule(moduleId: string, forceState?: boolean): boolean {
    const module = this.modules[moduleId]
    if (!module) {
      console.warn(`Module ${moduleId} not found`)
      return false
    }

    const targetState = forceState !== undefined ? forceState : !module.enabled

    if (targetState === module.enabled) return module.enabled

    if (!targetState && module.manifest.cannotBeDisabled) {
      console.warn(`Module ${moduleId} cannot be disabled`)
      return true
    }

    module.enabled = targetState

    if (targetState) {
      module.controller.enable()
      // Register render callback if provided
      if (module.controller.render && !this.onRender.includes(module.controller.render)) {
        this.onRender.push(module.controller.render)
      }
    } else {
      module.controller.disable()
      // Unregister render callback if provided
      if (module.controller.render) {
        const index = this.onRender.indexOf(module.controller.render)
        if (index > -1) {
          this.onRender.splice(index, 1)
        }
      }
    }

    return targetState
  }

  /**
   * Dispose all modules
   */
  private disposeModules(): void {
    for (const module of Object.values(this.modules)) {
      module.controller.dispose()
    }
    this.modules = {}
  }

  /**
   * Initialize all registered modules
   */
  private initializeModules(): void {
    // Use updateModulesFromConfig to handle initial state correctly (respects force states and auto-enable)
    this.updateModulesFromConfig()
  }

  /**
   * Get a module controller by ID
   */
  getModule<T = any>(moduleId: string): T | undefined {
    return this.modules[moduleId]?.controller as T | undefined
  }

  protected override anyModuleRequiresHeightmap(): boolean {
    return Object.values(this.modules).some(m => m.enabled && m.manifest.requiresHeightmap)
  }

  /** Returns the active camera container (may differ in VR mode). Used for position resets and rotation. */
  get cameraObject() {
    return this.cameraGroupVr ?? this.cameraContainer
  }

  /**
   * Wraps camera.position in a Proxy that logs a one-time warning when .set/.setX/.setY/.setZ
   * or .x/.y/.z assignment is used with values that look like world coords (|v| > 20).
   * camera.position is scene-local (0,0,0 or 0,0,zOffset). Use cameraWorldPos + sceneOrigin.update().
   */
  private _wrapCameraPositionWithWarning() {
    const realPos = this.camera.position
    const self = this
    const WORLD_COORD_THRESHOLD = 20 // our zOffset is ~4, so 20 catches mistaken world coords
    const looksLikeWorldCoords = (x: number, y: number, z: number) =>
      Math.abs(x) > WORLD_COORD_THRESHOLD || Math.abs(y) > WORLD_COORD_THRESHOLD || Math.abs(z) > WORLD_COORD_THRESHOLD
    const warnOnce = () => {
      if (!self._cameraPositionAccessWarned && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        self._cameraPositionAccessWarned = true
        console.warn(
          '[WorldRendererThree] Do not set camera.position to world coordinates — it is scene-local. ' +
          'Use cameraWorldPos and sceneOrigin.update() to move the camera.'
        )
      }
    }
    const proxy = new Proxy(realPos, {
      set(target, prop, value) {
        if ((prop === 'x' || prop === 'y' || prop === 'z') && typeof value === 'number' && Math.abs(value) > WORLD_COORD_THRESHOLD) {
          warnOnce()
        }
        ;(target as any)[prop] = value
        return true
      },
      get(target, prop, receiver) {
        const value = (target as any)[prop]
        if (prop === 'set') {
          return function (x: number, y: number, z: number) {
            if (looksLikeWorldCoords(x, y, z)) warnOnce()
            return (target as THREE.Vector3).set(x, y, z)
          }
        }
        if (prop === 'setX' || prop === 'setY' || prop === 'setZ') {
          return function (v: number) {
            if (Math.abs(v) > WORLD_COORD_THRESHOLD) warnOnce()
            return (target as any)[prop](v)
          }
        }
        if (prop === 'copy') {
          return function (v: THREE.Vector3) {
            if (looksLikeWorldCoords(v.x, v.y, v.z)) warnOnce()
            return (target as THREE.Vector3).copy(v)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    Object.defineProperty(this.camera, 'position', { value: proxy, configurable: true, enumerable: true })
  }

  worldSwitchActions() {
    this.onWorldSwitched.push(() => {
      // clear custom blocks
      this.protocolCustomBlocks.clear()
      // Reset section animations
      this.sectionsOffsetsAnimations = {}
      // Clear waypoints
      this.waypoints.clear()
      // Stop any running cinematic scripts
      this.cinimaticScript.stopScript()
      // Clear fireworks
      this.fireworks.clear()
    })
  }

  downloadWorldGeometry() {
    downloadWorldGeometry(this, new THREE.Vector3(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z), this.cameraShake.getBaseRotation(), 'world-geometry.json')
  }

  updateEntity(e, isPosUpdate = false) {
    const overrides = {
      rotation: {
        head: {
          x: e.headPitch ?? e.pitch,
          y: e.headYaw,
          z: 0
        }
      }
    }
    if (isPosUpdate) {
      this.entities.updateEntityPosition(e, false, overrides)
    } else {
      this.entities.update(e, overrides)
    }
  }

  updatePlayerEntity(e: any) {
    this.entities.handlePlayerEntity(e)
  }

  resetScene() {
    this.sceneOrigin.update(0, 0, 0)
    this.cameraWorldPos.x = 0
    this.cameraWorldPos.y = 0
    this.cameraWorldPos.z = 0

    this.scene.matrixAutoUpdate = false // for perf
    this.scene.background = new THREE.Color(this.initOptions.config.sceneBackground)
    this.scene.add(this.ambientLight)
    this.directionalLight.position.set(1, 1, 0.5).normalize()
    this.directionalLight.castShadow = true
    this.scene.add(this.directionalLight)

    const size = this.renderer.getSize(new THREE.Vector2())
    this.camera = new THREE.PerspectiveCamera(75, size.x / size.y, 0.1, 1000)
    this._wrapCameraPositionWithWarning()
    this.cameraContainer = new THREE.Object3D()
    this.cameraContainer.add(this.camera)
    this.scene.add(this.cameraContainer)
  }

  override watchReactivePlayerState() {
    super.watchReactivePlayerState()
    this.onReactivePlayerStateUpdated('inWater', (value) => {
      this.skyboxRenderer.updateWaterState(value, this.playerStateReactive.waterBreathing)
    })
    this.onReactivePlayerStateUpdated('waterBreathing', (value) => {
      this.skyboxRenderer.updateWaterState(this.playerStateReactive.inWater, value)
    })
    this.onReactivePlayerStateUpdated('ambientLight', (value) => {
      if (!value) return
      this.ambientLight.intensity = value
    })
    this.onReactivePlayerStateUpdated('directionalLight', (value) => {
      if (!value) return
      this.directionalLight.intensity = value
    })
    this.onReactivePlayerStateUpdated('lookingAtBlock', (value) => {
      this.cursorBlock.setHighlightCursorBlock(value ? new Vec3(value.x, value.y, value.z) : null, value?.shapes)
    })
    this.onReactivePlayerStateUpdated('diggingBlock', (value) => {
      this.cursorBlock.updateBreakAnimation(value ? { x: value.x, y: value.y, z: value.z } : undefined, value?.stage ?? null, value?.mergedShape)
    })
    this.onReactivePlayerStateUpdated('perspective', (value) => {
      // Update camera perspective when it changes
      const vecPos = new Vec3(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z)
      this.updateCamera(vecPos, this.cameraShake.getBaseRotation().yaw, this.cameraShake.getBaseRotation().pitch)
      // todo also update camera when block within camera was changed
    })
  }

  override watchReactiveConfig() {
    super.watchReactiveConfig()
    this.onReactiveConfigUpdated('showChunkBorders', (value) => {
      this.updateShowChunksBorder(value)
    })
    this.onReactiveConfigUpdated('defaultSkybox', (value) => {
      this.skyboxRenderer.updateDefaultSkybox(value)
    })

    let currentHandRenderer = this.displayOptions.inWorldRenderingConfig.handRenderer
    this.onReactiveConfigUpdated('handRenderer', (value) => {
      if (value === currentHandRenderer) return
      currentHandRenderer = value
      const wasReady = this.holdingBlock.ready
      const wasReadyLeft = this.holdingBlockLeft.ready
      this.holdingBlock.dispose()
      this.holdingBlockLeft.dispose()
      this.holdingBlock = createHoldingBlock(this)
      this.holdingBlockLeft = createHoldingBlock(this, true)
      if (wasReady) {
        this.holdingBlock.ready = true
        this.holdingBlock.updateItem()
      }
      if (wasReadyLeft) {
        this.holdingBlockLeft.ready = true
        this.holdingBlockLeft.updateItem()
      }
    })

    // Watch for config changes that affect modules
    this.onReactiveConfigUpdated('*' as any, () => {
      this.updateModulesFromConfig()
    })

    // Initial update
    this.updateModulesFromConfig()
  }

  /**
   * Update module states based on config (force states and auto-enable checks)
   */
  private updateModulesFromConfig(): void {
    const { moduleStates } = this.worldRendererConfig

    for (const [moduleId, module] of Object.entries(this.modules)) {
      const forceState = moduleStates[moduleId]

      // Check force states first
      if (forceState === 'enabled') {
        if (!module.enabled) {
          this.toggleModule(moduleId, true)
        }
        continue
      }

      if (forceState === 'disabled') {
        if (module.enabled && !module.manifest.cannotBeDisabled) {
          this.toggleModule(moduleId, false)
        }
        continue
      }

      // Auto mode: use autoEnableCheck if available, otherwise use enabledDefault
      if (forceState === 'auto' || forceState === undefined) {
        if (module.controller.autoEnableCheck) {
          const shouldEnable = module.controller.autoEnableCheck()

          if (shouldEnable && !module.enabled) {
            this.toggleModule(moduleId, true)
          } else if (!shouldEnable && module.enabled && !module.manifest.cannotBeDisabled) {
            this.toggleModule(moduleId, false)
          }
        } else {
          // No autoEnableCheck: use enabledDefault
          const shouldEnable = module.manifest.enabledDefault ?? false
          if (shouldEnable && !module.enabled) {
            this.toggleModule(moduleId, true)
          } else if (!shouldEnable && module.enabled && !module.manifest.cannotBeDisabled) {
            this.toggleModule(moduleId, false)
          }
        }
      }
    }
  }

  changeHandSwingingState(isAnimationPlaying: boolean, isLeft = false) {
    const holdingBlock = isLeft ? this.holdingBlockLeft : this.holdingBlock
    if (isAnimationPlaying) {
      holdingBlock.startSwing()
    } else {
      holdingBlock.stopSwing()
    }
  }

  async updateAssetsData(): Promise<void> {
    const resources = this.resourcesManager.currentResources

    const oldTexture = this.material.map
    const oldItemsTexture = this.itemsTexture

    const texture = loadThreeJsTextureFromBitmap(resources.blocksAtlasImage!)
    texture.needsUpdate = true
    texture.flipY = false
    this.material.map = texture

    const itemsTexture = loadThreeJsTextureFromBitmap(resources.itemsAtlasImage!)
    itemsTexture.needsUpdate = true
    itemsTexture.flipY = false
    this.itemsTexture = itemsTexture

    if (oldTexture) {
      oldTexture.dispose()
    }
    if (oldItemsTexture) {
      oldItemsTexture.dispose()
    }

    await super.updateAssetsData()
    this.onAllTexturesLoaded()
    if (Object.keys(this.loadedChunks).length > 0) {
      console.log('rerendering chunks because of texture update')
      this.rerenderAllChunks()
    }
  }

  onAllTexturesLoaded() {
    this.holdingBlock.ready = true
    this.holdingBlock.updateItem()
    this.holdingBlockLeft.ready = true
    this.holdingBlockLeft.updateItem()
  }

  changeBackgroundColor(color: [number, number, number]): void {
    this.realScene.background = new THREE.Color(color[0], color[1], color[2])
  }

  changeCardinalLight(cardinalLight: string): void {
    this.worldRendererConfig.cardinalLight = cardinalLight
  }

  timeUpdated(newTime: number): void {
    // Update starfield module with time
    const starfieldModule = this.getModule<any>('starfield')
    if (starfieldModule?.updateTimeOfDay) {
      starfieldModule.updateTimeOfDay(newTime)
    }

    this.skyboxRenderer.updateTime(newTime)
  }

  biomeUpdated(biome: Biome): void {
    if (biome?.temperature !== undefined) {
      this.skyboxRenderer.updateTemperature(biome.temperature)
    }
  }

  biomeReset(): void {
    // Reset to default temperature when biome is unknown
    this.skyboxRenderer.updateTemperature(DEFAULT_TEMPERATURE)
  }

  getItemRenderData(item: Record<string, any>, specificProps: ItemSpecificContextProperties) {
    return getItemUv(item, specificProps, this.resourcesManager, this.playerStateReactive)
  }

  async demoModel() {
    //@ts-expect-error
    const pos = cursorBlockRel(0, 1, 0).position

    const mesh = (await getMyHand())!
    // mesh.rotation.y = THREE.MathUtils.degToRad(90)
    setBlockPosition(mesh, pos)
    const helper = new THREE.BoxHelper(mesh, 0xff_ff_00)
    mesh.add(helper)
    this.realScene.add(mesh)
  }

  demoItem() {
    //@ts-expect-error
    const pos = cursorBlockRel(0, 1, 0).position
    const { mesh } = this.entities.getItemMesh({
      itemId: 541,
    }, {})!
    mesh.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    // mesh.scale.set(0.5, 0.5, 0.5)
    const helper = new THREE.BoxHelper(mesh, 0xff_ff_00)
    mesh.add(helper)
    this.realScene.add(mesh)
  }

  debugOverlayAdded = false
  addDebugOverlay() {
    if (this.debugOverlayAdded) return
    this.debugOverlayAdded = true
    const pane = addNewStat('debug-overlay')
    setInterval(() => {
      pane.setVisibility(this.displayAdvancedStats)
      if (this.displayAdvancedStats) {
        const formatBigNumber = (num: number) => {
          return new Intl.NumberFormat('en-US', {}).format(num)
        }
        let text = ''
        text += `C: ${formatBigNumber(this.renderer.info.render.calls)} `
        text += `TR: ${formatBigNumber(this.renderer.info.render.triangles)} `
        text += `TE: ${formatBigNumber(this.renderer.info.memory.textures)} `
        text += `F: ${formatBigNumber(this.tilesRendered)} `
        text += `B: ${formatBigNumber(this.blocksRendered)} `
        text += `MEM: ${this.chunkMeshManager.getEstimatedMemoryUsage().total} `
        const poolStats = this.chunkMeshManager.getStats()
        text += `POOL: ${poolStats.activeCount}/${poolStats.poolSize} HR: ${poolStats.hitRate}`
        pane.updateText(text)
        this.backendInfoReport = text
      }
    }, 200)
  }

  /**
   * Optionally update data that are depedendent on the viewer position
   */
  updatePosDataChunk(key: string) {
    const [x, y, z] = key.split(',').map(x => Math.floor(+x / 16))
    // sum of distances: x + y + z
    const chunkDistance = Math.abs(x - this.cameraSectionPos.x) + Math.abs(y - this.cameraSectionPos.y) + Math.abs(z - this.cameraSectionPos.z)
    const sectionObj = this.sectionObjects[key]
    const section = (sectionObj as any).mesh ?? sectionObj.children.find(child => child.name === 'mesh')!
    section.renderOrder = 500 - chunkDistance
  }

  override updateViewerPosition(pos: Vec3): void {
    this.viewerChunkPosition = pos
  }

  cameraSectionPositionUpdate() {
    // eslint-disable-next-line guard-for-in
    for (const key in this.sectionObjects) {
      const value = this.sectionObjects[key]
      if (!value) continue
      this.updatePosDataChunk(key)
    }
  }

  getDir(current: number, origin: number) {
    if (current === origin) return 0
    return current < origin ? 1 : -1
  }

  finishChunk(chunkKey: string) {
    // Reveal all sections of this chunk that were held invisible by the
    // "Batch Chunks Display" (`_renderByChunks`) option. No-op when the
    // option is off — `waitingChunksToDisplay` is empty in that case.
    this.chunkMeshManager.finishChunkDisplay(chunkKey)
  }

  private applyPendingSectionUpdates() {
    if (this.pendingSectionUpdates.size === 0) return

    const now = performance.now()
    const sectionHeight = this.getSectionHeight()
    const ready: string[] = []

    for (const key of this.pendingSectionUpdates.keys()) {
      const startedAt = this.pendingSectionBufferStartTimes.get(key) ?? now
      const sinceFirst = now - startedAt

      if (sinceFirst < WorldRendererThree.MAX_SECTION_UPDATE_BUFFER_MS) {
        // Still within this section's grace window — wait if any neighbor is
        // currently being re-meshed so we don't briefly expose a hole between
        // the just-updated section and a stale neighbor (sky-flicker bug).
        const [sx, sy, sz] = key.split(',').map(Number)
        const neighborKeys = [
          `${sx - 16},${sy},${sz}`, `${sx + 16},${sy},${sz}`,
          `${sx},${sy - sectionHeight},${sz}`, `${sx},${sy + sectionHeight},${sz}`,
          `${sx},${sy},${sz - 16}`, `${sx},${sy},${sz + 16}`,
        ]
        let neighborBusy = false
        for (const neighborKey of neighborKeys) {
          if (
            this.sectionsWaiting.has(neighborKey) &&
            !this.pendingSectionUpdates.has(neighborKey) &&
            this.sectionObjects[neighborKey]
          ) {
            neighborBusy = true
            break
          }
        }
        if (neighborBusy) continue
      }

      ready.push(key)
    }

    if (ready.length === 0) return

    for (const key of ready) {
      const update = this.pendingSectionUpdates.get(key)!
      this.pendingSectionUpdates.delete(key)
      this.pendingSectionBufferStartTimes.delete(key)

      const chunkCoords = update.key.split(',')
      const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`

      if (!this.loadedChunks[chunkKey] || !this.active) {
        this.chunkMeshManager.releaseSection(update.key)
        continue
      }

      if (!update.geometry.positions.length) {
        this.chunkMeshManager.releaseSection(update.key)
        continue
      }

      this.chunkMeshManager.updateSection(update.key, update.geometry)
      this.updatePosDataChunk(update.key)
    }
  }

  private clearPendingSectionUpdatesForChunk(x: number, z: number) {
    for (const key of [...this.pendingSectionUpdates.keys()]) {
      if (key.startsWith(`${x},`) && key.endsWith(`,${z}`)) {
        this.pendingSectionUpdates.delete(key)
        this.pendingSectionBufferStartTimes.delete(key)
      }
    }
  }

  handleWorkerMessage(data: { geometry: MesherGeometryOutput, key, type }): void {
    if (data.type === 'geometry') {
      const chunkCoords = data.key.split(',')
      const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`
      if (!this.loadedChunks[chunkKey] || !this.active) {
        this.pendingSectionUpdates.delete(data.key)
        this.pendingSectionBufferStartTimes.delete(data.key)
        return
      }

      if (this.sectionObjects[data.key]) {
        this.pendingSectionUpdates.set(data.key, data)
        // Per-section deadline: only set if we don't already have one, so
        // repeated updates to the same section don't postpone its flush.
        if (!this.pendingSectionBufferStartTimes.has(data.key)) {
          this.pendingSectionBufferStartTimes.set(data.key, performance.now())
        }
        return
      }

      if (!data.geometry.positions.length) {
        this.chunkMeshManager.releaseSection(data.key)
        return
      }
      this.chunkMeshManager.updateSection(data.key, data.geometry)
      this.updatePosDataChunk(data.key)
    }
  }


  getSignTexture(position: Vec3, blockEntity, isHanging, backSide = false) {
    const chunk = chunkPos(position)
    let textures = this.chunkTextures.get(`${chunk[0]},${chunk[1]}`)
    if (!textures) {
      textures = {}
      this.chunkTextures.set(`${chunk[0]},${chunk[1]}`, textures)
    }
    const texturekey = `${position.x},${position.y},${position.z}`
    // todo investigate bug and remove this so don't need to clean in section dirty
    if (textures[texturekey]) return textures[texturekey]

    const PrismarineChat = PrismarineChatLoader(this.version)
    const canvas = renderSign(blockEntity, isHanging, PrismarineChat)
    if (!canvas) return
    const tex = new THREE.Texture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.needsUpdate = true
    textures[texturekey] = tex
    return tex
  }

  getCameraPosition(target?: THREE.Vector3): THREE.Vector3 {
    return (target ?? this._tmpCameraPos).set(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z)
  }

  getSectionCameraPosition() {
    const pos = this.getCameraPosition()
    return new Vec3(
      Math.floor(pos.x / 16),
      Math.floor(pos.y / 16),
      Math.floor(pos.z / 16)
    )
  }

  updateCameraSectionPos() {
    const newSectionPos = this.getSectionCameraPosition()
    if (!this.cameraSectionPos.equals(newSectionPos)) {
      this.cameraSectionPos = newSectionPos
      this.cameraSectionPositionUpdate()
    }
  }

  setFirstPersonCamera(pos: Vec3 | null, yaw: number, pitch: number) {
    const yOffset = this.playerStateReactive.eyeHeight

    this.updateCamera(pos?.offset(0, yOffset, 0) ?? null, yaw, pitch)
    this.media.tryIntersectMedia()
    this.updateCameraSectionPos()
  }

  getThirdPersonCamera(pos: THREE.Vector3 | null, yaw: number, pitch: number) {
    pos ??= new THREE.Vector3(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z)

    // Calculate camera offset based on perspective
    const isBack = this.playerStateReactive.perspective === 'third_person_back'
    const distance = 4 // Default third person distance

    // Calculate direction vector using proper world orientation
    // We need to get the camera's current look direction and use that for positioning

    // Create a direction vector that represents where the camera is looking
    // This matches the Three.js camera coordinate system
    const direction = this._tpDirection.set(0, 0, -1) // Forward direction in camera space

    // Apply the same rotation that's applied to the camera container
    const pitchQuat = this._tpPitchQuat.setFromAxisAngle(this._tpAxisX, pitch)
    const yawQuat = this._tpYawQuat.setFromAxisAngle(this._tpAxisY, yaw)
    const finalQuat = this._tpFinalQuat.multiplyQuaternions(yawQuat, pitchQuat)

    // Transform the direction vector by the camera's rotation
    direction.applyQuaternion(finalQuat)

    // For back view, we want the camera behind the player (opposite to view direction)
    // For front view, we want the camera in front of the player (same as view direction)
    if (isBack) {
      direction.multiplyScalar(-1)
    }

    // Create debug visualization if advanced stats are enabled
    if (this.DEBUG_RAYCAST) {
      this.debugRaycast(pos, direction, distance)
    }

    // Convert world position to scene-relative coordinates for raycasting
    const scenePos = this._tpScenePos.set(
      this.sceneOrigin.toSceneX(pos.x),
      this.sceneOrigin.toSceneY(pos.y),
      this.sceneOrigin.toSceneZ(pos.z)
    )

    // Perform raycast to avoid camera going through blocks
    const raycaster = this._tpRaycaster
    raycaster.set(scenePos, direction)
    raycaster.far = distance // Limit raycast distance

    // Filter to only nearby chunks for performance
    const nearbyChunks = Object.values(this.sectionObjects)
      .filter(obj => obj.name === 'chunk' && obj.visible)
      .filter(obj => {
        // Get the mesh child which has the actual geometry
        const mesh = obj.children.find(child => child.name === 'mesh')
        if (!mesh) return false

        // Check distance from player position to chunk
        const chunkWorldPos = this._tpChunkWorldPos
        mesh.getWorldPosition(chunkWorldPos)
        const distance = scenePos.distanceTo(chunkWorldPos)
        return distance < 80 // Only check chunks within 80 blocks
      })

    // Get all mesh children for raycasting
    const meshes: THREE.Object3D[] = []
    for (const chunk of nearbyChunks) {
      const mesh = chunk.children.find(child => child.name === 'mesh')
      if (mesh) meshes.push(mesh)
    }

    const intersects = raycaster.intersectObjects(meshes, false)

    let finalDistance = distance
    if (intersects.length > 0) {
      // Use intersection distance minus a small offset to prevent clipping
      finalDistance = Math.max(0.5, intersects[0].distance - 0.2)
    }

    const finalPos = new Vec3(
      pos.x + direction.x * finalDistance,
      pos.y + direction.y * finalDistance,
      pos.z + direction.z * finalDistance
    )

    return finalPos
  }

  private debugRaycastHelper?: THREE.ArrowHelper
  private debugHitPoint?: THREE.Mesh

  private debugRaycast(pos: THREE.Vector3, direction: THREE.Vector3, distance: number) {
    // Remove existing debug objects
    if (this.debugRaycastHelper) {
      this.realScene.remove(this.debugRaycastHelper)
      this.debugRaycastHelper = undefined
    }
    if (this.debugHitPoint) {
      this.realScene.remove(this.debugHitPoint)
      this.debugHitPoint = undefined
    }

    // Convert world position to scene-relative coordinates
    const scenePos = new THREE.Vector3(
      this.sceneOrigin.toSceneX(pos.x),
      this.sceneOrigin.toSceneY(pos.y),
      this.sceneOrigin.toSceneZ(pos.z)
    )

    // Create raycast arrow
    this.debugRaycastHelper = new THREE.ArrowHelper(
      direction.clone().normalize(),
      scenePos,
      distance,
      0xff_00_00, // Red color
      distance * 0.1,
      distance * 0.05
    )
    this.realScene.add(this.debugRaycastHelper)

    // Create hit point indicator
    const hitGeometry = new THREE.SphereGeometry(0.2, 8, 8)
    const hitMaterial = new THREE.MeshBasicMaterial({ color: 0x00_ff_00 })
    this.debugHitPoint = new THREE.Mesh(hitGeometry, hitMaterial)
    this.debugHitPoint.position.copy(scenePos).add(direction.clone().multiplyScalar(distance))
    this.realScene.add(this.debugHitPoint)
  }

  prevFramePerspective = null as string | null

  setCinimaticCamera(pos: Vec3, yaw: number, pitch: number): void {
    // Directly set camera position and rotation for cinematic mode
    this.cameraWorldPos.x = pos.x
    this.cameraWorldPos.y = pos.y
    this.cameraWorldPos.z = pos.z
    this.sceneOrigin.update(pos.x, pos.y, pos.z)
    this.cameraObject.position.set(0, 0, 0)
    this.cameraShake.setBaseRotation(pitch, yaw)
    this.updateCameraSectionPos()
  }

  setCinimaticFov(fov: number): void {
    this.camera.fov = fov
    this.camera.updateProjectionMatrix()
  }

  updateCamera(pos: Vec3 | null, yaw: number, pitch: number): void {
    // Skip position/rotation updates if cinematic script is running
    if (this.cinimaticScript.running) {
      return
    }

    // if (this.freeFlyMode) {
    //   pos = this.freeFlyState.position
    //   pitch = this.freeFlyState.pitch
    //   yaw = this.freeFlyState.yaw
    // }

    if (pos) {
      if (this.renderer.xr.isPresenting) {
        pos.y -= this.camera.position.y // Fix Y position of camera in world
      }

      this.currentPosTween?.stop()
      // Use instant camera updates (0 delay) in playground mode when camera controls are enabled
      const tweenDelay = this.displayOptions.inWorldRenderingConfig.instantCameraUpdate
        ? 0
        : (this.playerStateUtils.isSpectatingEntity() ? 150 : 50)
      this.currentPosTween = new tweenJs.Tween(this.cameraWorldPos)
        .to({ x: pos.x, y: pos.y, z: pos.z }, tweenDelay)
        .onUpdate(() => {
          this.sceneOrigin.update(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z)
          this.cameraObject.position.set(0, 0, 0)
        })
        .start()
      // this.freeFlyState.position = pos
    }

    if (this.playerStateUtils.isSpectatingEntity()) {
      const rotation = this.cameraShake.getBaseRotation()
      // wrap in the correct direction
      let yawOffset = 0
      const halfPi = Math.PI / 2
      if (rotation.yaw < halfPi && yaw > Math.PI + halfPi) {
        yawOffset = -Math.PI * 2
      } else if (yaw < halfPi && rotation.yaw > Math.PI + halfPi) {
        yawOffset = Math.PI * 2
      }
      this.currentRotTween?.stop()
      this.currentRotTween = new tweenJs.Tween(rotation).to({ pitch, yaw: yaw + yawOffset }, 100)
        .onUpdate(params => this.cameraShake.setBaseRotation(params.pitch, params.yaw - yawOffset)).start()
    } else {
      this.currentRotTween?.stop()
      this.cameraShake.setBaseRotation(pitch, yaw)

      const { perspective } = this.playerStateReactive
      if (perspective === 'third_person_back' || perspective === 'third_person_front') {
        // Use getThirdPersonCamera for proper raycasting with max distance of 4
        const currentWorldPos = new THREE.Vector3(this.cameraWorldPos.x, this.cameraWorldPos.y, this.cameraWorldPos.z)
        const thirdPersonPos = this.getThirdPersonCamera(
          currentWorldPos,
          yaw,
          pitch
        )

        const distance = currentWorldPos.distanceTo(new THREE.Vector3(thirdPersonPos.x, thirdPersonPos.y, thirdPersonPos.z))
        // Apply Z offset based on perspective and calculated distance
        const zOffset = perspective === 'third_person_back' ? distance : -distance
        this.camera.position.set(0, 0, zOffset)

        if (perspective === 'third_person_front') {
          // Flip camera view 180 degrees around Y axis for front view
          this.camera.rotation.set(0, Math.PI, 0)
        } else {
          this.camera.rotation.set(0, 0, 0)
        }
      } else {
        // Only reset z (clears third-person offset); x/y are managed by CameraShake for bobbing
        this.camera.position.z = 0
        this.camera.rotation.set(0, 0, 0)

        // remove any debug raycasting
        if (this.debugRaycastHelper) {
          this.realScene.remove(this.debugRaycastHelper)
          this.debugRaycastHelper = undefined
        }
        if (this.debugHitPoint) {
          this.realScene.remove(this.debugHitPoint)
          this.debugHitPoint = undefined
        }
      }
    }

    this.updateCameraSectionPos()
  }

  debugChunksVisibilityOverride() {
    const { chunksRenderAboveOverride, chunksRenderBelowOverride, chunksRenderDistanceOverride, chunksRenderAboveEnabled, chunksRenderBelowEnabled, chunksRenderDistanceEnabled } = this.reactiveDebugParams

    const sectionHeight = this.getSectionHeight()
    const baseY = this.cameraSectionPos.y * sectionHeight

    if (
      this.displayOptions.inWorldRenderingConfig.enableDebugOverlay &&
      chunksRenderAboveOverride !== undefined ||
      chunksRenderBelowOverride !== undefined ||
      chunksRenderDistanceOverride !== undefined
    ) {
      for (const [key, object] of Object.entries(this.sectionObjects)) {
        if (object._waitingForChunkDisplay) continue
        const [x, y, z] = key.split(',').map(Number)
        const isVisible =
          // eslint-disable-next-line no-constant-binary-expression, sonarjs/no-redundant-boolean
          (chunksRenderAboveEnabled && chunksRenderAboveOverride !== undefined) ? y <= (baseY + chunksRenderAboveOverride) : true &&
            // eslint-disable-next-line @stylistic/indent-binary-ops, no-constant-binary-expression, sonarjs/no-redundant-boolean
            (chunksRenderBelowEnabled && chunksRenderBelowOverride !== undefined) ? y >= (baseY - chunksRenderBelowOverride) : true &&
              // eslint-disable-next-line @stylistic/indent-binary-ops
              (chunksRenderDistanceEnabled && chunksRenderDistanceOverride !== undefined) ? Math.abs(y - baseY) <= chunksRenderDistanceOverride : true

        object.visible = isVisible
      }
    } else {
      // No debug visibility override active — defer to the manager so the
      // performance-based override distance (set by `recordRenderTime` /
      // `autoLowerRenderDistance`) is honored, instead of force-showing every
      // section every frame and clobbering it.
      this.chunkMeshManager.updateSectionsVisibility()
    }
  }

  render(sizeChanged = false) {
    this.currentRenderedFrames++
    if (this.reactiveDebugParams.stopRendering) return
    this.debugChunksVisibilityOverride()
    const start = performance.now()
    this.lastRendered = performance.now()
    const deltaTime = this.lastRenderTime > 0
      ? Math.min(Math.max((start - this.lastRenderTime) / 1000, 0), 0.1)
      : 1 / 60
    this.lastRenderTime = start
    this.cursorBlock.render()
    this.updateSectionOffsets()

    // Update skybox position to follow camera
    const cameraPos = this.getCameraPosition()
    this.skyboxRenderer.update(cameraPos, this.viewDistance)

    const sizeOrFovChanged = sizeChanged || this.displayOptions.inWorldRenderingConfig.fov !== this.camera.fov
    if (sizeOrFovChanged) {
      const size = this.renderer.getSize(new THREE.Vector2())
      this.camera.aspect = size.width / size.height
      this.camera.fov = this.displayOptions.inWorldRenderingConfig.fov
      this.camera.updateProjectionMatrix()
    }

    if (!this.reactiveDebugParams.disableEntities) {
      this.entities.render()
    }

    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    const cam = this.cameraGroupVr instanceof THREE.Group ? this.cameraGroupVr.children.find(child => child instanceof THREE.PerspectiveCamera) as THREE.PerspectiveCamera : this.camera
    this.applyPendingSectionUpdates()
    this.renderer.render(this.scene, cam)

    if (
      this.displayOptions.inWorldRenderingConfig.showHand &&
      this.playerStateReactive.gameMode !== 'spectator' &&
      this.playerStateReactive.perspective === 'first_person' &&
      // !this.freeFlyMode &&
      !this.renderer.xr.isPresenting
    ) {
      this.holdingBlock.render(this.camera, this.renderer, this.ambientLight, this.directionalLight)
      this.holdingBlockLeft.render(this.camera, this.renderer, this.ambientLight, this.directionalLight)
    }

    for (const fountain of this.fountains) {
      if (this.sectionObjects[fountain.sectionId] && !this.sectionObjects[fountain.sectionId].foutain) {
        fountain.createParticles(this.sectionObjects[fountain.sectionId])
        this.sectionObjects[fountain.sectionId].foutain = true
      }
      fountain.render()
    }

    this.waypoints.render()
    this.fireworks.update()

    for (const onRender of this.onRender) {
      onRender(deltaTime)
    }
    const end = performance.now()
    const totalTime = end - start
    if (this.worldRendererConfig.autoLowerRenderDistance) {
      this.chunkMeshManager.recordRenderTime(totalTime)
    }
    this.renderTimeAvgCount++
    this.renderTimeAvg = ((this.renderTimeAvg * (this.renderTimeAvgCount - 1)) + totalTime) / this.renderTimeAvgCount
    this.renderTimeMax = Math.max(this.renderTimeMax, totalTime)
  }

  renderHead(position: Vec3, rotation: number, isWall: boolean, blockEntity) {
    let textureData: string
    if (blockEntity.SkullOwner) {
      textureData = blockEntity.SkullOwner.Properties?.textures?.[0]?.Value
    } else {
      textureData = blockEntity.profile?.properties?.find(p => p.name === 'textures')?.value
    }
    if (!textureData) return

    try {
      const decodedData = JSON.parse(Buffer.from(textureData, 'base64').toString())
      let skinUrl = decodedData.textures?.SKIN?.url
      const { skinTexturesProxy } = this.worldRendererConfig
      if (skinTexturesProxy) {
        skinUrl = skinUrl?.replace('http://textures.minecraft.net/', skinTexturesProxy)
          .replace('https://textures.minecraft.net/', skinTexturesProxy)
      }

      const mesh = getMesh(this, skinUrl, armorModel.head as any)
      const group = new THREE.Group()
      if (isWall) {
        mesh.position.set(0, 0.3125, 0.3125)
      }
      // move head model down as armor have a different offset than blocks
      mesh.position.y -= 23 / 16
      group.add(mesh)
      this.sceneOrigin.track(group)
      group.position.set(position.x + 0.5, position.y + 0.045, position.z + 0.5)
      group.rotation.set(
        0,
        -THREE.MathUtils.degToRad(rotation * (isWall ? 90 : 45 / 2)),
        0
      )
      group.scale.set(0.8, 0.8, 0.8)
      return group
    } catch (err) {
      console.error('Error decoding player texture:', err)
    }
  }

  renderSign(position: Vec3, rotation: number, isWall: boolean, isHanging: boolean, blockEntity) {
    const tex = this.getSignTexture(position, blockEntity, isHanging)

    if (!tex) return

    // todo implement
    // const key = JSON.stringify({ position, rotation, isWall })
    // if (this.signsCache.has(key)) {
    //   console.log('cached', key)
    // } else {
    //   this.signsCache.set(key, tex)
    // }

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
    mesh.renderOrder = 999

    const lineHeight = 7 / 16
    const scaleFactor = isHanging ? 1.3 : 1
    mesh.scale.set(1 * scaleFactor, lineHeight * scaleFactor, 1 * scaleFactor)

    const thickness = (isHanging ? 2 : 1.5) / 16
    const wallSpacing = 0.25 / 16
    if (isWall && !isHanging) {
      mesh.position.set(0, 0, -0.5 + thickness + wallSpacing + 0.0001)
    } else {
      mesh.position.set(0, 0, thickness / 2 + 0.0001)
    }

    const group = new THREE.Group()
    group.rotation.set(
      0,
      -THREE.MathUtils.degToRad(rotation * (isWall ? 90 : 45 / 2)),
      0
    )
    group.add(mesh)
    const height = (isHanging ? 10 : 8) / 16
    const heightOffset = (isHanging ? 0 : isWall ? 4.333 : 9.333) / 16
    const textPosition = height / 2 + heightOffset
    this.sceneOrigin.track(group)
    group.position.set(position.x + 0.5, position.y + textPosition, position.z + 0.5)
    return group
  }

  lightUpdate(chunkX: number, chunkZ: number) {
    // set all sections in the chunk dirty
    for (let y = this.worldSizeParams.minY; y < this.worldSizeParams.worldHeight; y += 16) {
      this.setSectionDirty(new Vec3(chunkX, y, chunkZ))
    }
  }

  rerenderAllChunks() { // todo not clear what to do with loading chunks
    for (const key of Object.keys(this.sectionObjects)) {
      const [x, y, z] = key.split(',').map(Number)
      this.setSectionDirty(new Vec3(x, y, z))
    }
  }

  updateShowChunksBorder(value: boolean) {
    // Lazily create helpers on the first toggle (they are not created upfront
    // for sections streamed in while the option was off).
    this.chunkMeshManager.updateAllBoxHelpers(value)
  }

  resetWorld() {
    super.resetWorld()

    this.pendingSectionUpdates.clear()
    this.pendingSectionBufferStartTimes.clear()
    this.chunkMeshManager.dispose()
    this.chunkMeshManager = new ChunkMeshManager(this, this.scene, this.material, this.worldSizeParams.worldHeight, this.viewDistance)

    // Clean up debug objects
    if (this.debugRaycastHelper) {
      this.realScene.remove(this.debugRaycastHelper)
      this.debugRaycastHelper = undefined
    }
    if (this.debugHitPoint) {
      this.realScene.remove(this.debugHitPoint)
      this.debugHitPoint = undefined
    }
  }

  getLoadedChunksRelative(pos: Vec3, includeY = false) {
    const [currentX, currentY, currentZ] = sectionPos(pos)
    return Object.fromEntries(Object.entries(this.sectionObjects).map(([key, o]) => {
      const [xRaw, yRaw, zRaw] = key.split(',').map(Number)
      const [x, y, z] = sectionPos({ x: xRaw, y: yRaw, z: zRaw })
      const setKey = includeY ? `${x - currentX},${y - currentY},${z - currentZ}` : `${x - currentX},${z - currentZ}`
      return [setKey, o]
    }))
  }

  cleanChunkTextures(x, z) {
    const textures = this.chunkTextures.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? {}
    for (const key of Object.keys(textures)) {
      textures[key].dispose()
      delete textures[key]
    }
    // Sign / head textures moved to ChunkMeshManager.signHeadsRenderer in PR
    // #16; without invalidating that cache here, sign edits (and any other
    // block-entity NBT change picked up via setSectionDirty) would re-render
    // with the stale cached canvas until a full world reset.
    this.chunkMeshManager.cleanSignChunkTextures(x, z)
  }

  readdChunks() {
    for (const key of Object.keys(this.sectionObjects)) {
      this.scene.remove(this.sectionObjects[key])
    }
    setTimeout(() => {
      for (const key of Object.keys(this.sectionObjects)) {
        this.scene.add(this.sectionObjects[key])
      }
    }, 500)
  }

  disableUpdates(children = this.scene.children) {
    for (const child of children) {
      child.matrixWorldNeedsUpdate = false
      this.disableUpdates(child.children ?? [])
    }
  }

  removeColumn(x, z) {
    super.removeColumn(x, z)

    this.cleanChunkTextures(x, z)
    this.clearPendingSectionUpdatesForChunk(x, z)
    const sectionHeight = this.getSectionHeight()
    const worldMinY = this.worldMinYRender
    for (let y = worldMinY; y < this.worldSizeParams.worldHeight; y += sectionHeight) {
      const key = `${x},${y},${z}`
      if (this.chunkMeshManager.sectionObjects[key]) {
        this.chunkMeshManager.releaseSection(key)
      }
    }
    // Drop near-first reveal state and re-check any farther chunks
    // that may have been blocked by this column.
    this.chunkMeshManager.onChunkRemovedFromGate(`${x},${z}`)
  }

  protected onViewerChunkPositionChanged(): void {
    this.chunkMeshManager.tryRevealPending()
  }

  setSectionDirty(...args: Parameters<WorldRendererCommon['setSectionDirty']>) {
    const [pos] = args
    this.cleanChunkTextures(pos.x, pos.z) // todo don't do this!
    super.setSectionDirty(...args)
  }

  static getRendererInfo(renderer: THREE.WebGLRenderer) {
    try {
      const gl = renderer.getContext()
      return `${gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')!.UNMASKED_RENDERER_WEBGL)}`
    } catch (err) {
      console.warn('Failed to get renderer info', err)
    }
  }

  worldStop() {
    this.media.onWorldStop()
  }

  destroy(): void {
    this.pendingSectionUpdates.clear()
    this.pendingSectionBufferStartTimes.clear()
    this.chunkMeshManager.dispose()
    this.disposeModules()
    this.fireworksLegacy.destroy()
    super.destroy()
    this.skyboxRenderer.dispose()
    this.fireworks.dispose()
  }

  shouldObjectVisible(object: THREE.Object3D) {
    // Get chunk coordinates - use world coords from userData if available, otherwise convert from scene coords
    const CHUNK_SIZE = 16
    const sectionHeight = this.getSectionHeight()
    let worldX: number, worldY: number, worldZ: number
    const wp = this.sceneOrigin.getWorldPosition(object)
    if (wp) {
      worldX = wp.x
      worldY = wp.y
      worldZ = wp.z
    } else {
      // Fallback for untracked objects: convert scene coords back to world
      worldX = this.sceneOrigin.toWorldX(object.position.x)
      worldY = this.sceneOrigin.toWorldY(object.position.y)
      worldZ = this.sceneOrigin.toWorldZ(object.position.z)
    }
    const chunkX = Math.floor(worldX / CHUNK_SIZE) * CHUNK_SIZE
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE) * CHUNK_SIZE
    const sectionY = Math.floor(worldY / sectionHeight) * sectionHeight

    const chunkKey = `${chunkX},${chunkZ}`
    const sectionKey = `${chunkX},${sectionY},${chunkZ}`

    return !!this.finishedChunks[chunkKey] || !!this.sectionObjects[sectionKey]
  }

  handleUserClick(button: 'left' | 'right') {
    this.media.handleUserClick(button)
  }

  updateSectionOffsets() {
    const currentTime = performance.now()
    for (const [key, anim] of Object.entries(this.sectionsOffsetsAnimations)) {
      const timeDelta = (currentTime - anim.time) / 1000 // Convert to seconds
      anim.time = currentTime

      // Update offsets based on speed and time delta
      anim.currentOffsetX += anim.speedX * timeDelta
      anim.currentOffsetY += anim.speedY * timeDelta
      anim.currentOffsetZ += anim.speedZ * timeDelta

      // Apply limits if they exist
      if (anim.limitX !== undefined) {
        if (anim.speedX > 0) {
          anim.currentOffsetX = Math.min(anim.currentOffsetX, anim.limitX)
        } else {
          anim.currentOffsetX = Math.max(anim.currentOffsetX, anim.limitX)
        }
      }
      if (anim.limitY !== undefined) {
        if (anim.speedY > 0) {
          anim.currentOffsetY = Math.min(anim.currentOffsetY, anim.limitY)
        } else {
          anim.currentOffsetY = Math.max(anim.currentOffsetY, anim.limitY)
        }
      }
      if (anim.limitZ !== undefined) {
        if (anim.speedZ > 0) {
          anim.currentOffsetZ = Math.min(anim.currentOffsetZ, anim.limitZ)
        } else {
          anim.currentOffsetZ = Math.max(anim.currentOffsetZ, anim.limitZ)
        }
      }

      // Apply the offset to the section object (compose with camera-relative base position)
      const section = this.sectionObjects[key]
      if (section) {
        section.position.set(
          anim.currentOffsetX,
          anim.currentOffsetY,
          anim.currentOffsetZ
        )
        section.updateMatrix()
      }
    }
  }

  reloadWorld() {
    this.entities.reloadEntities()
  }
}
