import * as THREE from 'three'
import { SWAY_PERIOD, SWAY_TIME_PERIOD } from './shaders/foliageSwayGlsl'

/** Which block shader family a material belongs to (decides the defines it gets). */
export type BlockMaterialKind = 'cube' | 'legacy'

type AtlasJson = {
  width: number
  height: number
  textures: Record<string, { u: number; v: number }>
}

const SHADER_CUBE_TILE_SIZE = 16

/**
 * 12-bit shader cube tile index → is leaves. Same layout as TextureIndexMapping (16px tiles, row-major), one byte per
 * tile, laid out `tilesPerRow` wide so the shader can texelFetch it directly. Undefined when the atlas does not use the
 * shader cube layout (cubes then go through the legacy path and this mask is unused).
 */
export function buildLeafTileMask(atlas: AtlasJson): { data: Uint8Array; width: number; height: number } | undefined {
  if (atlas.width % SHADER_CUBE_TILE_SIZE || atlas.height % SHADER_CUBE_TILE_SIZE) return undefined
  const width = atlas.width / SHADER_CUBE_TILE_SIZE
  const height = atlas.height / SHADER_CUBE_TILE_SIZE
  if (width * height > 4096) return undefined
  const data = new Uint8Array(width * height)
  for (const [name, info] of Object.entries(atlas.textures)) {
    if (!name.includes('leaves')) continue
    const col = Math.floor((info.u * atlas.width) / SHADER_CUBE_TILE_SIZE + 1e-6)
    const row = Math.floor((info.v * atlas.height) / SHADER_CUBE_TILE_SIZE + 1e-6)
    if (col < 0 || col >= width || row < 0 || row >= height) continue
    data[row * width + col] = 255
  }
  return { data, width, height }
}

/** Seconds for the sway shader, wrapped to keep float precision (the wind is periodic over SWAY_TIME_PERIOD). */
export function wrapSwayTime(nowMs: number): number {
  return (nowMs / 1000) % SWAY_TIME_PERIOD
}

/** Render origin modulo the sway period, always non-negative. */
export function swayOriginMod(value: number): number {
  return ((value % SWAY_PERIOD) + SWAY_PERIOD) % SWAY_PERIOD
}

/**
 * Optional visual effects of the chunk block shaders. Owns the uniforms shared by every block material (one object,
 * referenced from each material, so a single write updates all of them) and the defines that switch effects on.
 * Off effects add no define, so their shader code is not compiled and costs nothing.
 */
export class BlockEffects {
  readonly uniforms = {
    u_swayTime: { value: 0 },
    u_swayOriginMod: { value: new THREE.Vector3() },
    u_leafMask: { value: null as THREE.Texture | null }
  }

  private readonly materials = new Map<THREE.ShaderMaterial, BlockMaterialKind>()
  private wavingFoliage = false
  private leafMaskTexture: THREE.DataTexture | null = null

  /** Call for every block material once it is created. */
  register(material: THREE.ShaderMaterial, kind: BlockMaterialKind): void {
    Object.assign(material.uniforms, this.uniforms)
    this.materials.set(material, kind)
    this.applyDefines(material, kind)
  }

  unregister(material: THREE.ShaderMaterial): void {
    this.materials.delete(material)
  }

  isWavingFoliageEnabled(): boolean {
    return this.wavingFoliage
  }

  setWavingFoliage(enabled: boolean): void {
    if (this.wavingFoliage === enabled) return
    this.wavingFoliage = enabled
    this.refreshDefines()
  }

  setLeafMaskFromAtlas(atlas: AtlasJson | undefined): void {
    this.leafMaskTexture?.dispose()
    this.leafMaskTexture = null
    const mask = atlas && buildLeafTileMask(atlas)
    if (mask) {
      const texture = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat, THREE.UnsignedByteType)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
      this.leafMaskTexture = texture
    }
    this.uniforms.u_leafMask.value = this.leafMaskTexture
  }

  setSwayTime(nowMs: number): void {
    this.uniforms.u_swayTime.value = wrapSwayTime(nowMs)
  }

  /** Must run before the frame is drawn whenever the render origin may have moved (rebase). */
  setRenderOrigin(renderOrigin: { x: number; y: number; z: number }): void {
    this.uniforms.u_swayOriginMod.value.set(swayOriginMod(renderOrigin.x), swayOriginMod(renderOrigin.y), swayOriginMod(renderOrigin.z))
  }

  dispose(): void {
    this.leafMaskTexture?.dispose()
    this.leafMaskTexture = null
    this.materials.clear()
  }

  private refreshDefines(): void {
    for (const [material, kind] of this.materials) {
      this.applyDefines(material, kind)
      material.needsUpdate = true
    }
  }

  private applyDefines(material: THREE.ShaderMaterial, kind: BlockMaterialKind): void {
    const defines = { ...material.defines }
    const set = (name: string, on: boolean) => {
      if (on) defines[name] = ''
      else delete defines[name]
    }
    set('WAVING_FOLIAGE', this.wavingFoliage)
    set('WAVING_FOLIAGE_LEGACY', this.wavingFoliage && kind === 'legacy')
    set('WAVING_FOLIAGE_CUBE', this.wavingFoliage && kind === 'cube')
    material.defines = defines
  }
}
