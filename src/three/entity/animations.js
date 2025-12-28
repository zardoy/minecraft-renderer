//@ts-check
import { PlayerAnimation } from 'skinview3d'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const mix = (a, b, t) => a + (b - a) * t
const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2)
  if (a < 0) a += Math.PI * 2
  return a - Math.PI
}

/**
 * @typedef {{
 *  playerRot: any,
 *  bodyPos: any, bodyRot: any,
 *  leftArmPos: any, leftArmRot: any,
 *  rightArmPos: any, rightArmRot: any,
 *  leftLegPos: any, leftLegRot: any,
 *  rightLegPos: any, rightLegRot: any,
 *  headPos: any, headRot: any,
 *  capePos: any, capeRot: any,
 *  elytraPos: any, elytraRot: any,
 * }} Defaults
 */

function updateElytraRightWing(player) {
  const elytra = player?.elytra
  if (!elytra) return

  if (typeof elytra.updateRightWing === 'function') {
    elytra.updateRightWing()
    return
  }
  if (typeof elytra.updateRightWingRotation === 'function') {
    elytra.updateRightWingRotation()
    return
  }

  const left = elytra.leftWing
  const right = elytra.rightWing
  if (!left?.rotation || !right?.rotation) return
  if (typeof right.rotation.copy === 'function') {
    right.rotation.copy(left.rotation)
    right.rotation.z *= -1
  }
}

export class WalkingGeneralSwing extends PlayerAnimation {
  switchAnimationCallback

  isRunning = false
  isMoving = true
  isCrouched = false

  /** @type {number} 0..1 */
  moveAmount = 0
  /** @type {number} 0..1 */
  runAmount = 0

  /** @type {number} radians */
  lookYaw = 0
  /** @type {number} radians */
  lookPitch = 0

  _dt = 0
  _phase = 0
  _idlePhase = 0

  _moveBlend = 0
  _runBlend = 0
  _crouchBlend = 0

  _lookYawBlend = 0
  _lookPitchBlend = 0

  /** @type {number | null} */
  _swingTime = null
  _swingDuration = 0.25

  /** @type {Defaults | null} */
  _defaults = null

  update(player, delta) {
    this._dt = delta
    super.update(player, delta)
  }

  swingArm() {
    this._swingTime = 0
  }

  resetLocomotion() {
    this._moveBlend = 0
    this._runBlend = 0
    this._crouchBlend = 0
    this._phase = 0
  }

  _captureDefaults(player) {
    const skin = player?.skin
    this._defaults = {
      playerRot: player?.rotation?.clone?.(),

      bodyPos: skin?.body?.position?.clone?.(),
      bodyRot: skin?.body?.rotation?.clone?.(),

      leftArmPos: skin?.leftArm?.position?.clone?.(),
      leftArmRot: skin?.leftArm?.rotation?.clone?.(),
      rightArmPos: skin?.rightArm?.position?.clone?.(),
      rightArmRot: skin?.rightArm?.rotation?.clone?.(),

      leftLegPos: skin?.leftLeg?.position?.clone?.(),
      leftLegRot: skin?.leftLeg?.rotation?.clone?.(),
      rightLegPos: skin?.rightLeg?.position?.clone?.(),
      rightLegRot: skin?.rightLeg?.rotation?.clone?.(),

      headPos: skin?.head?.position?.clone?.(),
      headRot: skin?.head?.rotation?.clone?.(),

      capePos: player?.cape?.position?.clone?.(),
      capeRot: player?.cape?.rotation?.clone?.(),

      elytraPos: player?.elytra?.position?.clone?.(),
      elytraRot: player?.elytra?.rotation?.clone?.(),
    }
  }

  _applyDefaults(player) {
    const d = this._defaults
    if (!d) return

    const skin = player?.skin
    const cape = player?.cape
    const elytra = player?.elytra

    if (d.playerRot && player?.rotation) player.rotation.copy(d.playerRot)

    if (d.bodyPos && skin?.body?.position) skin.body.position.copy(d.bodyPos)
    if (d.bodyRot && skin?.body?.rotation) skin.body.rotation.copy(d.bodyRot)

    if (d.leftArmPos && skin?.leftArm?.position) skin.leftArm.position.copy(d.leftArmPos)
    if (d.leftArmRot && skin?.leftArm?.rotation) skin.leftArm.rotation.copy(d.leftArmRot)

    if (d.rightArmPos && skin?.rightArm?.position) skin.rightArm.position.copy(d.rightArmPos)
    if (d.rightArmRot && skin?.rightArm?.rotation) skin.rightArm.rotation.copy(d.rightArmRot)

    if (d.leftLegPos && skin?.leftLeg?.position) skin.leftLeg.position.copy(d.leftLegPos)
    if (d.leftLegRot && skin?.leftLeg?.rotation) skin.leftLeg.rotation.copy(d.leftLegRot)

    if (d.rightLegPos && skin?.rightLeg?.position) skin.rightLeg.position.copy(d.rightLegPos)
    if (d.rightLegRot && skin?.rightLeg?.rotation) skin.rightLeg.rotation.copy(d.rightLegRot)

    if (d.headPos && skin?.head?.position) skin.head.position.copy(d.headPos)
    if (d.headRot && skin?.head?.rotation) skin.head.rotation.copy(d.headRot)

    if (d.capePos && cape?.position) cape.position.copy(d.capePos)
    if (d.capeRot && cape?.rotation) cape.rotation.copy(d.capeRot)

    if (d.elytraPos && elytra?.position) elytra.position.copy(d.elytraPos)
    if (d.elytraRot && elytra?.rotation) elytra.rotation.copy(d.elytraRot)
  }

