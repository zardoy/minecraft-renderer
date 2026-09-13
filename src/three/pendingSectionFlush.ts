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
  /** Section currently has geometry on screen (an air section has none). */
  hasSectionObject: (key: string) => boolean
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

/**
 * Keys to install this frame. Either a group is complete (no member still
 * waiting on a visible neighbour) or its oldest member has run out of buffer
 * time — in both cases the whole group goes out together.
 */
export function selectReadySectionUpdates(query: PendingFlushQuery): string[] {
  const { now, maxBufferMs, sectionHeight } = query
  const ready: string[] = []

  for (const group of pendingSectionGroups(query.pendingKeys, sectionHeight)) {
    const members = new Set(group)

    let oldestStart = now
    for (const key of group) {
      const startedAt = query.startedAt(key) ?? now
      if (startedAt < oldestStart) oldestStart = startedAt
    }
    const expired = now - oldestStart >= maxBufferMs

    let waitingOnNeighbor = false
    if (!expired) {
      for (const key of group) {
        for (const neighbor of faceNeighborKeys(key, sectionHeight)) {
          if (members.has(neighbor)) continue
          if (query.isOutstanding(neighbor) && query.hasSectionObject(neighbor)) {
            waitingOnNeighbor = true
            break
          }
        }
        if (waitingOnNeighbor) break
      }
    }

    if (waitingOnNeighbor) continue
    ready.push(...group)
  }

  return ready
}
