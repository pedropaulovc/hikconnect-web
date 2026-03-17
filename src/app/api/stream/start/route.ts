import { NextResponse } from 'next/server'
import { StreamSession } from '@/lib/p2p/stream-session'
import { join } from 'path'
import { tmpdir } from 'os'
import { sessions } from '../sessions'

export async function POST(req: Request) {
  const body = await req.json()
  const { deviceSerial, channel = 1, streamType = 1 } = body

  if (!deviceSerial || typeof deviceSerial !== 'string') {
    return NextResponse.json({ error: 'deviceSerial is required' }, { status: 400 })
  }

  const sessionId = `${deviceSerial}-${channel}-${Date.now()}`
  const hlsDir = join(tmpdir(), 'hls', sessionId)

  const session = new StreamSession({
    stunHost: '43.130.155.63',
    stunPort: 6002,
    cas: {
      host: '34.194.209.167',
      port: 6500,
    },
    play: {
      busType: 1,           // 1 = live preview
      sessionKey: '',       // TODO: pull from HikConnect auth session
      streamType,           // 0 = main, 1 = sub
      channelNo: channel,
      streamSession: Date.now(),
    },
    hls: {
      outputDir: hlsDir,
      segmentDuration: 2,
    },
  })

  sessions.set(sessionId, session)

  try {
    await session.start()
  } catch (err) {
    sessions.delete(sessionId)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  return NextResponse.json({
    sessionId,
    playlistUrl: `/api/stream/${sessionId}/stream.m3u8`,
  })
}
