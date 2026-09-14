import { EventEmitter } from 'events'
import { test, expect, vi, describe, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { proxy } from 'valtio'
import { Vec3 } from 'vec3'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'
import { computeSectionVisibilitySet } from '../../mesher-shared/visGraph'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'
import { defaultPerformanceInstabilityFactors } from '../../performanceMonitor'
import { getInitialPlayerState } from '../../playerState/playerState'
import type { DisplayWorldOptions, GraphicsInitOptions } from '../../graphicsBackend/types'

vi.mock('../entity/EntityMesh', () => ({
  getMesh: vi.fn()
}))

vi.mock('../entities', () => ({
  Entities: vi.fn().mockImplementation(function Entities() {
    return { render: vi.fn() }
  })
}))

vi.mock('../skyboxRenderer', () => ({
  SkyboxRenderer: vi.fn().mockImplementation(function SkyboxRenderer() {
    return { init: vi.fn().mockResolvedValue(undefined) }
  }),
  DEFAULT_TEMPERATURE: 0.8
}))

vi.mock('../modules/index', () => ({
  BUILTIN_MODULES: {}
}))

vi.mock('../holdingBlockFactory', () => ({
  createHoldingBlock: vi.fn(() => ({ render: vi.fn() }))
}))

vi.mock('../hand', () => ({
  getMyHand: vi.fn()
}))

vi.mock('../world/cursorBlock', () => ({
  CursorBlock: vi.fn()
}))

vi.mock('../threeJsSound', () => ({
  ThreeJsSound: vi.fn()
}))

vi.mock('../cameraShake', () => ({
  CameraShake: vi.fn()
}))

vi.mock('../threeJsMedia', () => ({
  ThreeJsMedia: vi.fn()
}))

vi.mock('../waypoints', () => ({
  WaypointsRenderer: vi.fn()
}))

vi.mock('../fireworksRenderer', () => ({
  FireworksRenderer: vi.fn()
}))

vi.mock('../cinimaticScript', () => ({
  CinimaticScriptRunner: vi.fn()
}))

vi.mock('../fireworks', () => ({
  FireworksManager: vi.fn()
}))

vi.mock('../../lib/ui/newStats', () => ({
  addNewStat: vi.fn(() => ({ updateText: vi.fn(), setVisibility: vi.fn() })),
  updateStatText: vi.fn(),
  removeAllStats: vi.fn(),
  updatePanesVisibility: vi.fn(),
  MC_RENDERER_DEBUG_OVERLAY_CLASS: 'mc-renderer-debug-overlay'
}))

vi.mock('../../lib/utils/skins', () => ({
  setSkinsConfig: vi.fn(),
  steveTexture: {},
  stevePngUrl: ''
}))

vi.mock('@tweenjs/tween.js', () => ({
  default: {},
  Tween: vi.fn(),
  Easing: {}
}))

import { ChunkMeshManager } from '../chunkMeshManager'
import { WorldRendererThree } from '../worldRendererThree'

const ALL_OPEN = computeSectionVisibilitySet(16, () => false)
const SOLID = computeSectionVisibilitySet(16, () => true)

function makeQuadArrays() {
  const positions = new Float32Array([-1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1])
  const colors = new Float32Array(12).fill(1)
  const skyLights = new Float32Array(4).fill(1)
  const blockLights = new Float32Array(4).fill(0)
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  return { positions, colors, skyLights, blockLights, uvs, indices }
}

function makeEmptyGeometry(key: string, visibilitySet = ALL_OPEN): MesherGeometryOutput {
  const [x, y, z] = key.split(',').map(Number)
  return {
    sectionYNumber: 0,
    chunkKey: `${x},${z}`,
    sectionStartY: y!,
    sectionEndY: y! + 16,
    sectionStartX: x!,
    sectionEndX: x! + 16,
    sectionStartZ: z!,
    sectionEndZ: z! + 16,
    sx: x! + 8,
    sy: y! + 8,
    sz: z! + 8,
    visibilitySet,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    skyLights: new Float32Array(0),
    blockLights: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    indicesCount: 0,
    using32Array: true,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors: false,
    blocksCount: 0
  }
}

function makeSolidGeometry(key: string, visibilitySet = SOLID): MesherGeometryOutput {
  const geo = makeEmptyGeometry(key, visibilitySet)
  const quad = makeQuadArrays()
  geo.positions = quad.positions
  geo.colors = quad.colors
  geo.skyLights = quad.skyLights
  geo.blockLights = quad.blockLights
  geo.uvs = quad.uvs
  geo.indices = quad.indices
  geo.indicesCount = 6
  geo.normals = new Float32Array(12)
  geo.blocksCount = 1
  return geo
}

function loadColumn(renderer: WorldRendererThree, x: number, z: number) {
  renderer.addColumn(x, z, [], false)
}

function revealColumn(renderer: WorldRendererThree, x: number, z: number) {
  const chunkKey = `${x},${z}`
  renderer.finishedChunks[chunkKey] = true
  renderer.chunkMeshManager.finishChunkDisplay(chunkKey)
}

function createChunkMeshManagerOnly(worldSizeParams = { minY: 0, worldHeight: 256 }) {
  const scene = new THREE.Scene()
  const material = new THREE.MeshBasicMaterial()
  const worldRenderer = {
    shaderCubeBlocksEnabled: () => false,
    getModule: () => undefined,
    sceneOrigin: {
      track: () => {},
      removeAndUntrack: () => {},
      removeAndUntrackAll: () => {}
    },
    blockEntities: {},
    worldRendererConfig: {},
    displayOptions: { inWorldRenderingConfig: {} },
    finishedChunks: {},
    viewDistance: 4,
    getSectionHeight: () => 16
  }
  const manager = new ChunkMeshManager(worldRenderer as never, scene, material, worldSizeParams.worldHeight, 4)
  return manager
}

function ensureBrowserGlobals() {
  if (typeof globalThis.location === 'undefined') {
    vi.stubGlobal('location', { href: 'http://localhost/' })
  }
}

function createWorldRendererThree(worldSizeParams = { minY: 0, worldHeight: 256 }) {
  ensureBrowserGlobals()
  const rendererState = proxy({
    world: {
      chunksLoaded: {} as Record<string, true>,
      heightmaps: {} as Record<string, Int16Array>,
      allChunksLoaded: false,
      mesherWork: false,
      instabilityFactors: defaultPerformanceInstabilityFactors(),
      intersectMedia: null
    },
    renderer: '',
    preventEscapeMenu: false
  })

  const displayOptions = {
    version: '1.21.1',
    worldView: new EventEmitter() as DisplayWorldOptions['worldView'],
    inWorldRenderingConfig: { ...defaultWorldRendererConfig, smartCull: true },
    playerStateReactive: getInitialPlayerState(),
    rendererState,
    nonReactiveState: {
      fps: 0,
      worstRenderTime: 0,
      avgRenderTime: 0,
      world: {
        chunksLoaded: new Set<string>(),
        chunksLoadedCount: 0,
        chunksTotalNumber: 0,
        chunksFullInfo: ''
      },
      renderer: {
        timeline: { live: [], frozen: [], lastSecond: [] }
      }
    },
    resourcesManager: { currentResources: null, on: vi.fn() } as unknown as DisplayWorldOptions['resourcesManager']
  }

  const initOptions: GraphicsInitOptions = {
    config: { sceneBackground: '#000' },
    rendererSpecificSettings: {},
    callbacks: {
      displayCriticalError: vi.fn(),
      setRendererSpecificSettings: vi.fn(),
      fireCustomEvent: vi.fn()
    }
  }

  const mockGl = {
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
    getParameter: () => 'Mock WebGL Renderer'
  }

  const glRenderer = {
    capabilities: { isWebGL2: true },
    info: { memory: { textures: 0 } },
    getContext: () => mockGl,
    render: vi.fn(),
    xr: { isPresenting: false },
    domElement: {} as HTMLCanvasElement
  } as unknown as THREE.WebGLRenderer

  vi.spyOn(WorldRendererThree, 'getRendererInfo').mockReturnValue('mock-renderer')

  vi.spyOn(WorldRendererThree.prototype, 'init').mockResolvedValue(undefined)
  vi.spyOn(WorldRendererThree.prototype, 'resetScene').mockImplementation(() => {})
  vi.spyOn(WorldRendererThree.prototype, 'addDebugOverlay').mockImplementation(() => {})
  vi.spyOn(WorldRendererThree.prototype, 'worldSwitchActions').mockImplementation(() => {})
  vi.spyOn(WorldRendererThree.prototype as unknown as { initializeModules: () => void }, 'initializeModules').mockImplementation(() => {})

  const renderer = new WorldRendererThree(glRenderer, initOptions, displayOptions as DisplayWorldOptions)
  renderer.active = true
  renderer.workers = [{ postMessage: vi.fn() }, { postMessage: vi.fn() }]
  renderer.viewDistance = 4
  renderer.chunkMeshManager.updateViewDistance(4)
  renderer.viewerChunkPosition = new Vec3(0, 64, 0)
  renderer.worldSizeParams = worldSizeParams
  renderer.worldRendererConfig.smartCull = true
  renderer.playerStateReactive.gameMode = 'survival'
  vi.spyOn(renderer.cameraCollisionBlockCache, 'ingestColumn').mockImplementation(() => {})
  return renderer
}

function sectionVisibilitySet(renderer: WorldRendererThree, key: string): number | undefined {
  return renderer.chunkMeshManager['sectionOcclusionCull'].getGraph().getSection(key)?.visibilitySet
}

function runCull(renderer: WorldRendererThree, cameraY = 8, cameraZ = 8) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  const cameraX = 8
  camera.position.set(cameraX, cameraY, cameraZ)
  camera.lookAt(cameraX, cameraY, cameraZ - 12)
  camera.updateMatrixWorld()
  const smartCull = renderer.isSmartCullEnabled()
  renderer.chunkMeshManager.notifySmartCullChanged(smartCull)
  renderer.chunkMeshManager.updateSectionCullAndSort(camera, cameraX, cameraY, cameraZ, smartCull)
}

