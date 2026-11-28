import { describe, expect, it } from 'vitest'
import { MesherResultQueue } from './mesherResultQueue'

const drain = (queue: MesherResultQueue) => {
  const out: string[] = []
  for (let m = queue.shift(); m !== undefined; m = queue.shift()) out.push(`${m.type}:${m.key}`)
  return out
}

describe('MesherResultQueue', () => {
  it('keeps arrival order without urgent results', () => {
    const queue = new MesherResultQueue()
    queue.push({ type: 'geometry', key: '0,0,0' })
    queue.push({ type: 'heightmap', key: '0,0' })
    queue.push({ type: 'sectionFinished', key: '0,0,0' })
    expect(drain(queue)).toEqual(['geometry:0,0,0', 'heightmap:0,0', 'sectionFinished:0,0,0'])
  })

  it('handles block change results before queued chunk-load results', () => {
    const queue = new MesherResultQueue()
    for (let i = 0; i < 3; i++) queue.push({ type: 'geometry', key: `${i * 16},0,0` })
    queue.push({ type: 'geometry', key: '0,16,0', urgent: true })
    queue.push({ type: 'sectionFinished', key: '0,16,0', urgent: true })
    expect(queue.urgentLength).toBe(2)
    expect(drain(queue)).toEqual(['geometry:0,16,0', 'sectionFinished:0,16,0', 'geometry:0,0,0', 'geometry:16,0,0', 'geometry:32,0,0'])
  })

  it("takes the section's earlier queued results along, so one section's results stay in order", () => {
    const queue = new MesherResultQueue()
    queue.push({ type: 'geometry', key: '0,0,0' })
    queue.push({ type: 'geometry', key: '16,0,0' })
    queue.push({ type: 'sectionFinished', key: '16,0,0' })
    queue.push({ type: 'geometry', key: '16,0,0', urgent: true })
    // a later plain result of the same section comes after the urgent one
    queue.push({ type: 'sectionFinished', key: '16,0,0' })
    expect(queue.countKey('16,0,0')).toBe(4)
    expect(drain(queue)).toEqual(['geometry:16,0,0', 'sectionFinished:16,0,0', 'geometry:16,0,0', 'geometry:0,0,0', 'sectionFinished:16,0,0'])
  })

  it('clear empties both queues', () => {
    const queue = new MesherResultQueue()
    queue.push({ type: 'geometry', key: '0,0,0' })
    queue.push({ type: 'geometry', key: '16,0,0', urgent: true })
    queue.clear()
    expect(queue.length).toBe(0)
    expect(queue.shift()).toBeUndefined()
  })
})
