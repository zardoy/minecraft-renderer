import * as THREE from 'three'

export class SceneOrigin {
  // World coordinates of origin in float64 (JavaScript number)
  private _x = 0
  private _y = 0
  private _z = 0

  get x(): number { return this._x }
  get y(): number { return this._y }
  get z(): number { return this._z }

  /** Update origin (called each frame with camera world position) */
  update(worldX: number, worldY: number, worldZ: number): void {
    this._x = worldX
    this._y = worldY
    this._z = worldZ
  }

  /** Convert world coordinates → scene coordinates */
  toSceneX(worldX: number): number { return worldX - this._x }
  toSceneY(worldY: number): number { return worldY - this._y }
  toSceneZ(worldZ: number): number { return worldZ - this._z }

  /** Convert scene coordinates → world coordinates */
  toWorldX(sceneX: number): number { return sceneX + this._x }
  toWorldY(sceneY: number): number { return sceneY + this._y }
  toWorldZ(sceneZ: number): number { return sceneZ + this._z }

  /** Set position of a Three.js object from world coordinates */
  setPositionFromWorld(
    obj: THREE.Object3D,
    worldX: number, worldY: number, worldZ: number
  ): void {
    obj.position.set(
      worldX - this._x,
      worldY - this._y,
      worldZ - this._z
    )
  }
}
