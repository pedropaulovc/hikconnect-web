/**
 * Test VTM relay connection with protobuf StreamInfoReq.
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { VtmClient } from '../src/lib/p2p/vtm-client'

async function main() {
  console.log('=== Step 1: Login ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in. Session:', session.sessionId.substring(0, 30) + '...')

  console.log('\n=== Step 2: Get Stream Params ===')
  const cameras = await client.getCameras('L38239367')
  const cam = cameras[0]
  console.log('Camera: ch' + cam.channelNo)

  const vtmInfo = await client.getVtmInfo('L38239367', cam.channelNo)
  console.log('VTM:', vtmInfo.externalIp + ':' + vtmInfo.port)

  const ticket = await client.getStreamTicket('L38239367', cam.channelNo)
  console.log('Ticket:', ticket.substring(0, 40) + '...')

  console.log('\n=== Step 3: Connect to VTM ===')
  const vtm = new VtmClient({
    host: vtmInfo.externalIp,
    port: vtmInfo.port,
  })

  vtm.on('frame', (frame: { msgType: number; subType: number; payload: Buffer }) => {
    console.log(`[FRAME] type=${frame.msgType} sub=${frame.subType} len=${frame.payload.length}`)
    console.log(`  hex: ${frame.payload.subarray(0, 64).toString('hex')}`)
  })

  vtm.on('streamData', (data: Buffer) => {
    console.log(`[STREAM] ${data.length} bytes, first 32: ${data.subarray(0, 32).toString('hex')}`)
  })

  vtm.on('close', () => console.log('[VTM] Connection closed'))
  vtm.on('error', (err: Error) => console.log('[VTM] Error:', err.message))

  await vtm.connect()

  console.log('\n=== Step 4: Send StreamInfoReq ===')
  // Build ysproto:// URL (from Ghidra StreamParam::change_url)
  const streamUrl = `ysproto://${vtmInfo.externalIp}:${vtmInfo.port}/L38239367?channel=${cam.channelNo}&stream=1&btype=1`
  console.log('Stream URL:', streamUrl)

  vtm.sendStreamInfoReq({
    streamUrl,
    vtmStreamKey: ticket,
    clnVersion: '6.11.150',
    proxyType: 0,
    pdsString: '',
    userAgent: 'ezviz_android',
    pdsNum: 0,
    timeout: 30000,
  })

  console.log('Waiting 30s for stream data...')
  await new Promise(resolve => setTimeout(resolve, 30000))

  vtm.disconnect()
  console.log('Done.')
}

main().catch(console.error)
