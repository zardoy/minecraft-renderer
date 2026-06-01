type McElement = Record<string, unknown>

function buildIndexFromArray<T extends McElement> (
  array: T[],
  field: keyof T
): Record<string | number, T> {
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
  const fromArrayKey = mcData[arrayKey]
  if (Array.isArray(fromArrayKey)) {
    return fromArrayKey as McElement[]
  }
  const raw = mcData[rawKey]
  if (Array.isArray(raw)) {
    return raw as McElement[]
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
