import { generateSpiralMatrix } from '../lib/spiral'

export type ColumnPos = { x: number; z: number; key: string }

export type ColumnLoadStep =
  /** give this column to the renderer now */
  | ({ kind: 'emit' } & ColumnPos)
  /** a nearer column is missing and others are held back for it: call again at `at` (or when a column arrives) */
  | { kind: 'wait'; at: number; front: ColumnPos }
  /** nothing to give now; call again when a column arrives */
  | { kind: 'idle'; front?: ColumnPos }
  /** every column in view is given to the renderer (or was given up on) */
  | { kind: 'done' }

/**
 * Decides which column the renderer gets next, so columns appear nearest first around the player whatever order the server sends them
 * in (a vanilla server sends them row by row).
 *
 * Rules:
 * - Columns are walked nearest first (squared distance in chunks; ties in spiral order) from the current center.
 * - A received column is given out only when every nearer column is given out too, so a far column never appears before a near one.
 * - A nearer column that has not arrived holds the received ones back while columns keep arriving: the server is still sending, and a
 *   slow client (or a server sending row by row) gets the near ones seconds after the far ones. It is passed over once nothing arrived
 *   for `quietMs` (the server paused: it may never send it, outside its view distance or still generating), or once a received column
 *   waited `maxHoldMs`. With nothing received to show, the queue waits for the server as long as it takes. A passed-over column is given
 *   out first once it arrives, being nearer than the rest.
 */
export class ColumnLoadQueue {
  private order: ColumnPos[] = []
  private cursor = 0
  private centerAt = 0
  private lastArrivalAt = 0
  /** when each column arrived (columns that were there before `setCenter` count from then) */
  private readonly arrivedAt = new Map<string, number>()
  /** columns the renderer could not take (no data after all): not offered again until they arrive again */
  private readonly rejected = new Set<string>()

  /**
   * @param quietMs no arrival for this long = the server paused. Longer than a busy frame on a slow device, where the client does not
   *   read packets for hundreds of ms while the server is still sending.
   * @param maxHoldMs longest a received column waits for a nearer one while columns keep arriving
   */
  constructor(
    readonly quietMs = 1500,
    readonly maxHoldMs = 5000
  ) {}

  /** Columns around chunk `chunkX, chunkZ` within `viewDistance` chunks (a square, as servers send them), nearest first. */
  setCenter(chunkX: number, chunkZ: number, viewDistance: number, now: number) {
    this.order = generateSpiralMatrix(viewDistance)
      .map(([dx, dz], spiralIndex) => ({ dx, dz, spiralIndex }))
      .sort((a, b) => a.dx * a.dx + a.dz * a.dz - (b.dx * b.dx + b.dz * b.dz) || a.spiralIndex - b.spiralIndex)
      .map(({ dx, dz }) => {
        const x = (chunkX + dx) * 16
        const z = (chunkZ + dz) * 16
        return { x, z, key: `${x},${z}` }
      })
    this.cursor = 0
    this.centerAt = now
    const inView = new Set(this.order.map(column => column.key))
    for (const key of this.arrivedAt.keys()) if (!inView.has(key)) this.arrivedAt.delete(key)
  }

  /** The column at `key` has data now (again): it may be offered even if the renderer could not take it before. */
  arrived(key: string, now: number) {
    this.rejected.delete(key)
    this.arrivedAt.set(key, now)
    this.lastArrivalAt = Math.max(this.lastArrivalAt, now)
  }

  /** The renderer could not take the offered column. */
  reject(key: string) {
    this.rejected.add(key)
  }

  next(now: number, isReceived: (column: ColumnPos) => boolean, isLoaded: (key: string) => boolean): ColumnLoadStep {
    const pending = (column: ColumnPos) => !isLoaded(column.key) && !this.rejected.has(column.key)
    // a column passed over earlier (or unloaded and sent again) that is here now: nearer than everything ahead, so it goes first
    for (let i = 0; i < this.cursor; i++) {
      const column = this.order[i]!
      if (pending(column) && isReceived(column)) return { kind: 'emit', ...column }
    }
    while (this.cursor < this.order.length) {
      const column = this.order[this.cursor]!
      if (!pending(column)) {
        this.cursor++
        continue
      }
      if (isReceived(column)) return { kind: 'emit', ...column }
      // missing: it holds back the columns further away that are ready, the one waiting longest decides
      let oldestReady: number | undefined
      for (let i = this.cursor + 1; i < this.order.length; i++) {
        const other = this.order[i]!
        if (!pending(other) || !isReceived(other)) continue
        const since = Math.max(this.arrivedAt.get(other.key) ?? this.centerAt, this.centerAt)
        if (oldestReady === undefined || since < oldestReady) oldestReady = since
      }
      if (oldestReady === undefined) return { kind: 'idle', front: column }
      const quietSince = Math.max(this.lastArrivalAt, this.centerAt)
      const giveUpAt = Math.min(quietSince + this.quietMs, oldestReady + this.maxHoldMs)
      if (now < giveUpAt) return { kind: 'wait', at: giveUpAt, front: column }
      this.cursor++
    }
    return { kind: 'done' }
  }
}
