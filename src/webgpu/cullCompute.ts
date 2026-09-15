/**
 * GPU-driven section culling.
 *
 * One workgroup per section slot. Thread 0 frustum-tests the section's 16³ AABB in
 * camera-relative space; if it survives, it reserves a contiguous range in `visibleFaces`
 * with a single `atomicAdd` on the indirect draw's `instanceCount`. The whole workgroup
 * then fills that range with face indices.
 *
 * The result is one `drawIndirect` for the entire world. The CPU never builds a visible
 * span list, never sorts, and never touches the draw count — which is the point: on the
 * WebGL path that work scaled with loaded sections and dominated main-thread time on mobile.
 *
 * WebGPU core has no `multiDrawIndirect`, so compaction (rather than one indirect draw per
 * section) is what keeps this to a single draw call.
 */

import * as THREE from 'three/webgpu'
import { Fn, If, Loop, uint, int, float, vec3, uniform, atomicAdd, workgroupArray, workgroupBarrier, workgroupId, localId } from 'three/tsl'

import { SECTION_META_STRIDE, RUN_COUNTS_OFFSET, FACE_DIRECTIONS } from './globalBlockBufferGPU'
import { storageTyped, node } from './shaders/tslCompat'

export const CULL_WORKGROUP_SIZE = 64

/**
 * Whether any face of a given direction in a section can face the camera.
 *
 * Everything here is in camera-relative space, so the camera sits at the origin and each
 * test collapses to one sign comparison: a `+Y` (UP) face at relative height `h` faces the
 * camera iff `h < 0`, so the section's UP run survives iff its lowest point is below the
 * camera. Conservative at section granularity — a section the camera is inside keeps all
 * six runs, which is correct.
 *
 * Order matches faceId: UP, DOWN, EAST, WEST, SOUTH, NORTH.
 */
const DIRECTION_VISIBLE: ReadonlyArray<(boxMin: any, boxMax: any) => any> = [
  (boxMin) => boxMin.y.lessThan(float(0)), // UP    (+Y)
  (_boxMin, boxMax) => boxMax.y.greaterThan(float(0)), // DOWN  (-Y)
  (boxMin) => boxMin.x.lessThan(float(0)), // EAST  (+X)
  (_boxMin, boxMax) => boxMax.x.greaterThan(float(0)), // WEST  (-X)
  (boxMin) => boxMin.z.lessThan(float(0)), // SOUTH (+Z)
  (_boxMin, boxMax) => boxMax.z.greaterThan(float(0)) // NORTH (-Z)
]

/** Indirect draw args layout: [vertexCount, instanceCount, firstVertex, firstInstance]. */
export const DRAW_ARGS_LENGTH = 4

export type CullResources = {
  sectionMeta: THREE.StorageBufferAttribute
  visibleFaces: THREE.StorageBufferAttribute
  /** IndirectStorageBufferAttribute of length 4; index 1 is the atomic instance counter. */
  drawArgs: THREE.IndirectStorageBufferAttribute
  /** 6 planes as vec4(nx, ny, nz, d), camera-relative. */
  frustumPlanes: THREE.StorageBufferAttribute
}

export type CullUniforms = ReturnType<typeof createCullUniforms>

export function createCullUniforms() {
  return {
    // vec3 + int() at use sites; see the matching note in cubeBlockNode.ts.
    sectionOriginRel: uniform(new THREE.Vector3(0, 0, 0)),
    originDelta: uniform(new THREE.Vector3(0, 0, 0)),
    cameraOriginFrac: uniform(new THREE.Vector3(0, 0, 0)),
    /** Set to 0 to bypass frustum culling (debug / parity checks). */
    frustumCullEnabled: uniform(1),
    /**
     * Set to 0 to emit every direction. Consumers whose sections have no per-direction run
     * counts (the legacy quad buffer) are handled automatically and don't need this.
     */
    faceDirectionCullEnabled: uniform(1)
  }
}

/**
 * Builds the compute node. Dispatch with
 * `renderer.computeAsync(node, [sectionCount * CULL_WORKGROUP_SIZE])`.
 */
