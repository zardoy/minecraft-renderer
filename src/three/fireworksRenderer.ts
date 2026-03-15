import * as THREE from 'three'
import { Vec3 } from 'vec3'
import type { WorldRendererThree } from './worldRendererThree'

interface FireworkExplosion {
  id: string
  position: Vec3
  particles: FireworkParticle[]
  startTime: number
  duration: number
  size: number
  debugSphere?: THREE.Mesh
}

interface FireworkParticle {
  position: Vec3
  velocity: Vec3
  color: THREE.Color
  life: number
  maxLife: number
  mesh: THREE.Mesh
}

export class FireworksRenderer {
  // Class constants
  static readonly DEFAULT_PARTICLE_COUNT = 50
  static readonly DEFAULT_PARTICLE_SIZE = 0.05 // Much smaller for realistic firework particles
  static readonly DEFAULT_EXPLOSION_DURATION = 6000 // ms - increased duration
  static readonly GRAVITY = -0.005 // Realistic gravity in units/second²
  static readonly VELOCITY_FACTOR = 1.5 // Increased for proper explosion spread
  static readonly TEST_INTERVAL = 1000 // 1 second

  // Debug flags
  static readonly DEBUG_SHOW_EXPLOSION_CENTER = true
  static readonly DEBUG_SHOW_PARTICLE_TRAILS = false

  private readonly explosions = new Map<string, FireworkExplosion>()
  private readonly particleGeometry: THREE.BoxGeometry
  private readonly particleMaterials: THREE.MeshBasicMaterial[] = []
  private testModeTimer?: NodeJS.Timeout
  private explosionCounter = 0

  constructor(private readonly worldRenderer: WorldRendererThree) {
    // Create reusable box geometry for pixelated particles
    this.particleGeometry = new THREE.BoxGeometry(
      FireworksRenderer.DEFAULT_PARTICLE_SIZE,
      FireworksRenderer.DEFAULT_PARTICLE_SIZE,
      FireworksRenderer.DEFAULT_PARTICLE_SIZE
    )

    // Pre-create materials with different colors for performance
    this.createParticleMaterials()

    // Start test mode
    // this.startTestMode() // Disabled for debugging
  }

