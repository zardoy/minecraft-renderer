import * as THREE from 'three'
import { SWAY_PERIOD, SWAY_TIME_PERIOD } from './shaders/foliageSwayGlsl'

/**
 * Which block shader family a material belongs to (decides the defines it gets). `legacyBlended` materials draw with
 * alpha blending, so their alpha output must stay the real texture alpha (no emission encoding).
 */
export type BlockMaterialKind = 'cube' | 'legacy' | 'legacyBlended'

export type SunShadowsMode = 'off' | 'normal' | 'soft'

type AtlasJson = {
  width: number
  height: number
  suSv?: number
  textures: Record<string, { u: number; v: number; su?: number; sv?: number }>
}

/** Grid of the tile flags texture, in atlas pixels. Shader cubes use 16px tiles, so a cell is one cube tile index. */
export const TILE_FLAG_CELL = 16
/** Tile flag channels (RGBA8, 255 = set). */
export const TILE_FLAG = { leaves: 0, emissive: 1, hot: 2 } as const

/** Light sources: their bright texels glow with bloom. Latest and pre-flattening texture names. */
const EMISSIVE_TEXTURE =
  /^(glowstone|sea_lantern|shroomlight|lava_(still|flow)|magma(_block)?|(soul_)?fire_[01]|fire_layer_[01]|(soul_|redstone_)?torch(_on)?|(soul_)?lantern|jack_o_lantern|pumpkin_face_on|redstone_lamp_on|beacon|end_rod|glow_lichen|\w+_froglight(_side|_top)?|(soul_)?campfire_fire|crying_obsidian|respawn_anchor_top|(blast_)?furnace_front_on|smoker_front_on|(nether_)?portal|amethyst_cluster|sea_pickle|ochre_froglight\w*)$/
/** Hot surfaces: heat haze shimmers above them. */
const HOT_TEXTURE = /^(lava_(still|flow)|magma(_block)?|(soul_)?fire_[01]|fire_layer_[01]|(soul_)?campfire_fire)$/

export function tileFlagsForTexture(name: string): number[] {
  const flags: number[] = []
  if (name.includes('leaves')) flags.push(TILE_FLAG.leaves)
  if (EMISSIVE_TEXTURE.test(name)) flags.push(TILE_FLAG.emissive)
  if (HOT_TEXTURE.test(name)) flags.push(TILE_FLAG.hot)
  return flags
}

/**
 * One RGBA texel per 16px atlas cell with the TILE_FLAG channels of the texture covering it. Laid out
 * `atlasWidth / 16` wide: shader cubes texelFetch it by their 12-bit tile index (same row-major layout as
 * TextureIndexMapping), legacy geometry by `floor(uv * atlasSize / 16)`.
 */
export function buildTileFlags(atlas: AtlasJson): { data: Uint8Array; width: number; height: number } | undefined {
  if (atlas.width % TILE_FLAG_CELL || atlas.height % TILE_FLAG_CELL) return undefined
  const width = atlas.width / TILE_FLAG_CELL
  const height = atlas.height / TILE_FLAG_CELL
  const data = new Uint8Array(width * height * 4)
  for (const [name, info] of Object.entries(atlas.textures)) {
    const flags = tileFlagsForTexture(name)
    if (!flags.length) continue
    const col0 = Math.floor((info.u * atlas.width) / TILE_FLAG_CELL + 1e-6)
    const row0 = Math.floor((info.v * atlas.height) / TILE_FLAG_CELL + 1e-6)
    const cols = Math.max(1, Math.round(((info.su ?? atlas.suSv ?? 0) * atlas.width) / TILE_FLAG_CELL))
    const rows = Math.max(1, Math.round(((info.sv ?? atlas.suSv ?? 0) * atlas.height) / TILE_FLAG_CELL))
    for (let row = row0; row < Math.min(row0 + rows, height); row++) {
      for (let col = col0; col < Math.min(col0 + cols, width); col++) {
        if (col < 0 || row < 0) continue
        for (const flag of flags) data[(row * width + col) * 4 + flag] = 255
      }
    }
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
    u_tileFlags: { value: null as THREE.Texture | null },
    // Sun shadows, written by the sunShadows module (see shaders/sunShadowGlsl.ts)
    u_shadowMap: { value: null as THREE.DepthTexture | null },
    u_shadowMatrix: { value: new THREE.Matrix4() },
    u_shadowParams: { value: new THREE.Vector4() },
    u_shadowBias: { value: new THREE.Vector2() },
    u_shadowNormalOffset: { value: 0 },
    u_sunDir: { value: new THREE.Vector3(0, 1, 0) }
  }

  private readonly materials = new Map<THREE.ShaderMaterial, BlockMaterialKind>()
  private wavingFoliage = false
  private sunShadows: SunShadowsMode = 'off'
  private blockEmission = false
  private tileFlagsTexture: THREE.DataTexture | null = null

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

  getSunShadows(): SunShadowsMode {
    return this.sunShadows
  }

  setSunShadows(mode: SunShadowsMode): void {
    if (this.sunShadows === mode) return
    this.sunShadows = mode
    this.refreshDefines()
  }

  isBlockEmissionEnabled(): boolean {
    return this.blockEmission
  }

  /**
   * Opaque block shaders write light emission into the frame alpha (see shaders/blockEmissionGlsl.ts), read by the
   * bloom and heat haze post effects.
   */
  setBlockEmission(enabled: boolean): void {
    if (this.blockEmission === enabled) return
    this.blockEmission = enabled
    this.refreshDefines()
  }

  setTileFlagsFromAtlas(atlas: AtlasJson | undefined): void {
    this.tileFlagsTexture?.dispose()
    this.tileFlagsTexture = null
    const flags = atlas && buildTileFlags(atlas)
    if (flags) {
      const texture = new THREE.DataTexture(flags.data, flags.width, flags.height, THREE.RGBAFormat, THREE.UnsignedByteType)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
      this.tileFlagsTexture = texture
    }
    this.uniforms.u_tileFlags.value = this.tileFlagsTexture
  }

  setSwayTime(nowMs: number): void {
    this.uniforms.u_swayTime.value = wrapSwayTime(nowMs)
  }

  /** Must run before the frame is drawn whenever the render origin may have moved (rebase). */
  setRenderOrigin(renderOrigin: { x: number; y: number; z: number }): void {
    this.uniforms.u_swayOriginMod.value.set(swayOriginMod(renderOrigin.x), swayOriginMod(renderOrigin.y), swayOriginMod(renderOrigin.z))
  }

  dispose(): void {
    this.tileFlagsTexture?.dispose()
    this.tileFlagsTexture = null
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
    set('WAVING_FOLIAGE_LEGACY', this.wavingFoliage && kind !== 'cube')
    set('WAVING_FOLIAGE_CUBE', this.wavingFoliage && kind === 'cube')
    set('SUN_SHADOWS', this.sunShadows !== 'off')
    set('SUN_SHADOWS_SOFT', this.sunShadows === 'soft')
    set('BLOCK_EMISSION', this.blockEmission && kind !== 'legacyBlended')
    material.defines = defines
  }
}
