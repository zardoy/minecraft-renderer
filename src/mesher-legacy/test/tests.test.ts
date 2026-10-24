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

test('Known blocks are not rendered', () => {
  const { mesherWorld, getGeometry, pos, mcData } = setup(lastVersion, addPositions as any)
  const ignoreAsExpected = new Set([...INVISIBLE_BLOCKS, 'water', 'lava'])

  let time = 0
  let times = 0
  const missingBlocks = {} /*  as {[number, number]} */
  const erroredBlocks = {} /*  as {[number, number]} */
  for (const block of mcData.blocksArray) {
    if (ignoreAsExpected.has(block.name)) continue
    // if (block.maxStateId! - block.minStateId! > 100) continue
    // for (let i = block.minStateId!; i <= block.maxStateId!; i++) {
    for (let i = block.defaultState; i <= block.defaultState; i++) {
      // if (block.transparent) continue
      mesherWorld.setBlockStateId(pos, i)
      const start = performance.now()
      const { centerFaces, totalTiles, centerTileNeighbors, attr } = getGeometry()
      time += performance.now() - start
      times++
      if (centerFaces === 0) {
        const objAdd = attr.hadErrors ? erroredBlocks : missingBlocks
        if (objAdd[block.name]) continue
        objAdd[block.name] = true
        // invalidBlocks[block.name] = [i - block.defaultState!, centerTileNeighbors]
        // console.log('INVALID', block.name, centerTileNeighbors, i - block.minStateId)
      }
    }
  }
  console.log('Checking blocks of version', lastVersion)
  console.log('Average time', time / times)
  // should be fixed, but to avoid regressions & for visibility
  // TODO resolve creaking_heart issue (1.21.3)
  // TODO 26.x: copper chests / copper golem statues (block entity models) and golden_dandelion have no block model yet
  expect(missingBlocks).toMatchInlineSnapshot(`
    {
      "copper_chest": true,
      "copper_golem_statue": true,
      "exposed_copper_chest": true,
      "exposed_copper_golem_statue": true,
      "golden_dandelion": true,
      "oxidized_copper_chest": true,
      "oxidized_copper_golem_statue": true,
      "potted_golden_dandelion": true,
      "structure_void": true,
      "waxed_copper_chest": true,
      "waxed_copper_golem_statue": true,
      "waxed_exposed_copper_chest": true,
      "waxed_exposed_copper_golem_statue": true,
      "waxed_oxidized_copper_chest": true,
      "waxed_oxidized_copper_golem_statue": true,
      "waxed_weathered_copper_chest": true,
      "waxed_weathered_copper_golem_statue": true,
      "weathered_copper_chest": true,
      "weathered_copper_golem_statue": true,
    }
  `)
  expect(erroredBlocks).toMatchInlineSnapshot('{}')
})
