/**
 * WorldView - World data emitter for the renderer.
 * Renamed from WorldDataEmitter for clarity.
 *
 * Handles chunk loading/unloading, block updates, and world events.
 */

import { EventEmitter } from 'events'
import { Vec3 } from 'vec3'
import TypedEmitter from 'typed-emitter'
import type { WorldViewEvents, ChunkPosKey, WorldSizeParams } from './types'
import { generateSpiralMatrix } from '../lib/spiral'
import { sanitizeWorkerEventArgs } from '../lib/workerMessageSanitize'

/**
 * Helper to calculate chunk position from absolute position.
 */
export const chunkPos = (pos: { x: number; z: number } | Vec3): [number, number] => {
  return [Math.floor(pos.x / 16), Math.floor(pos.z / 16)]
}

/**
 * Helper to calculate section position from absolute position.
 */
export const sectionPos = (pos: { x: number; y: number; z: number }): [number, number, number] => {
  return [Math.floor(pos.x / 16), Math.floor(pos.y / 16), Math.floor(pos.z / 16)]
}

/**
 * Delayed iterator for chunk loading with configurable delay.
 */
export const delayedIterator = async <T>(arr: T[], delay: number, exec: (item: T, index: number) => Promise<void>, chunkSize = 1): Promise<void> => {
  for (let i = 0; i < arr.length; i += chunkSize) {
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    await exec(arr[i], i)
  }
}

type WorkerWorldViewBridge = {
  activeWorldView: WorldViewWorker
  handler: (event: MessageEvent) => void
}

const workerWorldViewBridges = new WeakMap<Worker, WorkerWorldViewBridge>()

/**
 * WorldView for worker thread communication.
 * This is a lightweight version that receives events from the main thread.
 */
export class WorldViewWorker extends (EventEmitter as new () => TypedEmitter<WorldViewEvents>) {
  static readonly restorerName = 'WorldViewWorker'

  static restoreTransferred(_data: any, worker?: Worker): WorldViewWorker {
    const worldView = new WorldViewWorker()
    if (!worker) {
      return worldView
    }

    let bridge = workerWorldViewBridges.get(worker)
    if (!bridge) {
      const handler = ({ data }: MessageEvent) => {
        const state = workerWorldViewBridges.get(worker)
        const active = state?.activeWorldView
        if (!active || data?.class !== WorldViewWorker.restorerName) return
        if (data.type === 'event') {
          active.emit(data.eventName, ...data.args)
        }
      }
      worker.addEventListener('message', handler as EventListener)
      bridge = { activeWorldView: worldView, handler }
      workerWorldViewBridges.set(worker, bridge)
    } else {
      bridge.activeWorldView = worldView
    }
    return worldView
  }

  /** @internal vitest — remove bridge listener from worker */
  static clearWorkerBridgeForTest(worker: Worker): void {
    const bridge = workerWorldViewBridges.get(worker)
    if (!bridge) return
    worker.removeEventListener('message', bridge.handler as EventListener)
    workerWorldViewBridges.delete(worker)
  }

  /** @internal vitest — count of bridge listeners on worker */
  static getWorkerBridgeListenerCountForTest(worker: Worker): number {
    return workerWorldViewBridges.has(worker) ? 1 : 0
  }
}

/**
 * World data provider interface for different world implementations.
 */
export interface WorldProvider {
  getColumnAt(pos: Vec3): any | null
  setBlockStateId(pos: Vec3, stateId: number): void | Promise<void>
  getBiome?(pos: Vec3): number
}

/**
 * WorldView - Main world data emitter for the renderer.
 *
 * Responsible for:
 * - Loading/unloading chunks based on view distance
 * - Emitting block updates to the renderer
 * - Managing loaded chunks state
 * - Spiral chunk loading for optimal player experience
 */
export class WorldView extends (EventEmitter as new () => TypedEmitter<WorldViewEvents>) {
  spiralNumber = 0
  gotPanicLastTime = false
  panicChunksReload = () => {}
  loadedChunks: Record<ChunkPosKey, boolean> = {}
  inLoading = false
  chunkReceiveTimes: number[] = []
  lastChunkReceiveTime = 0
  public lastChunkReceiveTimeAvg = 0
  panicTimeout?: ReturnType<typeof setTimeout>
  readonly lastPos: Vec3
  eventListeners: Record<string, any> = {}
  debugChunksInfo: Record<
    ChunkPosKey,
    {
      loads: Array<{
        dataLength: number
        reason: string
        time: number
      }>
    }
  > = {}

  waitingSpiralChunksLoad: Record<ChunkPosKey, (value: boolean) => void> = {}

  addWaitTime = 1
  keepChunksDistance = 0
  isPlayground = false
  allowPositionUpdate = true