  animate(player) {
    const dt = this._dt || 0
    if (!this._defaults) this._captureDefaults(player)
    this._applyDefaults(player)

    const externalMove = typeof this.moveAmount === 'number' ? this.moveAmount : (this.isMoving ? 1 : 0)
    const externalRun = typeof this.runAmount === 'number' ? this.runAmount : (this.isRunning ? 1 : 0)

    const targetMove = clamp01(externalMove)
    const targetRun = clamp01(externalRun)
    const targetCrouch = this.isCrouched ? 1 : 0

    const kMove = Math.min(1, dt * 8)
    const kRun = Math.min(1, dt * 6)
    const kCrouch = Math.min(1, dt * 7)

    this._moveBlend += (targetMove - this._moveBlend) * kMove
    this._runBlend += (targetRun - this._runBlend) * kRun
    this._crouchBlend += (targetCrouch - this._crouchBlend) * kCrouch

    const moveBlend = clamp01(this._moveBlend)
    const runBlend = clamp01(this._runBlend)
    const crouchBlend = clamp01(this._crouchBlend)

    const baseSpeed = mix(8, 10, runBlend)
    const crouchSpeedMul = mix(1, 0.55, crouchBlend)
    const speed = baseSpeed * crouchSpeedMul

    this._phase += dt * speed * moveBlend

    this._phase += dt * speed * moveBlend
    this._idlePhase += dt * 1.15

    const t = this._phase + (runBlend > 0.5 ? Math.PI * 0.5 : 0)

    if (this.switchAnimationCallback) {
      const boundary = Math.abs(Math.sin(t))
      if (boundary < 0.02) {
        const cb = this.switchAnimationCallback
        this.switchAnimationCallback = null
        cb?.()
      }
    }

    applyCrouchPose(player, crouchBlend)

    const maxYaw = (80 * Math.PI) / 180
    const maxPitch = (75 * Math.PI) / 180
    const targetLookYaw = clamp(wrapPi(this.lookYaw || 0), -maxYaw, maxYaw)
    const targetLookPitch = clamp(this.lookPitch || 0, -maxPitch, maxPitch)

    const kLook = Math.min(1, dt * 14)
    this._lookYawBlend += (targetLookYaw - this._lookYawBlend) * kLook
    this._lookPitchBlend += (targetLookPitch - this._lookPitchBlend) * kLook

    if (player?.skin?.head?.rotation) {
      player.skin.head.rotation.y += this._lookYawBlend
      player.skin.head.rotation.x += this._lookPitchBlend
    }

    const idleStrength = (1 - moveBlend) * (1 - 0.25 * runBlend)
    if (idleStrength > 0.0001 && player?.skin) {
      const b = Math.sin(this._idlePhase)
      player.skin.body.rotation.x += b * 0.02 * idleStrength
      player.skin.head.rotation.x += -b * 0.015 * idleStrength
      player.skin.leftArm.rotation.x += b * 0.03 * idleStrength
      player.skin.rightArm.rotation.x += -b * 0.03 * idleStrength
      if (player?.cape?.rotation) player.cape.rotation.x += Math.sin(this._idlePhase * 0.7) * 0.03 * idleStrength
    }

    if (moveBlend > 0.0001 && player?.skin) {
      const legAmp = mix(1, 0.85, crouchBlend)
      const armAmp = mix(1, 0.7, crouchBlend)

      const walkLegL = Math.sin(t) * 0.5
      const walkLegR = Math.sin(t + Math.PI) * 0.5
      const runLegL = Math.cos(t + Math.PI) * 1.3
      const runLegR = Math.cos(t) * 1.3

      player.skin.leftLeg.rotation.x += mix(walkLegL, runLegL, runBlend) * moveBlend * legAmp
      player.skin.rightLeg.rotation.x += mix(walkLegR, runLegR, runBlend) * moveBlend * legAmp

      const walkArmL = Math.sin(t + Math.PI) * 0.5
      const walkArmR = Math.sin(t) * 0.5
      const runArmL = Math.cos(t) * 1.5
      const runArmR = Math.cos(t + Math.PI) * 1.5

      player.skin.leftArm.rotation.x += mix(walkArmL, runArmL, runBlend) * moveBlend * armAmp
      player.skin.rightArm.rotation.x += mix(walkArmR, runArmR, runBlend) * moveBlend * armAmp

      const walkArmZBase = Math.PI * 0.02
      const runArmZBase = Math.PI * 0.1
      const armZBase = mix(walkArmZBase, runArmZBase, runBlend)

      const walkArmZL = Math.cos(t) * 0.03 + walkArmZBase
      const walkArmZR = Math.cos(t + Math.PI) * 0.03 - walkArmZBase
      const runArmZL = Math.cos(t) * 0.1 + runArmZBase
      const runArmZR = Math.cos(t + Math.PI) * 0.1 - runArmZBase

      player.skin.leftArm.rotation.z += (mix(walkArmZL, runArmZL, runBlend) * moveBlend + armZBase * 0.15 * moveBlend) * armAmp
      player.skin.rightArm.rotation.z += (mix(walkArmZR, runArmZR, runBlend) * moveBlend - armZBase * 0.15 * moveBlend) * armAmp
      
      if (this._defaults?.playerRot) {
        player.rotation.z = this._defaults.playerRot.z + Math.cos(t + Math.PI) * 0.01 * runBlend * moveBlend
      }

      const capeBase = mix(Math.PI * 0.06, Math.PI * 0.3, runBlend)
      const capeWave = mix(Math.sin(t / 1.5) * 0.06, Math.sin(t * 2) * 0.1, runBlend)
      if (player?.cape?.rotation) player.cape.rotation.x += (capeBase + capeWave) * moveBlend
    }

    if (this._swingTime !== null) {
      this._swingTime += dt
      const p = Math.min(this._swingTime / this._swingDuration, 1)
      HitAnimation.animate(p, player, moveBlend > 0.2)
      if (p >= 1) this._swingTime = null
    }
  }
}

