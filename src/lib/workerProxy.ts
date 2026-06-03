import { proxy, getVersion, subscribe } from 'valtio'
import { Vec3 } from 'vec3'

export function createWorkerProxy<T extends Record<string, (...args: any[]) => void | Promise<any>>>(handlers: T, channel?: MessagePort): { __workerProxy: T } {
  const target = channel ?? globalThis
  target.addEventListener('message', (event: any) => {
    const { type, args, msgId } = event.data
    if (handlers[type]) {
      const result = handlers[type](...args)
      if (result instanceof Promise) {
        void result.then((result) => {
          target.postMessage({
            type: 'result',
            msgId,
            args: [result]
          })
        })
      }
    }
  })
  return null as any
}

/**
 * in main thread
 * ```ts
 * // either:
 * import type { importedTypeWorkerProxy } from './worker'
 * // or:
 * type importedTypeWorkerProxy = import('./worker').importedTypeWorkerProxy
 *
 * const workerChannel = useWorkerProxy<typeof importedTypeWorkerProxy>(worker)
 * ```
 */
export const useWorkerProxy = <T extends { __workerProxy: Record<string, (...args: any[]) => void> }>(worker: Worker | MessagePort, autoTransfer = true): T['__workerProxy'] & {
  transfer: (...args: Transferable[]) => T['__workerProxy']
} => {
  let messageId = 0
  // in main thread
  return new Proxy({} as any, {
    get(target, prop) {
      if (prop === 'transfer') {
        return (...transferable: Transferable[]) => {
          return new Proxy({}, {
            get(target, prop) {
              return (...args: any[]) => {
                worker.postMessage({
                  type: prop,
                  args,
                }, transferable)
              }
            }
          })
        }
      }
      return (...args: any[]) => {
        const msgId = messageId++
        const transfer = autoTransfer ? args.filter(arg => {
          return arg instanceof ArrayBuffer || arg instanceof MessagePort
            || (typeof ImageBitmap !== 'undefined' && arg instanceof ImageBitmap)
            || (typeof OffscreenCanvas !== 'undefined' && arg instanceof OffscreenCanvas)
            || (typeof ImageData !== 'undefined' && arg instanceof ImageData)
        }) : []
        worker.postMessage({
          type: prop,
          msgId,
          args,
        }, transfer)
        return {
          // eslint-disable-next-line unicorn/no-thenable
          then(onfulfilled: (value: any) => void) {
            const handler = ({ data }: MessageEvent): void => {
              if (data.type === 'result' && data.msgId === msgId) {
                onfulfilled(data.args[0])
                worker.removeEventListener('message', handler as EventListener)
              }
            }
            worker.addEventListener('message', handler as EventListener)
          }
        }
      }
    }
  })
}

const DEBUG_SYNC = false

// rendererState: worker→main only; playerState: main→worker only. Applying ops on the
// receiver re-fires local subscribers; no echo loop while directions stay split.

type SyncDirection = 'toWorker' | 'fromWorker'

export type WireSyncOp =
  | { kind: 'set', path: (string | number | symbol)[], value: unknown }
  | { kind: 'delete', path: (string | number | symbol)[] }

type ValtioOp = readonly unknown[]

const currentWorkerSyncStats = { toWorker: 0, fromWorker: 0 }

let debugSyncStatsInterval: ReturnType<typeof setInterval> | null = null

const ensureDebugSyncStatsInterval = () => {
  if (debugSyncStatsInterval != null) return
  if (typeof window === 'undefined') return
  debugSyncStatsInterval = setInterval(() => {
    globalThis.debugWorkerSyncStats = { ...currentWorkerSyncStats }
    currentWorkerSyncStats.toWorker = 0
    currentWorkerSyncStats.fromWorker = 0
  }, 1000)
}

const bumpSyncStat = (direction: SyncDirection) => {
  ensureDebugSyncStatsInterval()
  if (direction === 'toWorker') {
    currentWorkerSyncStats.toWorker++
  } else {
    currentWorkerSyncStats.fromWorker++
  }
}

/** @internal vitest only */
export const resetWorkerSyncStatsForTest = () => {
  currentWorkerSyncStats.toWorker = 0
  currentWorkerSyncStats.fromWorker = 0
  if (debugSyncStatsInterval != null) {
    clearInterval(debugSyncStatsInterval)
    debugSyncStatsInterval = null
  }
}