function lastLegacyDrawSectionKeys(manager: ChunkMeshManager): string[] {
  return (manager['_visibleSectionSpans'] as Array<{ key: string }>).map(entry => entry.key)
}

function runBypassCull(renderer: WorldRendererThree, cameraY = 8, cameraZ = 8) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  const cameraX = 8
  camera.position.set(cameraX, cameraY, cameraZ)
  camera.lookAt(48, cameraY, cameraZ)
  camera.updateMatrixWorld()
  const smartCull = renderer.isSmartCullEnabled()
  renderer.chunkMeshManager.notifySmartCullChanged(smartCull)
  renderer.chunkMeshManager.updateSectionCullAndSort(camera, cameraX, cameraY, cameraZ, smartCull)
}
function flushPendingGeometry(renderer: WorldRendererThree) {
  ;(renderer as unknown as { applyPendingSectionUpdates: () => void }).applyPendingSectionUpdates()
}

function runManagerCull(manager: ChunkMeshManager, cameraY = 8) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  const cameraX = 8
  const cameraZ = 8
  camera.position.set(cameraX, cameraY, cameraZ)
  camera.lookAt(cameraX, cameraY, cameraZ - 12)
  camera.updateMatrixWorld()
  manager.notifySmartCullChanged(true)
  manager.updateSectionCullAndSort(camera, cameraX, cameraY, cameraZ, true)
}

