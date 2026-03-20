import { NextResponse } from 'next/server'
import { sessions, deviceLastStop } from '../sessions'

export async function POST(req: Request) {
  const body = await req.json()
  const { sessionId } = body

  if (!sessionId || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
  }

  const session = sessions.get(sessionId)
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  await session.stop()
  sessions.delete(sessionId)

  // Record stop time for per-device cooldown enforcement
  const deviceSerial = sessionId.split('-')[0]
  deviceLastStop.set(deviceSerial, Date.now())

  return NextResponse.json({ stopped: true })
}
