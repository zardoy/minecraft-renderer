import * as THREE from 'three'
import { expect, test, vi } from 'vitest'
import { CloudsModule } from '../modules/clouds'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'
import type { CloudCover } from '../cloudGeometry'

const cover: CloudCover = { width: 2, height: 2, filled: new Uint8Array([1, 0, 0, 1]) }

// No image decoding in node.
vi.mock('../cloudCover', () => ({ loadCloudCover: vi.fn(async () => cover) }))

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

const cloudMeshes = (scene: THREE.Scene) => scene.getObjectByName('clouds')!.children as THREE.Mesh[]

test('clouds are on by default and auto mode follows the clouds option', () => {
  const { module, worldRenderer } = createModule()
  expect(module.autoEnableCheck()).toBe(true)
  worldRenderer.worldRendererConfig.clouds = false
  expect(module.autoEnableCheck()).toBe(false)
})

test('clouds stay off in the nether even when enabled', () => {
  expect(createModule({ cardinalLight: 'nether' }).module.autoEnableCheck()).toBe(false)
})

test('disable hides the cloud layer and enable shows the same layer again', () => {
  const { module, scene } = createModule()
  module.enable()
  const layer = scene.getObjectByName('clouds')!
  expect(layer.visible).toBe(true)

  module.disable()
  expect(layer.visible).toBe(false)

  module.enable()
  expect(scene.getObjectByName('clouds')).toBe(layer)
  expect(layer.visible).toBe(true)
})

test('dispose removes the cloud layer from the scene', () => {
  const { module, scene } = createModule()
  module.enable()
  module.dispose()
  expect(scene.getObjectByName('clouds')).toBeUndefined()
})

test('renders a depth pre-pass before the colour pass over the same geometry', () => {
  const { module, scene } = createModule()
  module.enable()
  const [depthPass, colorPass] = cloudMeshes(scene)
  expect(depthPass.material).toMatchObject({ colorWrite: false, depthWrite: true })
  expect(colorPass.material).toMatchObject({ colorWrite: true, depthWrite: false })
  expect(depthPass.renderOrder).toBeLessThan(colorPass.renderOrder)
  expect(depthPass.geometry).toBe(colorPass.geometry)
})

test('builds volumetric cloud geometry once clouds.png has loaded and follows the camera', async () => {
  const { module, scene, worldRenderer } = createModule()
  module.enable()
  const [depthPass, colorPass] = cloudMeshes(scene)
  const sync = () => (depthPass.onBeforeRender as any)()

  // Nothing to draw until the texture is decoded.
  sync()
  expect(depthPass.geometry.index).toBeNull()

  await vi.waitFor(() => {
    sync()
    expect(depthPass.geometry.index).not.toBeNull()
  })
  const geometry = depthPass.geometry
  expect(colorPass.geometry).toBe(geometry)
  // Side faces and a 4-block thickness: more than a flat sheet's top/bottom quads.
  const ys = geometry.getAttribute('position').array.filter((_, i) => i % 3 === 1)
  expect(Math.max(...ys) - Math.min(...ys)).toBe(4)
  expect(geometry.getAttribute('shade')).toBeDefined()

  // Moving within the same cell keeps the geometry and only moves the layer.
  const before = scene.getObjectByName('clouds')!.position.x
  worldRenderer.sceneOrigin.x += 3
  sync()
  expect(depthPass.geometry).toBe(geometry)
  expect(scene.getObjectByName('clouds')!.position.x).toBeCloseTo(before - 3)

  // Crossing a cell boundary rebuilds around the new cell.
  worldRenderer.sceneOrigin.x += 24
  sync()
  expect(depthPass.geometry).not.toBe(geometry)
})

test('the layer sits at the configured cloud height above the camera', () => {
  const { module, scene, worldRenderer } = createModule({ cloudHeight: 192 })
  worldRenderer.sceneOrigin.y = 100
  module.enable()
  ;(cloudMeshes(scene)[0].onBeforeRender as any)()
  expect(scene.getObjectByName('clouds')!.position.y).toBeCloseTo(192.33 - 100)
})
