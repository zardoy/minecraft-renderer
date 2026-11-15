import * as THREE from 'three'
import { vanillaCelestialAngle } from '../lib/skyLight'

export type Vec3Like = { x: number; y: number; z: number }

/** Direction from the ground towards the sun, same rotation as the sunMoon module (east +X at sunrise, up at noon). */
export function sunDirectionFromTime(timeOfDay: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = vanillaCelestialAngle(timeOfDay) * Math.PI * 2
  return out.set(-Math.sin(theta), Math.cos(theta), 0)
}

/** Shadow strength by sun elevation (sin of the angle above the horizon): none at night, fades in after sunrise. */
export function sunShadowStrength(sunHeight: number): number {
  return THREE.MathUtils.smoothstep(sunHeight, 0.05, 0.25)
}

/**
 * Light space basis. The sun moves in the XY plane, so world +Z is always perpendicular to it: using it as the
 * texture "up" gives a basis that turns smoothly over the day and never flips.
 * z = towards the sun and x = (0,0,1) × z both lie in the XY plane, y = z × x = world +Z.
 */
export function lightBasis(sunDir: Vec3Like) {
  const z = new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize()
  const x = new THREE.Vector3(0, 0, 1).cross(z).normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  return { x, y, z }
}

export type ShadowFrameParams = {
  sunDir: Vec3Like
  /** World position the shadows follow (the camera). */
  focus: Vec3Like
  /** Render origin of the chunk shaders: matrices are built relative to it (it only changes on rebase). */
  renderOrigin: Vec3Like
  /** Blocks around the focus that receive shadows. */
  distance: number
  mapSize: number
}

export type ShadowFrame = {
  /** Snapped center, render origin and settings: a different key needs a new map. */
  key: string
  /** Render-origin-relative position → clip space of the shadow camera (casters). */
  lightViewProj: THREE.Matrix4
  /** Render-origin-relative position → [0, 1]³ shadow map uv + depth (receivers). */
  shadowMatrix: THREE.Matrix4
  /** Half size of the square the map covers, in blocks. */
  halfExtent: number
  /** World size of one shadow map texel. */
  texelWorld: number
  /** Near→far length of the shadow camera in blocks (depth 0..1 maps onto it). */
  depthRange: number
  /** Light space position the map is centered on, in world space. */
  centerWorld: THREE.Vector3
}

/** Coverage beyond the receiving distance, so the focus can move a whole snap step before the map must follow. */
export const SHADOW_SNAP_BLOCKS = 8
/** How far towards the sun casters are captured (tall terrain casting at a low sun). */
export const SHADOW_DEPTH_BLOCKS = 256

/**
 * Shadow camera for the given sun and focus. The center is snapped to a whole number of texels in light space, so
 * moving the focus never shifts texels (no shimmering edges), and to SHADOW_SNAP_BLOCKS so the map only has to be
 * re-rendered after the focus moved that far.
 */
