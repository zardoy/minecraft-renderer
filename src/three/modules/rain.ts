import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'

interface RainParticleData {
  velocity: THREE.Vector3
  age: number
  despawnOffset: number
}

const PARTICLE_COUNT = 2000
const RANGE = 32
const HEIGHT = 32
const FALL_SPEED_MIN = 12
const FALL_SPEED_MAX = 24
const HORIZONTAL_DRIFT = 1.2
const RESPAWN_BELOW = -5

const moduleOptions = {
  particleCount: 2000,
  speedFactor: 1,
}

export class RainModule implements RendererModuleController {
  private instancedMesh?: THREE.InstancedMesh
  private geometry?: THREE.BoxGeometry
  private material?: THREE.MeshBasicMaterial
  private particles: RainParticleData[] = []
  private enabled = false
  private readonly dummy = new THREE.Matrix4()
  private readonly tempPosition = new THREE.Vector3()
  private readonly tempQuaternion = new THREE.Quaternion()
  private readonly tempScale = new THREE.Vector3()

  constructor(private readonly worldRenderer: WorldRendererThree) { }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    if (!this.instancedMesh) {
      this.createRain()
    } else {
      this.instancedMesh.visible = true
    }
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.instancedMesh) {
      this.instancedMesh.visible = false
    }
  }

  autoEnableCheck(): boolean {
    return this.worldRenderer.worldRendererConfig.isRaining === true
  }

  render?: (deltaTime: number) => void = (deltaTime) => {
    if (!this.enabled || !this.instancedMesh || !this.material) return

    const cameraPos = this.worldRenderer.getCameraPosition()
    this.instancedMesh.position.set(0, 0, 0)

    const heightmaps = this.worldRenderer.reactiveState.world.heightmaps

    const { dummy, tempPosition: position, tempQuaternion: quaternion, tempScale: scale } = this

    // Cache chunk key lookup to avoid redundant Map.get and string allocation
    let prevChunkX = NaN
    let prevChunkZ = NaN
    let cachedHeightmap: Int16Array | undefined

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const particle = this.particles[i]
      this.instancedMesh.getMatrixAt(i, dummy)
      dummy.decompose(position, quaternion, scale)

      position.addScaledVector(particle.velocity, deltaTime)

      const relativeY = position.y
      const horizontalDist = Math.sqrt(position.x * position.x + position.z * position.z)

      // Convert camera-relative position to world coordinates
      const worldX = cameraPos.x + position.x
      const worldY = cameraPos.y + position.y
      const worldZ = cameraPos.z + position.z

      // Look up heightmap for this world position (cached per chunk)
      const chunkX = Math.floor(worldX / 16)
      const chunkZ = Math.floor(worldZ / 16)
      if (chunkX !== prevChunkX || chunkZ !== prevChunkZ) {
        cachedHeightmap = heightmaps[`${chunkX},${chunkZ}`]
        prevChunkX = chunkX
        prevChunkZ = chunkZ
      }

      const localX = ((Math.floor(worldX) % 16) + 16) % 16
      const localZ = ((Math.floor(worldZ) % 16) + 16) % 16
      const heightY = cachedHeightmap?.[localZ * 16 + localX]

      // Respawn when: out of range, hit heightmap surface (heightY + 1 = block top face), or fell too far
      const shouldRespawn = horizontalDist > RANGE ||
        (heightY !== undefined && heightY !== -32768 && worldY <= heightY + 1 + particle.despawnOffset) ||
        relativeY < RESPAWN_BELOW

      if (shouldRespawn) {
        this.respawnParticle(position)
        const speed = FALL_SPEED_MIN + Math.random() * (FALL_SPEED_MAX - FALL_SPEED_MIN)
        particle.velocity.set(
          (Math.random() - 0.5) * HORIZONTAL_DRIFT,
          -speed,
          (Math.random() - 0.5) * HORIZONTAL_DRIFT,
        )
        particle.despawnOffset = Math.random() * 0.5
      }

      dummy.compose(position, quaternion, scale)
      this.instancedMesh.setMatrixAt(i, dummy)
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    if (this.instancedMesh) {
      this.worldRenderer.scene.remove(this.instancedMesh)
    }
    this.geometry?.dispose()
    this.material?.dispose()
    this.instancedMesh = undefined
    this.geometry = undefined
    this.material = undefined
    this.particles = []
  }

  private createRain(): void {
    this.geometry = new THREE.BoxGeometry(0.03, 0.3, 0.03)
    this.material = new THREE.MeshBasicMaterial({
      color: 0x44_66_99,
      transparent: true,
      opacity: 0.35,
      // Must write depth so log-depth blocks occlude rain correctly (see cubeBlockShader).
      depthWrite: true,
      fog: false,
    })

    this.instancedMesh = new THREE.InstancedMesh(this.geometry, this.material, PARTICLE_COUNT)
    this.instancedMesh.name = 'rain-particles'
    this.instancedMesh.frustumCulled = false

    const dummy = new THREE.Matrix4()
    const position = new THREE.Vector3()

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.respawnParticle(position)
      position.y = Math.random() * HEIGHT
      dummy.setPosition(position)
      this.instancedMesh.setMatrixAt(i, dummy)

      const speed = FALL_SPEED_MIN + Math.random() * (FALL_SPEED_MAX - FALL_SPEED_MIN)
      this.particles.push({
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * HORIZONTAL_DRIFT,
          -speed,
          (Math.random() - 0.5) * HORIZONTAL_DRIFT,
        ),
        age: 0,
        despawnOffset: Math.random() * 0.5,
      })
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true
    this.worldRenderer.scene.add(this.instancedMesh)
  }

  private respawnParticle(position: THREE.Vector3): void {
    const angle = Math.random() * Math.PI * 2
    const distance = Math.random() * RANGE
    position.set(
      Math.cos(angle) * distance,
      HEIGHT,
      Math.sin(angle) * distance,
    )
  }
}

export const rainManifest: RendererModuleManifest = {
  id: 'rain',
  controller: RainModule,
  enabledDefault: false,
  requiresHeightmap: true,
}