const HitAnimation = {
  animate(progress, player, isMovingOrRunning) {
    if (!player?.skin?.rightArm?.rotation) return

    const t = progress * 18
    player.skin.rightArm.rotation.x = -0.4537860552 * 2 + 2 * Math.sin(t + Math.PI) * 0.3

    if (!isMovingOrRunning) {
      const basicArmRotationZ = 0.01 * Math.PI + 0.06
      player.skin.rightArm.rotation.z = -Math.cos(t) * 0.403 + basicArmRotationZ
      player.skin.body.rotation.y = -Math.cos(t) * 0.06
      player.skin.leftArm.rotation.x = Math.sin(t + Math.PI) * 0.077
      player.skin.leftArm.rotation.z = -Math.cos(t) * 0.015 + 0.13 - 0.05
      player.skin.leftArm.position.z = Math.cos(t) * 0.3
      player.skin.leftArm.position.x = 5 - Math.cos(t) * 0.05
    }
  },
}

function applyCrouchPose(player, crouchBlend) {
  const skin = player?.skin
  const cape = player?.cape
  const elytra = player?.elytra
  if (!skin || !cape) return

  const pr = clamp01(crouchBlend)
  const s = Math.abs(Math.sin((pr * Math.PI) / 2))
  if (s <= 0.000001) return

  skin.body.rotation.x += 0.4537860552 * s
  skin.body.position.z += (1.3256181 - 3.4500310377) * s
  skin.body.position.y += -2.103677462 * s

  cape.position.y += -1.851236166577372 * s
  cape.rotation.x += 0.294220265771 * s
  cape.position.z += (3.786619432 - 3.4500310377) * s

  if (elytra?.position) elytra.position.copy(cape.position)
  if (elytra?.rotation) elytra.rotation.copy(cape.rotation)
  if (elytra?.rotation) elytra.rotation.x -= (10.8 * Math.PI) / 180

  if (elytra?.leftWing?.rotation) elytra.leftWing.rotation.z = mix(0.72, 0.26179944 + 0.4582006, s)
  updateElytraRightWing(player)

  skin.head.position.y += -3.618325234674 * s

  const armZ = 0.1 * s
  const armPosZ = (3.618325234674 - 3.4500310377) * s
  const armPosY = -2.53943318 * s

  skin.leftArm.position.z += armPosZ
  skin.rightArm.position.z += armPosZ

  skin.leftArm.rotation.x += 0.410367746202 * s
  skin.rightArm.rotation.x += 0.410367746202 * s

  skin.leftArm.rotation.z += armZ
  skin.rightArm.rotation.z += -armZ

  skin.leftArm.position.y += armPosY
  skin.rightArm.position.y += armPosY

  skin.rightLeg.position.z += -3.4500310377 * s
  skin.leftLeg.position.z += -3.4500310377 * s
}