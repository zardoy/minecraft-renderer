import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import type { MesherGeometryOutput } from '../../mesher/shared'

const SCI_FI_CYAN = new THREE.Color(13 / 255, 234 / 255, 238 / 255)
const CHUNKS_THRESHOLD = 9
const REVEAL_DURATION = 3500 // ms for full reveal transition
const WIREFRAME_FADE_DELAY = 1200 // ms before wireframe starts fading

const INITIAL_WIREFRAME_MS = 350
const INITIAL_REVEAL_MS = 650
const INITIAL_WAVE_SPREAD_MS = 650

const CHUNK_WIREFRAME_MS = 120
const CHUNK_REVEAL_MS = 280

interface RevealingSection {
  key: string
  wireframeGroup: THREE.Group
  revealStartTime: number
  phase: 'wireframe' | 'transitioning' | 'complete'
  originalMeshRef: THREE.Mesh | null
  wireframeMs: number
  revealMs: number
}


/**
 * SciFiWorldReveal - Creates a futuristic wireframe-to-solid reveal effect
 *
 * When chunks load, they first appear as glowing cyan wireframes that pulse
 * and emanate from the camera, then gradually transition to solid geometry.
 */
export class SciFiWorldRevealModule implements RendererModuleController {
  private readonly pendingGeometries = new Map<string, MesherGeometryOutput>()
  private readonly revealingSections = new Map<string, RevealingSection>()
  private finishedChunkCount = 0
  private revealTriggered = false
  private revealStartTime = 0
  private enabled = false

  private onWorldSwitchedCb: (() => void) | null = null
  private patched = false
  private initialWaveDone = false

  // Wireframe materials
  private readonly wireframeMaterial!: THREE.LineBasicMaterial
  private readonly wireframeGlowMaterial!: THREE.LineBasicMaterial

  // For pulsing animation
  private pulseTime = 0

  // Track which chunks have been revealed
  private readonly revealedChunks = new Set<string>()

  // Store original methods for patching
  private originalFinishChunk: ((chunkKey: string) => void) | null = null
  private originalDestroy: (() => void) | null = null
  private originalSceneAdd: ((...object: THREE.Object3D[]) => THREE.Scene) | null = null
  private originalHandleWorkerMessage: ((data: { geometry: MesherGeometryOutput; key: string; type: string }) => void) | null = null

  private originalWbgHandle: ((data: any) => void) | null = null

  private configEnabled = true

