import { NextResponse } from 'next/server'
import { join } from 'path'
import { tmpdir } from 'os'
import { LiveStream } from '@/lib/p2p/live-stream'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { extractUserId } from '@/lib/hikconnect/client'
import { randomClientId } from '@/lib/p2p/client-id'
import { sessions } from '../sessions'

/**
 * POST /api/stream/playback
 * Start a playback stream for a specific recording time range.
 */
export async function POST(req: Request) {
  const body = await req.json()
  const {
    deviceSerial,
    channel = 1,
    startTime,
    stopTime,
  } = body

  if (!deviceSerial) {
    return NextResponse.json({ error: 'deviceSerial is required' }, { status: 400 })
  }

  if (!startTime || !stopTime) {
    return NextResponse.json({ error: 'startTime and stopTime are required' }, { status: 400 })
  }

  const sessionId = `pb-${deviceSerial}-${channel}-${Date.now()}`
  const hlsDir = join(tmpdir(), 'hls', sessionId)

  try {
    const client = getAuthenticatedClient()
    const p2pConfig = await client.getP2PConfig(deviceSerial)
    const secret = await client.getP2PSecret()
    const p2pLinkKey = Buffer.from(p2pConfig.secretKey.substring(0, 32), 'ascii')
    const stream = new LiveStream({
      deviceSerial,
      deviceIp: p2pConfig.connection.netIp || p2pConfig.connection.wanIp,
      devicePort: p2pConfig.connection.netStreamPort,
      p2pServers: secret.servers.map(s => ({ host: s.ip, port: s.port })),
      p2pKey: secret.key,
      p2pLinkKey,
      p2pKeyVersion: p2pConfig.keyVersion,
      p2pKeySaltIndex: secret.saltIndex,
      p2pKeySaltVer: secret.saltVer,
      sessionToken: client.getSession()!.sessionId,
      userId: extractUserId(client.getSession()!.sessionId),
      clientId: randomClientId(),
      channelNo: channel,
      streamType: 0, // main stream for playback
      // localPublicIp omitted — P2P server derives our NAT-mapped address from UDP source
      busType: 2, // playback mode
      startTime,
      stopTime,
      hls: {
        outputDir: hlsDir,
        segmentDuration: 4,
        quality: 'main', // playback uses streamType 0 (main); avoids 360p downscale on the libx264 fallback
      },
    })

    sessions.set(sessionId, stream)

    stream.on('stateChange', ({ to }: { from: string; to: string }) => {
      if (to === 'stopped' || to === 'error') {
        sessions.delete(sessionId)
      }
    })

    // LiveStream emits 'error' on a P2P/stream failure after start() resolves. A
    // Node EventEmitter 'error' with no listener is rethrown uncaught and would
    // crash the worker — so handle it: log and tear the stream down (releasing
    // the P2P socket + ffmpeg; the stateChange handler drops the session entry).
    stream.on('error', (err: Error) => {
      console.error(`[stream ${sessionId}] ${err.message}`)
      void stream.stop()
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
