import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'

interface BreakParticle {
  mesh: THREE.Mesh
  active: boolean
  x: number; y: number; z: number
  prevX: number; prevY: number; prevZ: number
  xd: number; yd: number; zd: number
  age: number
  maxAge: number
  onGround: boolean
  floorMap: number[]
  blockX: number
  blockZ: number
}

const MAX_PARTICLES = 512
const TICK_RATE = 1 / 20

export class BlockBreakParticlesModule implements RendererModuleController {
  private particles: BreakParticle[] = []
  private sharedMaterial?: THREE.MeshBasicMaterial
  private enabled = false
  private tickAccumulator = 0
  private nextParticleIndex = 0

  constructor(private readonly worldRenderer: WorldRendererThree) {}

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.ensureMaterial()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
  }

  dispose(): void {
    for (const p of this.particles) {
      if (p.active) {
        this.worldRenderer.sceneOrigin.removeAndUntrack(p.mesh)
      }
      p.mesh.geometry.dispose()
    }
    this.particles = []
    this.sharedMaterial?.dispose()
    this.sharedMaterial = undefined
    this.nextParticleIndex = 0
  }

  render = (deltaTime: number): void => {
    if (!this.enabled) return

    this.tickAccumulator += deltaTime
    while (this.tickAccumulator >= TICK_RATE) {
      this.tickAccumulator -= TICK_RATE
      this.tickPhysics()
    }

    const alpha = this.tickAccumulator / TICK_RATE
    this.updateVisuals(alpha)
  }

  spawnBlockBreakParticles(worldX: number, worldY: number, worldZ: number, blockName: string, floorMap: number[]): void {
    if (!this.enabled) return

    const texInfo = this.resolveBlockTexture(blockName)
    if (!texInfo) return

    for (let ox = 0; ox < 4; ox++) {
      for (let oy = 0; oy < 4; oy++) {
        for (let oz = 0; oz < 4; oz++) {
          const px = worldX + (ox + 0.5) / 4
          const py = worldY + (oy + 0.5) / 4
          const pz = worldZ + (oz + 0.5) / 4

          let motionX = px - worldX - 0.5
          let motionY = py - worldY - 0.5
          let motionZ = pz - worldZ - 0.5

          motionX += (Math.random() * 2 - 1) * 0.4
          motionY += (Math.random() * 2 - 1) * 0.4
          motionZ += (Math.random() * 2 - 1) * 0.4

          const strength = (Math.random() + Math.random() + 1) * 0.15
          const len = Math.sqrt(motionX * motionX + motionY * motionY + motionZ * motionZ)
          const xd = (motionX / len) * strength * 0.4
          const yd = (motionY / len) * strength * 0.4 + 0.1
          const zd = (motionZ / len) * strength * 0.4

          const maxAge = Math.floor(4 / (Math.random() * 0.9 + 0.1))

          this.createParticle(px, py, pz, xd, yd, zd, maxAge, texInfo, floorMap, worldX, worldZ)
        }
      }
    }
  }

  private tickPhysics(): void {
    for (const p of this.particles) {
      if (!p.active) continue

      p.prevX = p.x
      p.prevY = p.y
      p.prevZ = p.z

      p.age++
      if (p.age >= p.maxAge) {
        this.deactivateParticle(p)
        continue
      }

      p.yd -= 0.04
      p.x += p.xd
      p.y += p.yd
      p.z += p.zd

      // Recalculate onGround each tick (particle may move to a different column)
      const floorY = this.getFloorY(p)
      if (p.y <= floorY) {
        p.y = floorY
        p.yd = 0
        p.onGround = true
      } else {
        p.onGround = false
      }

      p.xd *= 0.98
      p.yd *= 0.98
      p.zd *= 0.98

      if (p.onGround) {
        p.xd *= 0.7
        p.zd *= 0.7
      }
    }
  }

  private updateVisuals(alpha: number): void {
    // Camera is at ~(0,0,0) in scene space (sceneOrigin tracks camera)
    const cameraPosScene = this.worldRenderer.camera.position

    for (const p of this.particles) {
      if (!p.active) continue

      const displayX = p.prevX + (p.x - p.prevX) * alpha
      const displayY = p.prevY + (p.y - p.prevY) * alpha
      const displayZ = p.prevZ + (p.z - p.prevZ) * alpha

      p.mesh.position.set(displayX, displayY, displayZ)
      // lookAt operates in parent (scene) coords — use scene-local camera pos
      p.mesh.lookAt(cameraPosScene.x, cameraPosScene.y, cameraPosScene.z)
    }
  }

  private createParticle(
    px: number, py: number, pz: number,
    xd: number, yd: number, zd: number,
    maxAge: number,
    texInfo: { u: number; v: number; su: number; sv: number },
    floorMap: number[],
    blockX: number, blockZ: number
  ): void {
    this.ensureMaterial()

    let particle = this.findInactiveParticle()

    if (!particle) {
      if (this.particles.length < MAX_PARTICLES) {
        particle = this.allocateParticle()
      } else {
        particle = this.recycleOldest()
      }
    }

    const randomU = Math.floor(Math.random() * 4)
    const randomV = Math.floor(Math.random() * 4)
    const particleU = texInfo.u + (randomU / 4) * texInfo.su
    const particleV = texInfo.v + (randomV / 4) * texInfo.sv
    const particleSU = texInfo.su / 4
    const particleSV = texInfo.sv / 4

    this.setGeometryUVs(particle.mesh.geometry as THREE.PlaneGeometry, particleU, particleV, particleSU, particleSV)

    particle.active = true
    particle.x = px; particle.y = py; particle.z = pz
    particle.prevX = px; particle.prevY = py; particle.prevZ = pz
    particle.xd = xd; particle.yd = yd; particle.zd = zd
    particle.age = 0
    particle.maxAge = maxAge
    particle.onGround = false
    particle.floorMap = floorMap
    particle.blockX = Math.floor(blockX)
    particle.blockZ = Math.floor(blockZ)

    const scale = 0.1 * (0.5 + Math.random() * 0.5) * 2
    particle.mesh.scale.set(scale, scale, scale)
    particle.mesh.position.set(px, py, pz)
    particle.mesh.visible = true

    this.worldRenderer.sceneOrigin.addAndTrack(particle.mesh)
  }

  private allocateParticle(): BreakParticle {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const mesh = new THREE.Mesh(geometry, this.sharedMaterial!)
    mesh.visible = false

    const particle: BreakParticle = {
      mesh,
      active: false,
      x: 0, y: 0, z: 0,
      prevX: 0, prevY: 0, prevZ: 0,
      xd: 0, yd: 0, zd: 0,
      age: 0,
      maxAge: 0,
      onGround: false,
      floorMap: [],
      blockX: 0,
      blockZ: 0,
    }

    this.particles.push(particle)
    return particle
  }

  private findInactiveParticle(): BreakParticle | undefined {
    for (let i = 0; i < this.particles.length; i++) {
      const idx = (this.nextParticleIndex + i) % this.particles.length
      if (!this.particles[idx].active) {
        this.nextParticleIndex = (idx + 1) % this.particles.length
        return this.particles[idx]
      }
    }
    return undefined
  }

  private recycleOldest(): BreakParticle {
    let oldest: BreakParticle = this.particles[0]
    for (const p of this.particles) {
      if (p.age > oldest.age) {
        oldest = p
      }
    }
    this.deactivateParticle(oldest)
    return oldest
  }

  private deactivateParticle(p: BreakParticle): void {
    if (!p.active) return
    p.active = false
    p.mesh.visible = false
    this.worldRenderer.sceneOrigin.removeAndUntrack(p.mesh)
  }

  private getFloorY(particle: BreakParticle): number {
    let dx = Math.floor(particle.x) - particle.blockX
    let dz = Math.floor(particle.z) - particle.blockZ
    dx = Math.max(-2, Math.min(2, dx))
    dz = Math.max(-2, Math.min(2, dz))
    return particle.floorMap[(dz + 2) * 5 + (dx + 2)]
  }

  private resolveBlockTexture(blockName: string): { u: number; v: number; su: number; sv: number } | null {
    const resources = this.worldRenderer.resourcesManager.currentResources
    if (!resources) return null

    const atlasJson = resources.blocksAtlasJson
    const textures = atlasJson.textures

    if (textures[blockName]) return this.extractUV(textures[blockName], atlasJson)

    for (const suffix of ['_side', '_top', '_front', '_0', '']) {
      const key = blockName + suffix
      if (textures[key]) return this.extractUV(textures[key], atlasJson)
    }

    for (const key of Object.keys(textures)) {
      if (key.startsWith(blockName)) return this.extractUV(textures[key], atlasJson)
    }

    return null
  }

  private extractUV(
    texInfo: { u: number; v: number; su?: number; sv?: number },
    atlasJson: { suSv: number }
  ): { u: number; v: number; su: number; sv: number } {
    return {
      u: texInfo.u,
      v: texInfo.v,
      su: texInfo.su ?? atlasJson.suSv,
      sv: texInfo.sv ?? atlasJson.suSv,
    }
  }

  private setGeometryUVs(geometry: THREE.PlaneGeometry, u: number, v: number, su: number, sv: number): void {
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute
    // PlaneGeometry UV layout: (0,1) (1,1) (0,0) (1,0)
    uvAttr.setXY(0, u, v)
    uvAttr.setXY(1, u + su, v)
    uvAttr.setXY(2, u, v + sv)
    uvAttr.setXY(3, u + su, v + sv)
    uvAttr.needsUpdate = true
  }

  private ensureMaterial(): void {
    if (this.sharedMaterial) return
    const atlasTexture = this.worldRenderer.material.map
    if (!atlasTexture) return
    this.sharedMaterial = new THREE.MeshBasicMaterial({
      map: atlasTexture,
      color: 0x999999,
      transparent: true,
      alphaTest: 0.1,
    })
  }
}

export const blockBreakParticlesManifest: RendererModuleManifest = {
  id: 'blockBreakParticles',
  controller: BlockBreakParticlesModule,
  enabledDefault: true,
  cannotBeDisabled: true,
  requiresHeightmap: false,
}
