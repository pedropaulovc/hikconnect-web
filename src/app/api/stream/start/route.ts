import { NextResponse } from 'next/server'
import { join } from 'path'
import { tmpdir } from 'os'
import { LiveStream } from '@/lib/p2p/live-stream'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { getPublicIp } from '@/lib/utils/public-ip'
import { sessions } from '../sessions'

export async function POST(req: Request) {
  const body = await req.json()
  const {
    deviceSerial,
    channel = 1,
    streamType = 1,
    verificationCode = 'ABCDEF',
  } = body

  if (!deviceSerial || typeof deviceSerial !== 'string') {
    return NextResponse.json({ error: 'deviceSerial is required' }, { status: 400 })
  }

  const sessionId = `${deviceSerial}-${channel}-${Date.now()}`
  const hlsDir = join(tmpdir(), 'hls', sessionId)

  try {
    // Get P2P config from API
    const client = getAuthenticatedClient()
    const p2pConfig = await client.getP2PConfig(deviceSerial)

    // Parse P2P key from hex-encoded secret key
    const p2pKey = Buffer.from(p2pConfig.secretKey, 'hex')

    const p2pLinkKey = Buffer.from(p2pConfig.secretKey.substring(0, 32), 'ascii')
    const stream = new LiveStream({
      deviceSerial,
      deviceIp: p2pConfig.connection.netIp || p2pConfig.connection.wanIp,
      devicePort: p2pConfig.connection.netStreamPort || 9020,
      p2pServers: p2pConfig.servers.map(s => ({ host: s.ip, port: s.port })),
      p2pKey,
      p2pLinkKey,
      p2pKeyVersion: p2pConfig.keyVersion || 101,
      p2pKeySaltIndex: 3,
      p2pKeySaltVer: 1,
      sessionToken: client.getSession()!.sessionId,
      userId: '', // TODO: extract from session JWT
      clientId: 0x0aed13f5, // TODO: fetch from API
      channelNo: channel,
      streamType,
      verificationCode,
      localPublicIp: await getPublicIp(),
      hls: {
        outputDir: hlsDir,
        segmentDuration: 2,
      },
    })

    sessions.set(sessionId, stream)

    stream.on('stateChange', ({ to }: { from: string; to: string }) => {
      if (to === 'stopped' || to === 'error') {
        sessions.delete(sessionId)
      }
    })

    await stream.start()

    return NextResponse.json({
      sessionId,
      playlistUrl: `/api/stream/${sessionId}/stream.m3u8`,
    })
  } catch (err) {
    sessions.delete(sessionId)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
