// src/lib/hikconnect/client.integration.test.ts
import { describe, it, expect } from 'vitest'
import { HikConnectClient } from './client'

const account = process.env.HIKCONNECT_ACCOUNT
const password = process.env.HIKCONNECT_PASSWORD

const skip = !account || !password

describe.skipIf(skip)('HikConnectClient integration', () => {
  it('logs in, lists devices, fetches stream params', async () => {
    const client = new HikConnectClient({
      baseUrl: 'https://api.hik-connect.com',
    })

    // Login
    const session = await client.login({ account: account!, password: password! })
    expect(session.sessionId).toBeTruthy()
    console.log('Logged in. apiDomain:', session.apiDomain)

    // List devices
    const devices = await client.getDevices()
    expect(devices.length).toBeGreaterThan(0)
    console.log('Devices:', devices.map(d => `${d.deviceSerial} (${d.deviceName})`))

    const device = devices[0]

    // List cameras
    const cameras = await client.getCameras(device.deviceSerial)
    expect(cameras.length).toBeGreaterThan(0)
    console.log('Cameras:', cameras.map(c => `ch${c.channelNo}: ${c.channelName}`))

    const cam = cameras[0]

    // Stream ticket
    const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
    expect(ticket).toBeTruthy()
    console.log('Stream ticket:', ticket.substring(0, 20) + '...')

    // VTM info
    const vtm = await client.getVtmInfo(device.deviceSerial, cam.channelNo)
    expect(vtm.externalIp).toBeTruthy()
    console.log('VTM:', vtm.externalIp, ':', vtm.port)

    // Relay server
    try {
      const relay = await client.getRelayServer('relay', device.deviceSerial, cam.channelNo)
      console.log('Relay:', relay.externalIp, ':', relay.port)
      if (relay.publicKey) {
        console.log('Relay public key version:', relay.publicKey.version)
        console.log('Relay public key (first 40 chars):', relay.publicKey.key?.substring(0, 40))
      }
    } catch (e) {
      console.log('Relay server not available (expected for some device types)')
    }

    // Log full device info for protocol analysis
    console.log('\n--- Full device info for VTDU protocol work ---')
    console.log(JSON.stringify(device, null, 2))
    console.log('\n--- Full VTM info ---')
    console.log(JSON.stringify(vtm, null, 2))
  }, 30000)
})
