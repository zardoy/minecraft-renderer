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
    // bedrock features are not used by the mesher
    if (mcDataFull.type === 'pc') {
      for (const { name } of pcFeatures as Array<{ name: string }>) {
        features[name] = mcDataFull.supportFeature(name as any)
      }
    }
    featuresCache.set(mcDataFull, features)
  }

  return { protocolVersions: protocolVersionsCache, features }
}