/** @internal vitest only */
export const getWorkerSyncStatsForTest = () => ({ ...currentWorkerSyncStats })

const getSyncId = () => {
  return Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15)
}

export const setByPath = (target: any, path: (string | number | symbol)[], value: unknown) => {
  if (path.length === 0) return
  let cur = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = {}
    }
    cur = cur[key]
  }
  cur[path[path.length - 1]!] = value
}

export const deleteByPath = (target: any, path: (string | number | symbol)[]) => {
  if (path.length === 0) return
  let cur = target
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]!]
    if (cur == null) return
  }
  delete cur[path[path.length - 1]!]
}

export const prepareOpValueForTransfer = (value: any, worker: Worker): any => {
  if (value == null || typeof value !== 'object') {
    return value
  }

  if (value instanceof Vec3) {
    return { x: value.x, y: value.y, z: value.z, __restorer: 'Vec3' }
  }

  if (typeof value['prepareForTransfer'] === 'function') {
    return value['prepareForTransfer'](worker)
  }

  if (ArrayBuffer.isView(value)) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => prepareOpValueForTransfer(item, worker))
  }

  if (getVersion(value) !== undefined) {
    return cloneValtioObject(value)
  }

  const result = {} as any
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = prepareOpValueForTransfer(value[key], worker)
    }
  }
  return result
}

const wireOpsFromValtioOps = (ops: ValtioOp[], worker: Worker): WireSyncOp[] => {
  const wire: WireSyncOp[] = []
  for (const op of ops) {
    const kind = op[0]
    if (kind === 'delete') {
      wire.push({ kind: 'delete', path: op[1] as (string | number | symbol)[] })
    } else if (kind === 'set') {
      wire.push({
        kind: 'set',
        path: op[1] as (string | number | symbol)[],
        value: prepareOpValueForTransfer(op[2], worker)
      })
    }
  }
  return wire
}

export const sendWorkerSyncOps = (
  syncId: string,
  ops: ValtioOp[],
  worker: Worker,
  direction: SyncDirection,
  debugKey: string
) => {
  if (ops.length === 0) return
  const wire = wireOpsFromValtioOps(ops, worker)
  if (wire.length === 0) return
  try {
    worker.postMessage({ type: 'sync', syncId, ops: wire })
    if (direction === 'toWorker') {
      bumpSyncStat('toWorker')
    }
    if (DEBUG_SYNC) console.log(`sync ${debugKey}`, wire.length, 'ops')
  } catch (err) {
    console.error('Failed to send worker sync ops', err, debugKey)
    for (const op of wire) {
      if (op.kind === 'set') findProblemTransfer(op.value)
    }
  }
}

export const applySyncOps = (
  target: any,
  wireOps: WireSyncOp[],
  worker: Worker,
  countReceive: 'fromWorker' | false = false
) => {
  for (const op of wireOps) {
    if (op.kind === 'delete') {
      deleteByPath(target, op.path)
    } else {
      setByPath(target, op.path, restoreTransferred(op.value, [], worker, false, false))
    }
  }
  if (countReceive === 'fromWorker') {
    bumpSyncStat('fromWorker')
  }
}

/** Full snapshot for plain (non-Valtio) objects on interval sync only, e.g. nonReactiveState. */
const sendWorkerSyncSnapshot = (syncId: string, obj: any, worker: Worker, direction: SyncDirection, debugKey: string) => {
  try {
    const value = cloneValtioObject(obj)
    worker.postMessage({ type: 'sync', syncId, value })
    if (direction === 'toWorker') {
      bumpSyncStat('toWorker')
    }
    if (DEBUG_SYNC) console.log(`sync snapshot ${debugKey}`)
  } catch (err) {
    console.error('Failed to send worker sync snapshot', err, debugKey)
    findProblemTransfer(obj)
  }
}

const applySyncSnapshot = (target: any, patch: any, worker: Worker, countReceive: 'fromWorker' | false = false) => {
  Object.assign(target, restoreTransferred(patch, [], worker, false, false))
  if (countReceive === 'fromWorker') {
    bumpSyncStat('fromWorker')
  }
}

