export function createGeometryIndexArray(indices: readonly number[]): Uint16Array | Uint32Array {
  let using32Array = false
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] > 65535) {
      using32Array = true
      break
    }
  }
  return using32Array ? new Uint32Array(indices) : new Uint16Array(indices)
}

export function appendGeometryIndices(
  target: number[],
  source: readonly number[],
  vertexOffset: number
): void {
  for (let index = 0; index < source.length; index++) {
    target.push(source[index] + vertexOffset)
  }
}
