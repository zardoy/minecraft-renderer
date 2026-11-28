/**
 * Flush policy for buffered section geometry (`pendingSectionUpdates`).
 *
 * A remesh of an already-visible section must not be installed alone while a
 * face neighbour is still being re-meshed: the neighbour's faces towards this
 * section were culled against the OLD block state, so installing one side
 * first exposes a see-through hole (the "sky flash" on dig/place).
 *
 * The policy therefore works on *groups*: pending sections that are face
 * adjacent form a connected group, and a group is installed only when every
 * outstanding neighbour of every member has arrived. When the buffer deadline
 * expires we still flush, but we flush the whole group in one batch — never a
 * single member, which is exactly the hole the buffer exists to prevent.
 */

export type PendingFlushQuery = {
  /** Keys currently buffered, in insertion order. */
  pendingKeys: Iterable<string>
  /** When each key was first buffered. */
  startedAt: (key: string) => number | undefined
  now: number
  maxBufferMs: number
  sectionHeight: number
  /** Section is dirty on a worker and its geometry has not arrived yet. */
  isOutstanding: (key: string) => boolean
  /**
   * When set, neighbour waits use topology outstanding instead of covering/light
   * outstanding. Omit for bit-for-bit legacy flush behavior.
   */
  isTopologyOutstanding?: (key: string) => boolean
  /** Section currently has geometry on screen (an air section has none). */
  hasSectionObject: (key: string) => boolean
  /**
   * Section is being re-meshed for a block change. Such a neighbour is waited on even without geometry on screen: a fully solid section next
   * to a broken block gets its first mesh (the stone behind it), and installing the broken block's section alone shows the sky through the
   * hole until it arrives. The deadline still applies: a short hole is better than the broken block staying drawn.
   */
  isBlockChanged?: (key: string) => boolean
  /**
   * Buffered result comes from a block change (the worker marks those `urgent`). A group made only of such results waits only for
   * block-changed neighbours: the other re-meshes around it (new chunks arriving next to it) are not part of the edit, and waiting for them
   * held a placed block for up to the deadline while chunks loaded (~350-750 ms on a Windows RTX 2060 PC).
   */
  isBlockChangeUpdate?: (key: string) => boolean
}

export function faceNeighborKeys(key: string, sectionHeight: number): string[] {
  const [sx, sy, sz] = key.split(',').map(Number)
  return [
    `${sx - 16},${sy},${sz}`,
    `${sx + 16},${sy},${sz}`,
    `${sx},${sy - sectionHeight},${sz}`,
    `${sx},${sy + sectionHeight},${sz}`,
    `${sx},${sy},${sz - 16}`,
    `${sx},${sy},${sz + 16}`
  ]
}

/**
 * Connected components of the buffered sections under face adjacency. Members
 * of one component must be installed in the same frame.
 */
export function pendingSectionGroups(pendingKeys: Iterable<string>, sectionHeight: number): string[][] {
  const remaining = new Set(pendingKeys)
  const groups: string[][] = []
  for (const seed of [...remaining]) {
    if (!remaining.has(seed)) continue
    const group: string[] = []
    const stack = [seed]
    remaining.delete(seed)
    while (stack.length > 0) {
      const key = stack.pop()!
      group.push(key)
      for (const neighbor of faceNeighborKeys(key, sectionHeight)) {
        if (remaining.delete(neighbor)) stack.push(neighbor)
      }
    }
    groups.push(group)
  }
  return groups
}

export type PendingFlushReason = 'group-complete' | 'deadline'

export type ReadySectionFlush = {
  key: string
  reason: PendingFlushReason
  /** deadline flush that left block-changed neighbours behind (a visible hole until they arrive): not expected, worth logging */
  missingBlockChangeNeighbors?: string[]
}

/**
 * Keys to install this frame. Either a group is complete (no member still
 * waiting on a visible neighbour) or its oldest member has run out of buffer
 * time — in both cases the whole group goes out together.
 */
export function selectReadySectionFlushes(query: PendingFlushQuery): ReadySectionFlush[] {
  const { now, maxBufferMs, sectionHeight } = query
  const ready: ReadySectionFlush[] = []

  for (const group of pendingSectionGroups(query.pendingKeys, sectionHeight)) {
    const members = new Set(group)

    let oldestStart = now
    for (const key of group) {
      const startedAt = query.startedAt(key) ?? now
      if (startedAt < oldestStart) oldestStart = startedAt
    }
    const expired = now - oldestStart >= maxBufferMs

    // neighbours the group still waits for: a visible one being re-meshed, or any one re-meshed for a block change. A group of block-change
    // results waits only for the latter.
    const blockChangeGroup = query.isBlockChangeUpdate !== undefined && group.every(key => query.isBlockChangeUpdate!(key))
    let waitingOnNeighbor = false
    const missingBlockChange: string[] = []
    for (const key of group) {
      for (const neighbor of faceNeighborKeys(key, sectionHeight)) {
        if (members.has(neighbor)) continue
        const neighborOutstanding = query.isTopologyOutstanding ? query.isTopologyOutstanding(neighbor) : query.isOutstanding(neighbor)
        if (!neighborOutstanding) continue
        const blockChanged = query.isBlockChanged?.(neighbor) ?? false
        if (blockChanged || (!blockChangeGroup && query.hasSectionObject(neighbor))) waitingOnNeighbor = true
        if (blockChanged && expired) missingBlockChange.push(neighbor)
      }
      // only the deadline flush needs the full list
      if (waitingOnNeighbor && !expired) break
    }

    if (waitingOnNeighbor && !expired) continue
    const reason: PendingFlushReason = expired ? 'deadline' : 'group-complete'
    for (const key of group) ready.push(missingBlockChange.length > 0 ? { key, reason, missingBlockChangeNeighbors: missingBlockChange } : { key, reason })
  }

  return ready
}

export function selectReadySectionUpdates(query: PendingFlushQuery): string[] {
  return selectReadySectionFlushes(query).map(item => item.key)
}
