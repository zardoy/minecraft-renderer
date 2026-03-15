import * as THREE from 'three'
import { WorldRendererThree } from './worldRendererThree'

export class CameraShake {
  private rollAngle = 0
  private get damageRollAmount() { return 5 }
  private get damageAnimDuration() { return 200 }
  private rollAnimation?: { startTime: number, startRoll: number, targetRoll: number, duration: number, returnToZero?: boolean }
  private basePitch = 0
  private baseYaw = 0

  constructor(public worldRenderer: WorldRendererThree, public onRenderCallbacks: Array<(deltaTime: number) => void>) {
    onRenderCallbacks.push(() => {
      this.update()
    })
  }

  setBaseRotation(pitch: number, yaw: number) {
    this.basePitch = pitch
    this.baseYaw = yaw
    this.update()
  }

  getBaseRotation() {
    return { pitch: this.basePitch, yaw: this.baseYaw }
  }

  shakeFromDamage(yaw?: number) {
    // Add roll animation
    const startRoll = this.rollAngle
    const targetRoll = startRoll + (yaw ?? (Math.random() < 0.5 ? -1 : 1)) * this.damageRollAmount

    this.rollAnimation = {
      startTime: performance.now(),
      startRoll,
      targetRoll,
      duration: this.damageAnimDuration / 2
    }
  }

  update() {
    if (this.worldRenderer.playerStateUtils.isSpectatingEntity()) {
      // Remove any shaking when spectating
      this.rollAngle = 0
      this.rollAnimation = undefined
    }
    // Update roll animation
    if (this.rollAnimation) {
      const now = performance.now()
      const elapsed = now - this.rollAnimation.startTime
      const progress = Math.min(elapsed / this.rollAnimation.duration, 1)

      if (this.rollAnimation.returnToZero) {
        // Ease back to zero
        this.rollAngle = this.rollAnimation.startRoll * (1 - this.easeInOut(progress))
        if (progress === 1) {
          this.rollAnimation = undefined
        }
      } else {
        // Initial roll
        this.rollAngle = this.rollAnimation.startRoll + (this.rollAnimation.targetRoll - this.rollAnimation.startRoll) * this.easeOut(progress)
        if (progress === 1) {
          // Start return to zero animation
          this.rollAnimation = {
            startTime: now,
            startRoll: this.rollAngle,
            targetRoll: 0,
            duration: this.damageAnimDuration / 2,
            returnToZero: true
          }
        }
      }
    }

    const camera = this.worldRenderer.cameraObject

    if (this.worldRenderer.cameraGroupVr) {
      // For VR camera, only apply yaw rotation
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.baseYaw)
      camera.setRotationFromQuaternion(yawQuat)
    } else {
      // For regular camera, apply all rotations
      // Add tiny offsets to prevent z-fighting at ideal angles (90, 180, 270 degrees)
      const pitchOffset = this.addAntiZfightingOffset(this.basePitch)
      const yawOffset = this.addAntiZfightingOffset(this.baseYaw)

      const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchOffset)
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOffset)
      const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(this.rollAngle))
      // Combine rotations in the correct order: pitch -> yaw -> roll
      const finalQuat = yawQuat.multiply(pitchQuat).multiply(rollQuat)
      camera.setRotationFromQuaternion(finalQuat)
    }
  }

  private easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t)
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
  }

  private addAntiZfightingOffset(angle: number): number {
    const offset = 0.001 // Very small offset in radians (about 0.057 degrees)

    // Check if the angle is close to ideal angles (0, π/2, π, 3π/2)
    const normalizedAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    const tolerance = 0.01 // Tolerance for considering an angle "ideal"

    if (Math.abs(normalizedAngle) < tolerance ||
      Math.abs(normalizedAngle - Math.PI / 2) < tolerance ||
      Math.abs(normalizedAngle - Math.PI) < tolerance ||
      Math.abs(normalizedAngle - 3 * Math.PI / 2) < tolerance) {
      return angle + offset
    }

    return angle
  }
}
