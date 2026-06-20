/**
 * Maps texture atlas positions to 12-bit absolute tile indices used by the
 * instanced shader-cube path.
 *
 * Requirement: atlas MUST be 1024×1024 with 16×16 tiles (max 4096 tiles fits in 12 bits).
 * If atlas dimensions differ, `isValid()` returns false and callers must fall back to
 * the legacy vertex path.
 */

// WorldBlockProvider interface (subset used by this module)
export interface TextureAtlasInfo {
  /** Atlas width in pixels (must be 1024) */
  width: number
  /** Atlas height in pixels (must be 1024) */
  height: number
  /** Tile size in pixels (must be 16) */
  tileSize: number
  /** Resolution scale (suSv = tileSize * resolution) */
  suSv: number
  /** Texture name → atlas position */
  textures: Record<string, TextureEntry>
}

export interface TextureEntry {
  /** Horizontal pixel offset within atlas */
  u: number
  /** Vertical pixel offset within atlas */
  v: number
  /** Horizontal pixel count (typically 16 or suSv) */
  su: number
  /** Vertical pixel count (typically 16 or suSv) */
  sv: number
}

export class TextureIndexMapping {
  private atlasWidth: number
  private atlasHeight: number
  private tileSize: number
  private tilesPerRow: number
  private maxTiles: number
  private valid: boolean

  constructor(atlasInfo: TextureAtlasInfo) {
    this.atlasWidth = atlasInfo.width
    this.atlasHeight = atlasInfo.height
    this.tileSize = atlasInfo.tileSize
    this.tilesPerRow = Math.floor(this.atlasWidth / this.tileSize)
    this.maxTiles = this.tilesPerRow * Math.floor(this.atlasHeight / this.tileSize)

    // Only valid when atlas matches the shader's hardcoded layout (1024×1024, 16×16 tiles).
    this.valid = this.atlasWidth === 1024 && this.atlasHeight === 1024 && this.tileSize === 16 && this.maxTiles <= 4096 // 12-bit limit
  }

  /** True when 12-bit texIndex encoding is safe (atlas matches the shader's layout). */
  isValid(): boolean {
    return this.valid
  }

  /** Tiles per row in the atlas */
  getTilesPerRow(): number {
    return this.tilesPerRow
  }

  /**
   * Compute absolute tile index from atlas pixel position.
   * Returns -1 if the position is out of range or gate fails.
   */
  tileIndexFromPixelCoords(u: number, v: number): number {
    if (!this.valid) return -1
    const tileCol = Math.floor(u / this.tileSize)
    const tileRow = Math.floor(v / this.tileSize)
    if (tileCol < 0 || tileCol >= this.tilesPerRow || tileRow < 0) return -1
    const index = tileRow * this.tilesPerRow + tileCol
    if (index >= this.maxTiles) return -1
    return index
  }

  /**
   * Get tile index for a texture entry from the atlas.
   * Returns -1 if the texture spans multiple tiles or gate fails.
   */
  tileIndexFromTextureEntry(entry: TextureEntry): number {
    if (!this.valid) return -1
    // Verify the texture occupies exactly one tile
    if (entry.su !== this.tileSize || entry.sv !== this.tileSize) return -1
    return this.tileIndexFromPixelCoords(entry.u, entry.v)
  }

  /**
   * Look up tile index by texture name.
   * Returns -1 if the texture is not found, spans multiple tiles, or gate fails.
   */
  tileIndexFromTextureName(textureName: string, atlasInfo: TextureAtlasInfo): number {
    if (!this.valid) return -1
    // Try exact name, then strip namespace prefix
    let entry = atlasInfo.textures[textureName]
    if (!entry && textureName.includes(':')) {
      entry = atlasInfo.textures[textureName.split(':')[1]]
    }
    if (!entry && textureName.includes('/')) {
      entry = atlasInfo.textures[textureName.split('/')[1]]
    }
    if (!entry) {
      // Try 'block/' prefix
      entry = atlasInfo.textures[`block/${textureName}`]
    }
    if (!entry) {
      // Try without 'block/' prefix
      const stripped = textureName.replace(/^block\//, '')
      entry = atlasInfo.textures[stripped]
    }
    if (!entry) return -1
    return this.tileIndexFromTextureEntry(entry)
  }
}
