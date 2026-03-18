/**
 * Test relay connection with multiple KDF variants to find the correct one.
 * Each variant produces a different session key from the same master key.
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { createHash, createHmac, createCipheriv, hkdfSync, createECDH } from 'crypto'
import { Socket } from 'net'
import { HikConnectClient } from '../src/lib/hikconnect/client'
import {
  generateKeyPair,
  deriveSharedSecret,
  buildEcdhReqPacket,
  spkiPublicKeyToRaw,
  rawPublicKeyToSpki,
} from '../src/lib/p2p/crypto'

// TLV encoding for relay body
function encodeTlv(tag: number, value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value
  const header = Buffer.alloc(3)
  header[0] = tag
  header.writeUInt16BE(data.length, 1)
  return Buffer.concat([header, data])
}
function encodeIntTlv(tag: number, value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(value)
  return encodeTlv(tag, buf)
}

// KDF variants to test
const kdfVariants: Record<string, (masterKey: Buffer) => Buffer> = {
  'raw': (mk) => mk.subarray(0, 32),

  'sha256': (mk) => createHash('sha256').update(mk).digest(),

  'hmac-sha256-ezviz': (mk) =>
    createHmac('sha256', Buffer.from('ezviz-ecdh')).update(mk).digest(),

  'hmac-sha256-mk-as-key': (mk) =>
    createHmac('sha256', mk).update(Buffer.from('ezviz-ecdh')).digest(),

  'hkdf-sha256': (mk) =>
    Buffer.from(hkdfSync('sha256', mk, Buffer.from('ezviz-ecdh'), Buffer.alloc(0), 32)),

  'hkdf-sha256-noinfo': (mk) =>
    Buffer.from(hkdfSync('sha256', mk, Buffer.alloc(0), Buffer.from('ezviz-ecdh'), 32)),

  'aes256ecb-counter': (mk) => {
    const counterBlock = Buffer.alloc(16)
    counterBlock[15] = 1
    const c1 = createCipheriv('aes-256-ecb', mk, null)
    c1.setAutoPadding(false)
    const b1 = c1.update(counterBlock)
    counterBlock[15] = 2
    const c2 = createCipheriv('aes-256-ecb', mk, null)
    c2.setAutoPadding(false)
    const b2 = c2.update(counterBlock)
    return Buffer.concat([b1, b2])
  },

  'double-sha256': (mk) => {
    const h1 = createHash('sha256').update(mk).digest()
    return createHash('sha256').update(h1).digest()
  },
}

async function testVariant(
  name: string, sessionKey: Buffer, masterKey: Buffer,
  clientPubKey: Buffer, body: Buffer,
  relayHost: string, relayPort: number,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, 5000)

    socket.once('error', () => {
      clearTimeout(timeout)
      resolve('error')
    })

    socket.once('close', () => {
      clearTimeout(timeout)
      resolve('closed')
    })

    let responseData = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      responseData = Buffer.concat([responseData, chunk])
      // Check if we have a complete frame
      if (responseData.length >= 12 && responseData[0] === 0x24) {
        const bodyLen = responseData.readUInt16BE(2)
        if (responseData.length >= 12 + bodyLen) {
          clearTimeout(timeout)
          const frameBody = responseData.subarray(12, 12 + bodyLen)
          const cmd = responseData[1]
          // Parse TLV in response
          let errorCode = 0
          let offset = 0
          while (offset + 3 <= frameBody.length) {
            const tag = frameBody[offset]
            const len = frameBody.readUInt16BE(offset + 1)
            if (tag === 0x07 && len === 4) {
              const val = frameBody.readInt32BE(offset + 3)
              if (val >= 0x2712) errorCode = val
            }
            offset += 3 + len
          }
          socket.destroy()
          resolve(errorCode === 0 ? `SUCCESS (cmd=0x${cmd.toString(16)})` : `error=${errorCode} (0x${errorCode.toString(16)})`)
        }
      }
    })

    socket.connect(relayPort, relayHost, () => {
      const packet = buildEcdhReqPacket({
        sessionKey,
        masterKey,
        clientPublicKey: clientPubKey,
        channelId: 9,
        bodyLength: body.length,
        body,
        seqNum: 1,
      })
      socket.write(packet)
    })
  })
}

async function main() {
  console.log('=== Relay KDF Variant Test ===\n')

  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })

  const devices = await client.getDevices()
  const device = devices[0]
  const cameras = await client.getCameras(device.deviceSerial)
  const cam = cameras[0]

  const relay = await client.getRelayServer('relay', device.deviceSerial, cam.channelNo)
  console.log(`Relay: ${relay.externalIp}:${relay.port}`)

  // Generate client key pair
  const clientKp = generateKeyPair()
  const serverPubKeyDer = Buffer.from(relay.publicKey.key, 'base64')
  const serverPubKeyRaw = spkiPublicKeyToRaw(serverPubKeyDer)
  const masterKey = deriveSharedSecret(clientKp.privateKey, serverPubKeyRaw)
  console.log(`Master key: ${masterKey.toString('hex').substring(0, 20)}...`)

  // Build relay body (same for all variants)
  const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
  const b64Serial = Buffer.from(device.deviceSerial).toString('base64')
  const sessionKey = b64Serial + '1' + Date.now()

  const body = Buffer.concat([
    encodeTlv(0x01, device.deviceSerial),
    encodeTlv(0x02, ticket),
    encodeTlv(0x03, sessionKey),
    encodeIntTlv(0x05, 55),
  ])

  console.log(`Body: ${body.length}B`)
  console.log(`\nTesting ${Object.keys(kdfVariants).length} KDF variants...\n`)

  for (const [name, kdf] of Object.entries(kdfVariants)) {
    const derivedKey = kdf(masterKey)
    const result = await testVariant(
      name, derivedKey, masterKey,
      clientKp.publicKey, body,
      relay.externalIp, relay.port,
    )
    const icon = result.startsWith('SUCCESS') ? '✓' : '✗'
    console.log(`  ${icon} ${name.padEnd(25)} → ${result}`)

    // Small delay between attempts
    await new Promise(r => setTimeout(r, 500))
  }

  console.log('\nDone!')
}

main().catch(console.error)
