// src/app/api/devices/[serial]/[channel]/recordings/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const startTime = url.searchParams.get('startTime') ?? ''
    const stopTime = url.searchParams.get('stopTime') ?? ''
    if (!startTime || !stopTime) {
      return NextResponse.json({ error: 'startTime and stopTime required' }, { status: 400 })
    }
    const client = getAuthenticatedClient()
    const files = await client.getRecordings(serial, Number(channel), startTime, stopTime)
    return NextResponse.json({ files })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
