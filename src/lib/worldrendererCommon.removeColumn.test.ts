import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { proxy } from 'valtio'
import { WorldRendererCommon } from './worldrendererCommon'
import { defaultWorldRendererConfig } from '../graphicsBackend/config'
import { defaultPerformanceInstabilityFactors } from '../performanceMonitor'
import { getInitialPlayerState } from '../playerState/playerState'
import type { DisplayWorldOptions, GraphicsInitOptions } from '../graphicsBackend/types'

vi.mock('./ui/newStats', () => ({
  addNewStat: vi.fn(() => ({ updateText: vi.fn(), setVisibility: vi.fn() })),
  updateStatText: vi.fn(),
  removeAllStats: vi.fn(),
  updatePanesVisibility: vi.fn(),
  MC_RENDERER_DEBUG_OVERLAY_CLASS: 'mc-renderer-debug-overlay'
}))

vi.mock('./utils/skins', () => ({
  setSkinsConfig: vi.fn(),
  steveTexture: {},
  stevePngUrl: ''
}))

function ensurePromiseWithResolvers() {
  if (!Promise.withResolvers) {
    Promise.withResolvers = function <T>() {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }
}

class TestWorldRenderer extends WorldRendererCommon {
  outputFormat = 'threeJs' as const

  changeBackgroundColor() {}
  changeCardinalLight() {}
  handleWorkerMessage() {}
  updateCamera() {}
  render() {}
  updateShowChunksBorder() {}
  updatePlayerEntity() {}
  worldStop() {}
}

function createRenderer() {
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
    inWorldRenderingConfig: { ...defaultWorldRendererConfig },
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
    resourcesManager: {} as DisplayWorldOptions['resourcesManager']
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

  const renderer = new TestWorldRenderer(displayOptions.resourcesManager, displayOptions as DisplayWorldOptions, initOptions)
  renderer.active = true
  renderer.workers = [{ postMessage: vi.fn() }, { postMessage: vi.fn() }]
  renderer.viewDistance = 16
  renderer.viewerChunkPosition = new Vec3(0, 64, 0)
  renderer.worldSizeParams = { minY: 0, worldHeight: 256 }
  renderer.loadedChunks['160,0'] = true
  return renderer
}

function sectionKeysForColumn(renderer: TestWorldRenderer, x: number, z: number): string[] {
  const keys: string[] = []
  const sectionHeight = renderer.getSectionHeight()
  for (let y = renderer.worldMinYRender; y < renderer.worldSizeParams.worldHeight; y += sectionHeight) {
    keys.push(`${x},${y},${z}`)
  }
  return keys
}

describe('WorldRendererCommon.removeColumn sectionsWaiting reconciliation', () => {
  beforeEach(() => {
    ensurePromiseWithResolvers()
    vi.useFakeTimers()
    vi.stubGlobal('location', { href: 'http://localhost/' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('clears sectionsWaiting when viewDistance gate blocks setSectionDirty(false)', () => {
    const renderer = createRenderer()
    const columnX = 160
    const columnZ = 0
    const sectionPos = new Vec3(columnX, 64, columnZ)

    renderer.setSectionDirty(sectionPos, true)
    expect(renderer.sectionsWaiting.get(`${columnX},64,${columnZ}`)).toBe(1)

    renderer.viewDistance = 4
    renderer.removeColumn(columnX, columnZ)

    for (const key of sectionKeysForColumn(renderer, columnX, columnZ)) {
      expect(renderer.sectionsWaiting.has(key)).toBe(false)
    }
  })

  test('treats late sectionFinished as a no-op after removeColumn', () => {
    const renderer = createRenderer()
    const sectionKey = '160,64,0'
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    renderer.sectionsWaiting.set(sectionKey, 1)
    renderer.viewDistance = 4
    renderer.removeColumn(160, 0)

    expect(() => {
      renderer.handleMessage({ type: 'sectionFinished', key: sectionKey, workerIndex: 0 })
    }).not.toThrow()

    expect(renderer.sectionsWaiting.has(sectionKey)).toBe(false)
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('sectionFinished for non-outstanding section'))

    debugSpy.mockRestore()
  })

  test('clears sectionsWaiting when unload happens before batched dirty flush', () => {
    const renderer = createRenderer()
    renderer.forceCallFromMesherReplayer = false
    const columnX = 160
    const columnZ = 0

    renderer.setSectionDirty(new Vec3(columnX, 64, columnZ), true)
    expect(renderer.sectionsWaiting.get(`${columnX},64,${columnZ}`)).toBe(1)

    renderer.viewDistance = 4
    renderer.removeColumn(columnX, columnZ)
    vi.advanceTimersByTime(0)

    for (const key of sectionKeysForColumn(renderer, columnX, columnZ)) {
      expect(renderer.sectionsWaiting.has(key)).toBe(false)
    }
  })
})
