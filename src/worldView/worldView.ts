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
import { ColumnLoadQueue, type ColumnPos } from './columnLoadQueue'
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

/**
 * Run `fn` on the next animation frame, or after ~one frame where
 * `requestAnimationFrame` is unavailable (workers in some browsers, Node tests).
 */
const scheduleNextFrame = (fn: () => void): { cancel: () => void } => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return { cancel: () => cancelAnimationFrame(id) }
  }
  const id = setTimeout(fn, 16)
  return { cancel: () => clearTimeout(id) }
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
 * - Giving new columns to the renderer nearest first (see `ColumnLoadQueue`), whatever order they arrive in
 */
export class WorldView extends (EventEmitter as new () => TypedEmitter<WorldViewEvents>) {
  /** Columns given to the renderer. */
  loadedChunks: Record<ChunkPosKey, boolean> = {}
  /** Order in which arrived columns go to the renderer. `pumpColumns` is the only place that gives it a new column. */
  readonly columnQueue = new ColumnLoadQueue()
  private pumpTimer?: ReturnType<typeof setTimeout>
  private pumpAt = 0
  private pumping = false
  private pumpAgain = false
  private loadedAllWaiters: Array<() => void> = []
  private columnUnloadEpoch = new Map<string, number>()
  private geometryReload?: Promise<void>
  /**
   * Columns the server unloaded that the renderer still shows, with their chunk distance (Chebyshev) from the player at that moment. See
   * `columnUnloadedByServer`.
   */
  private readonly serverUnloadedColumns = new Map<ChunkPosKey, number>()
  /** Columns queued by `queueLightRemesh`, reloaded at most once per frame. */
  private pendingLightRemesh = new Set<ChunkPosKey>()
  private lightRemeshFlush?: { cancel: () => void }
  /** Columns in view are still being given to the renderer. */
  inLoading = false
  chunkReceiveTimes: number[] = []
  lastChunkReceiveTime = 0
  public lastChunkReceiveTimeAvg = 0
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

  /**
   * The nearest column that has not arrived while others wait for it (debug screens). Calling it reports the column as arrived; it is kept
   * for clients that resolve it from their `chunkColumnLoad` handler.
   */
  waitingSpiralChunksLoad: Record<ChunkPosKey, (value: boolean) => void> = {}

  /** @deprecated unused: columns are given out as soon as their turn comes */
  addWaitTime = 0
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
    this.on('end', () => this.cancelPendingLightRemesh())
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
    if (typeof bot?.time?.moonPhase === 'number') {
      this.emit('moonPhase', bot.time.moonPhase)
    }
    if (bot?.entity) {
      this.emit('playerEntity', bot.entity)
    }

    // Emit block entities if not in offscreen/worker context
    this.emitterGotConnected(bot)