export function createCullCompute(res: CullResources, u: CullUniforms = createCullUniforms()) {
  const metaBuf = storageTyped(res.sectionMeta, 'int', res.sectionMeta.count * SECTION_META_STRIDE).toReadOnly()
  const visibleBuf = storageTyped(res.visibleFaces, 'uint', res.visibleFaces.count)
  // Atomic access is required for the instanceCount reservation.
  const argsBuf = storageTyped(res.drawArgs, 'uint', DRAW_ARGS_LENGTH).toAtomic()
  const planesBuf = storageTyped(res.frustumPlanes, 'vec4', 6).toReadOnly()

  // Per-direction reservation, shared across the workgroup. Index 0 doubles as the single
  // run used when direction culling is off (see below), so one emission loop serves both.
  const sharedBase = workgroupArray('uint', FACE_DIRECTIONS)
  const sharedCount = workgroupArray('uint', FACE_DIRECTIONS)
  const sharedOffset = workgroupArray('uint', FACE_DIRECTIONS)

  const compute = Fn(() => {
    const section = workgroupId.x.toVar()
    const lane = localId.x.toVar()
    const metaBase = int(section).mul(int(SECTION_META_STRIDE)).toVar()

    const faceCount = uint(metaBuf.element(metaBase.add(int(4)))).toVar()
    const faceStart = uint(metaBuf.element(metaBase.add(int(3)))).toVar()

    // Lane 0 decides visibility and reserves the output range.
    If(lane.equal(uint(0)), () => {
      const visibleCount = uint(0).toVar()

      If(faceCount.greaterThan(uint(0)), () => {
        const sx = metaBuf.element(metaBase).toVar()
        const sy = metaBuf.element(metaBase.add(int(1))).toVar()
        const sz = metaBuf.element(metaBase.add(int(2))).toVar()

        // Section AABB in the same camera-relative space the vertex shader builds.
        const boxMin = vec3(
          float(sx.sub(int(u.sectionOriginRel.x)).mul(int(16))),
          float(sy.sub(int(u.sectionOriginRel.y)).mul(int(16))),
          float(sz.sub(int(u.sectionOriginRel.z)).mul(int(16)))
        )
          .add(u.originDelta)
          .sub(u.cameraOriginFrac)
          .toVar()
        const boxMax = boxMin.add(vec3(16)).toVar()

        const inside = int(1).toVar()
        Loop({ start: uint(0), end: uint(6), type: 'uint' }, ({ i }) => {
          const plane = planesBuf.element(i).toVar()
          // Positive vertex: the AABB corner furthest along the plane normal.
          const pv = vec3(
            plane.x.greaterThanEqual(float(0)).select(boxMax.x, boxMin.x),
            plane.y.greaterThanEqual(float(0)).select(boxMax.y, boxMin.y),
            plane.z.greaterThanEqual(float(0)).select(boxMax.z, boxMin.z)
          )
          If(plane.xyz.dot(pv).add(plane.w).lessThan(float(0)), () => {
            inside.assign(int(0))
          })
        })

        If(inside.equal(int(1)).or(u.frustumCullEnabled.lessThan(float(0.5))), () => {
          visibleCount.assign(faceCount)
        })

        // --- per-direction reservation ---
        // Faces are stored sorted by direction (see `sortFacesByDirection`), so each
        // direction is one contiguous run. A whole run can be skipped when the camera is
        // behind every face in it, which for a section outside the camera's cell removes
        // exactly the 3 directions that face away — about half the geometry, with no
        // per-face work at all.
        If(visibleCount.greaterThan(uint(0)), () => {
          const running = uint(0).toVar()

          // Unrolled: FACE_DIRECTIONS is a compile-time constant and each test touches a
          // different component, so there is nothing to gain from a dynamic loop.
          for (let d = 0; d < FACE_DIRECTIONS; d++) {
            const runCount = uint(metaBuf.element(metaBase.add(int(RUN_COUNTS_OFFSET + d)))).toVar()
            sharedOffset.element(uint(d)).assign(running)

            const visible = DIRECTION_VISIBLE[d](boxMin, boxMax)
            const take = uint(0).toVar()
            If(visible.or(u.faceDirectionCullEnabled.lessThan(float(0.5))), () => {
              take.assign(runCount)
            })

            sharedCount.element(uint(d)).assign(take)
            const base = uint(0).toVar()
            If(take.greaterThan(uint(0)), () => {
              base.assign(atomicAdd(argsBuf.element(uint(1)), take))
            })
            sharedBase.element(uint(d)).assign(base)

            running.addAssign(runCount)
          }

          // Direction culling off (or a consumer that never wrote run counts, e.g. the
          // legacy quad buffer): fall back to one run covering everything.
          If(running.equal(uint(0)), () => {
            sharedOffset.element(uint(0)).assign(uint(0))
            sharedCount.element(uint(0)).assign(visibleCount)
            sharedBase.element(uint(0)).assign(atomicAdd(argsBuf.element(uint(1)), visibleCount))
            for (let d = 1; d < FACE_DIRECTIONS; d++) {
              sharedCount.element(uint(d)).assign(uint(0))
            }
          })
        }).Else(() => {
          for (let d = 0; d < FACE_DIRECTIONS; d++) {
            sharedCount.element(uint(d)).assign(uint(0))
          }
        })
      }).Else(() => {
        for (let d = 0; d < FACE_DIRECTIONS; d++) {
          sharedCount.element(uint(d)).assign(uint(0))
        }
      })
    })

    workgroupBarrier()

    // Emit every reserved run. Runs are independent, so no further synchronisation.
    for (let d = 0; d < FACE_DIRECTIONS; d++) {
      const writeCount = node(sharedCount.element(uint(d))).toVar()
      If(writeCount.greaterThan(uint(0)), () => {
        const base = node(sharedBase.element(uint(d))).toVar()
        const runOffset = node(sharedOffset.element(uint(d))).toVar()
        const idx = lane.toVar()
        const iterations = writeCount.add(uint(CULL_WORKGROUP_SIZE - 1)).div(uint(CULL_WORKGROUP_SIZE)).toVar()

        Loop({ start: uint(0), end: iterations, type: 'uint' }, () => {
          If(idx.lessThan(writeCount), () => {
            visibleBuf.element(base.add(idx)).assign(faceStart.add(runOffset).add(idx))
          })
          idx.addAssign(uint(CULL_WORKGROUP_SIZE))
        })
      })
    }
  })

  return {
    node: compute().compute(1, [CULL_WORKGROUP_SIZE, 1, 1]),
    uniforms: u,
    /** Rebuild the dispatch for a given number of section slots. */
    dispatchFor: (sectionCount: number) => compute().compute(Math.max(1, sectionCount) * CULL_WORKGROUP_SIZE, [CULL_WORKGROUP_SIZE, 1, 1])
  }
}

