import MinecraftData from 'minecraft-data'
import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { packUnpackedLightSection } from '../../mesher-shared/lightNibblePack'
import { LIGHT_BLOCKS_PER_SECTION, maskBitSet, worldSectionMaskBit, type ParsedUpdateLight } from './mesherWasmLightMerge'

// Drives the real worker message handler. The legacy mesh path reads light
// through `World.getChannelLightNorm`, so that is what these tests observe.

const { parseUpdateLightV17 } = vi.hoisted(() => ({ parseUpdateLightV17: vi.fn() }))

vi.mock('../runtime-build/wasm_mesher.js', () => ({
  default: vi.fn(async () => undefined),
  parseUpdateLightV17
}))
vi.mock('../../mesher-shared/models', async importOriginal => ({
  ...(await importOriginal<object>()),
  setBlockStatesData: vi.fn()
}))
vi.mock('./mesherWasmTickSchedule', () => ({
  BULK_MESH_INTERVAL_MS: 50,
  createMeshTickScheduler: () => ({ kick: vi.fn() })
}))

const VERSION = '1.17.1'
const NUM_SECTIONS = 16
const COLUMN_X = 16
const COLUMN_Z = 32
const PUBLISHED_Y = 64
const UNPUBLISHED_Y = 80
const PUBLISHED_POS = new Vec3(COLUMN_X + 3, PUBLISHED_Y + 1, COLUMN_Z + 5)
const UNPUBLISHED_POS = new Vec3(COLUMN_X + 3, UNPUBLISHED_Y + 5, COLUMN_Z + 5)
const INCOMING = {
  [PUBLISHED_Y]: { sky: 3, block: 1 },
  [UNPUBLISHED_Y]: { sky: 9, block: 4 }
}

type WorkerSelf = { onmessage: (event: { data: unknown }) => void }
type WorldLike = {
  getColumn: (x: number, z: number) => {
    setSkyLight: (pos: Vec3, light: number) => void
    setBlockLight: (pos: Vec3, light: number) => void
    skyLightSections: Array<unknown | null>
    blockLightSections: Array<unknown | null>
  }
  getChannelLightNorm: (pos: Vec3) => { block: number; sky: number }
}

const send = (data: unknown) => (globalThis.self as unknown as WorkerSelf).onmessage({ data })
const world = () => (globalThis as unknown as { world: WorldLike }).world
const lightAt = (pos: Vec3) => world().getChannelLightNorm(pos)
const expectedLight = ({ sky, block }: { sky: number; block: number }) => ({
  sky: Math.min(15, sky + 2) / 15,
  block: Math.min(15, block + 2) / 15
})

function serverColumnJson() {
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk(undefined as any)
  const stone = MinecraftData(VERSION).blocksByName.stone!.defaultState
  chunk.setBlockStateId(new Vec3(3, PUBLISHED_POS.y, 5), stone)
  chunk.setBlockStateId(new Vec3(3, UNPUBLISHED_POS.y, 5), stone)
  return chunk.toJson()
}

function serverLightPacket(): ParsedUpdateLight {
  const columnBytes = NUM_SECTIONS * LIGHT_BLOCKS_PER_SECTION
  const skyLight = new Uint8Array(columnBytes)
  const blockLight = new Uint8Array(columnBytes)
  const skyLightMask = new Uint32Array(2)
  const blockLightMask = new Uint32Array(2)
  for (const [sectionY, light] of Object.entries(INCOMING)) {
    const sectionIndex = Number(sectionY) / 16
    const start = sectionIndex * LIGHT_BLOCKS_PER_SECTION
    skyLight.fill(light.sky, start, start + LIGHT_BLOCKS_PER_SECTION)
    blockLight.fill(light.block, start, start + LIGHT_BLOCKS_PER_SECTION)
    maskBitSet(skyLightMask, worldSectionMaskBit(sectionIndex))
    maskBitSet(blockLightMask, worldSectionMaskBit(sectionIndex))
  }
  return {
    x: COLUMN_X / 16,
    z: COLUMN_Z / 16,
    trustEdges: true,
    numSections: NUM_SECTIONS,
    skyLight,
    blockLight,
    skyLightMask,
    blockLightMask,
    emptySkyLightMask: new Uint32Array(2),
    emptyBlockLightMask: new Uint32Array(2)
  }
}

function publishOwnerLight(publicationVersion: number, sectionY: number, light: { sky: number; block: number }) {
  const packed = (value: number) => packUnpackedLightSection(new Uint8Array(LIGHT_BLOCKS_PER_SECTION).fill(value))
  send({
    type: 'applyOwnerLightPublication',
    worldGeneration: 1,
    publicationVersion,
    sections: [{ sx: COLUMN_X, sy: sectionY, sz: COLUMN_Z, blockLight: packed(light.block), skyLight: packed(light.sky) }]
  })
}

