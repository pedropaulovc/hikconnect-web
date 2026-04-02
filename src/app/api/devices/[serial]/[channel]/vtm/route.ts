// src/app/api/devices/[serial]/[channel]/vtm/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const client = getAuthenticatedClient()
    const vtm = await client.getVtmInfo(serial, Number(channel))
    return NextResponse.json({ vtm })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
