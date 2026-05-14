import PrismarineWorld from 'prismarine-world'
import PrismarineChunk from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import MinecraftData from 'minecraft-data'
import { defaultMesherConfig } from '../../mesher-shared/shared'
import { setup } from './mesherTester.js'
import { generateSpiralMatrix } from '../../lib/spiral'

// const version = '1.8.8'
const version = '1.21.1'
const World = PrismarineWorld(version)
const Chunk = PrismarineChunk(version)
const data = MinecraftData(version)

const { chunk, getGeometry, reload } = setup(version, [])

const fillers = {
  // 10 iterations no smooth light 66ms m1 pro
  worstPossibleFull() {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = -64; y < 320; y++) {
          // Create a 3D checkerboard pattern where each block is surrounded by air
          const isEvalPoint = (x % 3 === 0) && (z % 3 === 0) && (y % 3 === 0)
          // chunk.setBlockStateId(new Vec3(x, y, z), isEvalPoint ? 1 : 0)
          chunk.setBlockType(new Vec3(x, y, z), isEvalPoint ? 1 : 0)
        }
      }
    }
  },
  allFilled() {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = -64; y < 320; y++) {
          chunk.setBlockType(new Vec3(x, y, z), 1)
        }
      }
    }
  }
}

defaultMesherConfig.enableLighting = true
defaultMesherConfig.smoothLighting = false

fillers.worstPossibleFull()
reload()

const sectionsY = Math.floor(384 / 16)
const chunks = generateSpiralMatrix(5).length
// const sections = chunks * sectionsY
const sections = 10

const testIterations = 10 * 16 * 16 * 16 * 6

console.time('iterate')
// for (let i = 0; i < testIterations; i++) {
//   const a = new Vec3(Math.random(), Math.random(), Math.random())
//   a[0]
// }

for (let i = 0; i < sections; i++) {
  const { totalTiles } = getGeometry()
  console.log('totalTiles', totalTiles)
  //   for (let x = 0; x < 16; x++) {
  //     for (let z = 0; z < 16; z++) {
  //       for (let y = -64; y < 320; y++) {
  //         world.getBlockStateId(new Vec3(x, y, z))
  //       }
  //     }
  //   }
}
console.timeEnd('iterate')
console.log(globalThis.tasksTiming)
console.log(sections)
