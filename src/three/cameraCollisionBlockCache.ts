import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'
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
  private Chunk: ReturnType<typeof Chunks>
  private solidityTable: Uint8Array
  private worldMinY = 0
  private worldMaxY = 256

  constructor(version: string) {
    this.Chunk = Chunks(version) as ReturnType<typeof Chunks>
    this.solidityTable = getCameraCollisionSolidityTable(version)
  }

  setVersion(version: string) {
    this.Chunk = Chunks(version) as ReturnType<typeof Chunks>
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

  ingestColumn(chunkX: number, chunkZ: number, chunkJson: unknown) {
    const chunk = this.Chunk.fromJson(chunkJson as Parameters<ReturnType<typeof Chunks>['fromJson']>[0]) as unknown as {
      getBlockStateId: (pos: Vec3) => number
    }
    const pos = new Vec3(0, 0, 0)

    for (let y = this.worldMinY; y < this.worldMaxY; y++) {
      pos.y = y
      const sy = alignSection(y)
      const ly = y - sy
      for (let lz = 0; lz < 16; lz++) {
        pos.z = lz
        const wz = chunkZ + lz
        const sz = alignSection(wz)
        const lzLocal = wz - sz
        for (let lx = 0; lx < 16; lx++) {
          pos.x = lx
          const stateId = chunk.getBlockStateId(pos) || 0
          if (!isStateIdSolidForCameraCollision(stateId, this.solidityTable)) continue

          const wx = chunkX + lx
          const sx = alignSection(wx)
          const key = sectionKey(sx, sy, sz)
          let bits = this.sections.get(key)
          if (!bits) {
            bits = new Uint32Array(WORDS_PER_SECTION)
            this.sections.set(key, bits)
          }
          setBit(bits, blockBitIndex(wx - sx, ly, lzLocal), true)
        }
      }
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
