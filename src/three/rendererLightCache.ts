import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'

/** 16³ blocks, one packed byte (block<<4 | sky) per block. */
export const RENDERER_LIGHT_BYTES_PER_SECTION = 4096

const FULLBRIGHT = { block: 0, sky: 1 } as const

const sectionKey = (sx: number, sy: number, sz: number) => `${sx},${sy},${sz}`
const columnKey = (sx: number, sz: number) => `${sx},${sz}`
const alignSection = (coord: number) => Math.floor(coord / 16) * 16
const localCoord = (coord: number) => ((coord % 16) + 16) % 16
const blockIndex = (lx: number, ly: number, lz: number) => lx + lz * 16 + ly * 256

const channelNorm = (raw: number) => Math.min(15, raw + 2) / 15

const getLightSectionIndex = (y: number, minY = 0) => Math.floor((y - minY) / 16) + 1

const hasChunkSection = (column: any, pos: Vec3) => {
  if (column._getSection) return column._getSection(pos)
  if (column.skyLightSections) {
    return column.skyLightSections[getLightSectionIndex(pos.y, column.minY)] || column.blockLightSections[getLightSectionIndex(pos.y, column.minY)]
  }
  if (column.sections) return column.sections[pos.y >> 4]
  return false
}

const hashBytes = (sections: Map<string, Uint8Array>) => {
  let hash = 2166136261
  const keys = [...sections.keys()].sort()
  for (const key of keys) {
    const data = sections.get(key)!
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i]!
      hash = Math.imul(hash, 16777619)
    }
  }
  return hash >>> 0
}

type LightChunk = {
  getBlockLight: (pos: Vec3) => number
  getSkyLight: (pos: Vec3) => number
  minY?: number
  _getSection?: (pos: Vec3) => unknown
  skyLightSections?: unknown[]
  blockLightSections?: unknown[]
  sections?: unknown
}

export type RendererLightSample = { block: number; sky: number }

export type RendererLightIngestResult = { changed: boolean; revision: number }

/**
 * Main-thread packed block/sky light for entity sampling.
 * Absent sections stay fullbright; present raw-zero gets the project +2 floor.
 */
export class RendererLightCache {
  private readonly sections = new Map<string, Uint8Array>()
  private readonly columnHashes = new Map<string, number>()
  private readonly columnRevisions = new Map<string, number>()
  private Chunk: ReturnType<typeof Chunks>
  private worldMinY = 0
  private worldMaxY = 256
  private globalRevision = 0
  private nextColumnRevision = 1

  constructor(version: string) {
    this.Chunk = Chunks(version) as ReturnType<typeof Chunks>
  }

  setVersion(version: string) {
    this.Chunk = Chunks(version) as ReturnType<typeof Chunks>
    this.clear()
  }

  setWorldBounds(minY: number, worldHeight: number) {
    if (this.worldMinY === minY && this.worldMaxY === worldHeight) return
    this.worldMinY = minY
    this.worldMaxY = worldHeight
    this.clear()
  }

  clear() {
    if (this.sections.size === 0 && this.columnRevisions.size === 0) {
      this.globalRevision++
      return
    }
    this.sections.clear()
    this.columnHashes.clear()
    this.columnRevisions.clear()
    this.globalRevision++
  }

  getAllocatedSectionCount(): number {
    return this.sections.size
  }

  getAllocatedBytes(): number {
    return this.sections.size * RENDERER_LIGHT_BYTES_PER_SECTION
  }

  getGlobalRevision(): number {
    return this.globalRevision
  }

  getColumnRevision(chunkX: number, chunkZ: number): number | undefined {
    return this.columnRevisions.get(columnKey(alignSection(chunkX), alignSection(chunkZ)))
  }

  removeColumn(chunkX: number, chunkZ: number) {
    const sx = alignSection(chunkX)
    const sz = alignSection(chunkZ)
    const col = columnKey(sx, sz)
    const syStart = alignSection(this.worldMinY)
    for (let sy = syStart; sy < this.worldMaxY; sy += 16) {
      this.sections.delete(sectionKey(sx, sy, sz))
    }
    this.columnHashes.delete(col)
    this.columnRevisions.delete(col)
  }

  ingestColumn(chunkX: number, chunkZ: number, chunkJson: unknown): RendererLightIngestResult {
    const sx = alignSection(chunkX)
    const sz = alignSection(chunkZ)
    const col = columnKey(sx, sz)
    const previousRevision = this.columnRevisions.get(col) ?? 0

    let chunk: LightChunk
    try {
      chunk = this.Chunk.fromJson(chunkJson as Parameters<ReturnType<typeof Chunks>['fromJson']>[0]) as unknown as LightChunk
      if (typeof chunk?.getBlockLight !== 'function' || typeof chunk?.getSkyLight !== 'function') {
        throw new Error('invalid chunk light API')
      }
    } catch {
      return { changed: false, revision: previousRevision }
    }

    const packed = new Map<string, Uint8Array>()
    const pos = new Vec3(0, 0, 0)
    const syStart = alignSection(this.worldMinY)
    for (let sy = syStart; sy < this.worldMaxY; sy += 16) {
      pos.set(0, sy, 0)
      if (!hasChunkSection(chunk, pos)) continue
      const data = new Uint8Array(RENDERER_LIGHT_BYTES_PER_SECTION)
      for (let ly = 0; ly < 16; ly++) {
        pos.y = sy + ly
        for (let lz = 0; lz < 16; lz++) {
          pos.z = lz
          for (let lx = 0; lx < 16; lx++) {
            pos.x = lx
            const block = Math.max(0, Math.min(15, chunk.getBlockLight(pos) | 0))
            const sky = Math.max(0, Math.min(15, chunk.getSkyLight(pos) | 0))
            data[blockIndex(lx, ly, lz)] = (block << 4) | sky
          }
        }
      }
      packed.set(sectionKey(sx, sy, sz), data)
    }

    const hash = hashBytes(packed)
    if (this.columnHashes.get(col) === hash && this.columnRevisions.has(col)) {
      return { changed: false, revision: previousRevision }
    }

    const syStartRemove = alignSection(this.worldMinY)
    for (let sy = syStartRemove; sy < this.worldMaxY; sy += 16) {
      this.sections.delete(sectionKey(sx, sy, sz))
    }
    for (const [key, data] of packed) {
      this.sections.set(key, data)
    }
    this.columnHashes.set(col, hash)
    const revision = this.nextColumnRevision++
    this.columnRevisions.set(col, revision)
    return { changed: true, revision }
  }

  getLight(x: number, y: number, z: number): RendererLightSample {
    if (y < this.worldMinY || y >= this.worldMaxY) return { ...FULLBRIGHT }
    const sx = alignSection(x)
    const sy = alignSection(y)
    const sz = alignSection(z)
    const data = this.sections.get(sectionKey(sx, sy, sz))
    if (!data) return { ...FULLBRIGHT }
    const packed = data[blockIndex(localCoord(x), y - sy, localCoord(z))] ?? 0
    return {
      block: channelNorm(packed >> 4),
      sky: channelNorm(packed & 0x0f)
    }
  }
}
