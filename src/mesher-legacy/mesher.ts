import { Vec3 } from 'vec3'
import { World } from '../mesher-shared/world'
import { getSectionGeometry, setBlockStatesData as setMesherData, computeWireframeEdgesJS } from '../mesher-shared/models'
import { BlockStateModelInfo } from '../mesher-shared/shared'
import { handleGetHeightmap, EMPTY_COLUMN_HEIGHTMAP_SENTINEL } from '../mesher-shared/computeHeightmap'

globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value))

if (globalThis.module && module.require) {
  // If we are in a node environement, we need to fake some env variables
  const r = module.require
  const { parentPort } = r('worker_threads')
  global.self = parentPort
  global.postMessage = (value, transferList) => {
    parentPort.postMessage(value, transferList)
  }
  global.performance = r('perf_hooks').performance
}

let workerIndex = 0
let world: World
let dirtySections = new Map<string, number>()
let allDataReady = false

function sectionKey(x, y, z) {
  return `${x},${y},${z}`
}

const batchMessagesLimit = 100

let queuedMessages = [] as any[]
let queueWaiting = false
const postMessage = (data, transferList = []) => {
  queuedMessages.push({ data, transferList })
  if (queuedMessages.length > batchMessagesLimit) {
    drainQueue(0, batchMessagesLimit)
  }
  if (queueWaiting) return
  queueWaiting = true
  setTimeout(() => {
    queueWaiting = false
    drainQueue(0, queuedMessages.length)
  })
}

function drainQueue(from, to) {
  const messages = queuedMessages.slice(from, to)
  global.postMessage(
    messages.map(m => m.data),
    messages.flatMap(m => m.transferList) as unknown as string
  )
  queuedMessages = queuedMessages.slice(to)
}

function setSectionDirty(pos, value = true) {
  const x = Math.floor(pos.x / 16) * 16
  const y = Math.floor(pos.y / 16) * 16
  const z = Math.floor(pos.z / 16) * 16
  const key = sectionKey(x, y, z)
  if (!value) {
    dirtySections.delete(key)
    postMessage({ type: 'sectionFinished', key, workerIndex })
    return
  }

  const chunk = world.getColumn(x, z)
  if (chunk?.getSection(pos)) {
    dirtySections.set(key, (dirtySections.get(key) || 0) + 1)
  } else {
    postMessage({ type: 'sectionFinished', key, workerIndex })
  }
}

const softCleanup = () => {
  // clean block cache and loaded chunks
  world = new World(world.config.version)
  globalThis.world = world
}

