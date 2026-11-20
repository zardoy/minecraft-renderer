import { fillSectionStates, parseColumn } from '../lib/columnSectionStates'
import { getCameraCollisionSolidityTable, isStateIdSolidForCameraCollision } from './cameraCollisionSolidity'

/** 16³ blocks per section; 1 bit per block. */
const WORDS_PER_SECTION = 128
export const CAMERA_COLLISION_BYTES_PER_SECTION = WORDS_PER_SECTION * 4

type SectionBitset = Uint32Array

const sectionKey = (sx: number, sy: number, sz: number) => `${sx},${sy},${sz}`

const alignSection = (coord: number) => Math.floor(coord / 16) * 16

const localCoord = (coord: number) => ((coord % 16) + 16) % 16

const blockBitIndex = (lx: number, ly: number, lz: number) => lx + lz * 16 + ly * 256

const getBit = (bits: SectionBitset, idx: number) => {
  const word = idx >>> 5
  return (bits[word]! & (1 << (idx & 31))) !== 0
}

const setBit = (bits: SectionBitset, idx: number, value: boolean) => {
  const word = idx >>> 5
  const mask = 1 << (idx & 31)
  if (value) bits[word]! |= mask
  else bits[word]! &= ~mask
}

const isBitsetEmpty = (bits: SectionBitset) => {
  for (let i = 0; i < WORDS_PER_SECTION; i++) {
    if (bits[i]!) return false
  }
  return true
}

/**
 * Sparse 1-bit-per-block solidity cache for third-person voxel DDA.
 * Allocates a 512-byte section bitset only when it contains ≥1 solid block.
 */
export class CameraCollisionBlockCache {
  private readonly sections = new Map<string, SectionBitset>()
  private readonly scratchStates = new Uint16Array(4096)
  private version: string
  private solidityTable: Uint8Array
  private worldMinY = 0
  private worldMaxY = 256

  constructor(version: string) {
    this.version = version
    this.solidityTable = getCameraCollisionSolidityTable(version)
  }

  setVersion(version: string) {
    this.version = version
    this.solidityTable = getCameraCollisionSolidityTable(version)
    this.sections.clear()
  }

  setWorldBounds(minY: number, worldHeight: number) {
    if (this.worldMinY === minY && this.worldMaxY === worldHeight) return
    this.worldMinY = minY
    this.worldMaxY = worldHeight
    this.sections.clear()
  }

  clear() {
    this.sections.clear()
  }

  /** Allocated 16³ section bitsets (512 bytes each). */
  getAllocatedSectionCount(): number {
    return this.sections.size
  }

  getAllocatedBytes(): number {
    return this.sections.size * CAMERA_COLLISION_BYTES_PER_SECTION
  }

  removeColumn(chunkX: number, chunkZ: number) {
    const syStart = alignSection(this.worldMinY)
    for (let sy = syStart; sy < this.worldMaxY; sy += 16) {
      this.sections.delete(sectionKey(chunkX, sy, chunkZ))
    }
  }

  /** `chunk` is the column JSON or the column already parsed (`addColumn` parses it once for every consumer). */
  ingestColumn(chunkX: number, chunkZ: number, chunk: unknown) {
    const column = parseColumn(this.version, chunk)
    const sx = alignSection(chunkX)
    const sz = alignSection(chunkZ)
    const table = this.solidityTable
    const states = this.scratchStates
    for (let sy = alignSection(this.worldMinY); sy < this.worldMaxY; sy += 16) {
      const key = sectionKey(sx, sy, sz)
      states.fill(0)
      let bits: SectionBitset | undefined
      if (fillSectionStates(column, sy, states)) {
        for (let i = 0; i < 4096; i++) {
          const stateId = states[i]!
          if (stateId === 0 || table[stateId] !== 1) continue
          bits ??= new Uint32Array(WORDS_PER_SECTION)
          // the state index is x + z * 16 + y * 256, the same order as the bitset
          bits[i >>> 5]! |= 1 << (i & 31)
        }
      }
      if (bits) this.sections.set(key, bits)
      else this.sections.delete(key)
    }
  }

  setBlockStateId(x: number, y: number, z: number, stateId: number) {
    if (y < this.worldMinY || y >= this.worldMaxY) return

    const sx = alignSection(x)
    const sy = alignSection(y)
    const sz = alignSection(z)
    const key = sectionKey(sx, sy, sz)
    const idx = blockBitIndex(localCoord(x), y - sy, localCoord(z))
    const solid = isStateIdSolidForCameraCollision(stateId, this.solidityTable)

    if (solid) {
      let bits = this.sections.get(key)
      if (!bits) {
        bits = new Uint32Array(WORDS_PER_SECTION)
        this.sections.set(key, bits)
      }
      setBit(bits, idx, true)
      return
    }

    const bits = this.sections.get(key)
    if (!bits) return
    setBit(bits, idx, false)
    if (isBitsetEmpty(bits)) this.sections.delete(key)
  }

  isSolidBlock(x: number, y: number, z: number): boolean {
    if (y < this.worldMinY || y >= this.worldMaxY) return false

    const bits = this.sections.get(sectionKey(alignSection(x), alignSection(y), alignSection(z)))
    if (!bits) return false

    return getBit(bits, blockBitIndex(localCoord(x), y - alignSection(y), localCoord(z)))
  }
}
