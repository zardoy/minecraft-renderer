// Temporary opt-in diagnostics. Each worker receives its own copy of the selection.
let positions = new Set<string>()
let sections = new Set<string>()

export function setClientLightProbePositions(points: Array<[number, number, number]>) {
  if (!Array.isArray(points) || points.some(point => !Array.isArray(point) || point.length !== 3 || point.some(value => !Number.isInteger(value)))) {
    throw new Error('Light probe positions must be integer [x, y, z] triples')
  }
  positions = new Set(points.map(point => point.join(',')))
  sections = new Set(points.map(point => point.map(value => Math.floor(value / 16) * 16).join(',')))
}

export function isClientLightProbeBlock(x: number, y: number, z: number) {
  return positions.has(`${x},${y},${z}`)
}

export function isClientLightProbeSection(key: string) {
  return sections.has(key)
}
