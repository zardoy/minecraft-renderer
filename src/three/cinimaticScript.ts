import * as THREE from 'three'
import * as tweenJs from '@tweenjs/tween.js'
import { Vec3 } from 'vec3'
import { WorldRendererThree } from './worldRendererThree'

export interface CinimaticPoint {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  duration: number // Time to reach this point from the previous one
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'smoothstep' | 'bounce'
  lookAt?: { x: number; y: number; z: number } // Optional: override rotation to look at this point
  fov?: number // Optional: change field of view
}

export interface CinimaticScript {
  name?: string
  points: CinimaticPoint[]
  loop?: boolean
  onComplete?: () => void
  onPointReached?: (pointIndex: number, point: CinimaticPoint) => void
}

export class CinimaticScriptRunner {
  private isRunning = false
  private currentScript: CinimaticScript | null = null
  private currentPointIndex = 0
  private currentTweens: Array<tweenJs.Tween<any>> = []
  private startTime = 0
  private totalDuration = 0

  // Camera state
  private currentPosition = { x: 0, y: 0, z: 0 }
  private currentRotation = { yaw: 0, pitch: 0 }
  private currentFov = 75

  constructor(
    private readonly worldRenderer: WorldRendererThree,
    private readonly updateCamera: (pos: Vec3, yaw: number, pitch: number) => void,
    private readonly updateFov: (fov: number) => void,
    private readonly getInitialState: () => { position: Vec3; yaw: number; pitch: number; fov: number }
  ) {}

  startScript(script: CinimaticScript): boolean {
    if (this.isRunning) {
      console.warn('Cinematic script already running. Stop current script first.')
      return false
    }

    if (!script.points || script.points.length === 0) {
      console.warn('Cinematic script has no points')
      return false
    }

    this.currentScript = script
    this.isRunning = true
    this.currentPointIndex = 0
    this.startTime = performance.now()

    // Calculate total duration
    this.totalDuration = script.points.reduce((sum, point) => sum + point.duration, 0)

    // Get initial state
    const initialState = this.getInitialState()
    this.currentPosition = {
      x: initialState.position.x,
      y: initialState.position.y,
      z: initialState.position.z
    }
    this.currentRotation = {
      yaw: initialState.yaw,
      pitch: initialState.pitch
    }
    this.currentFov = initialState.fov

    console.log(`Starting cinematic script: ${script.name || 'Unnamed'} (${this.totalDuration}ms)`)

    // Start from first point
    this.moveToPoint(0)

    return true
  }

  stopScript(): void {
    if (!this.isRunning) return

    // Stop all active tweens
    for (const tween of this.currentTweens) tween.stop()
    this.currentTweens = []

    this.isRunning = false
    this.currentScript = null
    this.currentPointIndex = 0
  }

  runExampleScripts(index: number) {
    const cameraWorldPos = this.worldRenderer.getCameraPosition()
    const playerPos = new Vec3(cameraWorldPos.x, cameraWorldPos.y, cameraWorldPos.z)

    // Circular flyby around current position
    const circular = CinimaticScriptRunner.createCircularFlyby(playerPos, 30, 20, 15_000)

    // Spiral descent from high above to current position
    const spiral = CinimaticScriptRunner.createSpiralDescent(
      playerPos.offset(0, 50, 0),
      playerPos,
      3, // 3 spirals
      12_000 // 12 seconds
    )

    // Building tour example
    const buildingTour = CinimaticScriptRunner.createBuildingTour([
      { pos: playerPos.offset(-20, 10, -20), lookAt: playerPos, duration: 3000 },
      { pos: playerPos.offset(20, 15, -20), lookAt: playerPos, duration: 3000 },
      { pos: playerPos.offset(20, 20, 20), lookAt: playerPos, duration: 3000 },
      { pos: playerPos.offset(-20, 25, 20), lookAt: playerPos, duration: 3000 }
    ])

    const scripts = [circular, spiral, buildingTour]
    this.startScript(scripts[index])

    return { circular, spiral, buildingTour }
  }

  private moveToPoint(pointIndex: number): void {
    if (!this.currentScript || pointIndex >= this.currentScript.points.length) {
      this.handleScriptComplete()
      return
    }

    const point = this.currentScript.points[pointIndex]
    const { duration } = point

    // Create target state
    const targetPosition = { x: point.x, y: point.y, z: point.z }
    const targetRotation = { yaw: point.yaw, pitch: point.pitch }
    const targetFov = point.fov ?? this.currentFov

    // Handle lookAt override
    if (point.lookAt) {
      const lookAtVec = new THREE.Vector3(point.lookAt.x, point.lookAt.y, point.lookAt.z)
      const fromVec = new THREE.Vector3(point.x, point.y, point.z)
      const direction = lookAtVec.sub(fromVec).normalize()

      // Convert direction to yaw/pitch
      targetRotation.yaw = Math.atan2(-direction.x, -direction.z)
      targetRotation.pitch = Math.asin(direction.y)
    }

    // Get easing function
    const easingFn = this.getEasingFunction(point.easing || 'easeInOut')

    // Create position tween
    const positionTween = new tweenJs.Tween(this.currentPosition)
      .to(targetPosition, duration)
      .easing(easingFn)
      .onUpdate(() => {
        this.updateCamera(
          new Vec3(this.currentPosition.x, this.currentPosition.y, this.currentPosition.z),
          this.currentRotation.yaw,
          this.currentRotation.pitch
        )
      })

    // Create rotation tween (handle wrapping)
    const rotationTween = new tweenJs.Tween(this.currentRotation)
      .to(this.wrapRotation(targetRotation), duration)
      .easing(easingFn)
      .onUpdate(() => {
        this.updateCamera(
          new Vec3(this.currentPosition.x, this.currentPosition.y, this.currentPosition.z),
          this.currentRotation.yaw,
          this.currentRotation.pitch
        )
      })

    // Create FOV tween if needed
    let fovTween: tweenJs.Tween<any> | null = null
    if (Math.abs(targetFov - this.currentFov) > 0.1) {
      const fovState = { fov: this.currentFov }
      fovTween = new tweenJs.Tween(fovState)
        .to({ fov: targetFov }, duration)
        .easing(easingFn)
        .onUpdate(() => {
          this.currentFov = fovState.fov
          this.updateFov(this.currentFov)
        })
    }

    // Start tweens
    this.currentTweens = [positionTween, rotationTween]
    if (fovTween) this.currentTweens.push(fovTween)

    positionTween.start()
    rotationTween.start()
    fovTween?.start()

    // Handle completion
    positionTween.onComplete(() => {
      this.currentPointIndex++

      // Call point reached callback
      this.currentScript?.onPointReached?.(pointIndex, point)

      // Move to next point
      if (this.isRunning) {
        this.moveToPoint(this.currentPointIndex)
      }
    })
  }

