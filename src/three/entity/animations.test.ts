import * as THREE from 'three'
import { PlayerObject } from 'skinview3d'
import { expect, test } from 'vitest'
import type { PlayerObjectType } from '../../lib/createPlayerObject'
import { WalkingGeneralSwing } from './animations'

const RIDING_LEG_X = -1.4137167
const VANILLA_RIDING_LEG_Y = Math.PI / 10
const VANILLA_RIDING_LEG_Z = Math.PI / 40
const SKINVIEW_RIDING_LEG_Y = -VANILLA_RIDING_LEG_Y
const SKINVIEW_RIDING_LEG_Z = -VANILLA_RIDING_LEG_Z
const RIDING_LEG_ORDER = 'ZYX'
const RIDING_ARM_DELTA = Math.PI / 5

const YZ_AXIS_FLIP = new THREE.Matrix4().makeScale(1, -1, -1)

function makePlayerObject(): PlayerObjectType {
  const playerObject = new PlayerObject() as PlayerObjectType
  playerObject.skin.leftLeg.rotation.set(0.1, 0.05, -0.02)
  playerObject.skin.rightLeg.rotation.set(-0.08, -0.04, 0.03)
  playerObject.skin.leftArm.rotation.set(0.2, 0, 0.01)
  playerObject.skin.rightArm.rotation.set(-0.15, 0, -0.01)
  return playerObject
}

function captureRotations(playerObject: PlayerObjectType) {
  const { leftArm, rightArm, leftLeg, rightLeg } = playerObject.skin
  return {
    leftArm: leftArm.rotation.clone(),
    rightArm: rightArm.rotation.clone(),
    leftLeg: leftLeg.rotation.clone(),
    rightLeg: rightLeg.rotation.clone()
  }
}

function runAnimationFrame(animation: WalkingGeneralSwing, playerObject: PlayerObjectType, dt = 0.05) {
  animation.update(playerObject, dt)
}

function makeJavaRidingLegMatrix(ySign: 1 | -1): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(RIDING_LEG_X, ySign * VANILLA_RIDING_LEG_Y, ySign * VANILLA_RIDING_LEG_Z, RIDING_LEG_ORDER))
}

function makeSkinviewRidingLegMatrix(y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(RIDING_LEG_X, y, z, RIDING_LEG_ORDER))
}

function conjugateYzAxisFlip(rotationMatrix: THREE.Matrix4): THREE.Matrix4 {
  return YZ_AXIS_FLIP.clone().multiply(rotationMatrix).multiply(YZ_AXIS_FLIP.clone())
}

function expectMatrixNear(a: THREE.Matrix4, b: THREE.Matrix4) {
  for (let i = 0; i < 16; i++) {
    expect(a.elements[i]).toBeCloseTo(b.elements[i])
  }
}

function expectRidingLegPose(playerObject: PlayerObjectType) {
  expect(playerObject.skin.rightLeg.rotation.order).toBe(RIDING_LEG_ORDER)
  expect(playerObject.skin.rightLeg.rotation.x).toBeCloseTo(RIDING_LEG_X)
  expect(playerObject.skin.rightLeg.rotation.y).toBeCloseTo(SKINVIEW_RIDING_LEG_Y)
  expect(playerObject.skin.rightLeg.rotation.z).toBeCloseTo(SKINVIEW_RIDING_LEG_Z)

  expect(playerObject.skin.leftLeg.rotation.order).toBe(RIDING_LEG_ORDER)
  expect(playerObject.skin.leftLeg.rotation.x).toBeCloseTo(RIDING_LEG_X)
  expect(playerObject.skin.leftLeg.rotation.y).toBeCloseTo(-SKINVIEW_RIDING_LEG_Y)
  expect(playerObject.skin.leftLeg.rotation.z).toBeCloseTo(-SKINVIEW_RIDING_LEG_Z)
}

test('riding sets ZYX leg rotations with inverted Y/Z signs for skinview3d axes', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  runAnimationFrame(animation, playerObject)

  expectRidingLegPose(playerObject)
})

test('riding leg rotation matrix matches vanilla after Y/Z axis conversion', () => {
  const javaRight = makeJavaRidingLegMatrix(1)
  const skinviewRight = makeSkinviewRidingLegMatrix(SKINVIEW_RIDING_LEG_Y, SKINVIEW_RIDING_LEG_Z)
  expectMatrixNear(conjugateYzAxisFlip(skinviewRight), javaRight)

  const javaLeft = makeJavaRidingLegMatrix(-1)
  const skinviewLeft = makeSkinviewRidingLegMatrix(-SKINVIEW_RIDING_LEG_Y, -SKINVIEW_RIDING_LEG_Z)
  expectMatrixNear(conjugateYzAxisFlip(skinviewLeft), javaLeft)
})

test('animated riding legs match expected rotation matrices', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true
  runAnimationFrame(animation, playerObject)

  playerObject.skin.rightLeg.updateMatrix()
  playerObject.skin.leftLeg.updateMatrix()

  const rightRot = new THREE.Matrix4().extractRotation(playerObject.skin.rightLeg.matrix)
  const leftRot = new THREE.Matrix4().extractRotation(playerObject.skin.leftLeg.matrix)

  expectMatrixNear(rightRot, makeSkinviewRidingLegMatrix(SKINVIEW_RIDING_LEG_Y, SKINVIEW_RIDING_LEG_Z))
  expectMatrixNear(leftRot, makeSkinviewRidingLegMatrix(-SKINVIEW_RIDING_LEG_Y, -SKINVIEW_RIDING_LEG_Z))
})