  constructor(private readonly worldRenderer: WorldRendererThree) {
    this.configEnabled = this.worldRenderer.worldRendererConfig.futuristicReveal === true

    this.wireframeMaterial = new THREE.LineBasicMaterial({
      color: SCI_FI_CYAN,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    this.wireframeGlowMaterial = new THREE.LineBasicMaterial({
      color: SCI_FI_CYAN,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  }

  enable(): void {
    if (!this.configEnabled) return
    if (this.enabled) return
    this.enabled = true
    this.patchWorldRenderer()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.unpatchWorldRenderer()
    this.reset()
  }

  render?: () => void = () => {
    if (!this.enabled) return
    this.update(16)
  }

  dispose(): void {
    this.disable()
    this.wireframeMaterial.dispose()
    this.wireframeGlowMaterial.dispose()
  }

  /**
   * Patch world renderer methods to integrate the reveal effect
   */
  private patchWorldRenderer(): void {
    if (this.patched) return
    this.patched = true
    const wr = this.worldRenderer

    // Hook into onWorldSwitched
    this.onWorldSwitchedCb = () => this.reset()
    wr.onWorldSwitched.push(this.onWorldSwitchedCb)


    // Patch finishChunk
    this.originalFinishChunk = wr.finishChunk.bind(wr)
    wr.finishChunk = (chunkKey: string) => {
      this.originalFinishChunk!(chunkKey)
      this.onChunkFinished(chunkKey)
    }

    // Patch destroy
    this.originalDestroy = wr.destroy.bind(wr)
    wr.destroy = () => {
      this.dispose()
      this.originalDestroy!()
    }

    // Patch handleWorkerMessage
    const wbg = wr.worldBlockGeometry
    this.originalWbgHandle = wbg.handleWorkerGeometryMessage.bind(wbg)

    wbg.handleWorkerGeometryMessage = (data: any) => {
      const result = this.originalWbgHandle!(data)

      if (this.enabled && data?.type === 'geometry') {
        Promise.resolve().then(() => {
          try {
            this.registerSection(data.key, data.geometry)
          } catch (err) {
            console.error('[SciFiReveal] registerSection failed', err)
          }
        })
      }

      return result
    }


    // Patch scene.add to intercept mesh additions
    this.originalSceneAdd = wr.scene.add.bind(wr.scene)
    wr.scene.add = (...objects: THREE.Object3D[]): THREE.Scene => {
      // Call original add first
      const result = this.originalSceneAdd!(...objects)

      // Check each added object for meshes that need reveal effect
      for (const obj of objects) {
        this.checkAndPatchMesh(obj)
      }

      return result
    }
  }

  /**
   * Unpatch world renderer methods
   */
  private unpatchWorldRenderer(): void {
    const wr = this.worldRenderer

    if (this.originalFinishChunk) {
      wr.finishChunk = this.originalFinishChunk
      this.originalFinishChunk = null
    }

    if (this.originalDestroy) {
      wr.destroy = this.originalDestroy
      this.originalDestroy = null
    }

    if (this.originalHandleWorkerMessage) {
      wr.handleWorkerMessage = this.originalHandleWorkerMessage
      this.originalHandleWorkerMessage = null
    }

    if (this.originalSceneAdd) {
      wr.scene.add = this.originalSceneAdd
      this.originalSceneAdd = null
    }

    if (this.originalWbgHandle) {
      wr.worldBlockGeometry.handleWorkerGeometryMessage = this.originalWbgHandle as any
      this.originalWbgHandle = null
    }

    if (this.onWorldSwitchedCb) {
      const i = wr.onWorldSwitched.indexOf(this.onWorldSwitchedCb)
      if (i !== -1) wr.onWorldSwitched.splice(i, 1)
      this.onWorldSwitchedCb = null
    }
    this.patched = false
  }

  /**
   * Check if an object or its children is a mesh that needs reveal effect visibility patch
   */
  private checkAndPatchMesh(obj: THREE.Object3D): void {
    // Check if this is a mesh with name === 'mesh'
    if (obj instanceof THREE.Mesh && obj.name === 'mesh') {
      const sectionKey = this.findSectionKeyForMesh(obj)
      if (sectionKey && this.shouldUseRevealEffect(sectionKey)) {
        obj.visible = false
          ; (obj as any).hiddenByReveal = true
      }
    }

    // Recursively check children
    for (const child of obj.children) {
      this.checkAndPatchMesh(child)
    }
  }

  /**
   * Find the section key for a mesh by traversing up to find the parent group
   * and checking for sectionKey property
   */
  private findSectionKeyForMesh(mesh: THREE.Mesh): string | null {
    // Traverse up to find the parent group with sectionKey
    let current: THREE.Object3D | null = mesh
    while (current) {
      const { sectionKey } = (current as any)
      if (sectionKey && this.worldRenderer.worldBlockGeometry.sectionObjects[sectionKey] === current) {
        return sectionKey
      }
      current = current.parent
    }

    // Fallback: try to derive key from mesh position
    // Section keys are in format "x,y,z" where x, y, z are section coordinates
    // Mesh position is at geometry.sx, geometry.sy, geometry.sz
    const pos = mesh.position
    const CHUNK_SIZE = 16
    const sectionHeight = this.worldRenderer.getSectionHeight()
    const sectionX = Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE
    const sectionY = Math.floor(pos.y / sectionHeight) * sectionHeight
    const sectionZ = Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE
    const derivedKey = `${sectionX},${sectionY},${sectionZ}`

    // Verify this key exists in sectionObjects
    if (this.worldRenderer.worldBlockGeometry.sectionObjects[derivedKey]) {
      return derivedKey
    }

    return null
  }

  /**
   * Get the scene from world renderer
   */
  private get scene(): THREE.Scene {
    return this.worldRenderer.scene
  }

  /**
   * Get camera position from world renderer
   */
  private getCameraPosition(): THREE.Vector3 {
    return this.worldRenderer.getCameraPosition()
  }

  /**
   * Get original mesh for a section key
   */
  private getOriginalMesh(key: string): THREE.Mesh | null {
    const sectionObject = this.worldRenderer.worldBlockGeometry.sectionObjects[key]
    if (!sectionObject) return null
    return sectionObject.children.find(child => child.name === 'mesh') as THREE.Mesh | null
  }

  /**
   * Call this when a chunk finishes loading
   */
  onChunkFinished(_chunkKey: string): void {
    this.finishedChunkCount++

    if (!this.revealTriggered && this.finishedChunkCount >= CHUNKS_THRESHOLD) {
      this.triggerReveal()
    }
  }

  /**
   * Register a new section geometry for the reveal effect
   */
  registerSection(key: string, geometry: MesherGeometryOutput): void {
    // If already revealed or currently revealing, skip
    if (this.revealedChunks.has(key) || this.revealingSections.has(key)) return

    // If reveal already triggered, start effect immediately (don't store in pending)
    if (this.revealTriggered) {
      this.startSectionReveal(key, geometry)
    } else {
      // Store geometry for later
      this.pendingGeometries.set(key, geometry)
    }
  }

  /**
   * Check if a section should use the reveal effect
   */
  shouldUseRevealEffect(key: string): boolean {
    return this.enabled && !this.revealedChunks.has(key) && !this.revealingSections.has(key)
  }

  /**
   * Trigger the reveal sequence
   */
  private triggerReveal(): void {
    this.revealTriggered = true
    this.initialWaveDone = true

    this.revealStartTime = performance.now()

    const cameraPos = this.getCameraPosition()

    // Copy and clear pending geometries before processing
    const toProcess = [...this.pendingGeometries.entries()]
    this.pendingGeometries.clear()

    // Sort by distance from camera for wave effect
    const sorted = toProcess
      .map(([key, geometry]) => {
        const distance = Math.hypot(
          (geometry.sx - cameraPos.x),
          (geometry.sy - cameraPos.y),
          (geometry.sz - cameraPos.z)
        )
        return { key, geometry, distance }
      })
      .sort((a, b) => a.distance - b.distance)

    const maxDistance = sorted.at(-1)?.distance || 1

    // Start reveal for each section with staggered timing
    for (const { key, geometry, distance } of sorted) {
      const delay = (distance / maxDistance) * 1500 // 1500ms spread for wave effect
      setTimeout(() => {
        // Double check the section hasn't been revealed already
        if (!this.revealedChunks.has(key) && !this.revealingSections.has(key)) {
          this.startSectionReveal(key, geometry)
        }
      }, delay)
    }
  }

  /**
   * Start the reveal effect for a single section
   */
  private startSectionReveal(key: string, geometry: MesherGeometryOutput): void {
    if (!geometry.positions?.length) return

    // Don't create if already exists
    if (this.revealingSections.has(key) || this.revealedChunks.has(key)) return

    // Create wireframe geometry
    const wireframeGeom = this.createWireframeGeometry(geometry)

    const original = this.getOriginalMesh(key)
    if (original) {
      original.visible = false
        ; (original as any).hiddenByReveal = true
    }
    // Main wireframe
    const wireframe = new THREE.LineSegments(wireframeGeom, this.wireframeMaterial.clone())
    wireframe.position.set(geometry.sx, geometry.sy, geometry.sz)
    wireframe.name = 'scifi-wireframe'
    wireframe.renderOrder = 1000

    // Glow layer
    const glowWireframe = new THREE.LineSegments(wireframeGeom.clone(), this.wireframeGlowMaterial.clone())
    glowWireframe.position.copy(wireframe.position)
    glowWireframe.scale.set(1.02, 1.02, 1.02)
    glowWireframe.name = 'scifi-glow'
    glowWireframe.renderOrder = 999

    const group = new THREE.Group()
    group.add(wireframe)
    group.add(glowWireframe)
    group.name = 'scifi-reveal-group'
      // Store key on group for debugging
      ; (group as any).sectionKey = key

    this.scene.add(group)

    const wireframeMs = this.initialWaveDone ? CHUNK_WIREFRAME_MS : INITIAL_WIREFRAME_MS
    const revealMs = this.initialWaveDone ? CHUNK_REVEAL_MS : INITIAL_REVEAL_MS

    const section: RevealingSection = {
      key,
      wireframeGroup: group,
      revealStartTime: performance.now(),
      phase: 'wireframe',
      originalMeshRef: null,
      wireframeMs,
      revealMs,
    }

    setTimeout(() => {
      const m = this.getOriginalMesh(key)
      if (m && !(m as any).hiddenByReveal) {
        m.visible = false
          ; (m as any).hiddenByReveal = true
      }
    }, 0)

    this.revealingSections.set(key, section)
  }

  /**
   * Create wireframe geometry from mesh geometry
   */
  private createWireframeGeometry(geometry: MesherGeometryOutput): THREE.BufferGeometry {
    const positions = geometry.positions as Float32Array
    const indices = geometry.indices as Uint32Array | Uint16Array

    const linePositions: number[] = []
    const edgeSet = new Set<string>()

    // Create edges from triangles
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

  /**
   * Add edge to line positions if not duplicate
   */
  private addEdge(
    positions: Float32Array,
    i0: number,
    i1: number,
    linePositions: number[],
    edgeSet: Set<string>
  ): void {
    const minI = Math.min(i0, i1)
    const maxI = Math.max(i0, i1)
    const key = `${minI}-${maxI}`

    if (edgeSet.has(key)) return
    edgeSet.add(key)

    linePositions.push(
      positions[i0 * 3]!, positions[i0 * 3 + 1]!, positions[i0 * 3 + 2]!,
      positions[i1 * 3]!, positions[i1 * 3 + 1]!, positions[i1 * 3 + 2]!
    )
  }

  /**
   * Update the reveal animation - call this every frame
   */
  update(deltaTime: number): void {
    if (!this.enabled || this.revealingSections.size === 0) return

    this.pulseTime += deltaTime * 0.001 // Convert to seconds
    const currentTime = performance.now()

    // Pulse effect parameters
    const basePulse = 0.6 + 0.4 * Math.sin(this.pulseTime * 4)

    const toComplete: RevealingSection[] = []

    for (const [key, section] of this.revealingSections) {
      const elapsed = currentTime - section.revealStartTime

      if (section.phase === 'wireframe') {
        // Animate wireframe
        const wireframe = section.wireframeGroup.children[0] as THREE.LineSegments
        const glow = section.wireframeGroup.children[1] as THREE.LineSegments

        if (wireframe?.material) {
          const mat = wireframe.material as THREE.LineBasicMaterial
          mat.opacity = basePulse

          // Color pulse with slight variation
          const colorIntensity = 0.85 + 0.15 * Math.sin(this.pulseTime * 6 + elapsed * 0.002)
          mat.color.setRGB(
            (13 / 255) * colorIntensity,
            (234 / 255) * colorIntensity,
            (238 / 255) * colorIntensity
          )
        }

        if (glow?.material) {
          const glowMat = glow.material as THREE.LineBasicMaterial
          glowMat.opacity = basePulse * 0.4
        }

        // Transition to fading phase
        if (elapsed > section.wireframeMs) {
          section.phase = 'transitioning'

          // Get and show the original mesh with fade-in
          section.originalMeshRef = this.getOriginalMesh(key)
          if (section.originalMeshRef) {
            section.originalMeshRef.visible = true
            // Store original material and create fade version
            const originalMat = section.originalMeshRef.material as THREE.MeshLambertMaterial
            const fadeMat = originalMat.clone()
            fadeMat.transparent = true
            fadeMat.opacity = 0
            fadeMat.needsUpdate = true
              ; (section.originalMeshRef as any).originalMaterial = originalMat
            section.originalMeshRef.material = fadeMat
          }
        }
      } else if (section.phase === 'transitioning') {
        const transitionElapsed = elapsed - section.wireframeMs
        const progress = Math.min(1, transitionElapsed / section.revealMs)

        // Smooth ease-out curve
        const eased = 1 - (1 - progress) ** 3

        // Fade out wireframe
        const wireframe = section.wireframeGroup.children[0] as THREE.LineSegments
        const glow = section.wireframeGroup.children[1] as THREE.LineSegments

        if (wireframe?.material) {
          const mat = wireframe.material as THREE.LineBasicMaterial
          mat.opacity = (1 - eased)
        }

        if (glow?.material) {
          const glowMat = glow.material as THREE.LineBasicMaterial
          glowMat.opacity = (1 - eased) * 0.55
        }

        // Fade in original mesh
        if (section.originalMeshRef?.material) {
          const fadeMat = section.originalMeshRef.material as THREE.MeshLambertMaterial
          fadeMat.opacity = eased
        }

        // Complete transition
        if (progress >= 1) {
          section.phase = 'complete'
          toComplete.push(section)
        }
      }
    }

    // Complete all finished sections after iteration
    for (const section of toComplete) {
      this.completeReveal(section)
    }
  }

  /**
   * Complete the reveal and clean up
   */
  private completeReveal(section: RevealingSection): void {
    // Remove from map first to prevent re-processing
    this.revealingSections.delete(section.key)
    this.revealedChunks.add(section.key)

    // Restore original material first
    if (section.originalMeshRef) {
      const originalMat = (section.originalMeshRef as any).originalMaterial
      if (originalMat) {
        const currentMat = section.originalMeshRef.material as THREE.Material
        section.originalMeshRef.material = originalMat
        currentMat.dispose()
        delete (section.originalMeshRef as any).originalMaterial
      }
      section.originalMeshRef.visible = true
      delete (section.originalMeshRef as any).hiddenByReveal
    }

    // Clean up wireframe group
    this.disposeWireframeGroup(section.wireframeGroup)
  }

  /**
   * Dispose a wireframe group and remove from scene
   */
  private disposeWireframeGroup(group: THREE.Group): void {
    // Remove from scene first
    this.scene.remove(group)

    // Collect all objects to dispose
    const toDispose: THREE.Object3D[] = []
    group.traverse((child) => {
      toDispose.push(child)
    })

    // Dispose all collected objects
    for (const child of toDispose) {
      const lineSegments = child as THREE.LineSegments
      if (lineSegments.geometry) {
        lineSegments.geometry.dispose()
      }
      if (lineSegments.material) {
        const mat = lineSegments.material
        if (Array.isArray(mat)) {
          for (const m of mat) m.dispose()
        } else if (mat && typeof mat.dispose === 'function') {
          mat.dispose()
        }
      }
    }

    // Clear children
    group.clear()
  }

  /**
   * Reset the reveal system
   */
  reset(): void {
    // Clean up all revealing sections
    for (const section of this.revealingSections.values()) {
      this.disposeWireframeGroup(section.wireframeGroup)
    }

    this.pendingGeometries.clear()
    this.revealingSections.clear()
    this.revealedChunks.clear()
    this.finishedChunkCount = 0
    this.revealTriggered = false
    this.revealStartTime = 0
    this.pulseTime = 0
  }

  /**
   * Force complete all reveals (skip animation)
   */
  forceCompleteAll(): void {
    const sections = [...this.revealingSections.values()]
    for (const section of sections) {
      // Show original mesh immediately
      if (!section.originalMeshRef) {
        section.originalMeshRef = this.getOriginalMesh(section.key)
      }
      if (section.originalMeshRef) {
        const originalMat = (section.originalMeshRef as any).originalMaterial
        if (originalMat) {
          section.originalMeshRef.material = originalMat
        }
        section.originalMeshRef.visible = true
      }
      this.completeReveal(section)
    }
  }

  // ============ DEBUG METHODS ============

  /**
   * Debug: Get all wireframe groups still in scene
   */
  debugGetWireframeGroups(): THREE.Group[] {
    const groups: THREE.Group[] = []
    this.scene.traverse((child) => {
      if (child.name === 'scifi-reveal-group') {
        groups.push(child as THREE.Group)
      }
    })
    return groups
  }

  /**
   * Debug: Force remove all wireframe groups from scene
   */
  debugForceCleanup(): void {
    const groups = this.debugGetWireframeGroups()
    console.log(`[SciFiReveal] Found ${groups.length} wireframe groups in scene`)

    for (const group of groups) {
      console.log(`[SciFiReveal] Removing group:`, group)
      this.disposeWireframeGroup(group)
    }

    // Also clean up any tracked sections
    for (const section of this.revealingSections.values()) {
      this.disposeWireframeGroup(section.wireframeGroup)
    }
    this.revealingSections.clear()

    console.log(`[SciFiReveal] Cleanup complete. Remaining groups: ${this.debugGetWireframeGroups().length}`)
  }

  /**
   * Debug: Get status of the reveal system
   */
  debugStatus() {
    const wireframeGroups = this.debugGetWireframeGroups()
    const trackedKeys = new Set(this.revealingSections.keys())
    const orphanedGroups = wireframeGroups.filter(g => !trackedKeys.has((g as any).sectionKey))

    return {
      revealTriggered: this.revealTriggered,
      finishedChunkCount: this.finishedChunkCount,
      pendingGeometries: this.pendingGeometries.size,
      revealingSections: this.revealingSections.size,
      revealedChunks: this.revealedChunks.size,
      wireframeGroupsInScene: wireframeGroups.length,
      orphanedWireframeGroups: orphanedGroups.length,
      orphanedKeys: orphanedGroups.map(g => (g as any).sectionKey),
      sections: [...this.revealingSections.entries()].map(([key, s]) => ({
        key,
        phase: s.phase,
        hasOriginalMesh: !!s.originalMeshRef,
        wireframeInScene: s.wireframeGroup.parent !== null
      }))
    }
  }

  /**
   * Debug: Log current status to console
   */
  debugLog(): void {
    console.log('[SciFiReveal] Status:', this.debugStatus())
  }
}

export const sciFiWorldRevealManifest: RendererModuleManifest = {
  id: 'futuristicReveal',
  controller: SciFiWorldRevealModule,
  enabledDefault: true,
}
