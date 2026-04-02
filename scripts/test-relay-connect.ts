/**
 * Test script: Connect to Hikvision relay server and attempt video streaming.
 *
 * Usage: npx tsx scripts/test-relay-connect.ts
 *
 * Requires .env.local with HIKCONNECT_ACCOUNT and HIKCONNECT_PASSWORD.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { RelayClient } from '../src/lib/p2p/relay-client'

async function main() {
  console.log('=== Step 1: Login ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in. Domain:', session.apiDomain)

  console.log('\n=== Step 2: Get Device Info ===')
  const devices = await client.getDevices()
  const device = devices[0]
  console.log('Device:', device.deviceSerial, device.name)

  const cameras = await client.getCameras(device.deviceSerial)
  const cam = cameras[0]
  console.log('Camera:', `ch${cam.channelNo}: ${cam.cameraName}`)

  console.log('\n=== Step 3: Get Relay Server Info ===')
  const relay = await client.getRelayServer('relay', device.deviceSerial, cam.channelNo)
  console.log('Relay server:', relay.externalIp, ':', relay.port)
  console.log('Relay domain:', relay.domain)
  if (relay.publicKey) {
    console.log('Public key version:', relay.publicKey.version)
  }

  console.log('\n=== Step 4: Get Stream Ticket ===')
  const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
  console.log('Ticket:', ticket.substring(0, 30) + '...')

  console.log('\n=== Step 5: Connect to Relay ===')
  // Generate a session key similar to the P2P session key
  const b64Serial = Buffer.from(device.deviceSerial).toString('base64')
  const now = new Date()
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0')
  const rand5 = String(Math.floor(10000 + Math.random() * 90000))
  const sessionKey = b64Serial + String(cam.channelNo) + dateStr + rand5

  const relayClient = new RelayClient({
    host: relay.externalIp,
    port: relay.port,
    deviceSerial: device.deviceSerial,
    ticket,
    sessionKey,
    serverPublicKey: relay.publicKey?.key,
  })

  let totalBytes = 0
  let packetCount = 0
  const outputDir = '/tmp/relay-capture'
  mkdirSync(outputDir, { recursive: true })

  relayClient.on('data', (data: Buffer) => {
    totalBytes += data.length
    packetCount++
    if (packetCount <= 10 || packetCount % 100 === 0) {
      console.log(`[Data] Packet #${packetCount}: ${data.length}B (total: ${totalBytes}B) first16=${data.subarray(0, 16).toString('hex')}`)
    }
    // Save first few packets for analysis
    if (packetCount <= 20) {
      writeFileSync(`${outputDir}/packet-${String(packetCount).padStart(4, '0')}.bin`, data)
    }
  })

  relayClient.on('streaming', (info: { relayHost: string; relayPort: number; sendRate: number }) => {
    console.log(`[Streaming] Connected! host=${info.relayHost} port=${info.relayPort} rate=${info.sendRate}`)
  })

  relayClient.on('error', (err: Error) => {
    console.error('[Error]', err.message)
  })

  relayClient.on('close', () => {
    console.log('[Relay] Connection closed')
  })

  try {
    await relayClient.connect()
    console.log('Connected to relay. Sending ConnectReq...')
    relayClient.sendConnectReq()

    // Wait for streaming or timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`\nTimeout after 30s. Received ${packetCount} packets (${totalBytes} bytes)`)
        resolve()
      }, 30_000)

      relayClient.once('streaming', () => {
        console.log('Streaming started! Waiting 15s for data...')
        clearTimeout(timeout)
        setTimeout(() => {
          console.log(`\nCapture done. Received ${packetCount} packets (${totalBytes} bytes)`)
          console.log(`Packets saved to ${outputDir}/`)
          resolve()
        }, 15_000)
      })

      relayClient.once('error', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    relayClient.disconnect()
  } catch (err) {
    console.error('Failed:', err)
    relayClient.disconnect()
  }
}

main().catch(console.error)