test('riding applies arm X delta relative to defaults', () => {
  const playerObject = makePlayerObject()
  const defaults = captureRotations(playerObject)
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  runAnimationFrame(animation, playerObject)

  expect(playerObject.skin.rightArm.rotation.x).toBeCloseTo(defaults.rightArm.x - RIDING_ARM_DELTA)
  expect(playerObject.skin.leftArm.rotation.x).toBeCloseTo(defaults.leftArm.x - RIDING_ARM_DELTA)
})

test('riding does not apply old arm Z spread', () => {
  const playerObject = makePlayerObject()
  const defaults = captureRotations(playerObject)
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  runAnimationFrame(animation, playerObject)

  expect(playerObject.skin.leftArm.rotation.z).toBeCloseTo(defaults.leftArm.z)
  expect(playerObject.skin.rightArm.rotation.z).toBeCloseTo(defaults.rightArm.z)
})

test('idle to riding to idle restores limb rotations including order', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  const defaults = captureRotations(playerObject)

  animation.isMoving = false
  runAnimationFrame(animation, playerObject)
  const idleRotations = captureRotations(playerObject)

  animation.isRiding = true
  runAnimationFrame(animation, playerObject)
  expectRidingLegPose(playerObject)

  animation.isRiding = false
  animation.isMoving = false
  runAnimationFrame(animation, playerObject)
  const restored = captureRotations(playerObject)

  expect(restored.leftArm.x).toBeCloseTo(idleRotations.leftArm.x)
  expect(restored.leftArm.y).toBeCloseTo(idleRotations.leftArm.y)
  expect(restored.leftArm.z).toBeCloseTo(idleRotations.leftArm.z)
  expect(restored.leftArm.order).toBe(idleRotations.leftArm.order)
  expect(restored.rightArm.x).toBeCloseTo(idleRotations.rightArm.x)
  expect(restored.rightArm.y).toBeCloseTo(idleRotations.rightArm.y)
  expect(restored.rightArm.z).toBeCloseTo(idleRotations.rightArm.z)
  expect(restored.rightArm.order).toBe(idleRotations.rightArm.order)
  expect(restored.leftLeg.x).toBeCloseTo(defaults.leftLeg.x)
  expect(restored.leftLeg.y).toBeCloseTo(defaults.leftLeg.y)
  expect(restored.leftLeg.z).toBeCloseTo(defaults.leftLeg.z)
  expect(restored.leftLeg.order).toBe(defaults.leftLeg.order)
  expect(restored.rightLeg.x).toBeCloseTo(defaults.rightLeg.x)
  expect(restored.rightLeg.y).toBeCloseTo(defaults.rightLeg.y)
  expect(restored.rightLeg.z).toBeCloseTo(defaults.rightLeg.z)
  expect(restored.rightLeg.order).toBe(defaults.rightLeg.order)
})

test('multiple riding frames do not accumulate angles', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  runAnimationFrame(animation, playerObject)
  const firstFrame = captureRotations(playerObject)

  for (let i = 0; i < 10; i++) {
    runAnimationFrame(animation, playerObject)
  }
  const lastFrame = captureRotations(playerObject)

  expect(lastFrame.leftLeg.x).toBeCloseTo(firstFrame.leftLeg.x)
  expect(lastFrame.leftLeg.y).toBeCloseTo(firstFrame.leftLeg.y)
  expect(lastFrame.leftLeg.z).toBeCloseTo(firstFrame.leftLeg.z)
  expect(lastFrame.leftLeg.order).toBe(firstFrame.leftLeg.order)
  expect(lastFrame.rightLeg.x).toBeCloseTo(firstFrame.rightLeg.x)
  expect(lastFrame.rightLeg.y).toBeCloseTo(firstFrame.rightLeg.y)
  expect(lastFrame.rightLeg.z).toBeCloseTo(firstFrame.rightLeg.z)
  expect(lastFrame.rightLeg.order).toBe(firstFrame.rightLeg.order)
  expect(lastFrame.leftArm.x).toBeCloseTo(firstFrame.leftArm.x)
  expect(lastFrame.rightArm.x).toBeCloseTo(firstFrame.rightArm.x)
})

test('oneSwing during riding keeps isRiding enabled', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  animation.swingArm()
  runAnimationFrame(animation, playerObject)

  expect(animation.isRiding).toBe(true)
})

test('oneSwing during riding keeps legs in riding pose', () => {
  const playerObject = makePlayerObject()
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true

  animation.swingArm()
  runAnimationFrame(animation, playerObject)

  expectRidingLegPose(playerObject)
})

test('leg armor attached to legs follows riding Y/Z rotations', () => {
  const playerObject = makePlayerObject()
  const leftLegArmor = new THREE.Group()
  const rightLegArmor = new THREE.Group()
  playerObject.skin.leftLeg.add(leftLegArmor)
  playerObject.skin.rightLeg.add(rightLegArmor)

  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  animation.isRiding = true
  runAnimationFrame(animation, playerObject)

  expectRidingLegPose(playerObject)

  leftLegArmor.updateMatrixWorld(true)
  rightLegArmor.updateMatrixWorld(true)
  const leftWorldQuat = new THREE.Quaternion()
  const rightWorldQuat = new THREE.Quaternion()
  leftLegArmor.getWorldQuaternion(leftWorldQuat)
  rightLegArmor.getWorldQuaternion(rightWorldQuat)
  const leftWorldEuler = new THREE.Euler().setFromQuaternion(leftWorldQuat, 'XYZ')
  const rightWorldEuler = new THREE.Euler().setFromQuaternion(rightWorldQuat, 'XYZ')

  expect(leftWorldEuler.y).not.toBeCloseTo(0)
  expect(leftWorldEuler.z).not.toBeCloseTo(0)
  expect(rightWorldEuler.y).not.toBeCloseTo(0)
  expect(rightWorldEuler.z).not.toBeCloseTo(0)
})