export function computeShadowFrame({ sunDir, focus, renderOrigin, distance, mapSize }: ShadowFrameParams): ShadowFrame {
  const basis = lightBasis(sunDir)
  const halfExtent = distance + SHADOW_SNAP_BLOCKS
  const texelWorld = (2 * halfExtent) / mapSize
  const step = Math.max(1, Math.round(SHADOW_SNAP_BLOCKS / texelWorld)) * texelWorld

  // Light space coordinates of the focus (float64, world coordinates may be large).
  const snap = (axis: THREE.Vector3) => Math.round((focus.x * axis.x + focus.y * axis.y + focus.z * axis.z) / step)
  const ia = snap(basis.x)
  const ib = snap(basis.y)
  const ic = snap(basis.z)
  const centerWorld = new THREE.Vector3()
    .addScaledVector(basis.x, ia * step)
    .addScaledVector(basis.y, ib * step)
    .addScaledVector(basis.z, ic * step)

  // Camera sits SHADOW_DEPTH_BLOCKS towards the sun from the center and looks back along -z.
  const eyeRelative = new THREE.Vector3(centerWorld.x - renderOrigin.x, centerWorld.y - renderOrigin.y, centerWorld.z - renderOrigin.z).addScaledVector(
    basis.z,
    SHADOW_DEPTH_BLOCKS
  )
  const cameraMatrix = new THREE.Matrix4().makeBasis(basis.x, basis.y, basis.z).setPosition(eyeRelative)
  const view = cameraMatrix.clone().invert()
  const depthRange = SHADOW_DEPTH_BLOCKS * 2
  const projection = new THREE.Matrix4().makeOrthographic(-halfExtent, halfExtent, halfExtent, -halfExtent, 0, depthRange)
  const lightViewProj = projection.multiply(view)
  const toTexture = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
  const shadowMatrix = toTexture.multiply(lightViewProj)

  // The sun direction is not part of the key: it changes every tick, shadowNeedsRerender compares it with a tolerance.
  const key = [ia, ib, ic, renderOrigin.x, renderOrigin.y, renderOrigin.z, distance, mapSize].join('|')
  return { key, lightViewProj, shadowMatrix, halfExtent, texelWorld, depthRange, centerWorld }
}

/** Angle between two unit vectors in degrees. */
export function angleBetweenDeg(a: Vec3Like, b: Vec3Like): number {
  const dot = THREE.MathUtils.clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1)
  return THREE.MathUtils.radToDeg(Math.acos(dot))
}

/**
 * Whether a 16³ section (corner key coordinates) can cast into the receiving area: within `distance` + margin of the
 * focus horizontally. Far casters only matter at a very low sun and would multiply the shadow pass cost.
 */
export function sectionCastsIntoRange(sectionX: number, sectionZ: number, focus: Vec3Like, distance: number, margin = 32): boolean {
  const dx = Math.max(sectionX - focus.x, 0, focus.x - (sectionX + 16))
  const dz = Math.max(sectionZ - focus.z, 0, focus.z - (sectionZ + 16))
  const range = distance + margin
  return dx * dx + dz * dz <= range * range
}

/** "x,y,z" section key → corner coordinates. */
export function parseSectionKey(key: string): [number, number, number] | undefined {
  const parts = key.split(',')
  if (parts.length !== 3) return undefined
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return [x, y, z]
}

export type ShadowRerenderState = {
  key: string
  sunDir: THREE.Vector3
  geometryVersion: string
  renderedAt: number
}

/**
 * Sun movement that requires a new map. With smooth time (see smoothTimeOfDay.ts) the sun moves ~0.3° per second, so
 * this is a new map ~5 times a second, each step moves a long shadow by well under a block.
 */
export const SHADOW_SUN_ANGLE_EPSILON_DEG = 0.06
/** Never re-render for the sun more often than this (fast time: sleeping, /time add), the shadow just steps then. */
export const SHADOW_SUN_MIN_INTERVAL_MS = 150
/** Chunks keep streaming in while exploring, re-render for them at most this often. */
export const SHADOW_GEOMETRY_THROTTLE_MS = 500

/**
 * Decides if the shadow map is stale: the frame key changed, the sun moved more than the tolerance (it moves every
 * tick) or the geometry changed (throttled).
 */
export function shadowNeedsRerender(
  previous: ShadowRerenderState | undefined,
  frameKey: string,
  sunDir: Vec3Like,
  geometryVersion: string,
  now: number
): boolean {
  if (!previous) return true
  if (previous.key !== frameKey) return true
  if (angleBetweenDeg(previous.sunDir, sunDir) > SHADOW_SUN_ANGLE_EPSILON_DEG && now - previous.renderedAt >= SHADOW_SUN_MIN_INTERVAL_MS) return true
  return previous.geometryVersion !== geometryVersion && now - previous.renderedAt >= SHADOW_GEOMETRY_THROTTLE_MS
}
