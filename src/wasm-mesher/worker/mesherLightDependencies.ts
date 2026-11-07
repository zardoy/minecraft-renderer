/**
 * Light-version stamp for one section mesh.
 *
 * Each column keeps only the latest applied owner version. The stamp is the
 * newest of those versions whose sampled columns were actually meshed, and it
 * stops before the first sampled column that was written but left out. The
 * version requested on the dirty job is not an input.
 */

export function sectionLightSampleColumns(sx: number, sz: number): string[] {
  const columns: string[] = []
  for (let dx = -16; dx <= 16; dx += 16) {
    for (let dz = -16; dz <= 16; dz += 16) {
      columns.push(`${sx + dx},${sz + dz}`)
    }
  }
  return columns
}

export function provenMeshLightVersion(opts: {
  sx: number
  sz: number
  usedColumns: ReadonlySet<string>
  appliedVersionByColumn: ReadonlyMap<string, number>
}): number {
  let gap = Number.POSITIVE_INFINITY
  let covered = 0
  for (const column of sectionLightSampleColumns(opts.sx, opts.sz)) {
    const applied = opts.appliedVersionByColumn.get(column)
    if (applied == null) continue
    if (!opts.usedColumns.has(column)) gap = Math.min(gap, applied)
    else covered = Math.max(covered, applied)
  }
  if (!Number.isFinite(gap)) return covered
  let belowGap = 0
  for (const column of sectionLightSampleColumns(opts.sx, opts.sz)) {
    const applied = opts.appliedVersionByColumn.get(column)
    if (applied == null || !opts.usedColumns.has(column) || applied >= gap) continue
    belowGap = Math.max(belowGap, applied)
  }
  return belowGap
}
