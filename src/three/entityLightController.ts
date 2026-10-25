import * as THREE from 'three'
import { blockEntityBrightness, DEFAULT_LIGHTMAP_PARAMS, type BlockLightmapParams } from '../lib/blockEntityLighting'

export type EntityLightOverride = 'normal' | 'fullbright'

export type EntityLightWorldPos = { x: number; y: number; z: number }

export type EntityLightMeta = {
  name?: string
  height?: number
  eyeHeight?: number
}

export type EntityLightSampler = {
  getLight: (x: number, y: number, z: number) => { block: number; sky: number }
  getSkyLevel: () => number
  getLightmapParams: () => BlockLightmapParams
  getColumnRevision: (chunkX: number, chunkZ: number) => number | undefined
  getGlobalRevision: () => number
  lightingEnabled: () => boolean
}

const BASE_COLOR_KEY = 'entityLightBaseColor'
const LAST_APPLIED_COLOR_KEY = 'entityLightLastAppliedColor'
const COLOR_EPSILON = 1e-4
const LIVING_EYE_HEIGHT_RATIO = 0.85

type ColorBearingMaterial = THREE.Material & { color: THREE.Color }

type ControlledMaterial = {
  material: ColorBearingMaterial
  base: THREE.Color
}

type TrackedRoot = {
  meta: EntityLightMeta
  override: EntityLightOverride
  materials: ControlledMaterial[]
  materialsDirty: boolean
  flashing: boolean
  lastProbe?: { x: number; y: number; z: number }
  lastColumnRevision?: number
  lastGlobalRevision?: number
  lastSkyLevel?: number
  lastLightmapParams?: BlockLightmapParams
  lastLightingEnabled?: boolean
  lastBrightness?: number
}

const alignColumn = (coord: number) => Math.floor(coord / 16) * 16

export function resolveEntityEyeHeight(meta: EntityLightMeta = {}): number {
  if (Number.isFinite(meta.eyeHeight)) return meta.eyeHeight as number
  if (Number.isFinite(meta.height)) return (meta.height as number) * LIVING_EYE_HEIGHT_RATIO
  return 0
}

export function entityProbeBlock(worldPos: EntityLightWorldPos, eyeHeight = 0): { x: number; y: number; z: number } {
  return {
    x: Math.floor(worldPos.x),
    y: Math.floor(worldPos.y + eyeHeight),
    z: Math.floor(worldPos.z)
  }
}

export function resolveEntityLightOverride(name?: string): EntityLightOverride {
  return name === 'glow_item_frame' ? 'fullbright' : 'normal'
}

type Rgb = { r: number; g: number; b: number }

const hasColor = (material: THREE.Material): material is ColorBearingMaterial => !!material && (material as ColorBearingMaterial).color instanceof THREE.Color

const readRgb = (material: ColorBearingMaterial, key: string): THREE.Color | undefined => {
  const stored = material.userData?.[key] as Rgb | undefined
  if (!stored || !Number.isFinite(stored.r) || !Number.isFinite(stored.g) || !Number.isFinite(stored.b)) return undefined
  return new THREE.Color(stored.r, stored.g, stored.b)
}

const storeRgb = (material: ColorBearingMaterial, key: string, color: THREE.Color) => {
  material.userData[key] = { r: color.r, g: color.g, b: color.b }
}

const colorsClose = (a: THREE.Color, b: THREE.Color) =>
  Math.abs(a.r - b.r) < COLOR_EPSILON && Math.abs(a.g - b.g) < COLOR_EPSILON && Math.abs(a.b - b.b) < COLOR_EPSILON

const readStoredBase = (material: ColorBearingMaterial): THREE.Color | undefined => readRgb(material, BASE_COLOR_KEY)

const storeBase = (material: ColorBearingMaterial, base: THREE.Color) => {
  storeRgb(material, BASE_COLOR_KEY, base)
}

const readLastApplied = (material: ColorBearingMaterial): THREE.Color | undefined => readRgb(material, LAST_APPLIED_COLOR_KEY)

const storeLastApplied = (material: ColorBearingMaterial, color: THREE.Color) => {
  storeRgb(material, LAST_APPLIED_COLOR_KEY, color)
}