/** Moves the JS column away from the caches, so a sync of this section is detectable. */
function markUnpublishedSectionInJsColumn(light: { sky: number; block: number }) {
  const column = world().getColumn(COLUMN_X, COLUMN_Z)
  const local = new Vec3(UNPUBLISHED_POS.x & 15, UNPUBLISHED_POS.y, UNPUBLISHED_POS.z & 15)
  column.setSkyLight(local, light.sky)
  column.setBlockLight(local, light.block)
}

describe('mesher worker JS column light with the client light owner', () => {
  beforeEach(async () => {
    vi.resetModules()
    parseUpdateLightV17.mockReset()
    parseUpdateLightV17.mockReturnValue(serverLightPacket())
    vi.stubGlobal('self', {})
    vi.stubGlobal('postMessage', vi.fn())
    const realSetInterval = globalThis.setInterval
    vi.stubGlobal('setInterval', vi.fn())
    await import('./mesherWasm')
    vi.stubGlobal('setInterval', realSetInterval)

    send({ type: 'mesherData', config: { version: VERSION, worldMinY: 0, worldMaxY: 256, enableLighting: true } })
    send({ type: 'chunk', x: COLUMN_X, z: COLUMN_Z, chunk: serverColumnJson() })
    send({ type: 'setUpdateLightV17', rawPacket: new Uint8Array(1), numSections: NUM_SECTIONS })
    await vi.waitFor(() => expect(parseUpdateLightV17).toHaveBeenCalledOnce())

    expect(lightAt(PUBLISHED_POS)).toEqual(expectedLight(INCOMING[PUBLISHED_Y]))
    expect(lightAt(UNPUBLISHED_POS)).toEqual(expectedLight(INCOMING[UNPUBLISHED_Y]))
  }, 30_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as any).world
  })

  it('keeps authoritative zero light explicit in initially null sections', () => {
    const sectionY = 96
    const pos = new Vec3(COLUMN_X + 3, sectionY + 1, COLUMN_Z + 5)
    expect(lightAt(pos)).toEqual({ block: 0, sky: 1 })
    publishOwnerLight(1, sectionY, { sky: 0, block: 0 })
    expect(lightAt(pos)).toEqual(expectedLight({ sky: 0, block: 0 }))
    send({ type: 'chunk', x: COLUMN_X, z: COLUMN_Z, chunk: serverColumnJson() })
    expect(lightAt(pos)).toEqual(expectedLight({ sky: 0, block: 0 }))
  })

  it('allocates only the authoritative channel and leaves omitted sections null', () => {
    const sectionY = 96
    send({
      type: 'applyOwnerLightPublication', worldGeneration: 1, publicationVersion: 1,
      sections: [{ sx: COLUMN_X, sy: sectionY, sz: COLUMN_Z, blockLight: new Uint8Array(2048) }]
    })
    const column = world().getColumn(COLUMN_X, COLUMN_Z)
    expect(column.blockLightSections[sectionY / 16 + 1]).not.toBeNull()
    expect(column.skyLightSections[sectionY / 16 + 1]).toBeNull()
    expect(column.blockLightSections[sectionY / 16 + 2]).toBeNull()
    expect(column.skyLightSections[sectionY / 16 + 2]).toBeNull()
    expect(lightAt(new Vec3(COLUMN_X + 3, sectionY + 17, COLUMN_Z + 5))).toEqual({ block: 0, sky: 1 })
  })

  it('raises JS light when a publication brightens a section', () => {
    const bright = { sky: 12, block: 7 }
    publishOwnerLight(1, PUBLISHED_Y, bright)
    expect(lightAt(PUBLISHED_POS)).toEqual(expectedLight(bright))
  })

  it('lowers JS light when a later publication darkens the section', () => {
    const dark = { sky: 0, block: 0 }
    publishOwnerLight(1, PUBLISHED_Y, { sky: 12, block: 7 })
    publishOwnerLight(2, PUBLISHED_Y, dark)
    expect(lightAt(PUBLISHED_POS)).toEqual(expectedLight(dark))
  })

  it('writes only the published section Ys into the JS column', () => {
    const marker = { sky: 14, block: 13 }
    const bright = { sky: 12, block: 7 }
    markUnpublishedSectionInJsColumn(marker)
    publishOwnerLight(1, PUBLISHED_Y, bright)
    expect(lightAt(PUBLISHED_POS)).toEqual(expectedLight(bright))
    expect(lightAt(UNPUBLISHED_POS)).toEqual(expectedLight(marker))
  })

  it('restores every incoming section in the JS column on revert', () => {
    publishOwnerLight(1, PUBLISHED_Y, { sky: 12, block: 7 })
    markUnpublishedSectionInJsColumn({ sky: 14, block: 13 })
    send({ type: 'revertOwnerLightToIncoming' })
    expect(lightAt(PUBLISHED_POS)).toEqual(expectedLight(INCOMING[PUBLISHED_Y]))
    expect(lightAt(UNPUBLISHED_POS)).toEqual(expectedLight(INCOMING[UNPUBLISHED_Y]))
  })
})