  constructor(
    public world: WorldProvider,
    public viewDistance: number,
    position: Vec3 = new Vec3(0, 0, 0)
  ) {
    super()
    this.lastPos = new Vec3(0, 0, 0).update(position)
  }

  /**
   * Prepare this WorldView for transfer to a worker thread.
   */
  prepareForTransfer(worker?: Worker): { __restorer: string } {
    if (worker) {
      const oldEmit = this.emit.bind(this) as any
      this.emit = ((eventName: keyof WorldViewEvents, ...args: any[]) => {
        oldEmit(eventName, ...args)
        worker.postMessage({
          class: WorldViewWorker.restorerName,
          type: 'event',
          eventName,
          args: sanitizeWorkerEventArgs(args)
        })
      }) as any
    }
    return {
      __restorer: WorldViewWorker.restorerName
    }
  }

  /**
   * Set a block state and emit update to renderer.
   */
  setBlockStateId(position: Vec3, stateId: number): void {
    const val = this.world.setBlockStateId(position, stateId)
    if (val && typeof (val as any).then === 'function') {
      throw new Error('setBlockStateId returned promise (not supported)')
    }
    this.emit('blockUpdate', { pos: position, stateId })
  }

  /**
   * Update the view distance and notify renderer.
   */
  updateViewDistance(viewDistance: number): void {
    this.viewDistance = viewDistance
    this.emit('renderDistance', viewDistance)
  }

  /**
   * Initialize the world view and start loading chunks.
   */
  async init(pos: Vec3, bot?: any): Promise<void> {
    console.log('WorldView init')
    this.updateViewDistance(this.viewDistance)
    this.emit('chunkPosUpdate', { pos })

    // Emit time and player entity if bot is provided
    if (bot?.time?.timeOfDay !== undefined) {
      this.emit('time', bot.time.timeOfDay)
    }
    if (bot?.entity) {
      this.emit('playerEntity', bot.entity)
    }

    // Emit block entities if not in offscreen/worker context
    this.emitterGotConnected(bot)

    const [botX, botZ] = chunkPos(pos)
    const positions = generateSpiralMatrix(this.viewDistance).map(([x, z]) => new Vec3((botX + x) * 16, 0, (botZ + z) * 16))

    this.lastPos.update(pos)
    await this._loadChunks(positions, pos)
  }

  chunkProgress(): void {
    if (this.panicTimeout) clearTimeout(this.panicTimeout)
    if (this.chunkReceiveTimes.length >= 5) {
      const avgReceiveTime = this.chunkReceiveTimes.reduce((a, b) => a + b, 0) / this.chunkReceiveTimes.length
      this.lastChunkReceiveTimeAvg = avgReceiveTime
      const timeoutDelay = avgReceiveTime * 2 + 1000

      if (this.panicTimeout) clearTimeout(this.panicTimeout)

      this.panicTimeout = setTimeout(() => {
        if (!this.gotPanicLastTime && this.inLoading) {
          console.warn('Chunk loading seems stuck, triggering panic reload')
          this.gotPanicLastTime = true
          this.panicChunksReload()
        }
      }, timeoutDelay)
    }
  }

  async _loadChunks(positions: Vec3[], centerPos: Vec3): Promise<void> {
    this.spiralNumber++
    const { spiralNumber } = this

    // Stop loading previous chunks
    for (const pos of Object.keys(this.waitingSpiralChunksLoad)) {
      this.waitingSpiralChunksLoad[pos](false)
      delete this.waitingSpiralChunksLoad[pos]
    }

    let continueLoading = true
    this.inLoading = true

    await delayedIterator(positions, this.addWaitTime, async pos => {
      if (!continueLoading || this.loadedChunks[`${pos.x},${pos.z}`]) return

      // Wait for chunk to be available from server
      if (!this.world.getColumnAt(pos)) {
        continueLoading = await new Promise<boolean>(resolve => {
          this.waitingSpiralChunksLoad[`${pos.x},${pos.z}`] = resolve
        })
      }
      if (!continueLoading) return
      await this.loadChunk(pos, undefined, `spiral ${spiralNumber} from ${centerPos.x},${centerPos.z}`)
      this.chunkProgress()
    })

    if (spiralNumber !== this.spiralNumber) return

    if (this.panicTimeout) clearTimeout(this.panicTimeout)
    this.inLoading = false
    this.gotPanicLastTime = false
    this.chunkReceiveTimes = []
    this.lastChunkReceiveTime = 0
  }

