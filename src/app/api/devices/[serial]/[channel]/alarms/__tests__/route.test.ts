import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AlarmPageResult } from '@/lib/hikconnect/alarms'

const getAlarms = vi.fn()
vi.mock('@/lib/hikconnect/getClient', () => ({
  getAuthenticatedClient: () => ({ getAlarms }),
}))

import { GET } from '../route'

const params = (serial: string, channel: string) => ({ params: Promise.resolve({ serial, channel }) })

beforeEach(() => { getAlarms.mockReset() })

describe('GET /api/devices/[serial]/[channel]/alarms', () => {
  it('400s when the time range is missing', async () => {
    const res = await GET(new Request('http://x/api?offset=0'), params('L38239367', '1'))
    expect(res.status).toBe(400)
  })

  it('filters by channel and returns events + cursor', async () => {
    const result: AlarmPageResult = {
      alarms: [
        { alarmId: 'a', channelNo: 1, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '', alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0 },
        { alarmId: 'b', channelNo: 5, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '', alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0 },
      ],
      page: { offset: 0, limit: 50, totalResults: 100, hasNext: false },
    }
    getAlarms.mockResolvedValue(result)
    const url = 'http://x/api?alarmStart=2026-06-03 00:00:00&alarmEnd=2026-06-03 13:00:00&offset=0&limit=15'
    const res = await GET(new Request(url), params('L38239367', '1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].channelNo).toBe(1)
    expect(body.hasMore).toBe(false)
    expect(typeof body.nextOffset).toBe('number')
    expect(getAlarms).toHaveBeenCalledWith('L38239367', expect.objectContaining({
      alarmStart: '2026-06-03 00:00:00', alarmEnd: '2026-06-03 13:00:00', limit: 50,
    }))
  })

  it('500s when the client throws', async () => {
    getAlarms.mockRejectedValue(new Error('boom'))
    const url = 'http://x/api?alarmStart=a&alarmEnd=b'
    const res = await GET(new Request(url), params('L38239367', '1'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })
})
