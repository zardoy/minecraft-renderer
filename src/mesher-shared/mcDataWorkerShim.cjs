// Version-agnostic replacement for `minecraft-data` inside the mesher worker bundles (see scripts/buildWorkerShared.mjs).
//
// The real package would bake its version tables (data.js, protocolVersions.json, features.json) into the bundle at build
// time, so a worker could only ever load versions that the renderer's devDependency knew about. Nothing version-specific is
// bundled here: everything is read lazily from `globalThis.mcData`, which the main thread supplies with the `mcData`
// message (see `meshersSendMcData`):
//   - `version`          IndexedData['version'] of the current version
//   - `protocolVersions` pc protocolVersions list (used for version comparisons)
//   - `features`         `supportFeature(name)` already resolved for the current version
//   - everything else    data files (blocks, biomes, blockCollisionShapes, tints, ...)
const mcDataToNode = require('minecraft-data/lib/loader')
const indexer = require('minecraft-data/lib/indexer.js')

function createVersion (type, suppliedVersion, protocolVersions) {
  const versions = indexer.buildIndexFromArray(protocolVersions, 'minecraftVersion') ?? {}
  // Allows comparisons against majorVersion even if `other` is not present in the versions list (e.g. 1.17.0 exists but not 1.17)
  for (const key in versions) {
    const versionObj = versions[key]
    if (versionObj.minecraftVersion.endsWith('.0')) versions[versionObj.majorVersion] = versionObj
  }

  const self = {}
  // the supplied dataVersion is authoritative: the current version doesn't have to be present in the supplied list
  self.dataVersion = suppliedVersion.dataVersion ?? versions[suppliedVersion.minecraftVersion]?.dataVersion
  const v1 = self.dataVersion ?? 0
  const raise = other => { throw new RangeError(`Version '${other}' not found in protocolVersions supplied by the main thread for ${type}`) }
  self['>='] = other => versions[other] ? v1 >= versions[other].dataVersion : raise(other)
  self['>'] = other => versions[other] ? v1 > versions[other].dataVersion : raise(other)
  self['<'] = other => versions[other] ? v1 < versions[other].dataVersion : raise(other)
  self['<='] = other => versions[other] ? v1 <= versions[other].dataVersion : raise(other)
  self['=='] = other => versions[other] ? v1 === versions[other].dataVersion : raise(other)
  self.type = type
  self.majorVersion = suppliedVersion.majorVersion
  return self
}

let cache = null

module.exports = function (mcVersion) {
  const supplied = globalThis.mcData
  const suppliedVersion = supplied?.version
  if (!suppliedVersion) return null // not supplied (yet)

  const requested = String(mcVersion)
  // a worker only ever works with the single version it was supplied data for
  if (requested !== suppliedVersion.minecraftVersion && requested !== suppliedVersion.majorVersion && requested !== String(suppliedVersion.version)) return null

  if (cache?.src === supplied) return cache.value

  const type = suppliedVersion.type ?? 'pc'
  const protocolVersions = supplied.protocolVersions ?? []
  protocolVersions.forEach((entry, i) => {
    // same as minecraft-data: bottom entries are lower
    if (!entry.dataVersion) entry.dataVersion = -i
  })

  const { version: _version, protocolVersions: _protocolVersions, features: _features, ...files } = supplied
  const nmcData = mcDataToNode({ ...files, version: suppliedVersion })
  nmcData.type = type
  nmcData.isNewerOrEqualTo = version => nmcData.version['>='](version)
  nmcData.isOlderThan = version => nmcData.version['<'](version)
  nmcData.version = Object.assign(createVersion(type, suppliedVersion, protocolVersions), nmcData.version)
  const features = supplied.features ?? {}
  nmcData.supportFeature = featureName => features[featureName] || false

  cache = { src: supplied, value: nmcData }
  return nmcData
}

// Used eagerly by prismarine-block (preflat id mapping), static and version independent
module.exports.legacy = {
  pc: require('minecraft-data/minecraft-data/data/pc/common/legacy.json'),
  bedrock: {}
}