    this.lastPos.update(pos)
    const [botX, botZ] = chunkPos(pos)
    await this.recenter(botX, botZ)
  }

  /** Walk columns from this chunk; resolves once every column in view is given to the renderer (or given up on). */
  private async recenter(chunkX: number, chunkZ: number): Promise<void> {
    this.columnQueue.setCenter(chunkX, chunkZ, this.viewDistance, Date.now())
    this.inLoading = true
    const loaded = new Promise<void>(resolve => this.loadedAllWaiters.push(resolve))
    this.requestPump()
    await loaded
  }

  /**
   * The world has data for this column now (the server sent it). A column already shown is updated at once; a new one waits for its turn
   * in `columnQueue`, so columns appear nearest first and never in the order the server sends them.
   */
  columnArrived(pos: { x: number; z: number }): void {
    const key = `${pos.x},${pos.z}`
    this.columnQueue.arrived(key, Date.now())
    if (this.loadedChunks[key]) {
      void this.emitColumn(pos, false, 'sent again')
      return
    }
    this.requestPump()
  }

  private requestPump(at = Date.now()): void {
    if (this.pumpTimer !== undefined) {
      if (this.pumpAt <= at) return
      clearTimeout(this.pumpTimer)
    }
    this.pumpAt = at
    this.pumpTimer = setTimeout(
      () => {
        this.pumpTimer = undefined
        void this.pumpColumns()
      },
      Math.max(0, at - Date.now())
    )
  }

  /**
   * Give the renderer every column whose turn has come, in `columnQueue` order. Not split over several tasks: handing a column over is
   * cheap, and a continuation queued behind the renderer's own work (mesh results) came back hundreds of ms later.
   */
  private async pumpColumns(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      for (;;) {
        const step = this.columnQueue.next(
          Date.now(),
          column => this.isColumnReceived(column),
          key => !!this.loadedChunks[key]
        )
        this.waitingSpiralChunksLoad = {}
        if (step.kind === 'emit') {
          const taken = await this.emitColumn(step, false, 'in order')
          if (!taken && !this.loadedChunks[step.key]) this.columnQueue.reject(step.key)
          continue
        }
        if (step.kind === 'done') {
          this.inLoading = false
          for (const resolve of this.loadedAllWaiters.splice(0)) resolve()
          return
        }
        const { front } = step
        if (front) this.waitingSpiralChunksLoad[front.key] = () => this.columnArrived(front)
        if (step.kind === 'wait') this.requestPump(step.at)
        return
      }
    } finally {
      this.pumping = false
      if (this.pumpAgain) {
        this.pumpAgain = false
        this.requestPump()
      }
    }
  }

  private isColumnReceived(column: ColumnPos): boolean {
    // the playground marks a column it has no data for as loaded (empty) instead of waiting for it
    if (this.isPlayground) return true
    return !!this.world.getColumnAt(new Vec3(column.x, 0, column.z))
  }

  /** Note a column's arrival time (average shown on the chunks debug screen). */
  chunkProgress(): void {
    if (this.chunkReceiveTimes.length >= 5) {
      this.lastChunkReceiveTimeAvg = this.chunkReceiveTimes.reduce((a, b) => a + b, 0) / this.chunkReceiveTimes.length
    }
  }

  /**
   * Send a column to the renderer again (light update, reload). A column the renderer does not have yet only joins `columnQueue` (it
   * appears in its turn, nearest first) and this resolves false.
   */
  async loadChunk(pos: { x: number; z: number; y?: number }, isLightUpdate = false, reason = 'reload'): Promise<boolean> {
    if (!this.loadedChunks[`${pos.x},${pos.z}`]) {
      this.columnArrived(pos)
      return false
    }
    return this.emitColumn(pos, isLightUpdate, reason)
  }

  private async emitColumn(pos: { x: number; z: number; y?: number }, isLightUpdate: boolean, reason: string): Promise<boolean> {
    const key = `${pos.x},${pos.z}`
    const epoch = this.columnUnloadEpoch.get(key) ?? 0
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))

    if (dx <= this.viewDistance && dz <= this.viewDistance) {
      const column = await this.world.getColumnAt(pos.y !== undefined ? (pos as Vec3) : new Vec3(pos.x, 0, pos.z))

      // An asynchronous fetch must not resurrect a truly unloaded column.
      const [currentX, currentZ] = chunkPos(this.lastPos)
      if (
        (this.columnUnloadEpoch.get(key) ?? 0) !== epoch ||
        Math.abs(currentX - Math.floor(pos.x / 16)) > this.viewDistance ||
        Math.abs(currentZ - Math.floor(pos.z / 16)) > this.viewDistance
      )
        return false
      if (column) {
        // the server has it again (`chunkColumnLoad` of a column still drawn comes here through `loadChunk`)
        this.serverUnloadedColumns.delete(key)
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
        return true
      } else if (this.isPlayground) {
        this.emit('markAsLoaded', { x: pos.x, z: pos.z })
      }
    }
    return false
  }

  /**
   * Request a light-only reload of a loaded column (e.g. after `update_light`).
   *
   * Servers often send several light packets for the same column within one
   * frame, and every `loadChunk` re-serializes the whole column and remeshes
   * all of its sections. Requests are therefore coalesced: each column is
   * reloaded at most once per frame, reading its latest state at flush time.
   * Columns that are unloaded (or still waiting for the spiral load) by then
   * are skipped, so a queued request never resurrects an unloaded column.
   */
  queueLightRemesh(x: number, z: number): void {
    this.pendingLightRemesh.add(`${x},${z}`)
    this.lightRemeshFlush ??= scheduleNextFrame(() => this.flushLightRemesh())
  }

  /** Drop queued light reloads and cancel the scheduled flush. */
  cancelPendingLightRemesh(): void {
    this.pendingLightRemesh.clear()
    this.lightRemeshFlush?.cancel()
    this.lightRemeshFlush = undefined
  }

  private flushLightRemesh(): void {
    this.lightRemeshFlush = undefined
    const keys = [...this.pendingLightRemesh]
    this.pendingLightRemesh.clear()
    for (const key of keys) {
      if (!this.loadedChunks[key] || this.waitingSpiralChunksLoad[key]) continue
      const [x, z] = key.split(',').map(Number)
      void this.loadChunk({ x, z }, true, 'update_light')
    }
  }

  reloadColumnGeometry(): Promise<void> {
    this.geometryReload ??= this.runColumnGeometryReload().finally(() => {
      this.geometryReload = undefined
    })
    return this.geometryReload
  }

  private async runColumnGeometryReload(): Promise<void> {
    this.dropServerUnloadedColumns()
    const coords = this.loadedColumnsNearestFirst()
    for (const [x, z] of coords) this.emit('unloadChunk', { x, z, preserveClientLight: true })
    for (const [x, z] of coords) {
      const key = `${x},${z}`
      if (!this.loadedChunks[key]) continue
      const epoch = this.columnUnloadEpoch.get(key) ?? 0
      let reloaded = false
      try {
        reloaded = await this.loadChunk({ x, z }, false, 'geometry-reload')
      } catch (error) {
        console.warn(`Failed to reload column geometry ${key}`, error)
      }
      if (!reloaded && this.loadedChunks[key] && (this.columnUnloadEpoch.get(key) ?? 0) === epoch) {
        this.unloadChunk({ x, z })
      }
    }
  }

  /**
   * Re-fetch and re-emit every loaded chunk (e.g. after mesher workers are recreated).
   */
  async reloadLoadedChunks(): Promise<void> {
    // the world has no data for them any more, they could not be meshed again
    this.dropServerUnloadedColumns()
    for (const [x, z] of this.loadedColumnsNearestFirst()) {
      await this.loadChunk({ x, z }, false, 'mesher-reconfigure')
    }
  }

  private loadedColumnsNearestFirst(): Array<[number, number]> {
    const coords = Object.keys(this.loadedChunks)
      .filter(key => this.loadedChunks[key])
      .map(key => key.split(',').map(Number) as [number, number])
    const { x: px, z: pz } = this.lastPos
    return coords.sort(([ax, az], [bx, bz]) => (ax - px) ** 2 + (az - pz) ** 2 - (bx - px) ** 2 - (bz - pz) ** 2)
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
   * The server unloaded this column (it left the server's view distance). While it is within `keepChunksDistance` beyond the view distance
   * the renderer keeps showing it, until the player moves farther from it than when it was unloaded. Without this, stepping back and forth
   * over a chunk border unloaded a whole row of columns at the far edge and faded it in again a moment later, when the server sent it again
   * (the renderer drops a column at once, so the row blinked). A column sent again is updated in place (`columnArrived`, no fade).
   */
  columnUnloadedByServer(pos: { x: number; z: number }): void {
    const key = `${pos.x},${pos.z}`
    const distance = this.chunkDistanceFromPlayer(pos.x, pos.z)
    if (this.keepChunksDistance > 0 && this.loadedChunks[key] && distance > 0 && distance <= this.viewDistance + this.keepChunksDistance) {
      this.serverUnloadedColumns.set(key, distance)
      // its data is gone from the world: a queued light reload would find nothing
      this.pendingLightRemesh.delete(key)
      return
    }
    this.unloadChunk(pos)
  }

  /** Chebyshev distance in chunks between the column at block `x`, `z` and the player's chunk. */
  private chunkDistanceFromPlayer(x: number, z: number): number {
    const [playerX, playerZ] = chunkPos(this.lastPos)
    return Math.max(Math.abs(Math.floor(x / 16) - playerX), Math.abs(Math.floor(z / 16) - playerZ))
  }

  private dropServerUnloadedColumns(onlyFartherThanAtUnload = false): void {
    for (const [key, distanceAtUnload] of [...this.serverUnloadedColumns]) {
      const [x, z] = key.split(',').map(Number) as [number, number]
      if (onlyFartherThanAtUnload && this.chunkDistanceFromPlayer(x, z) <= distanceAtUnload) continue
      this.unloadChunk({ x, z })
    }
  }

  /**
   * Unload a specific chunk.
   */
  unloadChunk(pos: { x: number; z: number }): void {
    const key = `${pos.x},${pos.z}`
    this.serverUnloadedColumns.delete(key)
    this.columnUnloadEpoch.set(key, (this.columnUnloadEpoch.get(key) ?? 0) + 1)
    this.pendingLightRemesh.delete(key)
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

      this.lastPos.update(pos)
      // columns the server already unloaded go once the player moves away from them (a forced update drops them all)
      this.dropServerUnloadedColumns(!force)
      // new columns in view, nearest first from here
      void this.recenter(botX, botZ)
    } else {
      this.emit('chunkPosUpdate', { pos })
      this.lastPos.update(pos)
    }
  }
}