const resolveBaseColor = (material: ColorBearingMaterial, flashing: boolean): THREE.Color => {
  const stored = readStoredBase(material)
  if (!stored) {
    const base = material.color.clone()
    storeBase(material, base)
    return base
  }
  if (flashing) return stored
  const lastApplied = readLastApplied(material)
  if (lastApplied && colorsClose(material.color, lastApplied)) return stored
  const base = material.color.clone()
  storeBase(material, base)
  return base
}

const applyBrightnessToMaterial = (entry: ControlledMaterial, brightness: number) => {
  entry.material.color.setRGB(entry.base.r * brightness, entry.base.g * brightness, entry.base.b * brightness)
  storeLastApplied(entry.material, entry.material.color)
}

const lightmapParamsEqual = (a?: BlockLightmapParams, b?: BlockLightmapParams) =>
  a === b ||
  (!!a &&
    !!b &&
    (a.curve ?? DEFAULT_LIGHTMAP_PARAMS.curve) === (b.curve ?? DEFAULT_LIGHTMAP_PARAMS.curve) &&
    (a.minBrightness ?? DEFAULT_LIGHTMAP_PARAMS.minBrightness) === (b.minBrightness ?? DEFAULT_LIGHTMAP_PARAMS.minBrightness) &&
    (a.gamma ?? DEFAULT_LIGHTMAP_PARAMS.gamma) === (b.gamma ?? DEFAULT_LIGHTMAP_PARAMS.gamma))

export class EntityLightController {
  private readonly roots = new Map<THREE.Object3D, TrackedRoot>()
  private skyLevel = 1
  private lightmapParams: BlockLightmapParams = { ...DEFAULT_LIGHTMAP_PARAMS }

  constructor(private readonly sampler: EntityLightSampler) {
    this.skyLevel = sampler.getSkyLevel()
    this.lightmapParams = { ...DEFAULT_LIGHTMAP_PARAMS, ...sampler.getLightmapParams() }
  }

  setSkyLevel(value: number) {
    this.skyLevel = value
    this.refreshAll()
  }

  setLightmapParams(params: BlockLightmapParams) {
    this.lightmapParams = { ...this.lightmapParams, ...params }
    this.refreshAll()
  }

  register(root: THREE.Object3D, meta: EntityLightMeta = {}, sharedMaterials?: Iterable<THREE.Material>) {
    const shared = sharedMaterials ? new Set(sharedMaterials) : undefined
    const existing = this.roots.get(root)
    if (existing) {
      existing.meta = { ...existing.meta, ...meta }
      existing.override = resolveEntityLightOverride(existing.meta.name)
      existing.materialsDirty = true
      existing.lastProbe = undefined
      if (shared) this.discoverMaterials(root, existing, shared)
      return
    }
    const tracked: TrackedRoot = {
      meta,
      override: resolveEntityLightOverride(meta.name),
      materials: [],
      materialsDirty: true,
      flashing: false
    }
    this.roots.set(root, tracked)
    if (shared) this.discoverMaterials(root, tracked, shared)
  }

  setMeta(root: THREE.Object3D, meta: EntityLightMeta) {
    const tracked = this.roots.get(root)
    if (!tracked) return
    tracked.meta = { ...tracked.meta, ...meta }
    tracked.override = resolveEntityLightOverride(tracked.meta.name)
    tracked.lastProbe = undefined
  }

  unregister(root: THREE.Object3D) {
    this.roots.delete(root)
  }

  clear() {
    this.roots.clear()
  }

  invalidateMaterials(root: THREE.Object3D) {
    const tracked = this.roots.get(root)
    if (!tracked) return
    tracked.materialsDirty = true
    tracked.lastProbe = undefined
  }

  invalidateFromDescendant(node: THREE.Object3D) {
    let current: THREE.Object3D | null = node
    while (current) {
      if (this.roots.has(current)) {
        this.invalidateMaterials(current)
        return
      }
      current = current.parent
    }
  }

  markFlash(root: THREE.Object3D, _durationMs?: number) {
    const tracked = this.roots.get(root)
    if (!tracked) return
    tracked.flashing = true
  }

  endFlash(root: THREE.Object3D) {
    const tracked = this.roots.get(root)
    if (!tracked) return
    tracked.flashing = false
    tracked.lastProbe = undefined
  }

