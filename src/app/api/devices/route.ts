// src/app/api/devices/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET() {
  try {
    const client = getAuthenticatedClient()
    const devices = await client.getDevices()
    return NextResponse.json({ devices })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to fetch devices'
    const status = message === 'Not authenticated' ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
