// src/app/api/devices/[serial]/[channel]/alarms/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { collectChannelAlarms } from '@/lib/hikconnect/alarms'

const DEVICE_PAGE = 50
const MAX_PAGES = 4

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const alarmStart = url.searchParams.get('alarmStart') ?? ''
    const alarmEnd = url.searchParams.get('alarmEnd') ?? ''
    if (!alarmStart || !alarmEnd) {
      return NextResponse.json({ error: 'alarmStart and alarmEnd required' }, { status: 400 })
    }
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const want = Number(url.searchParams.get('limit') ?? '15')

    const client = getAuthenticatedClient()
    const result = await collectChannelAlarms(
      (o) => client.getAlarms(serial, { alarmStart, alarmEnd, offset: o, limit: DEVICE_PAGE }),
      Number(channel), offset, want, { devicePage: DEVICE_PAGE, maxPages: MAX_PAGES },
    )
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
