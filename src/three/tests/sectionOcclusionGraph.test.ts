import { test, expect } from 'vitest'
import { SectionOcclusionGraph, buildOcclusionSectionRecord } from '../occlusion/sectionOcclusionGraph'
import { computeSectionVisibilitySet } from '../../mesher-shared/visGraph'

const ALL_OPEN = computeSectionVisibilitySet(16, () => false)
const SOLID = computeSectionVisibilitySet(16, () => true)

const DEFAULT_PARAMS = {
  smartCull: true,
  cameraWorldX: 8,
  cameraWorldY: 8,
  cameraWorldZ: 8,
  viewDistance: 4,
  sectionHeight: 16,
  worldMinY: 0,
  worldMaxY: 256
}

function reg(graph: SectionOcclusionGraph, key: string, vis = ALL_OPEN, sectionHeight = 16) {
  graph.setSection(key, buildOcclusionSectionRecord(key, vis, sectionHeight))
}

function runUpdate(graph: SectionOcclusionGraph, overrides: Partial<typeof DEFAULT_PARAMS> = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides }
  const cameraKey = `${Math.floor(params.cameraWorldX / 16) * 16},${Math.floor(params.cameraWorldY / params.sectionHeight) * params.sectionHeight},${Math.floor(params.cameraWorldZ / 16) * 16}`
  graph.runFullUpdate(cameraKey, params)
  return graph.getVisibleKeys()
}

test('BFS from camera section reaches neighbors when smart cull on and faces connect', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0')
  reg(graph, '16,0,0')
  reg(graph, '-16,0,0')

  const visible = runUpdate(graph)

  expect(visible.has('0,0,0')).toBe(true)
  expect(visible.has('16,0,0')).toBe(true)
  expect(visible.has('-16,0,0')).toBe(true)
})

test('solid section blocks traversal to neighbor behind it', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0', ALL_OPEN)
  reg(graph, '16,0,0', SOLID)
  reg(graph, '32,0,0', ALL_OPEN)

  const visible = runUpdate(graph)

  expect(visible.has('0,0,0')).toBe(true)
  expect(visible.has('16,0,0')).toBe(true)
  expect(visible.has('32,0,0')).toBe(false)
})

test('BFS assigns increasing step values', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0')
  reg(graph, '16,0,0')

  runUpdate(graph)

  expect(graph.getStep('0,0,0')).toBe(0)
  expect(graph.getStep('16,0,0')).toBe(1)
})

test('N-S tunnel section only connects through north/south faces', () => {
  const tunnelVis = computeSectionVisibilitySet(16, (lx, _ly, _lz) => lx === 0 || lx === 15)
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0', tunnelVis)
  reg(graph, '0,0,16', ALL_OPEN)

  const visible = runUpdate(graph)

  expect(visible.has('0,0,16')).toBe(true)
})

test('missing camera section seeds from surface ring', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0')

  const visible = runUpdate(graph, { cameraWorldY: -32 })

  expect(visible.has('0,0,0')).toBe(true)
})

test('camera in air section is seeded directly, not via surface fallback', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,64,0', ALL_OPEN)
  reg(graph, '0,80,0', ALL_OPEN)

  runUpdate(graph, { cameraWorldY: 84, cameraWorldX: 8, cameraWorldZ: 8 })

  expect(graph.getStep('0,80,0')).toBe(0)
  expect(graph.getVisibleKeys().has('0,64,0')).toBe(true)
})

test('surface connectivity over air gap in neighbouring column', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,64,0', ALL_OPEN)
  reg(graph, '0,80,0', ALL_OPEN)
  reg(graph, '16,48,0', ALL_OPEN)
  reg(graph, '16,64,0', ALL_OPEN)

  runUpdate(graph, { cameraWorldX: 8, cameraWorldY: 72, cameraWorldZ: 8 })

  expect(graph.getVisibleKeys().has('16,48,0')).toBe(true)
})

test('version counter increments on rebuild', () => {
  const graph = new SectionOcclusionGraph()
  reg(graph, '0,0,0')
  expect(graph.getVersion()).toBe(0)
  runUpdate(graph)
  expect(graph.getVersion()).toBe(1)
  runUpdate(graph)
  expect(graph.getVersion()).toBe(2)
})
