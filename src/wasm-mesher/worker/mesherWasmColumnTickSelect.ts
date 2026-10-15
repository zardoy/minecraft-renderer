/**
 * Choose which dirty columns a mesher tick processes.
 *
 * Urgent (player-edit) columns go first with no cap. Bulk columns are limited
 * so an incoming edit is not stuck behind a long FIFO of load-wave remeshes.
 */

export const BULK_COLUMNS_PER_TICK = 4

export type ColumnTickSection = { key: string; x: number; y: number; z: number; count: number }

export type ColumnTickGroup = { x: number; z: number; sections: ColumnTickSection[] }

export function groupDirtySectionsByColumn(dirtySections: Iterable<[string, number]>): ColumnTickGroup[] {
  const groups = new Map<string, ColumnTickGroup>()
  for (const [key, count] of dirtySections) {
    const [sx, sy, sz] = key.split(',').map(v => parseInt(v, 10))
    const colKey = `${sx},${sz}`
    let group = groups.get(colKey)
    if (!group) {
      group = { x: sx, z: sz, sections: [] }
      groups.set(colKey, group)
    }
    group.sections.push({ key, x: sx, y: sy, z: sz, count })
  }
  return [...groups.values()]
}

export function selectColumnGroupsForTick(
  dirtySections: Map<string, number>,
  urgentKeys: Set<string>,
  bulkLimit = BULK_COLUMNS_PER_TICK
): { selected: ColumnTickGroup[]; remaining: Map<string, number> } {
  const urgent: ColumnTickGroup[] = []
  const bulk: ColumnTickGroup[] = []
  for (const group of groupDirtySectionsByColumn(dirtySections)) {
    if (group.sections.some(section => urgentKeys.has(section.key))) urgent.push(group)
    else bulk.push(group)
  }
  const selected = [...urgent, ...bulk.slice(0, bulkLimit)]
  const remaining = new Map<string, number>()
  for (const group of bulk.slice(bulkLimit)) {
    for (const section of group.sections) remaining.set(section.key, section.count)
  }
  return { selected, remaining }
}
