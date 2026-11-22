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
  // what three.js does around a frame: onBeforeRender while rendering, `render` once the frame was drawn
  const renderFrame = () => (depthPass.onBeforeRender as any)()
  const endFrame = () => module.render!(0)

  // Nothing to draw until the texture is decoded.
  renderFrame()
  endFrame()
  expect(depthPass.geometry.index).toBeNull()

  await vi.waitFor(() => {
    renderFrame()
    endFrame()
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
  renderFrame()
  endFrame()
  expect(depthPass.geometry).toBe(geometry)
  expect(scene.getObjectByName('clouds')!.position.x).toBeCloseTo(before - 3)

  // Crossing a cell boundary rebuilds around the new cell once the frame is over.
  worldRenderer.sceneOrigin.x += 24
  renderFrame()
  endFrame()
  expect(depthPass.geometry).not.toBe(geometry)
  expect(colorPass.geometry).toBe(depthPass.geometry)
})

async function createReadyModule(config: Partial<typeof defaultWorldRendererConfig> = {}) {
  const ctx = createModule(config)
  ctx.module.enable()
  const [depthPass, colorPass] = cloudMeshes(ctx.scene)
  await vi.waitFor(() => {
    ctx.module.render!(0)
    expect(depthPass.geometry.index).not.toBeNull()
  })
  const group = ctx.scene.getObjectByName('clouds')!
  return { ...ctx, depthPass, colorPass, group, renderFrame: () => (depthPass.onBeforeRender as any)(), endFrame: () => ctx.module.render!(0) }
}

test('the geometry is never swapped or disposed while a frame is being rendered (one-frame cloud blink at cell borders)', async () => {
  const { worldRenderer, depthPass, colorPass, renderFrame } = await createReadyModule()
  // three.js queues the geometry of every object before it renders the frame, then calls onBeforeRender per object
  const queued = depthPass.geometry
  const disposed = vi.fn()
  queued.addEventListener('dispose', disposed)

  // the camera crossed several cell boundaries since the geometry was built
  worldRenderer.sceneOrigin.x += 100
  worldRenderer.sceneOrigin.z -= 100
  renderFrame()
  ;(colorPass.onBeforeRender as any)?.()

  expect(depthPass.geometry).toBe(queued)
  expect(colorPass.geometry).toBe(queued)
  expect(disposed).not.toHaveBeenCalled()
})

test('the old geometry is disposed only after the frame, and both passes switch together', async () => {
  const { worldRenderer, depthPass, colorPass, renderFrame, endFrame } = await createReadyModule()
  const old = depthPass.geometry
  const disposed = vi.fn()
  old.addEventListener('dispose', disposed)

  worldRenderer.sceneOrigin.x += 100
  renderFrame()
  expect(disposed).not.toHaveBeenCalled()
  endFrame()
  expect(disposed).toHaveBeenCalledTimes(1)
  expect(depthPass.geometry).not.toBe(old)
  expect(colorPass.geometry).toBe(depthPass.geometry)
})

test('the layer position follows the cell of the installed geometry, so it never jumps while the camera moves', async () => {
  const { worldRenderer, group, renderFrame, endFrame } = await createReadyModule()
  renderFrame()
  const start = group.position.x

  // walk 2 blocks per frame across a cell boundary: the layer moves smoothly in camera space the whole time
  let previous = start
  let maxStep = 0
  let rebuilds = 0
  for (let i = 0; i < 40; i++) {
    worldRenderer.sceneOrigin.x += 2
    renderFrame()
    const step = Math.abs(group.position.x - previous)
    previous = group.position.x
    maxStep = Math.max(maxStep, step)
    const geometryBefore = cloudMeshes(group.parent as THREE.Scene)[0]!.geometry
    endFrame()
    if (cloudMeshes(group.parent as THREE.Scene)[0]!.geometry !== geometryBefore) rebuilds++
  }
  expect(rebuilds).toBeGreaterThan(0)
  // the jump to the new cell happens in the frame after the rebuild together with the new geometry, bounded by one cell
  expect(maxStep).toBeLessThanOrEqual(2 + 12 + 1e-6)
})

test('a position update never needs a rebuild for the frame that is drawn', async () => {
  const { worldRenderer, group, depthPass, renderFrame, endFrame } = await createReadyModule()
  renderFrame()
  const geometry = depthPass.geometry
  const x = group.position.x
  // stale by one frame: still the same cell as the installed geometry, so the layer keeps its camera-relative position
  worldRenderer.sceneOrigin.x += 13
  renderFrame()
  expect(depthPass.geometry).toBe(geometry)
  expect(group.position.x).toBeCloseTo(x - 13)
  endFrame()
  expect(depthPass.geometry).not.toBe(geometry)
})

test('the layer sits at the configured cloud height above the camera', () => {
  const { module, scene, worldRenderer } = createModule({ cloudHeight: 192 })
  worldRenderer.sceneOrigin.y = 100
  module.enable()
  ;(cloudMeshes(scene)[0].onBeforeRender as any)()
  expect(scene.getObjectByName('clouds')!.position.y).toBeCloseTo(192.33 - 100)
})
