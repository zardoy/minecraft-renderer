import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Serialize any output object for snapshot comparison
 * Converts TypedArrays to regular arrays for JSON serialization
 */
export function serializeOutput(output: any): any {
  const serialized: any = {}
  for (const [key, value] of Object.entries(output)) {
    if (value instanceof Float32Array || value instanceof Uint32Array || value instanceof Uint16Array || value instanceof Uint8Array) {
      serialized[key] = Array.from(value as any)
    } else if (value instanceof ArrayBuffer) {
      serialized[key] = Array.from(new Uint8Array(value))
    } else if (typeof value === 'object' && value !== null) {
      serialized[key] = serializeOutput(value)
    } else {
      serialized[key] = value
    }
  }
  return serialized
}

/**
 * Deep equality comparison for snapshot testing
 */
export function deepEqual(obj1: any, obj2: any): boolean {
  if (obj1 === obj2) return true
  if (obj1 == null || obj2 == null) return false
  if (typeof obj1 !== typeof obj2) return false

  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) return false
    for (let i = 0; i < obj1.length; i++) {
      if (!deepEqual(obj1[i], obj2[i])) return false
    }
    return true
  }

  if (typeof obj1 === 'object') {
    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)
    if (keys1.length !== keys2.length) return false
    for (const key of keys1) {
      if (!keys2.includes(key)) return false
      if (!deepEqual(obj1[key], obj2[key])) return false
    }
    return true
  }

  return false
}

/**
 * Compare output with snapshot file, or write snapshot if it doesn't exist
 * @param output - The output object to compare/write
 * @param snapshotPath - Path to snapshot file (absolute or relative to __dirname)
 * @param baseDir - Base directory for relative paths (defaults to __dirname, ignored if snapshotPath is absolute)
 * @returns true if snapshot matches or was created, throws error if mismatch
 */
export function compareOrWriteSnapshot(
  output: any,
  snapshotPath: string,
  baseDir?: string
): boolean {
  // If path is absolute, use it directly; otherwise join with baseDir or __dirname
  const fullPath = snapshotPath.startsWith('/') || snapshotPath.includes(':')
    ? snapshotPath
    : baseDir ? join(baseDir, snapshotPath) : join(__dirname, snapshotPath)
  const serialized = serializeOutput(output)

  if (!existsSync(fullPath)) {
    // Write snapshot if file doesn't exist
    writeFileSync(fullPath, JSON.stringify(serialized, null, 2), 'utf-8')
    console.log('Snapshot file created:', fullPath)
    return true
  } else {
    // Compare with existing snapshot
    const snapshotContent = readFileSync(fullPath, 'utf-8')
    const snapshotData = JSON.parse(snapshotContent)

    if (!deepEqual(serialized, snapshotData)) {
      console.error('Snapshot mismatch! Current output differs from snapshot.')
      // console.error('Expected (snapshot):', JSON.stringify(snapshotData, null, 2))
      // console.error('Actual (current):', JSON.stringify(serialized, null, 2))
      throw new Error('Snapshot comparison failed - output has changed')
    }

    console.log('Snapshot comparison passed - no changes detected')
    return true
  }
}