describe('ChunkMeshManager occlusion grid helpers', () => {
  test('column unload removes all section keys including placeholders', () => {
    const manager = createChunkMeshManagerOnly()
    manager.registerColumnOcclusionGrid(0, 0, 0, 256, 16)
    manager.updateSection('0,64,0', makeSolidGeometry('0,64,0'))

    manager.unregisterColumnOcclusionGrid(0, 0, 0, 256, 16)

    expect(manager.hasRegisteredOcclusionSection('0,64,0')).toBe(false)
    expect(manager.hasRegisteredOcclusionSection('0,80,0')).toBe(false)
    manager.dispose()
  })

  test('second registerColumnOcclusionGrid is idempotent', () => {
    const manager = createChunkMeshManagerOnly()
    manager.registerColumnOcclusionGrid(0, 0, 0, 256, 16)
    const cull = manager['sectionOcclusionCull']
    cull.onSmartCullEnabled()
    runManagerCull(manager)
    const versionAfterFirst = cull.getVersion()

    manager.registerColumnOcclusionGrid(0, 0, 0, 256, 16)
    expect(cull.isStructuralDirty()).toBe(false)
    expect(cull.getVersion()).toBe(versionAfterFirst)
    manager.dispose()
  })
})

describe('WorldRendererThree occlusion lifecycle wiring', () => {
  test('addColumn registers placeholder grid using production worldMaxYRender', () => {
    const renderer = createWorldRendererThree({ minY: -64, worldHeight: 384 })
    renderer.addColumn(0, 0, [], false)

    expect(renderer.worldMaxYRender).toBe(320)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,-64,0')).toBe(true)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,304,0')).toBe(true)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,320,0')).toBe(false)
    renderer.chunkMeshManager.dispose()
  })

  test('addColumn on pre-1.18 world registers 0 through 240', () => {
    const renderer = createWorldRendererThree({ minY: 0, worldHeight: 256 })
    renderer.addColumn(0, 0, [], false)

    expect(renderer.worldMaxYRender).toBe(256)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,240,0')).toBe(true)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,256,0')).toBe(false)
    renderer.chunkMeshManager.dispose()
  })

  test('missing air section stays registered; camera in air sees terrain below (RC1b)', () => {
    const renderer = createWorldRendererThree()
    renderer.addColumn(0, 0, [], false)

    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,80,0')).toBe(true)
    expect(renderer.sectionObjects['0,80,0']).toBeUndefined()

    renderer.handleWorkerMessage({ type: 'geometry', key: '0,64,0', geometry: makeSolidGeometry('0,64,0') })

    runCull(renderer, 84)
    const visible = renderer.chunkMeshManager['sectionOcclusionCull'].getVisibleKeys()
    expect(visible.size).toBeGreaterThan(0)
    expect(visible.has('0,64,0')).toBe(true)
    renderer.chunkMeshManager.dispose()
  })

  test('handleWorkerMessage with empty geometry overwrites placeholder visibility', () => {
    const renderer = createWorldRendererThree()
    renderer.addColumn(0, 0, [], false)

    renderer.handleWorkerMessage({
      type: 'geometry',
      key: '0,64,0',
      geometry: makeEmptyGeometry('0,64,0', SOLID)
    })

    expect(sectionVisibilitySet(renderer, '0,64,0')).toBe(SOLID)
    expect(renderer.sectionObjects['0,64,0']).toBeUndefined()
    renderer.chunkMeshManager.dispose()
  })

  test('remesh solid to air to solid updates visibility and mesh lifecycle', () => {
    const renderer = createWorldRendererThree()
    renderer.addColumn(0, 0, [], false)

    renderer.handleWorkerMessage({ type: 'geometry', key: '0,64,0', geometry: makeSolidGeometry('0,64,0') })
    expect(renderer.sectionObjects['0,64,0']).toBeDefined()
    expect(sectionVisibilitySet(renderer, '0,64,0')).toBe(SOLID)

    renderer.handleWorkerMessage({ type: 'geometry', key: '0,64,0', geometry: makeEmptyGeometry('0,64,0', ALL_OPEN) })
    flushPendingGeometry(renderer)
    expect(renderer.sectionObjects['0,64,0']).toBeUndefined()
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,64,0')).toBe(true)
    expect(sectionVisibilitySet(renderer, '0,64,0')).toBe(ALL_OPEN)

    renderer.handleWorkerMessage({ type: 'geometry', key: '0,64,0', geometry: makeSolidGeometry('0,64,0') })
    expect(renderer.sectionObjects['0,64,0']).toBeDefined()
    expect(sectionVisibilitySet(renderer, '0,64,0')).toBe(SOLID)
    renderer.chunkMeshManager.dispose()
  })

  test('removeColumn tears down the occlusion grid', () => {
    const renderer = createWorldRendererThree()
    renderer.addColumn(0, 0, [], false)
    renderer.handleWorkerMessage({ type: 'geometry', key: '0,64,0', geometry: makeSolidGeometry('0,64,0') })

    renderer.removeColumn(0, 0)

    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,64,0')).toBe(false)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,80,0')).toBe(false)
    renderer.chunkMeshManager.dispose()
  })

  test('isPositionOcclusionVisible waits for finishedSections when grid registered', () => {
    const renderer = createWorldRendererThree()
    renderer.addColumn(0, 0, [], false)
    runCull(renderer, 84)

    renderer.finishedSections = {}
    expect(renderer.isPositionOcclusionVisible(8, 84, 8)).toBe(false)

    renderer.finishedSections['0,80,0'] = true
    expect(renderer.isPositionOcclusionVisible(8, 84, 8)).toBe(true)
    renderer.chunkMeshManager.dispose()
  })

  test('isPositionOcclusionVisible returns true above build height', () => {
    const renderer = createWorldRendererThree()
    renderer.finishedSections = {}
    expect(renderer.isPositionOcclusionVisible(8, 256, 8)).toBe(true)
    expect(renderer.isPositionOcclusionVisible(8, -1, 8)).toBe(true)
    renderer.chunkMeshManager.dispose()
  })

  test('compiled gate inert without registered grid (markAsLoaded path)', () => {
    const renderer = createWorldRendererThree()
    renderer.markAsLoaded(0, 0)
    renderer.finishedSections = {}
    renderer.worldRendererConfig.smartCull = false
    renderer.playerStateReactive.gameMode = 'survival'

    runCull(renderer, 84)
    expect(renderer.chunkMeshManager.hasRegisteredOcclusionSection('0,80,0')).toBe(false)
    expect(renderer.isPositionOcclusionVisible(8, 84, 8)).toBe(true)

    loadColumn(renderer, 0, 0)
    renderer.worldRendererConfig.smartCull = true
    renderer.chunkMeshManager.notifySmartCullChanged(true)
    runCull(renderer, 84)
    expect(renderer.isPositionOcclusionVisible(8, 84, 8)).toBe(false)

    renderer.chunkMeshManager.dispose()
  })

  test('isSmartCullEnabled follows config and disables in spectator', () => {
    const renderer = createWorldRendererThree()
    renderer.worldRendererConfig.smartCull = true
    renderer.playerStateReactive.gameMode = 'survival'
    expect(renderer.isSmartCullEnabled()).toBe(true)

    renderer.worldRendererConfig.smartCull = false
    expect(renderer.isSmartCullEnabled()).toBe(false)

    renderer.worldRendererConfig.smartCull = true
    renderer.playerStateReactive.gameMode = 'spectator'
    expect(renderer.isSmartCullEnabled()).toBe(false)
    renderer.chunkMeshManager.dispose()
  })
})

