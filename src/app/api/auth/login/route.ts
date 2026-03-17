// src/app/api/auth/login/route.ts
import { NextResponse } from 'next/server'
import { HikConnectClient, sessionStore } from '@/lib/hikconnect'

export async function POST(request: Request) {
  const body = await request.json()
  const { account, password } = body

  if (!account || !password) {
    return NextResponse.json({ error: 'account and password required' }, { status: 400 })
  }

  const client = new HikConnectClient({
    baseUrl: process.env.HIKCONNECT_BASE_URL ?? 'https://api.hik-connect.com',
  })

  try {
    const session = await client.login({ account, password })
    sessionStore.set(session)
    return NextResponse.json({ ok: true, apiDomain: session.apiDomain })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Login failed'
    return NextResponse.json({ error: message }, { status: 401 })
  }
}
