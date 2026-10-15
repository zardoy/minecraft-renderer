import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { blockEntityBrightness, DEFAULT_LIGHTMAP_PARAMS } from '../../lib/blockEntityLighting'
import { EntityLightController, entityProbeBlock, resolveEntityLightOverride } from '../entityLightController'

const nightSky = 4 / 15

function makeController(
  getLight: (x: number, y: number, z: number) => { block: number; sky: number } = () => ({ block: 0, sky: 1 }),
  extras: Partial<ConstructorParameters<typeof EntityLightController>[0]> = {}
) {
  let skyLevel = 1
  let lightingEnabled = true
  let globalRevision = 1
  const columnRevisions = new Map<string, number>([['0,0', 1]])
  const controller = new EntityLightController({
    getLight,
    getSkyLevel: () => skyLevel,
    getLightmapParams: () => DEFAULT_LIGHTMAP_PARAMS,
    getColumnRevision: (cx, cz) => columnRevisions.get(`${cx},${cz}`),
    getGlobalRevision: () => globalRevision,
    lightingEnabled: () => lightingEnabled,
    ...extras
  })
  return {
    controller,
    setSkyLevel: (value: number) => {
      skyLevel = value
      controller.setSkyLevel(value)
    },
    setLightingEnabled: (value: boolean) => {
      lightingEnabled = value
    },
    bumpColumn: () => {
      columnRevisions.set('0,0', (columnRevisions.get('0,0') ?? 0) + 1)
    },
    bumpFarColumn: () => {
      columnRevisions.set('16,0', (columnRevisions.get('16,0') ?? 0) + 1)
    }
  }
}

describe('entityProbeBlock', () => {
  it('samples the eye block, not the block above the AABB', () => {
    expect(entityProbeBlock({ x: 8.2, y: 64.3, z: 8.7 }, 1.62)).toEqual({ x: 8, y: 65, z: 8 })
    expect(entityProbeBlock({ x: 8.2, y: 64.3, z: 8.7 }, 1.8)).toEqual({ x: 8, y: 66, z: 8 })
  })
})

describe('resolveEntityLightOverride', () => {
  it('fullbrights only reliably identified glow item frames', () => {
    expect(resolveEntityLightOverride('glow_item_frame')).toBe('fullbright')
    expect(resolveEntityLightOverride('item_frame')).toBe('normal')
    expect(resolveEntityLightOverride('blaze')).toBe('normal')
  })
})

