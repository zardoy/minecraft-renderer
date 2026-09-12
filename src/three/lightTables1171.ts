import artifact from '../lib/lightTables1171.generated.json'

export const LIGHT_TABLES_MC_VERSION = '1.17.1' as const

export type LightTables1171 = {
  version: typeof LIGHT_TABLES_MC_VERSION
  /** Per-state emission from vanilla 1.17.1 Blocks.java lightLevel(...). */
  source: 'vanilla-1.17.1-blocks-java'
  vanillaWorldVersion: 2730
  vanillaCommit: string
  vanillaRegistryComplete: true
  emission: Uint8Array
  opacity: Uint8Array
}

/**
 * 1.17.1 light tables for `set_light_tables`.
 *
 * Emission is evaluated from the vendored vanilla 1.17.1 Blocks.java snapshot
 * (WORLD_VERSION 2730), mapped onto minecraft-data stateIds. Opacity is the
 * 1.17.1 getLightBlock default (solid cube 15, leaves 1, tinted glass 15,
 * otherwise 1) — not a face-occlusion dump.
 */
export function buildLightTables1171(): LightTables1171 {
  if (artifact.version !== LIGHT_TABLES_MC_VERSION) {
    throw new Error(`light table artifact version ${artifact.version} is not 1.17.1`)
  }
  if (artifact.source !== 'vanilla-1.17.1-blocks-java') {
    throw new Error(`refusing non-vanilla light table source ${artifact.source}`)
  }
  if (artifact.vanillaWorldVersion !== 2730 || !artifact.vanillaRegistryComplete) {
    throw new Error('light table artifact is not a complete 1.17.1 vanilla registry')
  }
  return {
    version: LIGHT_TABLES_MC_VERSION,
    source: 'vanilla-1.17.1-blocks-java',
    vanillaWorldVersion: 2730,
    vanillaCommit: artifact.vanillaCommit,
    vanillaRegistryComplete: true,
    emission: decodeB64(artifact.emissionB64),
    opacity: decodeB64(artifact.opacityB64)
  }
}

function decodeB64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(value, 'base64'))
  }
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
