import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import moreBlockDataGeneratedJson from '../lib/moreBlockDataGenerated.json'

const solidityCache = new Map<string, Uint8Array>()

const PASS_THROUGH_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'grass', 'short_grass', 'tall_grass'])

/** 1 = blocks third-person camera DDA; 0 = pass-through (air, plants, fluids). */
export function getCameraCollisionSolidityTable(version: string): Uint8Array {
  const cached = solidityCache.get(version)
  if (cached) return cached

  const mcData = MinecraftData(version)
  const Block = PrismarineBlockLoader(version)
  const noOcclusionsSet = new Set(Object.keys(moreBlockDataGeneratedJson.noOcclusions))
  const invisibleNames = new Set(mcData.blocksArray.filter(b => moreBlockDataGeneratedJson.invisibleBlocks[b.name]).map(b => b.name))

  let maxStateId = 0
  for (const idStr of Object.keys((mcData as { blocksByStateId: Record<string, unknown> }).blocksByStateId)) {
    maxStateId = Math.max(maxStateId, Number(idStr))
  }

  const table = new Uint8Array(maxStateId + 1)
  for (const idStr of Object.keys((mcData as { blocksByStateId: Record<string, unknown> }).blocksByStateId)) {
    const stateId = Number(idStr)
    if (!stateId) continue

    const block = (
      Block as { fromStateId: (id: number, y: number) => { name: string; transparent: boolean; boundingBox: string; shapes?: number[][] } | null }
    ).fromStateId(stateId, 0)
    if (!block) continue
    if (invisibleNames.has(block.name)) continue
    if (noOcclusionsSet.has(block.name)) continue
    if (PASS_THROUGH_NAMES.has(block.name)) continue
    if (block.boundingBox === 'empty') continue
    if (block.transparent && block.boundingBox !== 'block') continue
    if (!block.shapes || block.shapes.length === 0) continue

    table[stateId] = 1
  }

  solidityCache.set(version, table)
  return table
}

export function isStateIdSolidForCameraCollision(stateId: number, solidityTable: Uint8Array): boolean {
  return stateId > 0 && stateId < solidityTable.length && solidityTable[stateId] === 1
}
