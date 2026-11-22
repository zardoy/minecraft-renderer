import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'

export type ParsedColumn = { getBlockStateId: (pos: Vec3) => number }

const chunkClasses = new Map<string, ReturnType<typeof Chunks>>()

/** `Chunks(version)` builds the class (and its block registry) on every call: keep one per version. */
export function chunkClassFor(version: string): ReturnType<typeof Chunks> {
  let Chunk = chunkClasses.get(version)
  if (!Chunk) {
    Chunk = Chunks(version) as ReturnType<typeof Chunks>
    chunkClasses.set(version, Chunk)
  }
  return Chunk
}

/** A column as sent to the renderer (JSON) or one already parsed. Throws on bad JSON. */
export function parseColumn<T extends object = ParsedColumn>(version: string, chunkJsonOrColumn: unknown): T {
  if (chunkJsonOrColumn && typeof (chunkJsonOrColumn as Partial<ParsedColumn>).getBlockStateId === 'function') return chunkJsonOrColumn as T
  return chunkClassFor(version).fromJson(chunkJsonOrColumn as Parameters<ReturnType<typeof Chunks>['fromJson']>[0]) as unknown as T
}

type SectionLike = {
  palette?: number[] | null
  data?: { get: (index: number) => number; palette?: unknown }
  isEmpty?: () => boolean
}

function sectionAt(column: object, y0: number): SectionLike | null | undefined {
  const withGet = column as { getSection?: (pos: { x: number; y: number; z: number }) => SectionLike | null }
  if (typeof withGet.getSection === 'function') {
    return withGet.getSection({ x: 0, y: y0, z: 0 })
  }
  const withArray = column as { sections?: Array<SectionLike | null>; minY?: number }
  if (Array.isArray(withArray.sections)) {
    return withArray.sections[(y0 - (withArray.minY ?? 0)) >> 4]
  }
  return undefined
}

/**
 * Block states of the section at `y0` into `states` (index `x + z * 16 + y * 256`), read from the palette when the column has one.
 * Returns false and leaves `states` untouched for a missing or empty section (all air), so pass a zeroed array.
 */
export function fillSectionStates(column: ParsedColumn, y0: number, states: Uint16Array): boolean {
  const section = sectionAt(column, y0)
  if (section === null) return false
  if (section && typeof section.isEmpty === 'function' && section.isEmpty()) return false
  if (section && Array.isArray(section.palette) && section.palette.length === 1) {
    const only = section.palette[0] || 0
    if (only === 0) return false
    states.fill(only)
    return true
  }
  if (section?.data && typeof section.data.get === 'function') {
    // Before 1.18 `data` is a bit array of palette indexes. From 1.18 it is a palette container that maps through its own palette (which
    // the section exposes as `palette` too): mapping again turned most blocks into air.
    const palette = 'palette' in section.data ? null : section.palette
    for (let i = 0; i < 4096; i++) {
      let stateId = section.data.get(i)
      if (palette) stateId = palette[stateId]!
      states[i] = stateId || 0
    }
    return true
  }
  const pos = new Vec3(0, y0, 0)
  for (let ly = 0; ly < 16; ly++) {
    pos.y = y0 + ly
    for (let lz = 0; lz < 16; lz++) {
      pos.z = lz
      for (let lx = 0; lx < 16; lx++) {
        pos.x = lx
        let stateId = 0
        try {
          stateId = column.getBlockStateId(pos) || 0
        } catch {
          stateId = 0
        }
        states[lx + lz * 16 + ly * 256] = stateId
      }
    }
  }
  return true
}
