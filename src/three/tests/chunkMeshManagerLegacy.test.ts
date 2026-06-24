import { test, expect, vi } from 'vitest'
import * as THREE from 'three'

vi.mock('../entity/EntityMesh', () => ({
  getMesh: vi.fn(),
}))

import { ChunkMeshManager } from '../chunkMeshManager'
import type { WorldRendererThree } from '../worldRendererThree'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'

function makeQuadArrays () {
  const positions = new Float32Array([
    -1, -1, -1,
    -1, 1, -1,
    -1, 1, 1,
    -1, -1, 1,
  ])
  const colors = new Float32Array(12).fill(1)
  const skyLights = new Float32Array(4).fill(1)
  const blockLights = new Float32Array(4).fill(0)
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  return { positions, colors, skyLights, blockLights, uvs, indices }
}

function makeBlendOnlyGeometry (): MesherGeometryOutput {
  const blend = makeQuadArrays()
  return {
    sectionYNumber: 0,
    chunkKey: '0,0',
    sectionStartY: 0,
    sectionEndY: 16,
    sectionStartX: 0,
    sectionEndX: 16,
    sectionStartZ: 0,
    sectionEndZ: 16,
    sx: 8,
    sy: 8,
    sz: 8,
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
    blocksCount: 1,
    blend: {
      positions: blend.positions,
      normals: new Float32Array(12),
      colors: blend.colors,
      skyLights: blend.skyLights,
      blockLights: blend.blockLights,
      uvs: blend.uvs,
      indices: blend.indices,
    },
  }
}

function makeMixedGeometry (): MesherGeometryOutput {
  const opaque = makeQuadArrays()
  const blend = makeQuadArrays()
  return {
    sectionYNumber: 0,
    chunkKey: '0,0',
    sectionStartY: 0,
    sectionEndY: 16,
    sectionStartX: 0,
    sectionEndX: 16,
    sectionStartZ: 0,
    sectionEndZ: 16,
    sx: 8,
    sy: 8,
    sz: 8,
    positions: opaque.positions,
    normals: new Float32Array(12),
    colors: opaque.colors,
    skyLights: opaque.skyLights,
    blockLights: opaque.blockLights,
    uvs: opaque.uvs,
    indices: opaque.indices,
    indicesCount: 6,
    using32Array: true,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors: false,
    blocksCount: 2,
    blend: {
      positions: blend.positions,
      normals: new Float32Array(12),
      colors: blend.colors,
      skyLights: blend.skyLights,
      blockLights: blend.blockLights,
      uvs: blend.uvs,
      indices: blend.indices,
    },
  }
}

function makeInvalidBlendGeometry (): MesherGeometryOutput {
  const geo = makeBlendOnlyGeometry()
  const blend = geo.blend!
  return {
    ...geo,
    blend: {
      ...blend,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 1, 3]),
    },
  }
}

type ManagerOptions = {
  revealDefer?: boolean
}

function createManager (opts: ManagerOptions = {}): ChunkMeshManager {
  const scene = new THREE.Scene()
  const material = new THREE.MeshBasicMaterial()
  const revealModule = opts.revealDefer
    ? {
      shouldDeferSectionGeometry: () => true,
    }
    : undefined
  const worldRenderer = {
    shaderCubeBlocksEnabled: () => false,
    getModule: (name: string) => (name === 'futuristicReveal' ? revealModule : undefined),
    sceneOrigin: {
      track: () => {},
      removeAndUntrack: () => {},
      removeAndUntrackAll: () => {},
    },
    blockEntities: {},
    worldRendererConfig: {},
  } as unknown as WorldRendererThree
  return new ChunkMeshManager(worldRenderer, scene, material, 256, 1)
}

test('ChunkMeshManager: blend section routes to global blend buffer', () => {
  const manager = createManager()
  const key = '0,0,0'
  const geo = makeBlendOnlyGeometry()

  manager.updateSection(key, geo)

  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(true)
  expect(manager.sectionObjects[key]?.hasBlendMesh).toBe(false)
  expect(manager.sectionUsesPooledLegacyMesh(key)).toBe(false)

  manager.cleanupSection(key)
  manager.dispose()
})

test('ChunkMeshManager: cleanup removes blend from global buffer', () => {
  const manager = createManager()
  const key = '0,0,0'
  manager.updateSection(key, makeBlendOnlyGeometry())
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(true)

  manager.cleanupSection(key)
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(false)

  manager.dispose()
})