const handleMessage = data => {
  const globalVar: any = globalThis

  if (data.type === 'mcData') {
    globalVar.mcData = data.mcData
    globalVar.loadedData = data.mcData
  }

  if (data.config) {
    if (data.type === 'mesherData' && world) {
      // reset models
      world.blockCache = {}
      world.erroredBlockModel = undefined
    }

    world ??= new World(data.config.version)
    world.config = { ...world.config, ...data.config }
    globalThis.world = world
    globalThis.Vec3 = Vec3
  }

  switch (data.type) {
    case 'mesherData': {
      setMesherData(data.blockstatesModels, data.blocksAtlas, data.config.outputFormat === 'webgpu')
      allDataReady = true
      workerIndex = data.workerIndex

      break
    }
    case 'dirty': {
      const loc = new Vec3(data.x, data.y, data.z)
      setSectionDirty(loc, data.value)

      break
    }
    case 'chunk': {
      if (!world) break
      world.addColumn(data.x, data.z, data.chunk)
      if (data.customBlockModels) {
        const chunkKey = `${data.x},${data.z}`
        world.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'unloadChunk': {
      if (!world) break
      world.removeColumn(data.x, data.z)
      world.customBlockModels.delete(`${data.x},${data.z}`)
      if (Object.keys(world.columns).length === 0) softCleanup()
      break
    }
    case 'blockUpdate': {
      const loc = new Vec3(data.pos.x, data.pos.y, data.pos.z).floored()
      if (data.stateId !== undefined && data.stateId !== null) {
        world?.setBlockStateId(loc, data.stateId)
      }

      const chunkKey = `${Math.floor(loc.x / 16) * 16},${Math.floor(loc.z / 16) * 16}`
      if (data.customBlockModels) {
        world?.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'reset': {
      world = undefined as any
      // blocksStates = null
      dirtySections = new Map()
      // todo also remove cached
      globalVar.mcData = null
      globalVar.loadedData = null
      allDataReady = false

      break
    }
    case 'getCustomBlockModel': {
      if (!world) {
        global.postMessage({ type: 'customBlockModel', chunkKey: '', customBlockModel: undefined })
        break
      }
      const pos = new Vec3(data.pos.x, data.pos.y, data.pos.z)
      const chunkKey = `${Math.floor(pos.x / 16) * 16},${Math.floor(pos.z / 16) * 16}`
      const customBlockModel = world.customBlockModels.get(chunkKey)?.[`${pos.x},${pos.y},${pos.z}`]
      global.postMessage({ type: 'customBlockModel', chunkKey, customBlockModel })
      break
    }
    case 'getHeightmap': {
      if (!world) {
        const emptyHeightmap = new Int16Array(256).fill(EMPTY_COLUMN_HEIGHTMAP_SENTINEL)
        postMessage({ type: 'heightmap', key: `${Math.floor(data.x / 16)},${Math.floor(data.z / 16)}`, heightmap: emptyHeightmap })
        break
      }
      const { key, heightmap } = handleGetHeightmap(world, data.x, data.z)
      postMessage({ type: 'heightmap', key, heightmap })

      break
    }
    case 'mc-web-ping': {
      const replyWorkerIndex = typeof data.workerIndex === 'number' ? data.workerIndex : workerIndex
      global.postMessage({
        type: 'mc-web-pong',
        workerIndex: replyWorkerIndex,
        t: data.t,
        recvAt: typeof performance !== 'undefined' ? performance.now() : undefined
      })
      break
    }
    // No default
  }
}

// eslint-disable-next-line no-restricted-globals -- TODO
self.onmessage = ({ data }) => {
  if (Array.isArray(data)) {
    // eslint-disable-next-line unicorn/no-array-for-each
    data.forEach(handleMessage)
    return
  }

  handleMessage(data)
}

setInterval(() => {
  if (world === null || !allDataReady) return

  if (dirtySections.size === 0) return
  // console.log(sections.length + ' dirty sections')

  // const start = performance.now()
  for (const key of dirtySections.keys()) {
    const [x, y, z] = key.split(',').map(v => parseInt(v, 10))
    const chunk = world.getColumn(x, z)
    let processTime = 0
    if (chunk?.getSection(new Vec3(x, y, z))) {
      const start = performance.now()
      const geometry = getSectionGeometry(x, y, z, world)
      if (geometry.positions.length > 0 && geometry.indices.length > 0 && world.config.computeWireframeEdges) {
        const wireframeF32 = computeWireframeEdgesJS(geometry.positions as number[], geometry.indices as number[])
        if (wireframeF32.length > 0) {
          geometry.wireframePositions = wireframeF32
        }
      }
      const transferable = [geometry.positions?.buffer, geometry.normals?.buffer, geometry.colors?.buffer, geometry.uvs?.buffer].filter(Boolean)
      if (geometry.wireframePositions) {
        transferable.push(geometry.wireframePositions.buffer)
      }
      //@ts-expect-error
      postMessage({ type: 'geometry', key, geometry, workerIndex }, transferable)
      processTime = performance.now() - start
    } else {
      // console.info('[mesher] Missing section', x, y, z)
    }
    const dirtyTimes = dirtySections.get(key)
    if (!dirtyTimes) throw new Error('dirtySections.get(key) is falsy')
    for (let i = 0; i < dirtyTimes; i++) {
      postMessage({ type: 'sectionFinished', key, workerIndex, processTime })
      processTime = 0
    }
    dirtySections.delete(key)
  }

  // Send new block state model info if any
  if (world.blockStateModelInfo.size > 0) {
    const newBlockStateInfo: Record<string, BlockStateModelInfo> = {}
    for (const [cacheKey, info] of world.blockStateModelInfo) {
      if (!world.sentBlockStateModels.has(cacheKey)) {
        newBlockStateInfo[cacheKey] = info
        world.sentBlockStateModels.add(cacheKey)
      }
    }
    if (Object.keys(newBlockStateInfo).length > 0) {
      postMessage({ type: 'blockStateModelInfo', info: newBlockStateInfo })
    }
  }

  // const time = performance.now() - start
  // console.log(`Processed ${sections.length} sections in ${time} ms (${time / sections.length} ms/section)`)
}, 50)
