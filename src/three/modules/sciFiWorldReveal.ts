/**
 * Wireframe-to-solid chunk reveal.
 * Ported from web-client-2/renderer/viewer/three/sciFiWorldReveal.ts
 */
import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'
import type { SectionObject } from '../chunkMeshManager'

const SCI_FI_CYAN = new THREE.Color(13 / 255, 234 / 255, 238 / 255)

const CHUNKS_THRESHOLD = 9
const GLOBAL_START_FALLBACK_MS = 12_000
const WAVE_SPREAD_MS = 1500
const MAX_SECTION_LIFETIME_MS = 10_000

const INITIAL_WIREFRAME_MS = 350
const INITIAL_FADE_MS = 650
const CHUNK_WIREFRAME_MS = 120
const CHUNK_FADE_MS = 280

type RevealPhase = 'queued' | 'wireframe' | 'fade' | 'done'

interface SectionReveal {
  key: string
  geometry: MesherGeometryOutput
  phase: RevealPhase
  phaseStartMs: number
  revealAtMs: number
  wireframeMs: number
  fadeMs: number
  wireframeGroup: THREE.Group | null
  mesh: THREE.Mesh | null
  savedMaterial: THREE.Material | null
  pulseOffset: number
}

export class SciFiWorldRevealModule implements RendererModuleController {
  private enabled = true
  private readonly sections = new Map<string, SectionReveal>()
  private readonly completed = new Set<string>()

  private globalWaveStarted = false
  private globalWaveStartMs = 0
  private finishedChunkCount = 0
  private firstQueuedMs: number | null = null
  private pulseTime = 0

  private readonly wireframeMaterial = new THREE.LineBasicMaterial({
    color: SCI_FI_CYAN,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })

  private readonly wireframeGlowMaterial = new THREE.LineBasicMaterial({
    color: SCI_FI_CYAN,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })

  constructor(private readonly worldRenderer: WorldRendererThree) {
    if (worldRenderer.worldRendererConfig.futuristicReveal !== true) {
      this.enabled = false
    }
  }

  autoEnableCheck(): boolean {
    return this.worldRenderer.worldRendererConfig.futuristicReveal === true
  }

  enable(): void {
    if (!this.autoEnableCheck()) return
    this.setEnabled(true)
  }

  disable(): void {
    this.setEnabled(false)
  }

  dispose(): void {
    this.reset()
    this.wireframeMaterial.dispose()
    this.wireframeGlowMaterial.dispose()
  }

  shouldDeferSectionGeometry(sectionKey: string): boolean {
    return this.enabled && !this.completed.has(sectionKey)
  }

  onSectionMeshed(key: string, geometry: MesherGeometryOutput, sectionObject: SectionObject): void {
    const mesh = sectionObject.children.find(c => c.name === 'mesh')
    if (!(mesh instanceof THREE.Mesh)) return
    this.onSectionMeshedMesh(key, geometry, mesh)
  }

  onChunkFinished(): void {
    if (!this.enabled) return
    this.finishedChunkCount++
    this.tryStartGlobalWave(performance.now())
  }

  onSectionRemoved(key: string): void {
    this.cancelSection(key, true)
    this.completed.delete(key)
  }

  onWorldSwitched(): void {
    this.reset()
  }

  tick(deltaMs: number, now = performance.now()): void {
    if (!this.enabled) return

    this.tryStartGlobalWave(now)

    if (!this.globalWaveStarted && this.firstQueuedMs !== null && this.sections.size > 0 && now - this.firstQueuedMs >= GLOBAL_START_FALLBACK_MS) {
      this.startGlobalWave(now)
    }

    if (this.sections.size === 0) return

    this.pulseTime += deltaMs * 0.001
    const toFinish: SectionReveal[] = []

    for (const section of this.sections.values()) {
      if (now - section.phaseStartMs > MAX_SECTION_LIFETIME_MS) {
        toFinish.push(section)
        continue
      }

      if (section.phase === 'queued') {
        if (this.globalWaveStarted && now >= section.revealAtMs) {
          this.beginWireframe(section, now)
        }
        continue
      }

      const phaseElapsed = now - section.phaseStartMs

      if (section.phase === 'wireframe') {
        this.animateWireframe(section, phaseElapsed)
        if (phaseElapsed >= section.wireframeMs) {
          this.beginFade(section, now)
        }
        continue
      }

      if (section.phase === 'fade') {
        const progress = Math.min(1, phaseElapsed / section.fadeMs)
        this.animateFade(section, progress)
        if (progress >= 1) {
          toFinish.push(section)
        }
      }
    }

    for (const section of toFinish) {
      this.finishSection(section)
    }
  }