  /**
   * Load a chunk at the given position.
   */
  async loadChunk(pos: { x: number; z: number; y?: number }, isLightUpdate = false, reason = 'spiral'): Promise<void> {
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))

    if (dx <= this.viewDistance && dz <= this.viewDistance) {
      const column = await this.world.getColumnAt(pos.y !== undefined ? (pos as Vec3) : new Vec3(pos.x, 0, pos.z))

      if (column) {
        const chunk = column.toJson()
        const worldConfig: WorldSizeParams = {
          minY: column.minY ?? 0,
          worldHeight: column.worldHeight ?? 256
        }

        this.emit('loadChunk', {
          x: pos.x,
          z: pos.z,
          chunk,
          blockEntities: column.blockEntities,
          worldConfig,
          isLightUpdate
        })
        this.loadedChunks[`${pos.x},${pos.z}`] = true

        this.debugChunksInfo[`${pos.x},${pos.z}`] ??= { loads: [] }
        this.debugChunksInfo[`${pos.x},${pos.z}`].loads.push({
          dataLength: chunk.length,
          reason,
          time: Date.now()
        })
      } else if (this.isPlayground) {
        this.emit('markAsLoaded', { x: pos.x, z: pos.z })
      }
    }
  }

  /**
   * Re-fetch and re-emit every loaded chunk (e.g. after mesher workers are recreated).
   */
  async reloadLoadedChunks(): Promise<void> {
    const coords = Object.keys(this.loadedChunks)
    for (const key of coords) {
      const [x, z] = key.split(',').map(Number)
      await this.loadChunk({ x, z }, false, 'mesher-reconfigure')
    }
  }

  /**
   * Unload all chunks.
   */
  unloadAllChunks(): void {
    for (const coords of Object.keys(this.loadedChunks)) {
      const [x, z] = coords.split(',').map(Number)
      this.unloadChunk({ x, z })
    }
  }

  /**
   * Unload a specific chunk.
   */
  unloadChunk(pos: { x: number; z: number }): void {
    this.emit('unloadChunk', { x: pos.x, z: pos.z })
    delete this.loadedChunks[`${pos.x},${pos.z}`]
    delete this.debugChunksInfo[`${pos.x},${pos.z}`]
  }

  /**
   * Emit block entities when connected.
   * Only works in main thread (not offscreen/worker context).
   */
  emitterGotConnected(bot?: any): void {
    // Skip if in offscreen/worker context
    const isOffscreen = typeof (globalThis as any).WorkerGlobalScope !== 'undefined' && globalThis instanceof (globalThis as any).WorkerGlobalScope

    if (isOffscreen || !bot) return

    this.emit(
      'blockEntities',
      new Proxy(
        {},
        {
          get(_target, posKey, receiver) {
            if (typeof posKey !== 'string') return
            const [x, y, z] = posKey.split(',').map(Number)
            return bot.world.getBlock(new Vec3(x, y, z))?.entity
          }
        }
      )
    )
  }

  lastBiomeId: number | null = null

  updateBiome(pos: Vec3): void {
    try {
      if (!this.world.getBiome) return
      const biomeId = this.world.getBiome(pos)
      if (biomeId !== this.lastBiomeId) {
        this.lastBiomeId = biomeId
        // Note: Biome data lookup would need to be provided externally
        // This is a simplified version
        this.emit('biomeReset')
      }
    } catch (e) {
      console.error('error updating biome', e)
    }
  }

  lastPosCheck: Vec3 | null = null

  /**
   * Update position and load/unload chunks as needed.
   */
  async updatePosition(pos: Vec3, force = false): Promise<void> {
    if (!this.allowPositionUpdate) return
    const posFloored = pos.floored()
    if (!force && this.lastPosCheck && this.lastPosCheck.equals(posFloored)) return
    this.lastPosCheck = posFloored

    this.updateBiome(pos)

    const [lastX, lastZ] = chunkPos(this.lastPos)
    const [botX, botZ] = chunkPos(pos)

    if (lastX !== botX || lastZ !== botZ || force) {
      this.emit('chunkPosUpdate', { pos })

      // Unload chunks that are no longer in view
      const chunksToUnload: Vec3[] = []
      const viewDistanceWithBuffer = force ? this.viewDistance : this.viewDistance + this.keepChunksDistance

      for (const coords of Object.keys(this.loadedChunks)) {
        const [x, z] = coords.split(',').map(Number)
        const p = new Vec3(x, 0, z)
        const [chunkX, chunkZ] = chunkPos(p)
        const dx = Math.abs(botX - chunkX)
        const dz = Math.abs(botZ - chunkZ)
        if (dx > viewDistanceWithBuffer || dz > viewDistanceWithBuffer) {
          chunksToUnload.push(p)
        }
      }

      for (const p of chunksToUnload) {
        this.unloadChunk(p)
      }

      // Load new chunks
      const positions = generateSpiralMatrix(this.viewDistance)
        .map(([x, z]) => {
          const newPos = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
          if (!this.loadedChunks[`${newPos.x},${newPos.z}`]) return newPos
          return undefined!
        })
        .filter(a => !!a)

      this.lastPos.update(pos)
      void this._loadChunks(positions, pos)
    } else {
      this.emit('chunkPosUpdate', { pos })
      this.lastPos.update(pos)
    }
  }
}
