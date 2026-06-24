import * as THREE from 'three'
import type { SceneOrigin } from './sceneOrigin'

interface ParticleMesh extends THREE.Mesh {
  velocity: THREE.Vector3
  worldPos: THREE.Vector3
}

interface ParticleConfig {
  fountainHeight: number
  resetHeight: number
  xVelocityRange: number
  zVelocityRange: number
  particleCount: number
  particleRadiusRange: { min: number; max: number }
  yVelocityRange: { min: number; max: number }
}

export interface FountainOptions {
  position?: { x: number; y: number; z: number }
  particleConfig?: Partial<ParticleConfig>
}

export class Fountain {
  private readonly particles: ParticleMesh[] = []
  private readonly config: { particleConfig: ParticleConfig }
  private readonly position: THREE.Vector3
  private readonly sceneOrigin: SceneOrigin | undefined
  container: THREE.Object3D | undefined

  constructor(
    public sectionId: string,
    options: FountainOptions = {},
    sceneOrigin?: SceneOrigin
  ) {
    this.position = options.position ? new THREE.Vector3(options.position.x, options.position.y, options.position.z) : new THREE.Vector3(0, 0, 0)
    this.config = this.createConfig(options.particleConfig)
    this.sceneOrigin = sceneOrigin
  }

  private createConfig(particleConfigOverride?: Partial<ParticleConfig>): { particleConfig: ParticleConfig } {
    const particleConfig: ParticleConfig = {
      fountainHeight: 10,
      resetHeight: 0,
      xVelocityRange: 0.4,
      zVelocityRange: 0.4,
      particleCount: 400,
      particleRadiusRange: { min: 0.1, max: 0.6 },
      yVelocityRange: { min: 0.1, max: 2 },
      ...particleConfigOverride
    }

    return { particleConfig }
  }

  private toSceneX(worldX: number): number {
    return this.sceneOrigin ? this.sceneOrigin.toSceneX(worldX) : worldX
  }

  private toSceneY(worldY: number): number {
    return this.sceneOrigin ? this.sceneOrigin.toSceneY(worldY) : worldY
  }

  private toSceneZ(worldZ: number): number {
    return this.sceneOrigin ? this.sceneOrigin.toSceneZ(worldZ) : worldZ
  }

  createParticles(container: THREE.Object3D): void {
    this.container = container
    const colorStart = new THREE.Color(0xff_ff_00)
    const colorEnd = new THREE.Color(0xff_a5_00)

    for (let i = 0; i < this.config.particleConfig.particleCount; i++) {
      const radius =
        Math.random() * (this.config.particleConfig.particleRadiusRange.max - this.config.particleConfig.particleRadiusRange.min) +
        this.config.particleConfig.particleRadiusRange.min
      const geometry = new THREE.SphereGeometry(radius)
      const material = new THREE.MeshBasicMaterial({
        color: colorStart.clone().lerp(colorEnd, Math.random())
      })
      const mesh = new THREE.Mesh(geometry, material)
      const particle = mesh as unknown as ParticleMesh

      const worldX = this.position.x + (Math.random() - 0.5) * this.config.particleConfig.xVelocityRange * 2
      const worldY = this.position.y + this.config.particleConfig.fountainHeight
      const worldZ = this.position.z + (Math.random() - 0.5) * this.config.particleConfig.zVelocityRange * 2

      particle.worldPos = new THREE.Vector3(worldX, worldY, worldZ)
      particle.position.set(this.toSceneX(worldX), this.toSceneY(worldY), this.toSceneZ(worldZ))

      particle.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * this.config.particleConfig.xVelocityRange,
        -Math.random() * this.config.particleConfig.yVelocityRange.max,
        (Math.random() - 0.5) * this.config.particleConfig.zVelocityRange
      )

      this.particles.push(particle)
      this.container.add(particle)

      // this.container.onBeforeRender = () => {
      //   this.render()
      // }
    }
  }

  render(): void {
    for (const particle of this.particles) {
      particle.velocity.y -= 0.01 + Math.random() * 0.1
      particle.worldPos.add(particle.velocity)

      if (particle.worldPos.y < this.position.y + this.config.particleConfig.resetHeight) {
        const worldX = this.position.x + (Math.random() - 0.5) * this.config.particleConfig.xVelocityRange * 2
        const worldY = this.position.y + this.config.particleConfig.fountainHeight
        const worldZ = this.position.z + (Math.random() - 0.5) * this.config.particleConfig.zVelocityRange * 2

        particle.worldPos.set(worldX, worldY, worldZ)
        particle.velocity.set(
          (Math.random() - 0.5) * this.config.particleConfig.xVelocityRange,
          -Math.random() * this.config.particleConfig.yVelocityRange.max,
          (Math.random() - 0.5) * this.config.particleConfig.zVelocityRange
        )
      }

      particle.position.set(this.toSceneX(particle.worldPos.x), this.toSceneY(particle.worldPos.y), this.toSceneZ(particle.worldPos.z))
    }
  }

  private updateParticleCount(newCount: number): void {
    if (newCount !== this.config.particleConfig.particleCount) {
      this.config.particleConfig.particleCount = newCount
      const currentCount = this.particles.length

      if (newCount > currentCount) {
        this.addParticles(newCount - currentCount)
      } else if (newCount < currentCount) {
        this.removeParticles(currentCount - newCount)
      }
    }
  }

  private addParticles(count: number): void {
    const geometry = new THREE.SphereGeometry(0.1)
    const material = new THREE.MeshBasicMaterial({ color: 0x00_ff_00 })

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geometry, material)
      const particle = mesh as unknown as ParticleMesh
      particle.worldPos = this.position.clone()
      particle.position.set(this.toSceneX(this.position.x), this.toSceneY(this.position.y), this.toSceneZ(this.position.z))
      particle.velocity = new THREE.Vector3(
        Math.random() * this.config.particleConfig.xVelocityRange - this.config.particleConfig.xVelocityRange / 2,
        Math.random() * 2,
        Math.random() * this.config.particleConfig.zVelocityRange - this.config.particleConfig.zVelocityRange / 2
      )
      this.particles.push(particle)
      this.container!.add(particle)
    }
  }

  private removeParticles(count: number): void {
    for (let i = 0; i < count; i++) {
      const particle = this.particles.pop()
      if (particle) {
        this.container!.remove(particle)
      }
    }
  }

  public dispose(): void {
    for (const particle of this.particles) {
      particle.geometry.dispose()
      if (Array.isArray(particle.material)) {
        for (const material of particle.material) material.dispose()
      } else {
        particle.material.dispose()
      }
    }
  }
}
