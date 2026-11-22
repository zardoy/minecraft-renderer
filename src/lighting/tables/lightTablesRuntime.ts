import MinecraftData from 'minecraft-data'
import overridesJson from './lightDataOverrides.json'

/**
 * Light tables for any Minecraft version, built at runtime from minecraft-data (`emitLight`, `filterLight`) plus
 * `lightDataOverrides.json` (what minecraft-data cannot express: block-state dependent light, shape occlusion,
 * wrong data). For 1.17.1 the result was verified equal to the tables generated from vanilla's Blocks.java (the checksum
 * is pinned in lightTablesRuntime.test.ts).
 *
 * Tables are indexed by block state id and have the shape the light worker expects (`set_light_tables`):
 * - emission: block light emitted, 0..15
 * - opacity: raw vanilla `getLightBlock` (air 0, water / leaves 1, solid cube 15). The engine decays by max(1, this)
 * - occupancy: 2×2×2 solid octants for `useShapeForLightOcclusion` blocks (slabs, stairs, full snow), 0 for the rest
 */

/** The part of a minecraft-data block (`blocksArray` entry) the tables need. */
export type LightBlockData = {
  name: string
  minStateId?: number
  maxStateId?: number
  defaultState?: number
  states?: ReadonlyArray<{ name: string; type: string; num_values: number; values?: readonly unknown[] }>
  emitLight?: number
  filterLight?: number
  transparent?: boolean
  boundingBox?: string
}

export type LightTables = {
  version: string
  emission: Uint8Array
  opacity: Uint8Array
  occupancy: Uint8Array
}

type EmissionRule =
  | { type: 'lit'; value: number }
  | { type: 'candle' }
  | { type: 'light' }
  | { type: 'berries'; value: number }
  | { type: 'anyFace'; value: number }
  | { type: 'respawnAnchor' }
  | { type: 'seaPickle' }

type BlockOverride = {
  block: string
  /** Inclusive version range the override applies to, both optional. */
  minVersion?: string
  maxVersion?: string
  emission?: number
  lightBlock?: number
}

type OverridesFile = {
  emissionRules: Record<string, EmissionRule>
  emissionRuleSuffixes: Record<string, EmissionRule>
  overrides: BlockOverride[]
}

const FACE_PROPS = ['down', 'east', 'north', 'south', 'up', 'west']

/**
 * First version whose minecraft-data light fields are usable as the base. 1.17.1 matches the vanilla tables exactly and
 * 1.18.2 is identical to it; 1.16.5 and older differ in ~100 blocks (grass, flowers and torches with solid opacity, lit
 * furnaces and glowstone transparent, missing soul fire and soul torch light), so they need their own overrides first.
 */
export const RUNTIME_LIGHT_TABLES_MIN_VERSION = '1.17'

/** Whether `buildLightTables(version, ...)` is validated for this version. */
export function supportsRuntimeLightTables(version: string): boolean {
  return compareMcVersions(version, RUNTIME_LIGHT_TABLES_MIN_VERSION) >= 0
}

/** Numeric comparison of dotted Minecraft versions ("1.9" < "1.17.1"). */
export function compareMcVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function overrideApplies(override: BlockOverride, version: string): boolean {
  if (override.minVersion && compareMcVersions(version, override.minVersion) < 0) return false
  if (override.maxVersion && compareMcVersions(version, override.maxVersion) > 0) return false
  return true
}

/** Block state properties for a state id, from the block's `states` definition (last property varies fastest). */
export function statePropsAt(block: LightBlockData, stateId: number): Record<string, string | number | boolean> {
  let data = stateId - (block.minStateId ?? block.defaultState ?? 0)
  const out: Record<string, string | number | boolean> = {}
  const states = block.states ?? []
  for (let i = states.length - 1; i >= 0; i--) {
    const prop = states[i]!
    const idx = data % prop.num_values
    data = Math.floor(data / prop.num_values)
    if (prop.type === 'bool') out[prop.name] = idx === 0
    else if (prop.values) out[prop.name] = prop.values[idx] as string | number
    else out[prop.name] = idx
  }
  return out
}

function ruleEmission(rule: EmissionRule, props: Record<string, string | number | boolean>): number {
  switch (rule.type) {
    case 'lit':
      return props.lit === true ? rule.value : 0
    case 'candle':
      return props.lit === true ? 3 * Number(props.candles) : 0
    case 'light':
      return Number(props.level)
    case 'berries':
      return props.berries === true ? rule.value : 0
    case 'anyFace':
      return FACE_PROPS.some(face => props[face] === true) ? rule.value : 0
    case 'respawnAnchor':
      return Math.floor((Number(props.charges) / 4) * 15)
    case 'seaPickle':
      return props.waterlogged === true ? 3 + 3 * Number(props.pickles) : 0
  }
}

const isSlab = (name: string) => name.endsWith('_slab') || name === 'petrified_oak_slab'
const isStairs = (name: string) => name.endsWith('_stairs')
const isLeaves = (name: string) => name.endsWith('_leaves')
const isLiquid = (name: string) => name === 'water' || name === 'lava' || name === 'bubble_column'

/**
 * Raw vanilla getLightBlock. minecraft-data's `filterLight` is the base; the cases below are where it differs from
 * vanilla (verified against the 1.17.1 Blocks.java tables) or depends on the block state.
 */
