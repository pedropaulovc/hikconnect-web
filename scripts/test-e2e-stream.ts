#!/usr/bin/env -S npx tsx
// End-to-end test: login → get stream params → STUN bind → CAS connect
// Usage: npx tsx scripts/test-e2e-stream.ts

import { readFileSync } from 'node:fs'

// Load .env.local manually
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { hikStunBind, rfc5389StunBind } from '../src/lib/p2p/stun-client'
import { CasClient, buildPlayRequest } from '../src/lib/p2p/cas-client'

const account = process.env.HIKCONNECT_ACCOUNT
const password = process.env.HIKCONNECT_PASSWORD

if (!account || !password) {
  console.error('Set HIKCONNECT_ACCOUNT and HIKCONNECT_PASSWORD in .env.local')
  process.exit(1)
}

async function main() {
  // Step 1: Login
  console.log('=== Step 1: HikConnect Login ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: account!, password: password! })
  console.log('Session ID:', session.sessionId.substring(0, 20) + '...')
  console.log('API domain:', session.apiDomain)

  // Step 2: Get devices
  console.log('\n=== Step 2: List Devices ===')
  const devices = await client.getDevices()
  console.log('Devices:', devices.map(d => `${d.deviceSerial} (${d.name})`).join(', '))

  const device = devices[0]
  const cameras = await client.getCameras(device.deviceSerial)
  const cam = cameras[0]
  console.log(`Using: ${device.deviceSerial} ch${cam.channelNo}`)

  // Step 3: Get stream params
  console.log('\n=== Step 3: Stream Parameters ===')
  const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
  console.log('Stream ticket:', ticket.substring(0, 30) + '...')

  const vtm = await client.getVtmInfo(device.deviceSerial, cam.channelNo)
  console.log('VTM IP:', vtm.externalIp, 'port:', vtm.port)

  // Extract P2P params from device info
  const p2p = (device as Record<string, unknown>).p2pInfo as Record<string, unknown> | undefined
  console.log('P2P info:', JSON.stringify(p2p, null, 2))

  // Full device dump
  console.log('\nFull device dump:')
  console.log(JSON.stringify(device, null, 2))

  // Step 4: STUN binding
  console.log('\n=== Step 4: STUN Binding ===')
  try {
    // Try the Hik STUN server first
    const stunResult = await hikStunBind('43.130.155.63', 6002, device.deviceSerial)
    console.log('Hik STUN mapped address:', stunResult.address, ':', stunResult.port, 'NAT:', stunResult.natType)
  } catch (e) {
    console.log('Hik STUN failed:', (e as Error).message)
    // Try a public STUN server as fallback
    try {
      const stunResult = await rfc5389StunBind('stun.l.google.com', 19302)
      console.log('Google STUN mapped address:', stunResult.address, ':', stunResult.port)
    } catch (e2) {
      console.log('Google STUN also failed:', (e2 as Error).message)
    }
  }

  // Step 4b: P2P Config Discovery (endpoints found in APK dex)
  console.log('\n=== Step 4b: P2P Config Discovery ===')
  const session2 = client.getSession()!
  const base = `https://${session2.apiDomain}`
  const headers: Record<string, string> = { sessionId: session2.sessionId, clientType: '55', featureCode: 'deadbeef' }

  // Try the P2P SDK endpoints on multiple base URLs (found in APK dex)
  const bases = [base, 'https://iusopen.ezvizlife.com']
  for (const b of bases) {
    for (const path of ['/api/sdk/p2p/user/info/get', `/api/sdk/p2p/dev/info/get`]) {
      try {
        const r = await fetch(b + path, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `deviceSerial=${device.deviceSerial}`,
        })
        const text = await r.text()
        const isJson = text.startsWith('{')
        console.log(`POST ${b}${path}`)
        console.log('  →', isJson ? text.substring(0, 500) : `HTML (${r.status})`)
      } catch (e) { console.log(`POST ${b}${path} → ERROR:`, (e as Error).message) }
    }
  }

  // Step 5: CAS broker connection
  console.log('\n=== Step 5: CAS Broker Connection ===')
  const cas = new CasClient({
    host: '34.194.209.167',
    port: 6500,
  })

  cas.on('message', (msg) => {
    console.log('CAS received:', JSON.stringify({
      msgType: `0x${msg.msgType.toString(16).padStart(4, '0')}`,
      seqNum: msg.seqNum,
      attrCount: msg.attributes.length,
      attrs: msg.attributes.map((a: { tag: number; value: Buffer }) => ({
        tag: `0x${a.tag.toString(16).padStart(2, '0')}`,
        len: a.value.length,
        value: a.value.length <= 32 ? a.value.toString('hex') : `${a.value.subarray(0, 16).toString('hex')}...`,
      })),
    }, null, 2))
  })

  cas.on('error', (err) => {
    console.log('CAS error:', err.message)
  })

  try {
    await cas.connect()
    console.log('Connected to CAS broker!')

    // Send a PLAY_REQUEST with params from Frida capture
    const playMsg = buildPlayRequest({
      busType: 1,              // 1 = preview
      sessionKey: session.sessionId,
      streamType: 1,           // sub stream
      channelNo: cam.channelNo,
      streamSession: Date.now() & 0x7fffffff,
    })
    console.log('Sending PLAY_REQUEST (0x0C02)...')
    cas.send(playMsg)

    // Wait for response
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('No response from CAS after 5s')
        resolve()
      }, 5000)

      cas.on('message', (msg) => {
        clearTimeout(timeout)
        console.log('CAS response received!')
        resolve()
      })
    })

    cas.disconnect()
  } catch (e) {
    console.log('CAS connection failed:', (e as Error).message)
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