/**
 * Allocates the indirect draw args buffer.
 * vertexCount is fixed at 6 (two triangles per face instance); instanceCount is the
 * atomic the cull pass accumulates and must be reset to 0 each frame.
 */
export function createDrawArgs(verticesPerFace: number): THREE.IndirectStorageBufferAttribute {
  const arr = new Uint32Array(DRAW_ARGS_LENGTH)
  arr[0] = verticesPerFace
  arr[1] = 0
  arr[2] = 0
  arr[3] = 0
  return new THREE.IndirectStorageBufferAttribute(arr, DRAW_ARGS_LENGTH)
}

/** Zeroes instanceCount before the cull pass. Cheap enough to do on the CPU each frame. */
export function resetDrawArgs(drawArgs: THREE.IndirectStorageBufferAttribute): void {
  const arr = drawArgs.array as Uint32Array
  arr[1] = 0
  drawArgs.needsUpdate = true
}

/** Extracts the 6 camera-relative frustum planes into the storage buffer. */
const _frustum = new THREE.Frustum()
const _viewProj = new THREE.Matrix4()

export function updateFrustumPlanes(planes: THREE.StorageBufferAttribute, camera: THREE.Camera): void {
  _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_viewProj)
  const arr = planes.array as Float32Array
  for (const [i, p] of _frustum.planes.entries()) {
    arr[i * 4] = p.normal.x
    arr[i * 4 + 1] = p.normal.y
    arr[i * 4 + 2] = p.normal.z
    arr[i * 4 + 3] = p.constant
  }
  planes.needsUpdate = true
}