describe('pending bypass', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('rebuild pending bypasses block filter but entities stay on stale lastVisible', () => {
    const renderer = createWorldRendererThree()
    const cull = renderer.chunkMeshManager['sectionOcclusionCull']
    const manager = renderer.chunkMeshManager
    cull.onSmartCullEnabled()

    loadColumn(renderer, 0, 0)
    loadColumn(renderer, 16, 0)
    loadColumn(renderer, 32, 0)

    renderer.handleWorkerMessage({ type: 'geometry', key: '0,0,0', geometry: makeSolidGeometry('0,0,0', ALL_OPEN) })
    renderer.handleWorkerMessage({ type: 'geometry', key: '16,0,0', geometry: makeSolidGeometry('16,0,0', SOLID) })
    renderer.handleWorkerMessage({ type: 'geometry', key: '32,0,0', geometry: makeSolidGeometry('32,0,0', ALL_OPEN) })

    revealColumn(renderer, 0, 0)
    revealColumn(renderer, 16, 0)
    revealColumn(renderer, 32, 0)

    runBypassCull(renderer, 8, 8)

    expect(cull.isSectionVisible('32,0,0')).toBe(false)
    const filteredDrawKeys = lastLegacyDrawSectionKeys(manager)
    expect(filteredDrawKeys).toContain('16,0,0')
    expect(filteredDrawKeys).not.toContain('32,0,0')

    renderer.chunkMeshManager.registerSectionOcclusion('16,0,0', makeEmptyGeometry('16,0,0', ALL_OPEN))
    runBypassCull(renderer, 8, 8)

    expect(cull.isRebuildPending()).toBe(true)
    expect(manager.isOcclusionRebuildPending()).toBe(true)
    const drawKeys = lastLegacyDrawSectionKeys(manager)
    expect(drawKeys).toContain('16,0,0')
    expect(drawKeys).toContain('32,0,0')
    expect(cull.isSectionVisible('32,0,0')).toBe(false)

    renderer.chunkMeshManager.dispose()
  })
})
