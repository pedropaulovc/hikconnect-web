import { NextResponse } from 'next/server'
import { sessions } from '../sessions'

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

  session.stop()
  sessions.delete(sessionId)

  return NextResponse.json({ stopped: true })
}
