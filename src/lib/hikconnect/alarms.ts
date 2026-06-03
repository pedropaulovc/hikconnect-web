import type { AlarmEvent, AlarmPage } from './types'

export type AlarmPageResult = { alarms: AlarmEvent[]; page: AlarmPage }
export type ChannelAlarms = { events: AlarmEvent[]; nextOffset: number; hasMore: boolean }

/**
 * Accumulate alarms for one channel from the device-wide /v3/alarms/advanced stream.
 *
 * The endpoint has no channel param and offset is page-quantized to `limit`, so we pull
 * device pages, filter by channelNo, and advance the cursor as page.offset + devicePage
 * (page-aligned, snap-proof). Stops at >= want matches, when the device has no more pages,
 * or after maxPages (bounds latency for sparse channels). Pure: takes a fetchPage callback.
 */
export async function collectChannelAlarms(
  fetchPage: (offset: number) => Promise<AlarmPageResult>,
  channelNo: number,
  startOffset: number,
  want: number,
  opts: { devicePage: number; maxPages: number },
): Promise<ChannelAlarms> {
  const events: AlarmEvent[] = []
  let offset = startOffset
  let hasMore = false

  for (let i = 0; i < opts.maxPages; i++) {
    const { alarms, page } = await fetchPage(offset)
    events.push(...alarms.filter(a => a.channelNo === channelNo))
    offset = page.offset + opts.devicePage

    if (!page.hasNext) {
      hasMore = false
      break
    }
    hasMore = true
    if (events.length >= want) break
  }

  return { events, nextOffset: offset, hasMore }
}
