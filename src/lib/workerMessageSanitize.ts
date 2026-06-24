/**
 * Strip non–structured-clone values before Worker.postMessage (e.g. mineflayer `debug` on entities).
 */
export function sanitizeForWorkerPostMessage(value: unknown, depth = 0): unknown {
  if (depth > 16) return undefined
  if (value === null || value === undefined) return value

  const t = typeof value
  if (t === 'function' || t === 'symbol') return undefined
  if (t === 'bigint') return value.toString()
  if (t !== 'object') return value

  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
  }
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    return value.map(entry => sanitizeForWorkerPostMessage(entry, depth + 1)).filter(entry => entry !== undefined)
  }

  const record = value as Record<string, unknown>
  if (typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number' && !('w' in record)) {
    return { x: record.x, y: record.y, z: record.z }
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key === '_client' || key === '_events' || key === '_eventsCount') continue
    const sanitized = sanitizeForWorkerPostMessage(record[key], depth + 1)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

export function sanitizeWorkerEventArgs(args: unknown[]): unknown[] {
  return args.map(arg => sanitizeForWorkerPostMessage(arg))
}
