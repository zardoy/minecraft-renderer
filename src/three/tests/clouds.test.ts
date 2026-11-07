import * as THREE from 'three'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CloudsModule } from '../modules/clouds'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'

beforeEach(() => {
  // No image decoding in node; the module only needs a texture object.
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture())
})

afterEach(() => {
  vi.restoreAllMocks()
})

function createModule(config: Partial<typeof defaultWorldRendererConfig> = {}) {
  const scene = new THREE.Scene()
  const worldRenderer = {
    scene,
    timeOfTheDay: 6000,
    viewDistance: 8,
    sceneOrigin: new THREE.Vector3(),
    worldRendererConfig: { ...defaultWorldRendererConfig, ...config }
  }
  const module = new CloudsModule(worldRenderer as any)
  return { module, scene, worldRenderer }
}

test('clouds are on by default and auto mode follows the clouds option', () => {
  const { module, worldRenderer } = createModule()
  expect(module.autoEnableCheck()).toBe(true)
  worldRenderer.worldRendererConfig.clouds = false
  expect(module.autoEnableCheck()).toBe(false)
})

test('clouds stay off in the nether even when enabled', () => {
  expect(createModule({ cardinalLight: 'nether' }).module.autoEnableCheck()).toBe(false)
})

test('disable hides the cloud layer and enable shows the same mesh again', () => {
  const { module, scene } = createModule()
  module.enable()
  const mesh = scene.getObjectByName('clouds')!
  expect(mesh.visible).toBe(true)

  module.disable()
  expect(mesh.visible).toBe(false)

  module.enable()
  expect(scene.getObjectByName('clouds')).toBe(mesh)
  expect(mesh.visible).toBe(true)
})

test('dispose removes the cloud layer from the scene', () => {
  const { module, scene } = createModule()
  module.enable()
  module.dispose()
  expect(scene.getObjectByName('clouds')).toBeUndefined()
})
