import { subscribeKey } from 'valtio/utils'

// eslint-disable-next-line max-params
export function watchProperty<T extends Record<string, any>, K>(
  asyncGetter: (value: T[keyof T]) => Promise<K>,
  valtioProxy: T,
  key: keyof T,
  readySetter: (res: K) => void,
  cleanup?: (res: K) => void
) {
  let i = 0
  let lastRes: K | undefined
  const request = async () => {
    const req = ++i
    const res = await asyncGetter(valtioProxy[key])
    if (req === i) {
      if (lastRes) {
        cleanup?.(lastRes)
      }
      readySetter(res)
      lastRes = res
    } else {
      // rejected
      cleanup?.(res)
    }
  }
  void request()
  return subscribeKey(valtioProxy, key, request)
}
