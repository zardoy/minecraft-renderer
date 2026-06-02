type McElement = Record<string, unknown>

function coerceDenseArray (value: unknown): McElement[] | undefined {
  if (Array.isArray(value)) {
    return value as McElement[]
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, McElement>
  const keys = Object.keys(record).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b)
  if (!keys.length || keys[0] !== 0) {
    return undefined
  }
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== i) {
      return undefined
    }
  }
  return keys.map((k) => record[String(k)])
}

function buildIndexFromArray<T extends McElement> (
  array: T[],
  field: keyof T
): Record<string | number, T> {
  if (!Array.isArray(array)) {
    console.warn('[augmentWorkerMcData] buildIndexFromArray expected array, got', typeof array)
    return {}
  }
  return array.reduce<Record<string | number, T>>((index, element) => {
    index[element[field] as string | number] = element
    return index
  }, {})
}

function buildIndexFromArrayWithRanges<T extends McElement> (
  array: T[],
  minField: keyof T,
  maxField: keyof T
): Record<number, T> {
  if (!Array.isArray(array)) {
    console.warn('[augmentWorkerMcData] buildIndexFromArrayWithRanges expected array, got', typeof array)
    return {}
  }
  return array.reduce<Record<number, T>>((index, element) => {
    const min = element[minField] as number
    const max = element[maxField] as number
    for (let i = min; i <= max; i++) {
      index[i] = element
    }
    return index
  }, {})
}

function ensureBlockStateIds (blocks: McElement[]) {
  if (!blocks.length) return
  if ('minStateId' in blocks[0] && 'defaultState' in blocks[0]) return
  for (const block of blocks) {
    const id = block.id as number
    block.minStateId = id << 4
    block.maxStateId = (block.minStateId as number) + 15
    block.defaultState = block.minStateId
  }
}

function getSourceArray (
  mcData: Record<string, unknown>,
  arrayKey: string,
  rawKey: string
): McElement[] | undefined {
  const fromArrayKey = coerceDenseArray(mcData[arrayKey])
  if (fromArrayKey?.length) {
    return fromArrayKey
  }
  const raw = coerceDenseArray(mcData[rawKey])
  if (raw?.length) {
    return raw
  }
  return undefined
}

export function augmentWorkerMcData (mcData: Record<string, unknown>) {
  if (mcData.__workerIndexesBuilt) {
    return mcData
  }

  const blocks = getSourceArray(mcData, 'blocksArray', 'blocks')
  if (blocks?.length) {
    ensureBlockStateIds(blocks)
    mcData.blocksArray = blocks
    mcData.blocks = buildIndexFromArray(blocks, 'id')
    mcData.blocksByName = buildIndexFromArray(blocks, 'name')
    mcData.blocksByStateId = buildIndexFromArrayWithRanges(blocks, 'minStateId', 'maxStateId')
  }

  const items = getSourceArray(mcData, 'itemsArray', 'items')
  if (items?.length) {
    mcData.itemsArray = items
    mcData.itemsByName = buildIndexFromArray(items, 'name')
    mcData.items = buildIndexFromArray(items, 'id')
  }

  const entities = getSourceArray(mcData, 'entitiesArray', 'entities')
  if (entities?.length) {
    mcData.entitiesArray = entities
    mcData.entitiesByName = buildIndexFromArray(entities, 'name')
    mcData.entities = buildIndexFromArray(entities, 'id')
  }

  const biomes = getSourceArray(mcData, 'biomesArray', 'biomes')
  if (biomes?.length) {
    mcData.biomesArray = biomes
    mcData.biomes = buildIndexFromArray(biomes, 'id')
    mcData.biomesByName = buildIndexFromArray(biomes, 'name')
  }

  mcData.__workerIndexesBuilt = true
  return mcData
}
