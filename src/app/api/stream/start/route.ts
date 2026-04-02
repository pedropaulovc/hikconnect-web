import { NextResponse } from 'next/server'
import { join } from 'path'
import { tmpdir } from 'os'
import { LiveStream } from '@/lib/p2p/live-stream'
import { P2P_SERVER_KEY } from '@/lib/p2p/p2p-session'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { extractUserId } from '@/lib/hikconnect/client'
import { sessions, deviceLastStop, DEVICE_COOLDOWN_MS } from '../sessions'

export async function POST(req: Request) {
  const body = await req.json()
  const {
    deviceSerial,
    channel = 1,
    quality = 'sub',
  } = body
  // Hik-Connect device stream types (from Frida RE on Android app):
  // 1 = HD (main/4K), 2 = SD (sub/360p)
  const streamType = quality === 'main' ? 1 : 2

  if (!deviceSerial || typeof deviceSerial !== 'string') {
    return NextResponse.json({ error: 'deviceSerial is required' }, { status: 400 })
  }

  // Enforce per-device cooldown — NVR needs time to release P2P stream slots after teardown
  const lastStop = deviceLastStop.get(deviceSerial)
  if (lastStop) {
    const elapsed = Date.now() - lastStop
    if (elapsed < DEVICE_COOLDOWN_MS) {
      const remaining = Math.ceil((DEVICE_COOLDOWN_MS - elapsed) / 1000)
      return NextResponse.json(
        { error: `Device needs ${remaining}s cooldown before next stream` },
        { status: 429 },
      )
    }
  }

  const sessionId = `${deviceSerial}-${channel}-${Date.now()}`
  const hlsDir = join(tmpdir(), 'hls', sessionId)

  try {
    // Get P2P config from API
    const client = getAuthenticatedClient()
    const p2pConfig = await client.getP2PConfig(deviceSerial)

    const p2pLinkKey = Buffer.from(p2pConfig.secretKey.substring(0, 32), 'ascii')
    const stream = new LiveStream({
      deviceSerial,
      deviceIp: p2pConfig.connection.netIp || p2pConfig.connection.wanIp,
      devicePort: p2pConfig.connection.netStreamPort || 9020,
      p2pServers: p2pConfig.servers.map(s => ({ host: s.ip, port: s.port })),
      p2pKey: P2P_SERVER_KEY,
      p2pLinkKey,
      p2pKeyVersion: p2pConfig.keyVersion || 101,
      p2pKeySaltIndex: 3,
      p2pKeySaltVer: 1,
      sessionToken: client.getSession()!.sessionId,
      userId: extractUserId(client.getSession()!.sessionId),
      clientId: 0x0aed13f5, // TODO: fetch from API
      channelNo: channel,
      streamType,
      // localPublicIp omitted — P2P server derives our NAT-mapped address from UDP source
      hls: {
        outputDir: hlsDir,
        segmentDuration: 2,
        quality: quality === 'main' ? 'main' as const : 'sub' as const,
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
