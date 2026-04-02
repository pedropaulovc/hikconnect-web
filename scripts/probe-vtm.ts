/**
 * Phase 2: Probe the VTM and relay servers to understand the protocol.
 *
 * Usage: export $(grep -v '^#' .env.local | xargs) && npx tsx scripts/probe-vtm.ts
 */
import { HikConnectClient } from '../src/lib/hikconnect/client'
import * as net from 'node:net'
import * as tls from 'node:tls'

const account = process.env.HIKCONNECT_ACCOUNT!
const password = process.env.HIKCONNECT_PASSWORD!

async function probe() {
  // Step 1: Get fresh session + stream params
  console.log('=== Step 1: Authenticate and get stream params ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account, password })
  console.log('Session:', session.sessionId.substring(0, 20) + '...')

  const devices = await client.getDevices()
  const device = devices[0]
  console.log('Device:', device.deviceSerial, device.name)

  const cameras = await client.getCameras(device.deviceSerial)
  const cam = cameras[0]
  console.log('Camera:', cam.channelNo, cam.cameraName)

  const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
  console.log('Ticket:', ticket.substring(0, 30) + '...')
  console.log('Ticket (full, base64):', ticket)

  const vtm = await client.getVtmInfo(device.deviceSerial, cam.channelNo)
  console.log('VTM:', vtm.externalIp, ':', vtm.port)

  let relay
  try {
    relay = await client.getRelayServer('relay', device.deviceSerial, cam.channelNo)
    console.log('Relay:', relay.externalIp, ':', relay.port)
  } catch {
    console.log('No relay server available')
  }

  // Step 2: Try RTSP on VTM port (8554 is standard RTSP)
  console.log('\n=== Step 2: Probe VTM server (RTSP?) ===')
  await probeRtsp(vtm.externalIp, vtm.port, device.deviceSerial, cam.channelNo, ticket)

  // Step 3: Try raw TCP to VTM
  console.log('\n=== Step 3: Raw TCP to VTM ===')
  await probeTcp(vtm.externalIp, vtm.port, 'VTM')

  // Step 4: Try raw TCP to relay
  if (relay) {
    console.log('\n=== Step 4: Raw TCP to Relay ===')
    await probeTcp(relay.externalIp, relay.port, 'Relay')
  }

  // Step 5: Try TLS to VTM
  console.log('\n=== Step 5: TLS to VTM ===')
  await probeTls(vtm.externalIp, vtm.port, 'VTM')
}

async function probeRtsp(ip: string, port: number, serial: string, channel: number, ticket: string) {
  // Try various RTSP URL patterns
  const urls = [
    `rtsp://${ip}:${port}/${serial}/${channel}`,
    `rtsp://${ip}:${port}/Streaming/Channels/${channel}01`,
    `rtsp://${ip}:${port}/${serial}`,
    `rtsp://${ip}:${port}/live`,
  ]

  for (const url of urls) {
    console.log(`  Trying DESCRIBE ${url}`)
    try {
      const result = await sendRtsp(ip, port, `DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`)
      console.log(`  Response: ${result.substring(0, 200)}`)
      if (result.includes('RTSP/1.0 200') || result.includes('RTSP/1.0 401')) {
        console.log('  >>> RTSP SERVER DETECTED!')
        return
      }
    } catch (e) {
      console.log(`  Error: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Also try OPTIONS (no URL needed)
  console.log(`  Trying OPTIONS`)
  try {
    const result = await sendRtsp(ip, port, `OPTIONS rtsp://${ip}:${port} RTSP/1.0\r\nCSeq: 1\r\n\r\n`)
    console.log(`  Response: ${result.substring(0, 200)}`)
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : e}`)
  }
}

function sendRtsp(ip: string, port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port, timeout: 5000 }, () => {
      socket.write(request)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('utf-8')
      // RTSP responses end with double CRLF
      if (data.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')) })
    socket.on('error', reject)
    socket.on('close', () => { if (data) resolve(data); else reject(new Error('closed without data')) })
  })
}

function probeTcp(ip: string, port: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port, timeout: 5000 }, () => {
      console.log(`  ${label}: TCP connected to ${ip}:${port}`)
      // Wait for server to send first data (if any)
      setTimeout(() => {
        console.log(`  ${label}: No data received after 3s (server waits for client)`)
        socket.destroy()
        resolve()
      }, 3000)
    })
    let received = false
    socket.on('data', (chunk) => {
      received = true
      console.log(`  ${label}: Received ${chunk.length} bytes`)
      console.log(`  ${label}: Hex: ${chunk.toString('hex').substring(0, 100)}`)
      console.log(`  ${label}: ASCII: ${chunk.toString('ascii').substring(0, 100)}`)
      socket.destroy()
      resolve()
    })
    socket.on('timeout', () => { console.log(`  ${label}: Connection timeout`); socket.destroy(); resolve() })
    socket.on('error', (e) => { console.log(`  ${label}: Error: ${e.message}`); resolve() })
    socket.on('close', () => { if (!received) resolve() })
  })
}

function probeTls(ip: string, port: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: ip, port, timeout: 5000, rejectUnauthorized: false }, () => {
      console.log(`  ${label}: TLS connected to ${ip}:${port}`)
      console.log(`  ${label}: Protocol: ${socket.getProtocol()}`)
      console.log(`  ${label}: Cipher: ${JSON.stringify(socket.getCipher())}`)
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 3000)
    })
    socket.on('data', (chunk) => {
      console.log(`  ${label}: TLS received ${chunk.length} bytes`)
      console.log(`  ${label}: Hex: ${chunk.toString('hex').substring(0, 100)}`)
      socket.destroy()
      resolve()
    })
    socket.on('timeout', () => { console.log(`  ${label}: TLS timeout`); socket.destroy(); resolve() })
    socket.on('error', (e) => { console.log(`  ${label}: TLS error: ${e.message}`); resolve() })
  })
}

probe().catch(console.error)
