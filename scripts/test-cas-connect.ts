/**
 * Test CAS/VTDU relay connection — TCP path that bypasses P2P complexity.
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { CasClient, buildPlayRequest } from '../src/lib/p2p/cas-client'
import type { V3Message } from '../src/lib/p2p/v3-protocol'

async function main() {
  console.log('=== Step 1: Login ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in. Domain:', session.apiDomain)

  console.log('\n=== Step 2: Get Stream Params ===')
  const devices = await client.getDevices()
  const device = devices[0]
  console.log('Device:', device.deviceSerial, device.deviceName)

  const cameras = await client.getCameras(device.deviceSerial)
  console.log('Cameras:', cameras.map(c => `ch${c.channelNo}: ${c.channelName}`))

  // Get VTM info for relay connection
  const vtm = await client.getVtmInfo(device.deviceSerial, cameras[0].channelNo)
  console.log('VTM:', vtm)

  // Get stream ticket
  const ticket = await client.getStreamTicket(device.deviceSerial, cameras[0].channelNo)
  console.log('Ticket:', ticket.substring(0, 30) + '...')

  // Get P2P config for CAS server address
  const p2p = await client.getP2PConfig(device.deviceSerial)
  console.log('CAS server:', p2p.connection.netIp + ':' + p2p.connection.netCmdPort)

  console.log('\n=== Step 3: Connect to CAS Broker ===')
  // Try VTM server as CAS broker
  const casHost = vtm.externalIp || '148.153.53.29'
  const casPort = vtm.port || 8554
  console.log('Connecting to CAS at', casHost + ':' + casPort)

  const cas = new CasClient({ host: casHost, port: casPort })

  cas.on('message', (msg: V3Message) => {
    console.log(`[CAS-MSG] cmd=0x${msg.msgType.toString(16)} seq=${msg.seqNum} attrs=${msg.attributes.length}`)
    for (const attr of msg.attributes) {
      const ascii = attr.value.toString('ascii').replace(/[^\x20-\x7e]/g, '.')
      console.log(`  tag=0x${attr.tag.toString(16).padStart(2, '0')} len=${attr.value.length} val=${attr.value.toString('hex').substring(0, 40)} "${ascii.substring(0, 30)}"`)
    }
  })

  cas.on('error', (err: Error) => {
    console.log('[CAS-ERR]', err.message)
  })

  cas.on('close', () => {
    console.log('[CAS] Connection closed')
  })

  try {
    await cas.connect()
    console.log('Connected to CAS!')

    // Send PLAY_REQUEST
    console.log('\n=== Step 4: Send PLAY_REQUEST ===')
    const playReq = buildPlayRequest({
      busType: 1,           // 1 = live preview
      sessionKey: session.sessionId,
      streamType: 1,        // sub stream
      channelNo: cameras[0].channelNo,
      streamSession: Date.now() & 0x7fffffff,
    })
    console.log('Sending PLAY_REQUEST cmd=0x' + playReq.msgType.toString(16))
    cas.send(playReq)

    // Wait for responses
    console.log('Waiting 30s for stream data...')
    await new Promise(resolve => setTimeout(resolve, 30000))

  } catch (err) {
    console.error('CAS connection failed:', err)
  } finally {
    cas.disconnect()
    console.log('Disconnected.')
  }
}

main().catch(console.error)