  private setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.forceFinishAll()
    }
  }

  private onSectionMeshedMesh(key: string, geometry: MesherGeometryOutput, mesh: THREE.Mesh): void {
    if (!this.enabled || !geometry.positions?.length) return
    if (this.completed.has(key)) return

    const existing = this.sections.get(key)
    if (existing) {
      existing.mesh = mesh
      existing.geometry = geometry
      if (existing.phase === 'wireframe' || existing.phase === 'fade') {
        this.finishSection(existing)
      }
      return
    }

    const now = performance.now()
    if (this.firstQueuedMs === null) {
      this.firstQueuedMs = now
    }

    const useChunkTimings = this.globalWaveStarted
    this.sections.set(key, {
      key,
      geometry,
      phase: 'queued',
      phaseStartMs: now,
      revealAtMs: this.globalWaveStarted ? now : 0,
      wireframeMs: useChunkTimings ? CHUNK_WIREFRAME_MS : INITIAL_WIREFRAME_MS,
      fadeMs: useChunkTimings ? CHUNK_FADE_MS : INITIAL_FADE_MS,
      wireframeGroup: null,
      mesh,
      savedMaterial: null,
      pulseOffset: Math.random() * Math.PI * 2
    })

    mesh.visible = false
    this.setShaderMeshesVisible(key, false)
    this.tryStartGlobalWave(now)
  }

  private reset(): void {
    this.forceFinishAll()
    this.sections.clear()
    this.completed.clear()
    this.globalWaveStarted = false
    this.globalWaveStartMs = 0
    this.finishedChunkCount = 0
    this.firstQueuedMs = null
    this.pulseTime = 0
  }

  private forceFinishAll(): void {
    for (const section of [...this.sections.values()]) {
      this.finishSection(section)
    }
    this.sections.clear()
    this.unhideAllSectionMeshes()
  }

  private tryStartGlobalWave(now: number): void {
    if (this.globalWaveStarted) return
    if (this.sections.size === 0) return

    if (this.finishedChunkCount >= CHUNKS_THRESHOLD) {
      this.startGlobalWave(now)
      return
    }

    if (this.worldRenderer.allChunksFinished) {
      this.startGlobalWave(now)
    }
  }

  private startGlobalWave(now: number): void {
    if (this.globalWaveStarted) return
    this.globalWaveStarted = true
    this.globalWaveStartMs = now

    const cameraPos = this.worldRenderer.getCameraPosition()
    let maxDistance = 1
    const distances = new Map<string, number>()

    for (const [key, section] of this.sections) {
      if (section.phase !== 'queued') continue
      const { sx, sy, sz } = section.geometry
      const distance = Math.hypot(sx - cameraPos.x, sy - cameraPos.y, sz - cameraPos.z)
      distances.set(key, distance)
      maxDistance = Math.max(maxDistance, distance)
    }

    for (const [, section] of this.sections) {
      if (section.phase !== 'queued') continue
      const distance = distances.get(section.key) ?? 0
      section.revealAtMs = now + (distance / maxDistance) * WAVE_SPREAD_MS
      section.wireframeMs = CHUNK_WIREFRAME_MS
      section.fadeMs = CHUNK_FADE_MS
    }
  }

  private beginWireframe(section: SectionReveal, now: number): void {
    const mesh = section.mesh ?? this.getSectionMesh(section.key)
    section.mesh = mesh
    if (!mesh) {
      this.sections.delete(section.key)
      return
    }

    const wireframeGeom = this.createWireframeGeometry(section.geometry)
    const wireframe = new THREE.LineSegments(wireframeGeom, this.wireframeMaterial.clone())
    this.worldRenderer.sceneOrigin.track(wireframe)
    wireframe.position.set(section.geometry.sx, section.geometry.sy, section.geometry.sz)
    wireframe.name = 'scifi-wireframe'
    wireframe.renderOrder = 1000

    const glow = new THREE.LineSegments(wireframeGeom.clone(), this.wireframeGlowMaterial.clone())
    this.worldRenderer.sceneOrigin.track(glow)
    glow.position.copy(wireframe.position)
    glow.scale.setScalar(1.02)
    glow.name = 'scifi-glow'
    glow.renderOrder = 999

    const group = new THREE.Group()
    group.name = 'scifi-reveal-group'
    group.add(wireframe, glow)
    this.worldRenderer.realScene.add(group)

    mesh.visible = false
    this.setShaderMeshesVisible(section.key, false)

    section.wireframeGroup = group
    section.phase = 'wireframe'
    section.phaseStartMs = now
  }

  private beginFade(section: SectionReveal, now: number): void {
    const mesh = section.mesh ?? this.getSectionMesh(section.key)
    section.mesh = mesh
    if (mesh) {
      mesh.visible = true
      const rawMat = mesh.material
      if (!Array.isArray(rawMat) && rawMat && typeof rawMat.clone === 'function') {
        section.savedMaterial = rawMat
        const fadeMat = rawMat.clone()
        fadeMat.transparent = true
        fadeMat.opacity = 0
        fadeMat.needsUpdate = true
        mesh.material = fadeMat
      }
    }
    this.setShaderMeshesVisible(section.key, true)
    section.phase = 'fade'
    section.phaseStartMs = now
  }

  private animateWireframe(section: SectionReveal, phaseElapsed: number): void {
    if (!section.wireframeGroup) return
    const wireframe = section.wireframeGroup.children[0] as THREE.LineSegments
    const glow = section.wireframeGroup.children[1] as THREE.LineSegments
    const basePulse = 0.6 + 0.4 * Math.sin(this.pulseTime * 4 + section.pulseOffset)
    if (wireframe?.material) {
      const mat = wireframe.material as THREE.LineBasicMaterial
      mat.opacity = basePulse
      const intensity = 0.85 + 0.15 * Math.sin(this.pulseTime * 6 + phaseElapsed * 0.002)
      mat.color.setRGB((13 / 255) * intensity, (234 / 255) * intensity, (238 / 255) * intensity)
    }
    if (glow?.material) {
      ;(glow.material as THREE.LineBasicMaterial).opacity = basePulse * 0.4
    }
  }

  private animateFade(section: SectionReveal, progress: number): void {
    const eased = 1 - (1 - progress) ** 3
    if (section.wireframeGroup) {
      const wireframe = section.wireframeGroup.children[0] as THREE.LineSegments
      const glow = section.wireframeGroup.children[1] as THREE.LineSegments
      if (wireframe?.material) (wireframe.material as THREE.LineBasicMaterial).opacity = 1 - eased
      if (glow?.material) (glow.material as THREE.LineBasicMaterial).opacity = (1 - eased) * 0.55
    }
    const mesh = section.mesh
    if (mesh && section.savedMaterial && !Array.isArray(mesh.material)) {
      ;(mesh.material as THREE.Material).opacity = eased
    }
    this.setShaderMeshesVisible(section.key, eased > 0.001)
  }

  private finishSection(section: SectionReveal): void {
    const mesh = section.mesh ?? this.getSectionMesh(section.key)
    if (mesh) {
      if (section.savedMaterial) {
        const fadeMat = mesh.material as THREE.Material
        mesh.material = section.savedMaterial
        fadeMat.dispose()
        section.savedMaterial = null
      }
      mesh.visible = true
    }
    this.setShaderMeshesVisible(section.key, true)

    const { chunkMeshManager } = this.worldRenderer
    chunkMeshManager.migrateDeferredShaderToGlobal(section.key)
    chunkMeshManager.migrateDeferredLegacyToGlobal(section.key)

    if (section.wireframeGroup) {
      this.disposeWireframeGroup(section.wireframeGroup)
      section.wireframeGroup = null
    }
    this.sections.delete(section.key)
    this.completed.add(section.key)
  }

  private cancelSection(key: string, unhide: boolean): void {
    const section = this.sections.get(key)
    if (!section) return
    if (section.wireframeGroup) {
      this.disposeWireframeGroup(section.wireframeGroup)
    }
    if (unhide) {
      const mesh = section.mesh ?? this.getSectionMesh(key)
      if (mesh) {
        if (section.savedMaterial) {
          const fadeMat = mesh.material as THREE.Material
          mesh.material = section.savedMaterial
          fadeMat.dispose()
        }
        mesh.visible = true
      }
      this.setShaderMeshesVisible(key, true)
    }
    this.sections.delete(key)
  }

  private getSectionMesh(key: string): THREE.Mesh | null {
    const sectionObject = this.worldRenderer.chunkMeshManager.sectionObjects[key]
    if (!sectionObject) return null
    const mesh = sectionObject.children.find(c => c.name === 'mesh')
    return mesh instanceof THREE.Mesh ? mesh : null
  }

  private getShaderMesh(key: string): THREE.Mesh | null {
    const sectionObject = this.worldRenderer.chunkMeshManager.sectionObjects[key]
    if (!sectionObject) return null
    const mesh = sectionObject.children.find(c => c.name === 'shaderMesh')
    return mesh instanceof THREE.Mesh ? mesh : null
  }

  private setShaderMeshesVisible(key: string, visible: boolean): void {
    const shaderMesh = this.getShaderMesh(key)
    if (shaderMesh) shaderMesh.visible = visible
  }

  private unhideAllSectionMeshes(): void {
    for (const obj of Object.values(this.worldRenderer.chunkMeshManager.sectionObjects)) {
      if (!obj) continue
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && (child.name === 'mesh' || child.name === 'shaderMesh')) {
          child.visible = true
        }
      })
    }
  }

  private disposeWireframeGroup(group: THREE.Group): void {
    this.worldRenderer.sceneOrigin.removeAndUntrackAll(group)
    this.worldRenderer.realScene.remove(group)
    group.traverse(child => {
      const line = child as THREE.LineSegments
      line.geometry?.dispose()
      const mat = line.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat?.dispose()
    })
    group.clear()
  }

  private createWireframeGeometry(geometry: MesherGeometryOutput): THREE.BufferGeometry {
    const positions = geometry.positions as Float32Array
    const indices = geometry.indices as Uint32Array | Uint16Array
    const linePositions: number[] = []
    const edgeSet = new Set<string>()
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]!
      const i1 = indices[i + 1]!
      const i2 = indices[i + 2]!
      this.addEdge(positions, i0, i1, linePositions, edgeSet)
      this.addEdge(positions, i1, i2, linePositions, edgeSet)
      this.addEdge(positions, i2, i0, linePositions, edgeSet)
    }
    const wireframeGeom = new THREE.BufferGeometry()
    wireframeGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
    return wireframeGeom
  }

  private addEdge(positions: Float32Array, i0: number, i1: number, linePositions: number[], edgeSet: Set<string>): void {
    const minI = Math.min(i0, i1)
    const maxI = Math.max(i0, i1)
    const edgeKey = `${minI}-${maxI}`
    if (edgeSet.has(edgeKey)) return
    edgeSet.add(edgeKey)
    linePositions.push(positions[i0 * 3]!, positions[i0 * 3 + 1]!, positions[i0 * 3 + 2]!, positions[i1 * 3]!, positions[i1 * 3 + 1]!, positions[i1 * 3 + 2]!)
  }
}

export const sciFiWorldRevealManifest: RendererModuleManifest = {
  id: 'futuristicReveal',
  controller: SciFiWorldRevealModule,
  enabledDefault: true
}
