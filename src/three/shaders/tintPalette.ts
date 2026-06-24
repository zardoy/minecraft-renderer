import * as THREE from 'three'

// ---- Palette entry ----
export interface TintPaletteEntry {
  r: number // 0-1
  g: number
  b: number
}

// ---- Palette manager ----
export class TintPalette {
  private entries: TintPaletteEntry[] = [{ r: 1, g: 1, b: 1 }] // index 0 = white (no tint)
  private colorToIndex: Map<number, number> = new Map() // packed color -> index
  private categoryBiomeToIndex: Map<string, number> = new Map()
  private texture: THREE.DataTexture | null = null
  private ready = false

  /** Pack [r,g,b] (0-1 floats) into a 24-bit integer for fast lookup */
  private packColor(r: number, g: number, b: number): number {
    const ri = Math.round(r * 255)
    const gi = Math.round(g * 255)
    const bi = Math.round(b * 255)
    return (ri << 16) | (gi << 8) | bi
  }

  /** Add a tint entry, returns its palette index (reuses duplicates) */
  add(r: number, g: number, b: number, category: string, key: string): number {
    const packed = this.packColor(r, g, b)

    // Try categorical lookup first (faster and preserves semantic grouping)
    const catKey = `${category}:${key}`
    const existing = this.categoryBiomeToIndex.get(catKey)
    if (existing !== undefined) return existing

    // Deduplicate by exact color
    const colorIdx = this.colorToIndex.get(packed)
    if (colorIdx !== undefined) {
      this.categoryBiomeToIndex.set(catKey, colorIdx)
      return colorIdx
    }

    const idx = this.entries.length
    this.entries.push({ r, g, b })
    this.colorToIndex.set(packed, idx)
    this.categoryBiomeToIndex.set(catKey, idx)
    return idx
  }

  /** Look up tint index for a specific block face */
  getTintIndex(faceTintIndex: number | undefined, blockName: string, blockProps: Record<string, any>, biome: string): number {
    if (faceTintIndex === undefined) return 0 // white

    if (faceTintIndex === 0) {
      if (blockName === 'redstone_wire') {
        return this.categoryBiomeToIndex.get(`redstone:${blockProps.power}`) ?? this.categoryBiomeToIndex.get('redstone:0') ?? 0
      }
      if (blockName === 'birch_leaves' || blockName === 'spruce_leaves' || blockName === 'lily_pad') {
        return this.categoryBiomeToIndex.get(`constant:${blockName}`) ?? this.categoryBiomeToIndex.get('constant:default') ?? 0
      }
      if (blockName.includes('leaves') || blockName === 'vine') {
        return this.categoryBiomeToIndex.get(`foliage:${biome}`) ?? this.categoryBiomeToIndex.get('foliage:plains') ?? 0
      }
      // Default: grass tint
      return this.categoryBiomeToIndex.get(`grass:${biome}`) ?? this.categoryBiomeToIndex.get('grass:plains') ?? 0
    }

    return 0 // unknown tint index -> white
  }

  /** Get the palette entry at a given index */
  getEntry(index: number): TintPaletteEntry {
    return this.entries[index] ?? this.entries[0]
  }

  /** Total number of palette entries */
  get size(): number {
    return this.entries.length
  }

  /** Build RGBA Float32Array from palette entries (for DataTexture) */
  private buildTextureData(): Float32Array {
    // RGBA × 256 entries
    const data = new Float32Array(256 * 4)
    for (let i = 0; i < this.entries.length && i < 256; i++) {
      const e = this.entries[i]
      data[i * 4] = e.r
      data[i * 4 + 1] = e.g
      data[i * 4 + 2] = e.b
      data[i * 4 + 3] = 1.0
    }
    return data
  }

  /** Create or update the Three.js DataTexture */
  createTexture(): THREE.DataTexture {
    if (this.texture) {
      this.texture.dispose()
      this.texture = null
      this.ready = false
    }
    const data = this.buildTextureData()
    const texture = new THREE.DataTexture(data as any, 256, 1, THREE.RGBAFormat, THREE.FloatType) as THREE.DataTexture
    texture.minFilter = THREE.NearestFilter
    texture.magFilter = THREE.NearestFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.needsUpdate = true
    this.texture = texture
    this.ready = true
    return texture
  }

  getTexture(): THREE.DataTexture | null {
    return this.texture
  }

  isReady(): boolean {
    return this.ready
  }

  /** Precompute the full palette using tints data */
  static fromTintsData(tintsData: Record<string, any>): TintPalette {
    const palette = new TintPalette()
    // Offsets to avoid collision with categorical keys — already handled by packColor dedup

    function tintToGl(tint: number): [number, number, number] {
      const r = ((tint >> 16) & 0xff) / 255
      const g = ((tint >> 8) & 0xff) / 255
      const b = (tint & 0xff) / 255
      return [r, g, b]
    }

    // --- grass tint (per biome) ---
    if (tintsData.grass) {
      const grassDefault = tintToGl(tintsData.grass.default)
      for (const { keys, color } of tintsData.grass.data ?? []) {
        const c = tintToGl(color as number)
        for (const biome of keys as string[]) {
          palette.add(c[0], c[1], c[2], 'grass', biome)
        }
      }
      palette.add(grassDefault[0], grassDefault[1], grassDefault[2], 'grass', 'plains')
    }

    // --- foliage tint (per biome) ---
    if (tintsData.foliage) {
      const foliageDefault = tintToGl(tintsData.foliage.default)
      for (const { keys, color } of tintsData.foliage.data ?? []) {
        const c = tintToGl(color as number)
        for (const biome of keys as string[]) {
          palette.add(c[0], c[1], c[2], 'foliage', biome)
        }
      }
      palette.add(foliageDefault[0], foliageDefault[1], foliageDefault[2], 'foliage', 'plains')
    }

    // --- redstone tint (per power level 0-15) ---
    if (tintsData.redstone) {
      const rsDefault = tintToGl(tintsData.redstone.default)
      for (const { keys, color } of tintsData.redstone.data ?? []) {
        const c = tintToGl(color as number)
        for (const key of keys as string[]) {
          palette.add(c[0], c[1], c[2], 'redstone', key)
        }
      }
      palette.add(rsDefault[0], rsDefault[1], rsDefault[2], 'redstone', '0')
    }

    // --- constant tints (birch leaves, spruce leaves, lily pad) ---
    if (tintsData.constant) {
      const constDefault = tintToGl(tintsData.constant.default)
      for (const { keys, color } of tintsData.constant.data ?? []) {
        const c = tintToGl(color as number)
        for (const key of keys as string[]) {
          palette.add(c[0], c[1], c[2], 'constant', key)
        }
      }
      palette.add(constDefault[0], constDefault[1], constDefault[2], 'constant', 'default')
    }

    return palette
  }
}
