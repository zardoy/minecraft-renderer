import { test, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { Vec3 } from 'vec3'

vi.mock('../entity/EntityMesh', () => ({
  getMesh: vi.fn(),
}))

const renderSignMock = vi.fn()
vi.mock('../../sign-renderer', () => ({
  renderSign: (...args: unknown[]) => renderSignMock(...args),
}))

vi.mock('prismarine-chat', () => ({
  default: () => () => ({}),
}))

import { ChunkMeshManager } from '../chunkMeshManager'
import type { WorldRendererThree } from '../worldRendererThree'

function createManager (): ChunkMeshManager {
  const scene = new THREE.Scene()
  const material = new THREE.MeshBasicMaterial()
  const worldRenderer = {
    version: '1.20',
    shaderCubeBlocksEnabled: () => false,
    getModule: () => undefined,
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

function stubCanvas () {
  return { width: 64, height: 32 } as HTMLCanvasElement
}

beforeEach(() => {
  renderSignMock.mockReset()
  renderSignMock.mockImplementation(() => stubCanvas())
})

test('getSignTexture: same blockEntity returns cached texture without re-render', () => {
  const manager = createManager()
  const signHeadsRenderer = (manager as unknown as { signHeadsRenderer: { getSignTexture: Function } }).signHeadsRenderer
  const pos = new Vec3(10, 64, 10)
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const tex1 = signHeadsRenderer.getSignTexture(pos, blockEntity, false)
  const tex2 = signHeadsRenderer.getSignTexture(pos, blockEntity, false)

  expect(tex1).toBeDefined()
  expect(tex2).toBe(tex1)
  expect(renderSignMock).toHaveBeenCalledTimes(1)

  manager.dispose()
})

test('getSignTexture: changed blockEntity disposes old texture and renders anew', () => {
  const manager = createManager()
  const signHeadsRenderer = (manager as unknown as { signHeadsRenderer: { getSignTexture: Function } }).signHeadsRenderer
  const pos = new Vec3(10, 64, 10)
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const tex1 = signHeadsRenderer.getSignTexture(pos, blockEntity, false)!
  const disposeSpy = vi.spyOn(tex1, 'dispose')

  const changed = { Text1: '{"text":"World"}' }
  const tex2 = signHeadsRenderer.getSignTexture(pos, changed, false)

  expect(tex2).toBeDefined()
  expect(tex2).not.toBe(tex1)
  expect(disposeSpy).toHaveBeenCalledTimes(1)
  expect(renderSignMock).toHaveBeenCalledTimes(2)

  manager.dispose()
})