  update(root: THREE.Object3D, worldPos: EntityLightWorldPos, sharedMaterials?: Iterable<THREE.Material>) {
    const tracked = this.roots.get(root)
    if (!tracked) return
    const materialsWereDirty = tracked.materialsDirty
    if (tracked.materialsDirty) {
      this.discoverMaterials(root, tracked, sharedMaterials ? new Set(sharedMaterials) : undefined)
    }

    const lightingEnabled = this.sampler.lightingEnabled()
    const probe = entityProbeBlock(worldPos, resolveEntityEyeHeight(tracked.meta))
    const columnRevision = this.sampler.getColumnRevision(alignColumn(probe.x), alignColumn(probe.z))
    const globalRevision = this.sampler.getGlobalRevision()
    const skyLevel = this.skyLevel
    const lightmapParams = this.lightmapParams

    const unchanged =
      tracked.lastProbe &&
      tracked.lastProbe.x === probe.x &&
      tracked.lastProbe.y === probe.y &&
      tracked.lastProbe.z === probe.z &&
      tracked.lastColumnRevision === columnRevision &&
      tracked.lastGlobalRevision === globalRevision &&
      tracked.lastSkyLevel === skyLevel &&
      tracked.lastLightingEnabled === lightingEnabled &&
      lightmapParamsEqual(tracked.lastLightmapParams, lightmapParams)

    if (unchanged && !materialsWereDirty) return

    tracked.lastProbe = probe
    tracked.lastColumnRevision = columnRevision
    tracked.lastGlobalRevision = globalRevision
    tracked.lastSkyLevel = skyLevel
    tracked.lastLightmapParams = lightmapParams
    tracked.lastLightingEnabled = lightingEnabled

    if (tracked.flashing) return

    const brightness = this.computeBrightness(tracked, probe, lightingEnabled)
    tracked.lastBrightness = brightness
    for (const entry of tracked.materials) {
      applyBrightnessToMaterial(entry, brightness)
    }
  }

  private refreshAll() {
    for (const [root, tracked] of this.roots) {
      if (tracked.flashing || tracked.materialsDirty) {
        tracked.lastProbe = undefined
        continue
      }
      const lightingEnabled = this.sampler.lightingEnabled()
      const probe = tracked.lastProbe ?? { x: 0, y: 0, z: 0 }
      const brightness = tracked.lastProbe ? this.computeBrightness(tracked, probe, lightingEnabled) : undefined
      if (brightness === undefined) {
        tracked.lastProbe = undefined
        continue
      }
      tracked.lastSkyLevel = this.skyLevel
      tracked.lastLightmapParams = this.lightmapParams
      tracked.lastLightingEnabled = lightingEnabled
      tracked.lastBrightness = brightness
      for (const entry of tracked.materials) {
        applyBrightnessToMaterial(entry, brightness)
      }
      void root
    }
  }

  private computeBrightness(tracked: TrackedRoot, probe: { x: number; y: number; z: number }, lightingEnabled: boolean) {
    if (!lightingEnabled || tracked.override === 'fullbright') return 1
    const sample = this.sampler.getLight(probe.x, probe.y, probe.z)
    return blockEntityBrightness(sample.block, sample.sky, this.skyLevel, this.lightmapParams)
  }

  private discoverMaterials(root: THREE.Object3D, tracked: TrackedRoot, sharedMaterials?: Set<THREE.Material>) {
    const next: ControlledMaterial[] = []
    const seen = new Set<THREE.Material>()
    root.traverse(child => {
      if (child.name === 'debug') return
      const raw = (child as THREE.Mesh).material
      if (!raw) return
      const list = Array.isArray(raw) ? raw : [raw]
      let replacedArray = false
      const nextList = list.map((material, index) => {
        if (!hasColor(material) || seen.has(material)) return material
        seen.add(material)
        let current = material
        if (sharedMaterials?.has(current)) {
          current = current.clone() as ColorBearingMaterial
          if (Array.isArray(raw)) {
            list[index] = current
            replacedArray = true
          } else {
            ;(child as THREE.Mesh).material = current
          }
        }
        const base = resolveBaseColor(current, tracked.flashing)
        next.push({ material: current, base })
        return current
      })
      if (replacedArray) (child as THREE.Mesh).material = nextList
    })
    tracked.materials = next
    tracked.materialsDirty = false
  }
}
