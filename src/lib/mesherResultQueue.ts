type QueuedMesherMessage = { key?: unknown; urgent?: boolean } | null | undefined

/**
 * Mesher worker results waiting for the main thread. Results of block changes (`urgent`, set by the worker for sections dirtied by a block
 * change) are handled before queued chunk-load results, like vanilla meshes the player's own edits first: behind a load wave they waited
 * several time-sliced frames, and a broken block's neighbour arriving late shows the sky through the hole.
 *
 * Results of one section stay in order: an urgent result takes the earlier queued results of its section along to the urgent queue.
 */
export class MesherResultQueue<T extends QueuedMesherMessage = any> {
  private normal: T[] = []
  private urgent: T[] = []

  get length(): number {
    return this.normal.length + this.urgent.length
  }

  get urgentLength(): number {
    return this.urgent.length
  }

  push(message: T): void {
    const key = message?.key
    if (!message?.urgent || typeof key !== 'string') {
      this.normal.push(message)
      return
    }
    if (this.normal.some(m => m?.key === key)) {
      const rest: T[] = []
      for (const m of this.normal) (m?.key === key ? this.urgent : rest).push(m)
      this.normal = rest
    }
    this.urgent.push(message)
  }

  shift(): T | undefined {
    return this.urgent.length > 0 ? this.urgent.shift() : this.normal.shift()
  }

  /** queued results of this section (both queues) */
  countKey(key: string): number {
    let count = 0
    for (const m of this.urgent) if (m?.key === key) count++
    for (const m of this.normal) if (m?.key === key) count++
    return count
  }

  clear(): void {
    this.normal = []
    this.urgent = []
  }
}
