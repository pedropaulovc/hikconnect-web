// src/app/api/devices/[serial]/cameras/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string }> }) {
  try {
    const { serial } = await params
    const client = getAuthenticatedClient()
    const cameras = await client.getCameras(serial)
    return NextResponse.json({ cameras })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
