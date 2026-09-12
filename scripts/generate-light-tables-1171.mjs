import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MinecraftData from 'minecraft-data'

const VERSION = '1.17.1'
const WORLD_VERSION = 2730
const VANILLA_COMMIT = '72447031d70fca0cfc9087de2704da83bc12fa79'
const FACE_PROPS = ['down', 'east', 'north', 'south', 'up', 'west']

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const blocksJavaPath = join(root, 'src/lib/vanilla-1.17.1/Blocks.java')
const outPath = join(root, 'src/lib/lightTables1171.generated.json')

export function matchParens(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openIdx + 1, i)
    }
  }
  throw new Error('unbalanced parentheses')
}

export function parseEmissionRules(blocksJava) {
  const rules = new Map()
  let i = 0
  while (true) {
    const j = blocksJava.indexOf('register(', i)
    if (j < 0) break
    if (blocksJava.startsWith('String', j + 9)) {
      i = j + 9
      continue
    }
    const inner = matchParens(blocksJava, j + 8)
    const nameMatch = inner.match(/^\s*"([^"]+)"/)
    if (nameMatch) {
      const lightAt = inner.indexOf('.lightLevel(')
      let kind = { type: 'zero' }
      if (lightAt >= 0) {
        const arg = matchParens(inner, lightAt + '.lightLevel'.length).replace(/\s+/g, ' ').trim()
        kind = classifyLightArg(arg)
      }
      rules.set(nameMatch[1], kind)
    }
    i = j + 9
  }
  return rules
}

function classifyLightArg(arg) {
  const constant = arg.match(/^blockStatex -> (\d+)$/)
  if (constant) return { type: 'const', value: Number(constant[1]) }
  const lit = arg.match(/^litBlockEmission\((\d+)\)$/)
  if (lit) return { type: 'lit', value: Number(lit[1]) }
  if (arg === 'CandleBlock.LIGHT_EMISSION') return { type: 'candle' }
  if (arg === 'LightBlock.LIGHT_EMISSION') return { type: 'light' }
  if (arg === 'CaveVines.emission(14)') return { type: 'berries', value: 14 }
  if (arg === 'GlowLichenBlock.emission(7)') return { type: 'anyFace', value: 7 }
  if (arg === 'blockStatex -> RespawnAnchorBlock.getScaledChargeLevel(blockStatex, 15)') {
    return { type: 'respawnAnchor' }
  }
  if (arg.includes('SeaPickleBlock.isDead')) return { type: 'seaPickle' }
  throw new Error(`unknown lightLevel argument: ${arg}`)
}

function propsAt(block, stateId) {
  let data = stateId - (block.minStateId ?? block.defaultState)
  const out = {}
  const states = block.states ?? []
  for (let i = states.length - 1; i >= 0; i--) {
    const prop = states[i]
    const idx = data % prop.num_values
    data = Math.floor(data / prop.num_values)
    if (prop.type === 'bool') out[prop.name] = idx === 0
    else if (prop.values) out[prop.name] = prop.values[idx]
    else out[prop.name] = idx
  }
  return out
}

function emissionFor(rule, props) {
  switch (rule.type) {
    case 'zero':
      return 0
    case 'const':
      return rule.value
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
    default:
      throw new Error(`unhandled rule ${rule.type}`)
  }
}

function opacityFor(block) {
  if (block.name === 'tinted_glass') return 15
  if (block.name.endsWith('_leaves')) return 1
  if (!block.transparent && block.boundingBox === 'block') return 15
  return 1
}

export function buildVanillaLightTables1171(blocksJava, mcData = MinecraftData(VERSION)) {
  const rules = parseEmissionRules(blocksJava)
  let maxState = 0
  for (const block of mcData.blocksArray) {
    const hi = block.maxStateId ?? block.defaultState
    if (hi > maxState) maxState = hi
    if (!rules.has(block.name)) {
      throw new Error(`1.17.1 Blocks.java has no register() for ${block.name}`)
    }
  }
  const emission = new Uint8Array(maxState + 1)
  const opacity = new Uint8Array(maxState + 1)
  opacity.fill(1)
  for (const block of mcData.blocksArray) {
    const rule = rules.get(block.name)
    const lo = block.minStateId ?? block.defaultState
    const hi = block.maxStateId ?? block.defaultState
    const blockOpacity = opacityFor(block)
    for (let id = lo; id <= hi; id++) {
      emission[id] = Math.max(0, Math.min(15, emissionFor(rule, propsAt(block, id))))
      opacity[id] = blockOpacity
    }
  }
  return {
    version: VERSION,
    vanillaWorldVersion: WORLD_VERSION,
    source: 'vanilla-1.17.1-blocks-java',
    vanillaCommit: VANILLA_COMMIT,
    vanillaRegistryComplete: true,
    emission,
    opacity
  }
}

function toArtifact(tables) {
  return {
    version: tables.version,
    vanillaWorldVersion: tables.vanillaWorldVersion,
    source: tables.source,
    vanillaCommit: tables.vanillaCommit,
    vanillaRegistryComplete: tables.vanillaRegistryComplete,
    emissionB64: Buffer.from(tables.emission).toString('base64'),
    opacityB64: Buffer.from(tables.opacity).toString('base64')
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const blocksJava = readFileSync(blocksJavaPath, 'utf8')
  const tables = buildVanillaLightTables1171(blocksJava)
  writeFileSync(outPath, `${JSON.stringify(toArtifact(tables), null, 2)}\n`)
  console.log(`wrote ${outPath} states=${tables.emission.length}`)
}