test('ChunkMeshManager: hidden section excluded from draw spans', () => {
  const manager = createManager()
  const key = '0,0,0'
  manager.updateSection(key, makeBlendOnlyGeometry())
  const section = manager.sectionObjects[key]!
  section.visible = false

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  camera.position.set(8, 8, 20)
  camera.lookAt(8, 8, 8)
  camera.updateMatrixWorld()

  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(manager.globalLegacyBlendBuffer?.getVisibleIndexSpans().length).toBe(0)

  section.visible = true
  const blendBuf = manager.globalLegacyBlendBuffer!
  while (blendBuf.hasPendingUploads()) blendBuf.uploadDirtyRange()
  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(manager.globalLegacyBlendBuffer?.getVisibleIndexSpans().length).toBeGreaterThan(0)

  manager.cleanupSection(key)
  manager.dispose()
})

test('ChunkMeshManager: reveal defer blend migrates to global and releases pool', () => {
  const manager = createManager({ revealDefer: true })
  const key = '0,0,0'
  const geo = makeBlendOnlyGeometry()

  manager.updateSection(key, geo)

  expect(manager.sectionObjects[key]?.hasBlendMesh).toBe(true)
  expect(manager.sectionObjects[key]?.deferredLegacyBlend).toBeDefined()
  expect(manager.globalLegacyBlendBuffer?.hasSection(key) ?? false).toBe(false)
  expect(manager.sectionUsesPooledLegacyMesh(key)).toBe(true)

  manager.migrateDeferredLegacyToGlobal(key)

  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(true)
  expect(manager.sectionObjects[key]?.hasBlendMesh).toBe(false)
  expect(manager.sectionObjects[key]?.deferredLegacyBlend).toBeUndefined()
  expect(manager.sectionUsesPooledLegacyMesh(key)).toBe(false)

  manager.cleanupSection(key)
  manager.dispose()
})

test('ChunkMeshManager: invalid blend geometry falls back to pooled mesh', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const manager = createManager()
  const key = '0,0,0'

  manager.updateSection(key, makeInvalidBlendGeometry())

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('blend invariant violation'))
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(false)
  expect(manager.sectionObjects[key]?.hasBlendMesh).toBe(true)
  expect(manager.sectionUsesPooledLegacyMesh(key)).toBe(true)

  warn.mockRestore()
  manager.cleanupSection(key)
  manager.dispose()
})

test('ChunkMeshManager: raycastGlobalLegacySections rejects off-ray sections within center distance', () => {
  const manager = createManager()
  const onRayKey = '0,0,0'
  const offRayKey = '0,2,0'

  manager.updateSection(onRayKey, makeBlendOnlyGeometry())

  const offRayGeo = makeBlendOnlyGeometry()
  offRayGeo.sz = 40
  manager.updateSection(offRayKey, offRayGeo)

  expect(manager.globalLegacyBlendBuffer?.hasSection(onRayKey)).toBe(true)
  expect(manager.globalLegacyBlendBuffer?.hasSection(offRayKey)).toBe(true)
  expect(manager.sectionObjects[offRayKey]?.worldZ).toBe(40)

  const origin = new THREE.Vector3(4, 8, 8)
  const direction = new THREE.Vector3(1, 0, 0).normalize()
  const raycaster = new THREE.Raycaster(origin, direction)
  raycaster.far = 4

  const hit = manager.raycastGlobalLegacySections(raycaster, origin, 80)
  expect(hit).toBeDefined()
  expect(hit!).toBeGreaterThan(2)
  expect(hit!).toBeLessThan(4)

  manager.cleanupSection(onRayKey)
  manager.cleanupSection(offRayKey)
  manager.dispose()
})

test('ChunkMeshManager: mixed opaque and blend route to separate global buffers', () => {
  const manager = createManager()
  const key = '0,0,0'

  manager.updateSection(key, makeMixedGeometry())

  expect(manager.globalLegacyBuffer?.hasSection(key)).toBe(true)
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(true)
  expect(manager.sectionObjects[key]?.hasBlendMesh).toBe(false)
  expect(manager.sectionUsesPooledLegacyMesh(key)).toBe(false)

  manager.cleanupSection(key)
  expect(manager.globalLegacyBuffer?.hasSection(key)).toBe(false)
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(false)

  manager.dispose()
})
