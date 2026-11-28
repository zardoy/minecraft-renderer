import MinecraftData, { IndexedData } from 'minecraft-data'
import pcFeatures from 'minecraft-data/minecraft-data/data/pc/common/features.json'

/**
 * Version tables the mesher workers need to behave like `minecraft-data`.
 * The worker bundles don't contain any (see src/mesher-shared/mcDataWorkerShim.cjs), they are supplied with the `mcData` message
 * so the workers support every version the main thread's `minecraft-data` supports.
 */
export type MesherVersionTables = {
  /** pc protocolVersions, newest first (same order as minecraft-data); only the fields needed for comparisons */
  protocolVersions: Array<{ minecraftVersion: string; majorVersion: string; dataVersion?: number; version?: number }>
  /** `supportFeature(name)` resolved for the current version */
  features: Record<string, unknown>
}

let protocolVersionsCache: MesherVersionTables['protocolVersions'] | undefined
const featuresCache = new WeakMap<object, MesherVersionTables['features']>()

export const getMesherVersionTables = (mcDataFull: IndexedData): MesherVersionTables => {
  protocolVersionsCache ??= MinecraftData.versions.pc.map(({ minecraftVersion, majorVersion, dataVersion, version }: any) => ({
    minecraftVersion,
    majorVersion,
    dataVersion,
    version
  }))

  let features = featuresCache.get(mcDataFull)
  if (!features) {
    features = {}
    const sentTable = (mcDataFull as { features?: unknown }).features ?? (globalThis as { mcData?: { features?: unknown } }).mcData?.features
    if (typeof mcDataFull.supportFeature !== 'function' && sentTable && typeof sentTable === 'object' && !Array.isArray(sentTable)) {
      // off-thread renderer: mcData reached this worker as plain data (no supportFeature), with the table the main thread computed.
      // Without it the meshers got no features and read block states the wrong way (every block showed another block's model)
      features = sentTable as Record<string, unknown>
    } else if (mcDataFull.type === 'pc') {
      // bedrock features are not used by the mesher
      for (const { name } of pcFeatures as Array<{ name: string }>) {
        features[name] = mcDataFull.supportFeature(name as any)
      }
    }
    featuresCache.set(mcDataFull, features)
  }

  return { protocolVersions: protocolVersionsCache, features }
}