describe('EntityLightController', () => {
  it('multiplies immutable base tint and is idempotent', () => {
    const { controller } = makeController(() => ({ block: 0, sky: 1 }))
    const material = new THREE.MeshLambertMaterial({ color: 0xb5_6d_51 })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material)
    const root = new THREE.Group()
    root.add(mesh)
    const base = material.color.clone()
    controller.register(root, { eyeHeight: 1.62 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    const brightness = blockEntityBrightness(0, 1, 1)
    expect(material.color.r).toBeCloseTo(base.r * brightness, 5)
    expect(material.color.g).toBeCloseTo(base.g * brightness, 5)
    expect(material.color.b).toBeCloseTo(base.b * brightness, 5)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(base.r * brightness, 5)
  })

  it('clones a shared material and leaves the original fullbright', () => {
    const shared = new THREE.MeshBasicMaterial({ color: 0xff_00_00 })
    const { controller } = makeController(() => ({ block: 0, sky: 0 }))
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared)
    const root = new THREE.Group()
    root.add(mesh)
    controller.register(root, { eyeHeight: 0 }, new Set([shared]))
    controller.update(root, { x: 1, y: 64, z: 1 })
    expect(shared.color.getHex()).toBe(0xff_00_00)
    expect(mesh.material).not.toBe(shared)
    const brightness = blockEntityBrightness(0, 0, 1)
    expect((mesh.material as THREE.MeshBasicMaterial).color.r).toBeCloseTo(1 * brightness, 5)
  })

  it('keeps two roots independent and skips debug helpers', () => {
    let sample = { block: 1, sky: 1 }
    const { controller } = makeController(() => sample)
    const brightMat = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const darkMat = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const debugMat = new THREE.MeshBasicMaterial({ color: 0x00_ff_00 })
    const bright = new THREE.Group()
    bright.add(new THREE.Mesh(new THREE.BoxGeometry(), brightMat))
    const dark = new THREE.Group()
    dark.add(new THREE.Mesh(new THREE.BoxGeometry(), darkMat))
    const debug = new THREE.Mesh(new THREE.BoxGeometry(), debugMat)
    debug.name = 'debug'
    dark.add(debug)
    controller.register(bright, { eyeHeight: 0 })
    controller.register(dark, { eyeHeight: 0 })
    controller.update(bright, { x: 1, y: 64, z: 1 })
    sample = { block: 0, sky: 0 }
    controller.update(dark, { x: 20, y: 64, z: 20 })
    expect(brightMat.color.r).toBeCloseTo(1, 5)
    expect(darkMat.color.r).toBeCloseTo(blockEntityBrightness(0, 0, 1), 5)
    expect(debugMat.color.getHex()).toBe(0x00_ff_00)
  })

  it('refreshes on sky change and stays fullbright when lighting is disabled', () => {
    const { controller, setSkyLevel, setLightingEnabled } = makeController(() => ({ block: 0, sky: 1 }))
    const material = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material))
    controller.register(root, { eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    setSkyLevel(nightSky)
    expect(material.color.r).toBeCloseTo(blockEntityBrightness(0, 1, nightSky), 5)
    setLightingEnabled(false)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(1, 5)
  })

  it('resamples a stationary root when the column revision changes', () => {
    let sample = { block: 1, sky: 1 }
    const { controller, bumpColumn } = makeController(() => sample)
    const material = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material))
    controller.register(root, { eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(1, 5)
    sample = { block: 0, sky: 0 }
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(1, 5)
    bumpColumn()
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(blockEntityBrightness(0, 0, 1), 5)
  })

  it('does not resample when only a distant column revision changes', () => {
    let sample = { block: 1, sky: 1 }
    const { controller, bumpFarColumn } = makeController(() => sample)
    const material = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material))
    controller.register(root, { eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(1, 5)
    sample = { block: 0, sky: 0 }
    bumpFarColumn()
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(1, 5)
  })

  it('adopts an authored material retint after invalidation', () => {
    const { controller } = makeController(() => ({ block: 0, sky: 0 }))
    const material = new THREE.MeshBasicMaterial({ color: 0xb5_6d_51 })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material)
    const root = new THREE.Group()
    root.add(mesh)
    controller.register(root, { eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    const brightness = blockEntityBrightness(0, 0, 1)
    const brown = new THREE.Color(0xb5_6d_51)
    expect(material.color.r).toBeCloseTo(brown.r * brightness, 5)
    material.color.setHex(0x00_ff_00)
    controller.invalidateMaterials(root)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(0, 5)
    expect(material.color.g).toBeCloseTo(brightness, 5)
    expect(material.color.b).toBeCloseTo(0, 5)
  })

  it('keeps glow item frames fullbright and recovers after a damage flash', () => {
    const { controller } = makeController(() => ({ block: 0, sky: 0 }))
    const material = new THREE.MeshBasicMaterial({ color: 0xaa_aa_aa })
    const baseR = material.color.r
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material)
    const root = new THREE.Group()
    root.add(mesh)
    controller.register(root, { name: 'glow_item_frame', eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.r).toBeCloseTo(baseR, 5)

    const flashed = material.clone()
    flashed.color.set(0xff_00_00)
    mesh.material = flashed
    controller.markFlash(root, 500)
    controller.invalidateMaterials(root)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(flashed.color.getHex()).toBe(0xff_00_00)
    controller.endFlash(root)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(flashed.color.r).toBeCloseTo(baseR, 5)
  })

  it('unregisters so later updates do not keep mutating materials', () => {
    const { controller } = makeController(() => ({ block: 0, sky: 0 }))
    const material = new THREE.MeshBasicMaterial({ color: 0xff_ff_ff })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material))
    controller.register(root, { eyeHeight: 0 })
    controller.update(root, { x: 8, y: 64, z: 8 })
    const dim = material.color.r
    controller.unregister(root)
    material.color.setHex(0xff_ff_ff)
    controller.update(root, { x: 8, y: 64, z: 8 })
    expect(material.color.getHex()).toBe(0xff_ff_ff)
    expect(dim).toBeLessThan(1)
  })
})
