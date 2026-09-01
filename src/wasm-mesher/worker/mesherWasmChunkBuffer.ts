export type PendingChunkMessage = {
  x: number
  z: number
  chunk: any
  customBlockModels?: any
  isLightUpdate?: boolean
}

export class PendingChunkBuffer {
  private pending: PendingChunkMessage[] = []

  enqueue(msg: PendingChunkMessage) {
    this.pending.push(msg)
  }

  drain(apply: (msg: PendingChunkMessage) => void) {
    const batch = this.pending.splice(0)
    for (const msg of batch) apply(msg)
  }

  get size() {
    return this.pending.length
  }

  clear() {
    this.pending.length = 0
  }
}