const setupObjectSync = (obj: any, originalObj: any, worker: Worker, isValtio: boolean, debugKey: string) => {
  const syncFromWorker = obj['__syncFromWorker'] || originalObj['__syncFromWorker']
  const syncToWorker = obj['__syncToWorker'] || originalObj['__syncToWorker']
  if (!syncToWorker && !syncFromWorker && !isValtio) return

  const syncId = getSyncId()
  obj['__syncId'] = syncId

  if (syncToWorker || isValtio) {
    if (isValtio && syncToWorker !== false) {
      subscribe(originalObj, (ops) => {
        sendWorkerSyncOps(syncId, ops as ValtioOp[], worker, 'toWorker', `toWorker:${debugKey}`)
      })
    }

    const interval = obj['__syncToWorkerInterval'] ?? originalObj['__syncToWorkerInterval'] ?? 0
    if (interval > 0 && !isValtio) {
      setInterval(() => {
        sendWorkerSyncSnapshot(syncId, originalObj, worker, 'toWorker', `toWorker:interval:${debugKey}`)
      }, interval)
    }
  }

  if (originalObj['__syncFromWorker']) {
    worker.addEventListener('message', (event: any) => {
      if (event.data.type === 'sync' && event.data.syncId === syncId) {
        if (event.data.ops) {
          applySyncOps(originalObj, event.data.ops, worker, 'fromWorker')
        } else if (event.data.value) {
          applySyncSnapshot(originalObj, event.data.value, worker, 'fromWorker')
        }
      }
    })
  }
}

const cloneValtioObject = (obj: any) => {
  if (getVersion(obj) === undefined) {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(cloneValtioObject)
  }

  if (typeof obj === 'object' && obj !== null) {
    const newObj = {} as any
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = cloneValtioObject(obj[key])
      }
    }
    return newObj
  }

  return obj
}

export const deepPrepareForTransfer = (obj: any, worker: Worker, autoRemoveMethods = true, _isRoot = true, _isInsideValtio = false) => {
  const originalObj = obj
  const newObj = {} as any

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (autoRemoveMethods && typeof obj[key] === 'function') {
        continue
      }

      // print a warning for Date, RegExp, Map, Set, WeakMap, WeakSet
      if (obj[key] instanceof Date || obj[key] instanceof RegExp || obj[key] instanceof Map || obj[key] instanceof Set || obj[key] instanceof WeakMap || obj[key] instanceof WeakSet) {
        console.warn(`Warning: ${key} is a ${typeof obj[key]}, which is not supported for transfer.`)
      }

      if (obj[key] instanceof Vec3) {
        newObj[key] = { x: obj[key].x, y: obj[key].y, z: obj[key].z }
        newObj[key]['__restorer'] = 'Vec3'
        continue
      }

      newObj[key] = obj[key]

      if (typeof obj[key] === 'object' && obj[key] !== null) {
        if (obj[key]['prepareForTransfer']) {
          newObj[key] = obj[key]['prepareForTransfer'](worker)
          continue
        }

        const isValtio = getVersion(obj[key]) !== undefined
        newObj[key] = isValtio ? cloneValtioObject(obj[key]) : obj[key]

        if (obj[key]['__syncFromWorker']) {
          newObj[key]['__syncFromWorker'] = true
        }
        if (obj[key]['__syncToWorker']) {
          newObj[key]['__syncToWorker'] = true
        }
        if (obj[key]['__syncFromWorkerInterval']) {
          newObj[key]['__syncFromWorkerInterval'] = obj[key]['__syncFromWorkerInterval']
        }
        if (obj[key]['__syncToWorkerInterval']) {
          newObj[key]['__syncToWorkerInterval'] = obj[key]['__syncToWorkerInterval']
        }

        // Try to enable sync main -> worker
        const tryEnableDefaultSync = obj[key]['__syncToWorker'] !== false && !_isInsideValtio && isValtio && !obj[key]['__syncFromWorker']
        newObj[key]['__syncToWorker'] ??= tryEnableDefaultSync
        if (isValtio) {
          newObj[key]['__valtio'] ??= true
        }

        if (newObj[key]['__syncToWorker'] && isValtio) {
          setupObjectSync(newObj[key], originalObj[key], worker, true, key)
          continue
        }
        if (newObj[key]['__syncFromWorker'] || newObj[key]['__syncToWorker']) {
          setupObjectSync(newObj[key], originalObj[key], worker, isValtio, key)
          continue
        }
        setupObjectSync(newObj[key], originalObj[key], worker, false, key)


        newObj[key] = deepPrepareForTransfer(newObj[key], worker, autoRemoveMethods, false, isValtio)
      }
    }
  }
  return newObj
}