  private wrapRotation(target: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
    // Handle yaw wrapping to take shortest path
    let targetYaw = target.yaw
    const yawDiff = targetYaw - this.currentRotation.yaw

    if (yawDiff > Math.PI) {
      targetYaw -= 2 * Math.PI
    } else if (yawDiff < -Math.PI) {
      targetYaw += 2 * Math.PI
    }

    // Clamp pitch to avoid gimbal lock
    const targetPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, target.pitch))

    return { yaw: targetYaw, pitch: targetPitch }
  }

  private getEasingFunction(easing: string): (t: number) => number {
    switch (easing) {
      case 'linear':
        return tweenJs.Easing.Linear.None
      case 'easeIn':
        return tweenJs.Easing.Quadratic.In
      case 'easeOut':
        return tweenJs.Easing.Quadratic.Out
      case 'easeInOut':
        return tweenJs.Easing.Quadratic.InOut
      case 'smoothstep':
        return tweenJs.Easing.Cubic.InOut
      case 'bounce':
        return tweenJs.Easing.Bounce.Out
      default:
        return tweenJs.Easing.Quadratic.InOut
    }
  }

  private handleScriptComplete(): void {
    if (!this.currentScript) return

    const script = this.currentScript

    if (script.loop) {
      // Restart from beginning
      this.currentPointIndex = 0
      this.moveToPoint(0)
    } else {
      // Script finished
      console.log(`Cinematic script completed: ${script.name || 'Unnamed'}`)
      script.onComplete?.()
      this.stopScript()
    }
  }

  // Public getters
  get running(): boolean {
    return this.isRunning
  }

  get progress(): number {
    if (!this.isRunning || this.totalDuration === 0) return 0
    const elapsed = performance.now() - this.startTime
    return Math.min(elapsed / this.totalDuration, 1)
  }

  get currentScriptName(): string | undefined {
    return this.currentScript?.name
  }

  // Static helper methods for creating common scripts
  static createCircularFlyby(center: Vec3, radius: number, height: number, duration: number): CinimaticScript {
    const points: CinimaticPoint[] = []
    const numPoints = 8

    for (let i = 0; i <= numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2
      const x = center.x + Math.cos(angle) * radius
      const z = center.z + Math.sin(angle) * radius
      const y = center.y + height

      points.push({
        x,
        y,
        z,
        yaw: angle + Math.PI / 2, // Look tangent to circle
        pitch: -0.2, // Look slightly down
        duration: duration / numPoints,
        easing: 'smoothstep',
        lookAt: { x: center.x, y: center.y, z: center.z }
      })
    }

    return {
      name: 'Circular Flyby',
      points,
      loop: false
    }
  }

  static createSpiralDescent(start: Vec3, end: Vec3, spirals: number, duration: number): CinimaticScript {
    const points: CinimaticPoint[] = []
    const numPoints = spirals * 8
    const radius = 20

    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints
      const angle = t * spirals * Math.PI * 2

      const x = THREE.MathUtils.lerp(start.x, end.x, t) + Math.cos(angle) * radius * (1 - t)
      const z = THREE.MathUtils.lerp(start.z, end.z, t) + Math.sin(angle) * radius * (1 - t)
      const y = THREE.MathUtils.lerp(start.y, end.y, t)

      points.push({
        x,
        y,
        z,
        yaw: angle + Math.PI / 2,
        pitch: -0.3 * t, // Gradually look more down
        duration: duration / numPoints,
        easing: 'easeInOut'
      })
    }

    return {
      name: 'Spiral Descent',
      points,
      loop: false
    }
  }

  static createBuildingTour(waypoints: Array<{ pos: Vec3; lookAt?: Vec3; duration?: number }>): CinimaticScript {
    const points: CinimaticPoint[] = waypoints.map((wp, i) => ({
      x: wp.pos.x,
      y: wp.pos.y,
      z: wp.pos.z,
      yaw: 0, // Will be overridden by lookAt if provided
      pitch: 0,
      duration: wp.duration || 3000,
      easing: 'smoothstep',
      lookAt: wp.lookAt ? { x: wp.lookAt.x, y: wp.lookAt.y, z: wp.lookAt.z } : undefined
    }))

    return {
      name: 'Building Tour',
      points,
      loop: false
    }
  }
}
