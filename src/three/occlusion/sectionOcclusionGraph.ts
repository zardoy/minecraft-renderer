/**
 * Sync port of Minecraft SectionOcclusionGraph BFS (v1 — no Octree/async/advanced ray-march).
 * @see extracted_minecraft_data/client/net/minecraft/client/renderer/SectionOcclusionGraph.java
 */

import { Vec3 } from 'vec3'
import { Direction, DIRECTIONS, VISIBILITY_SET_ALL_TRUE, oppositeDirection, visibilityBetweenPacked } from '../../mesher-shared/visibilitySet'

export type OcclusionSectionRecord = {
  visibilitySet: number
  /** Section corner world X (block coord of section origin). */
  sectionX: number
  sectionY: number
  sectionZ: number
  /** Six neighbour section keys (DOWN, UP, NORTH, SOUTH, WEST, EAST). */
  neighborKeys: readonly string[]
}

export type OcclusionUpdateParams = {
  smartCull: boolean
  cameraWorldX: number
  cameraWorldY: number
  cameraWorldZ: number
  viewDistance: number
  sectionHeight: number
  worldMinY: number
  worldMaxY: number
}

export type OcclusionRebuildStats = {
  durationMs: number
  nodeCount: number
}

export class OcclusionNode {
  readonly sectionKey: string
  private sourceDirections = 0
  directions = 0
  readonly step: number

  constructor(sectionKey: string, sourceDir: Direction | null, step: number) {
    this.sectionKey = sectionKey
    this.step = step
    if (sourceDir != null) {
      this.addSourceDirection(sourceDir)
    }
  }

  setDirections(fromParent: number, exitDir: Direction): void {
    this.directions = (fromParent | this.directions | (1 << exitDir)) >>> 0
  }

  hasDirection(dir: Direction): boolean {
    return (this.directions & (1 << dir)) !== 0
  }

  addSourceDirection(dir: Direction): void {
    this.sourceDirections = (this.sourceDirections | (1 << dir)) >>> 0
  }

  hasSourceDirection(index: number): boolean {
    return (this.sourceDirections & (1 << index)) !== 0
  }

  hasSourceDirections(): boolean {
    return this.sourceDirections !== 0
  }
}

function sectionKeyFromWorld(worldX: number, worldY: number, worldZ: number): string {
  return `${worldX},${worldY},${worldZ}`
}

function parseSectionKey(key: string): { x: number; y: number; z: number } {
  const [x, y, z] = key.split(',').map(Number)
  return { x: x!, y: y!, z: z! }
}

function buildNeighborKeys(x: number, y: number, z: number, sectionHeight: number): readonly string[] {
  return [
    sectionKeyFromWorld(x, y - sectionHeight, z),
    sectionKeyFromWorld(x, y + sectionHeight, z),
    sectionKeyFromWorld(x, y, z - 16),
    sectionKeyFromWorld(x, y, z + 16),
    sectionKeyFromWorld(x - 16, y, z),
    sectionKeyFromWorld(x + 16, y, z)
  ]
}

export function buildOcclusionSectionRecord(key: string, visibilitySet: number, sectionHeight: number): OcclusionSectionRecord {
  const { x, y, z } = parseSectionKey(key)
  return {
    visibilitySet,
    sectionX: x,
    sectionY: y,
    sectionZ: z,
    neighborKeys: buildNeighborKeys(x, y, z, sectionHeight)
  }
}

export function occlusionSectionRecordsEqual(a: OcclusionSectionRecord, b: OcclusionSectionRecord): boolean {
  return (
    a.visibilitySet === b.visibilitySet &&
    a.sectionX === b.sectionX &&
    a.sectionY === b.sectionY &&
    a.sectionZ === b.sectionZ &&
    a.neighborKeys.length === b.neighborKeys.length &&
    a.neighborKeys.every((key, index) => key === b.neighborKeys[index])
  )
}

function isInViewDistance(
  camX: number,
  camY: number,
  camZ: number,
  secX: number,
  secY: number,
  secZ: number,
  viewDistance: number,
  sectionHeight: number
): boolean {
  const camChunkX = Math.floor(camX / 16)
  const camChunkZ = Math.floor(camZ / 16)
  const secChunkX = Math.floor(secX / 16)
  const secChunkZ = Math.floor(secZ / 16)
  if (Math.abs(secChunkX - camChunkX) > viewDistance || Math.abs(secChunkZ - camChunkZ) > viewDistance) {
    return false
  }
  const camSecY = Math.floor(camY / sectionHeight)
  const secSecY = Math.floor(secY / sectionHeight)
  return Math.abs(secSecY - camSecY) <= viewDistance
}

export class SectionOcclusionGraph {
  private readonly sections = new Map<string, OcclusionSectionRecord>()
  private readonly nodeByKey = new Map<string, OcclusionNode>()
  private visibleKeys = new Set<string>()
  private stepByKey = new Map<string, number>()
  private version = 0
  private lastRebuildStats: OcclusionRebuildStats = { durationMs: 0, nodeCount: 0 }

  setSection(key: string, record: OcclusionSectionRecord): void {
    this.sections.set(key, record)
  }

  hasSection(key: string): boolean {
    return this.sections.has(key)
  }

  getSection(key: string): OcclusionSectionRecord | undefined {
    return this.sections.get(key)
  }

  removeSection(key: string): void {
    this.sections.delete(key)
    this.nodeByKey.delete(key)
    this.visibleKeys.delete(key)
    this.stepByKey.delete(key)
  }

  getVisibleKeys(): ReadonlySet<string> {
    return this.visibleKeys
  }

  getStep(key: string): number | undefined {
    return this.stepByKey.get(key)
  }

