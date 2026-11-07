/**
 * Thin compatibility layer over TSL.
 *
 * `@types/three` is hand-maintained on DefinitelyTyped and its TSL surface lags the
 * runtime: `storage()` is only typed for float|uint|vec2|vec3|vec4|Struct, while the
 * runtime also accepts `uvec4`, `ivec3`, `int`, etc. Node arithmetic typings are likewise
 * partial, so chained bit ops on a correctly-typed int node can fail to resolve.
 *
 * Rather than sprinkling `as any` through the shader bodies (where it would hide genuine
 * mistakes), the casts are isolated here and named, so the shaders stay readable and the
 * places we're ahead of the typings are explicit.
 */

import { storage, ivec2 } from 'three/tsl'
import type * as THREE from 'three/webgpu'

/** TSL scalar/vector type names accepted by the runtime `storage()`. */
export type StorageScalarType = 'float' | 'int' | 'uint' | 'vec2' | 'vec3' | 'vec4' | 'ivec2' | 'ivec3' | 'ivec4' | 'uvec2' | 'uvec3' | 'uvec4'

type AnyStorageAttribute = THREE.StorageBufferAttribute | THREE.StorageInstancedBufferAttribute | THREE.IndirectStorageBufferAttribute

/**
 * `storage()` with the full runtime type set. Returns `any` because the node graph's
 * element/atomic accessors are only partially typed.
 */
export function storageTyped(attribute: AnyStorageAttribute, type: StorageScalarType, count: number): any {
  return (storage as any)(attribute, type, count)
}

/** Marks an expression as an untyped TSL node (typings gap, not a correctness escape). */
export const node = (value: any): any => value

/**
 * `ivec2()` accepting node arguments. The typed overloads only cover numeric literals
 * and a couple of node shapes, so texture-size / UV conversions don't resolve.
 */
export const ivec2n = (...args: any[]): any => (ivec2 as any)(...args)
