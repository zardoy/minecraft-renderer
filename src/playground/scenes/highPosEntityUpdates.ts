//@ts-nocheck
import { Vec3 } from 'vec3'
import { BasePlaygroundScene } from '../baseScene'

export default class extends BasePlaygroundScene {
  continuousRender = true
  // Set targetPos to high position (1 million blocks)
  targetPos = new Vec3(1000000, 100, 1000000)

  override initGui(): void {
    this.params = {
      entity: 'player',
      speed: 10, // blocks per second
      range: 100, // distance to move back and forth
      updatesPerSecond: 20, // how often to emit position updates
      start: () => {
        this.startEntityMovement()
      },
      stop: () => {
        this.stopEntityMovement()
      }
    }
    this.paramOptions = {
      entity: {
        options: this.mcData.entitiesArray.map(b => b.name).sort((a, b) => a.localeCompare(b))
      }
    }
    super.initGui()
  }

  private entityPosition = 0 // current position offset from base
  private entityDirection = 1 // 1 for forward, -1 for backward
  private animationFrameId: number | null = null
  private updateIntervalId: NodeJS.Timeout | null = null

  private startEntityMovement() {
    if (this.updateIntervalId) return // already running

    // Calculate update interval in ms
    const updateInterval = 1000 / this.params.updatesPerSecond

    this.updateIntervalId = setInterval(() => {
      this.updateEntityPosition()
    }, updateInterval)
  }

  private stopEntityMovement() {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId)
      this.updateIntervalId = null
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  private updateEntityPosition() {
    if (!this.worldView) return

    // Calculate movement per update
    const movementPerUpdate = (this.params.speed / this.params.updatesPerSecond) * this.entityDirection

    // Update position
    this.entityPosition += movementPerUpdate

    // Reverse direction when hitting boundaries
    if (this.entityPosition >= this.params.range) {
      this.entityPosition = this.params.range
      this.entityDirection = -1
    } else if (this.entityPosition <= -this.params.range) {
      this.entityPosition = -this.params.range
      this.entityDirection = 1
    }

    // Calculate actual position (high base position + offset)
    const entityPos = this.targetPos.offset(this.entityPosition, 1, 0.5)

    // Emit entity update (simulating server position update)
    this.worldView.emit('entity', {
      id: 'moving-entity',
      name: this.params.entity,
      pos: entityPos,
      width: 0.6,
      height: 1.8,
      username: localStorage.testUsername,
      yaw: Math.PI, // facing forward direction
      pitch: 0
    })
  }

  override renderFinish(): void {
    // Clear any existing entities
    this.worldRenderer?.entities.clear()

    // Start entity movement
    this.startEntityMovement()

    // Recenter camera to high position
    if (this.camera && this.controls) {
      const cameraOffset = new Vec3(5, 5, 5)
      const cameraPos = this.targetPos.offset(cameraOffset.x, cameraOffset.y, cameraOffset.z)

      this.controls.target.set(this.targetPos.x + 0.5, this.targetPos.y + 1, this.targetPos.z + 0.5)
      this.camera.position.set(cameraPos.x, cameraPos.y, cameraPos.z)
      this.camera.lookAt(this.targetPos.x + 0.5, this.targetPos.y + 1, this.targetPos.z + 0.5)
      this.controls.update()
      this.syncCameraToBackend()
    }
  }

  // Cleanup on scene teardown
  override sceneReset(): void {
    this.stopEntityMovement()
  }
}