  isVisible(key: string): boolean {
    return this.visibleKeys.has(key)
  }

  getVersion(): number {
    return this.version
  }

  getLastRebuildStats(): Readonly<OcclusionRebuildStats> {
    return this.lastRebuildStats
  }

  getSectionCount(): number {
    return this.sections.size
  }

  needsRebuild(): boolean {
    return this.sections.size > 0 && this.visibleKeys.size === 0 && this.version === 0
  }

  clear(): void {
    this.sections.clear()
    this.nodeByKey.clear()
    this.visibleKeys = new Set()
    this.stepByKey.clear()
    this.version++
    this.lastRebuildStats = { durationMs: 0, nodeCount: 0 }
  }

  runFullUpdate(cameraKey: string, params: OcclusionUpdateParams): void {
    const start = performance.now()
    this.nodeByKey.clear()
    this.visibleKeys = new Set()
    this.stepByKey.clear()

    const queue: OcclusionNode[] = []
    this.initializeQueueForFullUpdate(cameraKey, queue, params)

    const cam = parseSectionKey(cameraKey)
    let head = 0
    while (head < queue.length) {
      const node = queue[head++]!
      const sectionKey = node.sectionKey
      const record = this.sections.get(sectionKey)
      if (!record) continue

      this.visibleKeys.add(sectionKey)
      this.stepByKey.set(sectionKey, node.step)

      const visibilitySet = record.visibilitySet

      for (let dirIndex = 0; dirIndex < DIRECTIONS.length; dirIndex++) {
        const exitDir = DIRECTIONS[dirIndex]!
        const neighborSectionKey = record.neighborKeys[dirIndex]!
        if (!this.sections.has(neighborSectionKey)) continue
        const neighbor = this.sections.get(neighborSectionKey)!
        if (!isInViewDistance(cam.x, cam.y, cam.z, neighbor.sectionX, neighbor.sectionY, neighbor.sectionZ, params.viewDistance, params.sectionHeight)) {
          continue
        }

        if (node.hasDirection(oppositeDirection(exitDir))) continue

        if (node.hasSourceDirections()) {
          let canSee = false
          for (let i = 0; i < DIRECTIONS.length; i++) {
            if (node.hasSourceDirection(i) && visibilityBetweenPacked(visibilitySet, oppositeDirection(DIRECTIONS[i]!), exitDir)) {
              canSee = true
              break
            }
          }
          if (!canSee) continue
        }

        const existing = this.nodeByKey.get(neighborSectionKey)
        if (existing) {
          existing.addSourceDirection(exitDir)
        } else {
          const next = new OcclusionNode(neighborSectionKey, exitDir, node.step + 1)
          next.setDirections(node.directions, exitDir)
          this.nodeByKey.set(neighborSectionKey, next)
          queue.push(next)
        }
      }
    }

    this.version++
    this.lastRebuildStats = {
      durationMs: performance.now() - start,
      nodeCount: this.sections.size
    }
  }

  /** @see SectionOcclusionGraph.initializeQueueForFullUpdate */
  private initializeQueueForFullUpdate(cameraKey: string, queue: OcclusionNode[], params: OcclusionUpdateParams): void {
    if (this.sections.has(cameraKey)) {
      const node = new OcclusionNode(cameraKey, null, 0)
      this.nodeByKey.set(cameraKey, node)
      queue.push(node)
      return
    }

    const cam = parseSectionKey(cameraKey)
    const camSecY = Math.floor(cam.y / params.sectionHeight)
    const minSecY = Math.floor(params.worldMinY / params.sectionHeight)
    const maxSecY = Math.floor((params.worldMaxY - 1) / params.sectionHeight)
    const belowMin = camSecY < minSecY
    const surfaceSecY = belowMin ? minSecY : maxSecY
    const surfaceY = surfaceSecY * params.sectionHeight

    const camChunkX = Math.floor(cam.x / 16)
    const camChunkZ = Math.floor(cam.z / 16)
    const seeds: Array<{ node: OcclusionNode; distSq: number }> = []

    for (let dx = -params.viewDistance; dx <= params.viewDistance; dx++) {
      for (let dz = -params.viewDistance; dz <= params.viewDistance; dz++) {
        const key = sectionKeyFromWorld((camChunkX + dx) * 16, surfaceY, (camChunkZ + dz) * 16)
        if (!this.sections.has(key)) continue
        const neighbor = this.sections.get(key)!
        if (!isInViewDistance(cam.x, cam.y, cam.z, neighbor.sectionX, neighbor.sectionY, neighbor.sectionZ, params.viewDistance, params.sectionHeight)) {
          continue
        }

        const entryDir = belowMin ? Direction.UP : Direction.DOWN
        const node = new OcclusionNode(key, entryDir, 0)
        node.setDirections(0, entryDir)
        if (dx > 0) node.setDirections(node.directions, Direction.EAST)
        else if (dx < 0) node.setDirections(node.directions, Direction.WEST)
        if (dz > 0) node.setDirections(node.directions, Direction.SOUTH)
        else if (dz < 0) node.setDirections(node.directions, Direction.NORTH)

        const center = new Vec3(cam.x + 8, cam.y + 8, cam.z + 8)
        const distSq = center.distanceTo(new Vec3(neighbor.sectionX + 8, neighbor.sectionY + 8, neighbor.sectionZ + 8))
        seeds.push({ node, distSq })
      }
    }

    seeds.sort((a, b) => a.distSq - b.distSq)
    for (const seed of seeds) {
      this.nodeByKey.set(seed.node.sectionKey, seed.node)
      queue.push(seed.node)
    }
  }
}
