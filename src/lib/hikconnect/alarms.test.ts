import { describe, it, expect, vi } from 'vitest'
import { collectChannelAlarms } from './alarms'
import type { AlarmEvent, AlarmPage } from './types'

// Minimal alarm factory — only channelNo matters for filtering.
const ev = (channelNo: number, alarmId = `${channelNo}`): AlarmEvent => ({
  alarmId, channelNo, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '',
  alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0,
})
const page = (offset: number, hasNext: boolean): AlarmPage => ({ offset, limit: 50, totalResults: 100, hasNext })

describe('collectChannelAlarms', () => {
  it('filters a single device page by channelNo', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1), ev(5), ev(1), ev(7)], page: page(offset, false) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 4 })
    expect(r.events.map(e => e.channelNo)).toEqual([1, 1])
    expect(r.hasMore).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('accumulates across pages until want is reached', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({
      alarms: [ev(1), ev(5), ev(1)],            // 2 channel-1 matches per page
      page: page(offset, true),
    }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 3, { devicePage: 50, maxPages: 4 })
    expect(r.events).toHaveLength(4)            // scanned 2 pages (2 + 2 >= want=3)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(r.nextOffset).toBe(100)             // 0 -> page.offset(50)+50
    expect(r.hasMore).toBe(true)
  })

  it('stops at maxPages for a sparse channel and reports hasMore', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(9)], page: page(offset, true) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 3 })
    expect(r.events).toHaveLength(0)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(r.hasMore).toBe(true)
    expect(r.nextOffset).toBe(150)
  })

  it('stops when the device reports no more pages', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1)], page: page(offset, false) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 4 })
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(r.hasMore).toBe(false)
  })

  it('advances the cursor from the snapped page.offset (offset quantization)', async () => {
    // Server snaps requested offset 95 down to 50.
    const fetchPage = vi.fn(async (_requested: number) => ({ alarms: [ev(1)], page: page(50, true) }))
    const r = await collectChannelAlarms(fetchPage, 1, 95, 1, { devicePage: 50, maxPages: 4 })
    expect(r.nextOffset).toBe(100)             // snapped 50 + devicePage 50
  })

  it('starts from the given offset', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1)], page: page(offset, false) }))
    await collectChannelAlarms(fetchPage, 1, 200, 15, { devicePage: 50, maxPages: 4 })
    expect(fetchPage).toHaveBeenCalledWith(200)
  })
})
