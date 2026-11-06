import { test, expect } from 'vitest'
import minecraftData, { versions } from 'minecraft-data'
import { INVISIBLE_BLOCKS } from '../../mesher-shared/worldConstants'
import { setup } from './mesherTester'

// newest release that minecraft-data has data for (its protocol versions list can run ahead of the data, e.g. 26.2 / 26.3)
const lastVersion = versions.pc
  .map(x => x.minecraftVersion)
  .filter(version => !/w|-pre|-rc|-snapshot/.test(version))
  .find(version => minecraftData(version))!

const addPositions = [
  // [[0, 0, 0], 'diamond_block'],
  // [[1, 0, 0], 'stone'],
  // [[-1, 0, 0], 'stone'],
  // [[0, 1, 0], 'stone'],
  // [[0, -1, 0], 'stone'],
  // [[0, 0, 1], 'stone'],
  // [[0, 0, -1], 'stone'],
] as const

/** Meshes the default state of every block of the version and returns the blocks that gave no geometry / errored */
function meshAllBlocks(version: string) {
  const { mesherWorld, getGeometry, pos, mcData } = setup(version, addPositions as any)
  const ignoreAsExpected = new Set([...INVISIBLE_BLOCKS, 'water', 'lava'])

  const missingBlocks: string[] = []
  const erroredBlocks: string[] = []
  for (const block of mcData.blocksArray) {
    if (ignoreAsExpected.has(block.name)) continue
    mesherWorld.setBlockStateId(pos, block.defaultState)
    const { centerFaces, attr } = getGeometry()
    if (centerFaces === 0) (attr.hadErrors ? erroredBlocks : missingBlocks).push(block.name)
  }
  return { missingBlocks, erroredBlocks }
}

// These tests only guard against making the renderer worse. Blocks that a new minecraft-data / mc-assets version adds
// without a model must not fail them (versions are updated automatically), so the newest version is only checked for errors.

// TODO resolve creaking_heart issue (1.21.3)
const KNOWN_MISSING_BLOCKS = ['structure_void']
// pinned: the data of a released version doesn't grow new blocks, so what renders here must keep rendering
const pinnedVersion = '1.21.8'

test(`Blocks of ${pinnedVersion} that rendered keep rendering`, () => {
  const { missingBlocks, erroredBlocks } = meshAllBlocks(pinnedVersion)
  // fixing a block (it renders now) is fine, only blocks that stopped rendering fail
  expect(missingBlocks.filter(name => !KNOWN_MISSING_BLOCKS.includes(name))).toEqual([])
  expect(erroredBlocks).toEqual([])
})

test('Newest version: no block fails to mesh', () => {
  const { missingBlocks, erroredBlocks } = meshAllBlocks(lastVersion)
  console.log('Checked blocks of version', lastVersion)
  // visibility only, e.g. new block entities that need a custom model in mc-assets
  if (missingBlocks.length > 0) console.warn(`Blocks of ${lastVersion} that render nothing:`, missingBlocks.join(', '))
  expect(erroredBlocks).toEqual([])
})
