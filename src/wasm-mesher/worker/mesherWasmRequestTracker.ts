// Tracks requested section keys and their pending dirty counts separately from
// the section keys that a full-column WASM meshing call can generate.
//
// Why this exists:
//  - The legacy per-section path usually generates exactly the requested key.
//  - The column path can mesh a whole chunk column and produce data for more
//    sections than the main thread requested. `WorldRendererCommon` throws on
//    `sectionFinished` for keys it did not register, so the worker must filter
//    outgoing `geometry`/`sectionFinished` events through this tracker.
//  - Each `setSectionDirty(value=true)` is one logical request and must yield
//    exactly one `sectionFinished` event, mirroring the existing per-key
//    counter semantics of `dirtySections`.

export class SectionRequestTracker {
  private readonly counts = new Map<string, number>()

  /** Register one pending request for `key` (called per dirty-section ingest). */
  addRequest(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  /** True if at least one request for `key` is still pending. */
  hasPending(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0
  }

  /** Pending request count for `key` (0 if none). */
  pendingCount(key: string): number {
    return this.counts.get(key) ?? 0
  }

  /**
   * Consume one pending request for `key`. Returns true if a request was
   * consumed, false if there was nothing pending. Callers in the column
   * path must treat `false` as a contract violation (the main thread did
   * not request this key).
   */
  consumeOne(key: string): boolean {
    const c = this.counts.get(key) ?? 0
    if (c <= 0) return false
    if (c === 1) this.counts.delete(key)
    else this.counts.set(key, c - 1)
    return true
  }

  /** Clear all pending requests (used on worker reset). */
  clear(): void {
    this.counts.clear()
  }

  /** Drop all pending requests for one column (`cx`,`cz` = column origin in block coords). */
  clearColumn(cx: number, cz: number): void {
    for (const key of [...this.counts.keys()]) {
      const [x, , z] = key.split(',').map(Number)
      if (x === cx && z === cz) {
        this.counts.delete(key)
      }
    }
  }

  /** Number of distinct keys with pending requests. */
  size(): number {
    return this.counts.size
  }
}
