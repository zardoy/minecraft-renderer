import MinecraftData from 'minecraft-data'

export const LIGHT_TABLES_MC_VERSION = '1.17.1' as const

export type LightTables1171 = {
  version: typeof LIGHT_TABLES_MC_VERSION
  /** Coarse block-level emit/filter from minecraft-data. Not a vanilla per-state dump. */
  source: 'minecraft-data-block-level'
  vanillaRegistryComplete: false
  emission: Uint8Array
  opacity: Uint8Array
}

/**
 * Build 1.17.1 light tables from minecraft-data.
 *
 * This is a mapping stub, not the vanilla 1.17.1 registry dump (that dump is
 * still missing; the repo decompile is ~1.21.7 and must not be used as 1.17.1).
 * Lit furnace / redstone lamp / candles stay 0 because minecraft-data has
 * emitLight on the block, not the state.
 */
export function buildLightTables1171(mcData = MinecraftData(LIGHT_TABLES_MC_VERSION)): LightTables1171 {
  const blocks = mcData.blocksArray
  let maxState = 0
  for (const block of blocks) {
    const hi = block.maxStateId ?? block.defaultState
    if (hi > maxState) maxState = hi
  }
  const emission = new Uint8Array(maxState + 1)
  const opacity = new Uint8Array(maxState + 1)
  opacity.fill(1)
  for (const block of blocks) {
    const lo = block.minStateId ?? block.defaultState
    const hi = block.maxStateId ?? block.defaultState
    const emit = clamp4(block.emitLight ?? 0)
    const filter = clamp4(Math.max(1, block.filterLight ?? 1))
    for (let id = lo; id <= hi; id++) {
      emission[id] = emit
      opacity[id] = filter
    }
  }
  return {
    version: LIGHT_TABLES_MC_VERSION,
    source: 'minecraft-data-block-level',
    vanillaRegistryComplete: false,
    emission,
    opacity
  }
}

function clamp4(value: number): number {
  return Math.max(0, Math.min(15, value | 0))
}