  private createParticleMaterials() {
    const colors = [
      0xff_00_00, // Red
      0x00_ff_00, // Green
      0x00_00_ff, // Blue
      0xff_ff_00, // Yellow
      0xff_00_ff, // Magenta
      0x00_ff_ff, // Cyan
      0xff_a5_00, // Orange
      0x80_00_80, // Purple
      0xff_c0_cb, // Pink
      0xff_ff_ff, // White
    ]

    for (const color of colors) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1
      })
      this.particleMaterials.push(material)
    }
  }

  private getRandomMaterial(): THREE.MeshBasicMaterial {
    return this.particleMaterials[Math.floor(Math.random() * this.particleMaterials.length)]
  }

  private createExplosion(position: Vec3, size = 1, color?: number, duration = FireworksRenderer.DEFAULT_EXPLOSION_DURATION): FireworkExplosion {
    const explosionId = `firework_${this.explosionCounter++}_${Date.now()}`
    const particles: FireworkParticle[] = []
    const particleCount = Math.floor(FireworksRenderer.DEFAULT_PARTICLE_COUNT * size)

    // Create debug sphere if enabled
    let debugSphere: THREE.Mesh | undefined
    if (FireworksRenderer.DEBUG_SHOW_EXPLOSION_CENTER) {
      const sphereRadius = 0.5 * size
      const sphereGeometry = new THREE.SphereGeometry(sphereRadius, 8, 8)
      const sphereMaterial = new THREE.MeshBasicMaterial({
        color: 0xff_00_00,
        wireframe: true,
        transparent: true,
        opacity: 0.8
      })
      debugSphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
      debugSphere.renderOrder = 999 // Render before particles
      this.worldRenderer.sceneOrigin.addAndTrack(debugSphere)
      debugSphere.position.set(position.x, position.y, position.z)
      console.log(`Debug: Created explosion center sphere at (${position.x}, ${position.y}, ${position.z}) with radius ${sphereRadius}`)
    }

    for (let i = 0; i < particleCount; i++) {
      // Create planar firework explosion (disk pattern)
      const angle = Math.random() * Math.PI * 2 // Random angle in the plane
      const distance = Math.sqrt(Math.random()) * FireworksRenderer.VELOCITY_FACTOR * size // Square root for uniform distribution

      // Create a plane that faces the camera (or can be rotated)
      // For now, let's make it explode in the XZ plane (horizontal disk)
      const velocity = new Vec3(
        distance * Math.cos(angle),
        Math.random() * 0.5 - 0.25, // Small random Y variation for depth
        distance * Math.sin(angle)
      )

      // DEBUG: Log first few particles to understand positioning
      if (i < 5) {
        console.log(`Debug: Particle ${i} - Initial pos: (${position.x}, ${position.y}, ${position.z}), Velocity: (${velocity.x.toFixed(3)}, ${velocity.y.toFixed(3)}, ${velocity.z.toFixed(3)}), Distance: ${distance.toFixed(3)}`)
        console.log(`Debug: Particle ${i} - Velocity magnitude: ${velocity.toString()}, Expected max: ${(FireworksRenderer.VELOCITY_FACTOR * size).toFixed(3)}`)
      }

      // Create particle mesh
      const material = color === undefined
        ? this.getRandomMaterial().clone()
        : new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })

      const mesh = new THREE.Mesh(this.particleGeometry, material)

      // Make particles more visible
      mesh.renderOrder = 1000 // Render on top

      // Add to scene (must be before position.set so proxy captures coordinates)
      this.worldRenderer.sceneOrigin.addAndTrack(mesh)
      mesh.position.set(position.x, position.y, position.z)

      // DEBUG: Add particle size info to console
      if (i < 5) {
        console.log(`Debug: Particle ${i} mesh created at (${mesh.position.x}, ${mesh.position.y}, ${mesh.position.z}) with size ${FireworksRenderer.DEFAULT_PARTICLE_SIZE}`)
      }

      const particle: FireworkParticle = {
        position: position.clone(),
        velocity,
        color: new THREE.Color(material.color),
        life: 1,
        maxLife: 1,
        mesh
      }

      particles.push(particle)
    }

    const explosion: FireworkExplosion = {
      id: explosionId,
      position: position.clone(),
      particles,
      startTime: Date.now(),
      duration,
      size,
      debugSphere
    }

    this.explosions.set(explosionId, explosion)
    console.log(`Debug: Created firework explosion ${explosionId} at (${position.x}, ${position.y}, ${position.z}) with ${particleCount} particles, duration ${duration}ms`)
    console.log(`Debug: Expected behavior - All particles should start at explosion center and move outward with velocities up to ${(FireworksRenderer.VELOCITY_FACTOR * size).toFixed(3)} units/second`)
    console.log(`Debug: Debug sphere radius: ${(0.5 * size).toFixed(3)}, Particle size: ${FireworksRenderer.DEFAULT_PARTICLE_SIZE}`)
    return explosion
  }

  private createExplosionFacingCamera(position: Vec3, size = 1, color?: number, duration = FireworksRenderer.DEFAULT_EXPLOSION_DURATION): FireworkExplosion {
    const explosionId = `firework_${this.explosionCounter++}_${Date.now()}`
    const particles: FireworkParticle[] = []
    const particleCount = Math.floor(FireworksRenderer.DEFAULT_PARTICLE_COUNT * size)

    // Create debug sphere if enabled
    let debugSphere: THREE.Mesh | undefined
    if (FireworksRenderer.DEBUG_SHOW_EXPLOSION_CENTER) {
      const sphereRadius = 0.5 * size
      const sphereGeometry = new THREE.SphereGeometry(sphereRadius, 8, 8)
      const sphereMaterial = new THREE.MeshBasicMaterial({
        color: 0xff_00_00,
        wireframe: true,
        transparent: true,
        opacity: 0.8
      })
      debugSphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
      debugSphere.renderOrder = 999 // Render before particles
      this.worldRenderer.sceneOrigin.addAndTrack(debugSphere)
      debugSphere.position.set(position.x, position.y, position.z)
      console.log(`Debug: Created camera-facing explosion center sphere at (${position.x}, ${position.y}, ${position.z}) with radius ${sphereRadius}`)
    }

    // Get camera direction to face the explosion plane towards camera
    const cameraPos = this.worldRenderer.getCameraPosition()
    const directionToCamera = new Vec3(
      cameraPos.x - position.x,
      cameraPos.y - position.y,
      cameraPos.z - position.z
    ).normalize()

    // Create a plane perpendicular to the camera direction
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * FireworksRenderer.VELOCITY_FACTOR * size

      // Create velocity in the plane perpendicular to camera direction
      const velocity = new Vec3(
        distance * Math.cos(angle),
        distance * Math.sin(angle),
        0
      )

      // Rotate the velocity to face the camera
      // This is a simplified rotation - in a full implementation you'd use quaternions
      const rotatedVelocity = new Vec3(
        velocity.x * directionToCamera.x - velocity.z * directionToCamera.z,
        velocity.y,
        velocity.x * directionToCamera.z + velocity.z * directionToCamera.x
      )

      // DEBUG: Log first few particles
      if (i < 5) {
        console.log(`Debug: Camera-facing Particle ${i} - Velocity: (${rotatedVelocity.x.toFixed(3)}, ${rotatedVelocity.y.toFixed(3)}, ${rotatedVelocity.z.toFixed(3)}), Distance: ${distance.toFixed(3)}`)
      }

      // Create particle mesh
      const material = color === undefined
        ? this.getRandomMaterial().clone()
        : new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })

      const mesh = new THREE.Mesh(this.particleGeometry, material)

      // Make particles more visible
      mesh.renderOrder = 1000 // Render on top

      // Add to scene (must be before position.set so proxy captures coordinates)
      this.worldRenderer.sceneOrigin.addAndTrack(mesh)
      mesh.position.set(position.x, position.y, position.z)

      const particle: FireworkParticle = {
        position: position.clone(),
        velocity: rotatedVelocity,
        color: new THREE.Color(material.color),
        life: 1,
        maxLife: 1,
        mesh
      }

      particles.push(particle)
    }

    const explosion: FireworkExplosion = {
      id: explosionId,
      position: position.clone(),
      particles,
      startTime: Date.now(),
      duration,
      size,
      debugSphere
    }

    this.explosions.set(explosionId, explosion)
    console.log(`Debug: Created camera-facing firework explosion ${explosionId} at (${position.x}, ${position.y}, ${position.z}) with ${particleCount} particles, duration ${duration}ms`)
    return explosion
  }

  /**
   * Create a firework explosion at the specified position
   * @param position World position for the explosion
   * @param size Size multiplier for the explosion (default: 1.0)
   * @param color Optional specific color for all particles (default: random colors)
   * @param duration Duration of the explosion in milliseconds (default: DEFAULT_EXPLOSION_DURATION)
   */
  explode(position: Vec3, size = 1, color?: number, duration?: number): string {
    const explosion = this.createExplosion(position, size, color, duration)
    return explosion.id
  }

  /**
   * Create a firework explosion that faces the camera direction
   * @param position World position for the explosion
   * @param size Size multiplier for the explosion (default: 1.0)
   * @param color Optional specific color for all particles (default: random colors)
   * @param duration Duration of the explosion in milliseconds (default: DEFAULT_EXPLOSION_DURATION)
   */
  explodeFacingCamera(position: Vec3, size = 1, color?: number, duration?: number): string {
    const explosion = this.createExplosionFacingCamera(position, size, color, duration)
    return explosion.id
  }

  private startTestMode() {
    const cameraPos = this.worldRenderer.getCameraPosition()
    const fireworkPos = new Vec3(cameraPos.x, cameraPos.y + 10, cameraPos.z)
    this.testModeTimer = setInterval(() => {
      // Random size and color for variety
      const size = 0.8 + Math.random() * 0.4 // 0.8 - 1.2
      const colors = [0xff_00_00, 0x00_ff_00, 0x00_00_ff, 0xff_ff_00, 0xff_00_ff, 0x00_ff_ff, 0xff_a5_00]
      const randomColor = colors[Math.floor(Math.random() * colors.length)]

      console.log('fireworkPos', fireworkPos)
      this.explodeFacingCamera(fireworkPos, size, randomColor)
    }, FireworksRenderer.TEST_INTERVAL)
  }

  private updateParticle(particle: FireworkParticle, deltaTime: number, explosionDuration: number) {
    // DEBUG: Log first few updates to see what's happening
    const isFirstParticle = particle.mesh.position.x === particle.position.x &&
      particle.mesh.position.y === particle.position.y &&
      particle.mesh.position.z === particle.position.z

    if (isFirstParticle && particle.life > 0.95) {
      console.log(`Debug: First particle update - DeltaTime: ${deltaTime}ms (${(deltaTime / 1000).toFixed(3)}s), Duration: ${explosionDuration}`)
      console.log(`Debug: Initial velocity: (${particle.velocity.x.toFixed(3)}, ${particle.velocity.y.toFixed(3)}, ${particle.velocity.z.toFixed(3)}) units/s`)
      console.log(`Debug: Initial position: (${particle.position.x.toFixed(3)}, ${particle.position.y.toFixed(3)}, ${particle.position.z.toFixed(3)})`)
    }

    // Apply gravity
    particle.velocity.y += FireworksRenderer.GRAVITY

    // Update position
    const oldPos = particle.position.clone()
    // Convert deltaTime from milliseconds to seconds for proper physics
    const deltaTimeSeconds = deltaTime / 1000
    particle.position.add(particle.velocity.scaled(deltaTimeSeconds))
    particle.mesh.position.set(particle.position.x, particle.position.y, particle.position.z)

    // Update life and opacity
    const oldLife = particle.life
    particle.life -= deltaTime / explosionDuration
    const opacity = Math.max(0, particle.life)
    if (particle.mesh.material instanceof THREE.MeshBasicMaterial) {
      particle.mesh.material.opacity = opacity
    }

    // DEBUG: Log movement for first few frames
    if (isFirstParticle && oldLife > 0.95) {
      const movement = particle.position.distanceTo(oldPos)
      console.log(`Debug: Particle moved ${movement.toFixed(4)} units in ${(deltaTime / 1000).toFixed(3)}s, new pos: (${particle.position.x.toFixed(3)}, ${particle.position.y.toFixed(3)}, ${particle.position.z.toFixed(3)})`)
      console.log(`Debug: Life: ${oldLife.toFixed(3)} -> ${particle.life.toFixed(3)}, Opacity: ${opacity.toFixed(3)}`)
    }

    return particle.life > 0
  }

  render() {
    const currentTime = Date.now()
    const deltaTime = 16.67 // Assume ~60fps for physics calculations

    // DEBUG: Log render calls occasionally
    if (this.explosions.size > 0 && Math.random() < 0.01) { // ~1% chance
      console.log(`Debug: Render called with ${this.explosions.size} explosions, deltaTime: ${deltaTime}`)
    }

    for (const [explosionId, explosion] of this.explosions.entries()) {
      const elapsed = currentTime - explosion.startTime

      // Debug sphere is tracked by sceneOrigin — no manual repositioning needed

      if (elapsed >= explosion.duration) {
        // Remove expired explosion
        console.log(`Debug: Removing expired explosion ${explosionId} after ${elapsed}ms`)
        this.removeExplosion(explosionId)
        continue
      }

      // DEBUG: Log explosion status every 2 seconds
      if (elapsed % 2000 < 16) { // Every ~2 seconds
        console.log(`Debug: Explosion ${explosionId} - Elapsed: ${elapsed}ms, Particles alive: ${explosion.particles.length}`)
      }

      // Update all particles in this explosion
      explosion.particles = explosion.particles.filter(particle => this.updateParticle(particle, deltaTime, explosion.duration))

      // If no particles left, remove explosion early
      if (explosion.particles.length === 0) {
        console.log(`Debug: Removing explosion ${explosionId} - no particles left`)
        this.removeExplosion(explosionId)
      }
    }
  }

  private removeExplosion(explosionId: string) {
    const explosion = this.explosions.get(explosionId)
    if (!explosion) return

    // Clean up particle meshes
    for (const particle of explosion.particles) {
      this.worldRenderer.sceneOrigin.removeAndUntrack(particle.mesh)
      if (particle.mesh.material instanceof THREE.Material) {
        particle.mesh.material.dispose()
      }
    }

    // Clean up debug sphere if it exists
    if (explosion.debugSphere) {
      this.worldRenderer.sceneOrigin.removeAndUntrack(explosion.debugSphere)
      explosion.debugSphere.geometry.dispose()
      if (explosion.debugSphere.material instanceof THREE.Material) {
        explosion.debugSphere.material.dispose()
      }
      console.log('Debug: Removed explosion center sphere')
    }

    this.explosions.delete(explosionId)
  }

  stopTestMode() {
    if (this.testModeTimer) {
      clearInterval(this.testModeTimer)
      this.testModeTimer = undefined
    }
  }

  destroy() {
    this.stopTestMode()

    // Clean up all explosions
    for (const explosionId of this.explosions.keys()) {
      this.removeExplosion(explosionId)
    }

    // Clean up materials
    for (const material of this.particleMaterials) {
      material.dispose()
    }

    // Clean up geometry
    this.particleGeometry.dispose()
  }
}