function lightBlockFor(block: LightBlockData, props: Record<string, string | number | boolean>): number {
  const { name } = block
  if (name === 'tinted_glass') return 15
  if (isLeaves(name) || isLiquid(name) || name === 'barrier') return 1
  if (isSlab(name)) {
    if (props.type === 'double') return 15
    return props.waterlogged === true ? 1 : 0
  }
  if (isStairs(name)) return props.waterlogged === true ? 1 : 0
  if (name === 'snow') return Number(props.layers) === 8 ? 15 : 0
  if ((name === 'piston' || name === 'sticky_piston') && props.extended === true) return 0
  if (name === 'glass' || name.endsWith('_stained_glass')) return 0
  if (typeof block.filterLight === 'number') return Math.max(0, Math.min(15, block.filterLight))
  if (!block.transparent && block.boundingBox === 'block') return 15
  return 0
}

const UPPER: Record<string, number> = { north: 0x30, south: 0xc0, west: 0x50, east: 0xa0 }
const CCW: Record<string, string> = { north: 'west', west: 'south', south: 'east', east: 'north' }
const CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' }
const OUTER_OCTANT: Record<string, number> = { north_west: 0x10, north_east: 0x20, south_west: 0x40, south_east: 0x80 }

const invertY = (occ: number) => ((occ & 0x0f) << 4) | ((occ & 0xf0) >> 4)

function stairOccupancy(props: Record<string, string | number | boolean>): number {
  const facing = String(props.facing)
  const shape = String(props.shape)
  let occ = 0x0f
  if (shape === 'straight') occ |= UPPER[facing] ?? 0
  else if (shape === 'inner_left') occ |= (UPPER[facing] ?? 0) | (UPPER[CCW[facing]!] ?? 0)
  else if (shape === 'inner_right') occ |= (UPPER[facing] ?? 0) | (UPPER[CW[facing]!] ?? 0)
  else if (shape === 'outer_left') occ |= OUTER_OCTANT[`${facing}_${CCW[facing]}`] ?? OUTER_OCTANT[`${CCW[facing]}_${facing}`] ?? 0
  else if (shape === 'outer_right') occ |= OUTER_OCTANT[`${facing}_${CW[facing]}`] ?? OUTER_OCTANT[`${CW[facing]}_${facing}`] ?? 0
  return props.half === 'top' ? invertY(occ) : occ
}

function occupancyFor(block: LightBlockData, props: Record<string, string | number | boolean>): number {
  const { name } = block
  if (isSlab(name)) {
    if (props.type === 'double') return 0
    return props.type === 'top' ? 0xf0 : 0x0f
  }
  if (isStairs(name)) return stairOccupancy(props)
  if (name === 'snow' && Number(props.layers) === 8) return 0xff
  return 0
}

const clamp15 = (value: number) => Math.max(0, Math.min(15, value))

const loadedTables = new Map<string, LightTables>()

/** Tables of a session version, built once from minecraft-data (throws for versions below RUNTIME_LIGHT_TABLES_MIN_VERSION). */
export function loadLightTables(version: string): LightTables {
  if (!supportsRuntimeLightTables(version)) {
    throw new Error(`light tables are not available for ${version}, they need Minecraft ${RUNTIME_LIGHT_TABLES_MIN_VERSION} or newer`)
  }
  let tables = loadedTables.get(version)
  if (!tables) {
    tables = buildLightTables(version, MinecraftData(version).blocksArray as unknown as LightBlockData[])
    loadedTables.set(version, tables)
  }
  return tables
}

function findEmissionRule(name: string, file: OverridesFile): EmissionRule | undefined {
  const exact = file.emissionRules[name]
  if (exact) return exact
  for (const [suffix, rule] of Object.entries(file.emissionRuleSuffixes)) {
    if (name.endsWith(suffix)) return rule
  }
  return undefined
}

/**
 * Build the light tables of `version` from its minecraft-data blocks.
 * `overrides` is only a parameter for tests, production passes nothing and uses lightDataOverrides.json.
 */
export function buildLightTables(version: string, blocks: readonly LightBlockData[], overrides: OverridesFile = overridesJson as OverridesFile): LightTables {
  let maxState = 0
  for (const block of blocks) {
    const hi = block.maxStateId ?? block.defaultState ?? 0
    if (hi > maxState) maxState = hi
  }
  const emission = new Uint8Array(maxState + 1)
  const opacity = new Uint8Array(maxState + 1)
  const occupancy = new Uint8Array(maxState + 1)
  const applicable = overrides.overrides.filter(o => overrideApplies(o, version))

  for (const block of blocks) {
    const lo = block.minStateId ?? block.defaultState ?? 0
    const hi = block.maxStateId ?? block.defaultState ?? 0
    const rule = findEmissionRule(block.name, overrides)
    const blockOverrides = applicable.filter(o => o.block === block.name)
    for (let id = lo; id <= hi; id++) {
      const props = statePropsAt(block, id)
      let emitted = rule ? ruleEmission(rule, props) : (block.emitLight ?? 0)
      let lightBlock = lightBlockFor(block, props)
      for (const override of blockOverrides) {
        if (override.emission !== undefined) emitted = override.emission
        if (override.lightBlock !== undefined) lightBlock = override.lightBlock
      }
      emission[id] = clamp15(emitted)
      opacity[id] = clamp15(lightBlock)
      occupancy[id] = occupancyFor(block, props)
    }
  }
  return { version, emission, opacity, occupancy }
}