export const findProblemTransfer = (obj: any, path: string[] = []) => {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (!obj[key]) continue
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        findProblemTransfer(obj[key], [...path, key])
      }
      try {
        structuredClone(obj[key])
      } catch (error) {
        console.error(error)
        console.log('Failed to clone for transfer', path.join('.'))
      }
    }
  }
}

// Tracks which syncIds already have listeners/timers wired, per worker, so a
// given synced object is never armed twice (prevents runaway interval/listener
// accumulation if a payload carrying __sync* flags is ever restored again).
const armedSyncIds = new WeakMap<Worker, Set<string>>()

const receiveSyncedObject = (obj: any, worker: Worker, debugKey: string) => {
  if (!obj['__syncId']) return
  const syncId = obj['__syncId']

  let armed = armedSyncIds.get(worker)
  if (!armed) {
    armed = new Set()
    armedSyncIds.set(worker, armed)
  }
  if (armed.has(syncId)) return
  armed.add(syncId)

  if (obj['__syncToWorker']) {
    worker.addEventListener('message', (event: any) => {
      if (event.data.type === 'sync' && event.data.syncId === syncId) {
        if (event.data.ops) {
          applySyncOps(obj, event.data.ops, worker)
        } else if (event.data.value) {
          applySyncSnapshot(obj, event.data.value, worker)
        }
      }
    })
  }

  if (obj['__syncFromWorker']) {
    if (obj['__valtio']) {
      subscribe(obj, (ops) => {
        sendWorkerSyncOps(syncId, ops as ValtioOp[], worker, 'fromWorker', `fromWorker:${debugKey}`)
      })
    }

    const interval = obj['__syncFromWorkerInterval'] ?? 0
    if (interval > 0 && !obj['__valtio']) {
      setInterval(() => {
        sendWorkerSyncSnapshot(syncId, obj, worker, 'fromWorker', `fromWorker:interval:${debugKey}`)
      }, interval)
    }
  }
}

const defaultRestorers = [
  {
    restorerName: 'Vec3',
    restoreTransferred(obj, worker: Worker) {
      return new Vec3(obj.x, obj.y, obj.z)
    }
  }
]

export const addDefaultRestorer = (restorer: { restorerName: string, restoreTransferred: (obj: any, worker: Worker) => any }) => {
  defaultRestorers.unshift(restorer)
}

export const restoreTransferred = (obj: any, restorersArg: any[], worker: Worker, errorHandler: ((error: Error) => void) | boolean = true, armSync = true) => {
  const restorers = [...defaultRestorers, ...restorersArg]

  const restoreValue = (value: any, debugKey: string): any => {
    if (value == null || typeof value !== 'object') {
      return value
    }

    if (value['__restorer']) {
      const restorer = restorers.find(r => {
        return r.restorerName ? r.restorerName === value['__restorer'] : r.name === value['__restorer']
      })
      if (restorer) {
        return restorer.restoreTransferred(value, worker)
      }
      const error = new Error(`Restorer ${value['__restorer']} not found`)
      if (typeof errorHandler === 'function') {
        errorHandler(error)
      } else if (errorHandler) {
        throw error
      } else {
        console.error(error)
      }
      return value
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => restoreValue(item, `${debugKey}[${index}]`))
    }

    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      const child = value[key]
      if (child != null && typeof child === 'object') {
        value[key] = restoreValue(child, `${debugKey}.${key}`)
      }
    }

    if (value['__valtio']) {
      value = proxy(value)
    }

    if (armSync) receiveSyncedObject(value, worker, debugKey)
    return value
  }

  return restoreValue(obj, 'root')
}

// const workerProxy = createWorkerProxy({
//     startRender (canvas: HTMLCanvasElement) {
//     },
// })

// const worker = useWorkerProxy(null, workerProxy)

// worker.
