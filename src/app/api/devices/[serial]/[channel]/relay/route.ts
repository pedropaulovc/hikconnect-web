// src/app/api/devices/[serial]/[channel]/relay/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const type = url.searchParams.get('type') ?? 'relay'
    const client = getAuthenticatedClient()
    const config = await client.getRelayServer(type, serial, Number(channel))
    return NextResponse.json({ config })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
