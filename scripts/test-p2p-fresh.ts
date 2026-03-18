/**
 * P2P test with fresh captured body from Android app.
 * Uses the exact V3 body that got SUCCESS from the P2P server.
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { createSocket } from 'node:dgram'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { HikConnectClient } from '../src/lib/hikconnect/client'
import { crc8, decodeV3Message, encodeV3Message, defaultMask, Opcode } from '../src/lib/p2p/v3-protocol'

const P2P_KEY = Buffer.from('e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5', 'hex')
const P2P_SERVERS = [
  { host: '52.5.124.127', port: 6000 },
  { host: '52.203.168.207', port: 6000 },
]

// Fresh body captured from Android app (the 250-byte successful request)
const FRESH_BODY = Buffer.from(
  '30387e000c07050e3336370700ec' +
  'e2de0c020000' +
  '1619' +
  '62343cf300020065' +
  '0120' + '6663666165633930613535663461363162346537323131313532613264383035' +
  '0204' + '0aed13f5' +
  '0302' + '0003' +
  '317524a49ebffb46b3150fc16aa95690' +
  'a8bd738bade6c4e3ef614766f501ea48' +
  'db14a3dc437223c472ac309b6363b695' +
  '0dd8841003dc204e2fa8d4eb75fa6baa' +
  '4f8231ec71107a96012e0ec2563d7f07' +
  '794266d0df78f606f1db1ef29809f3fa' +
  '787d90cceeb178ea41abfede80a7afd0' +
  'edcd3148b412e144c730270e496a0001' +
  'ccfe079ea96518aafc31bff7641e5fa0' +
  'a142c1bfae58189358bf75e3a4d52270' +
  '3d8c9b6bc409b506a6a2c7bb703160d0',
  'hex',
)

function timestamp32(): number {
  return Number(BigInt(Date.now()) & 0xffffffffn)
}

function buildV3Request(seqNum: number): Buffer {
  // Use fresh body, just update the seq number
  const body = Buffer.from(FRESH_BODY)
  // seq is at offset 14 (inside tag=0x07 content, 6-byte prefix then 2-byte seq)
  // Actually the raw body: routing(11) + tag0x07(3) + 6byte prefix + 2byte seq = offset 20
  body.writeUInt16BE(seqNum & 0xffff, 20)

  // AES-128-CBC encrypt
  const aesKey = P2P_KEY.subarray(0, 16)
  const iv = Buffer.alloc(16)
  const cipher = createCipheriv('aes-128-cbc', aesKey, iv)
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()])

  // Build V3 header
  const header = Buffer.alloc(12)
  header[0] = 0xe2
  header[1] = 0xda // encrypt=1, saltVer=1, saltIdx=3, is2BLen=1
  header.writeUInt16BE(Opcode.TRANSFOR_DATA, 2)
  header.writeUInt32BE(seqNum, 4)
  header.writeUInt16BE(0x6234, 8)
  header[10] = 0x0c
  header[11] = 0x00

  const full = Buffer.concat([header, encrypted])
  full[11] = crc8(full)
  return full
}

// Parse response sub-TLVs from tag=0x37 value
function parseResponseAttrs(data: Buffer): Map<number, Buffer> {
  const attrs = new Map<number, Buffer>()
  // Find first TLV (skip routing header — scan for tag 0x02 or 0x84)
  for (let i = 0; i < data.length - 2; i++) {
    const tag = data[i]
    const len = data[i + 1]
    if ((tag === 0x02 || tag === 0x84) && len === 0x04 && i + 2 + len <= data.length) {
      attrs.set(tag, data.subarray(i + 2, i + 2 + len))
      i += 1 + len // skip to next
    }
  }
  return attrs
}

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  console.log('Logged in, domain:', session.apiDomain)

  const p2p = await client.getP2PConfig('L38239367')
  const deviceIp = p2p.connection.netIp || p2p.connection.wanIp
  const devicePort = p2p.connection.netStreamPort || 9020
  console.log('Device:', deviceIp + ':' + devicePort)

  const socket = createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, resolve))
  const localPort = socket.address().port
  console.log('Local UDP port:', localPort)

  let seqNum = 0x1619 // Use same base seq from capture
  let deviceSessionId = 0
  const sourceId = (Math.random() * 0xffffffff) >>> 0

  // Handle incoming packets
  socket.on('message', (msg, rinfo) => {
    const from = `${rinfo.address}:${rinfo.port}`

    // V3 responses from P2P servers
    if (msg.length >= 12 && (msg[0] >> 4) === 0xe) {
      try {
        const v3 = decodeV3Message(msg, P2P_KEY)
        console.log(`[V3] from ${from} cmd=0x${v3.msgType.toString(16)}`)
        for (const attr of v3.attributes) {
          console.log(`  tag=0x${attr.tag.toString(16)} len=${attr.value.length} hex=${attr.value.toString('hex')}`)

          // Parse sub-attrs in tag=0x37
          if (attr.tag === 0x37) {
            const sub = parseResponseAttrs(attr.value)
            const statusCode = sub.get(0x02)
            const devSession = sub.get(0x84)
            if (statusCode) {
              const code = statusCode.readUInt32BE(0)
              console.log(`  >> status=0x${code.toString(16)} (${code === 0 ? 'SUCCESS' : 'ERROR ' + code})`)
            }
            if (devSession) {
              deviceSessionId = devSession.readUInt32BE(0)
              console.log(`  >> deviceSession=0x${deviceSessionId.toString(16)}`)
            }
          }
        }
      } catch (err) {
        console.log(`[V3] decode error from ${from}:`, err)
      }
      return
    }

    // Device responses
    const type = msg.length >= 2 ? msg.readUInt16BE(0) : 0
    console.log(`[RECV] from ${from} len=${msg.length} type=0x${type.toString(16)} hex=${msg.subarray(0, Math.min(64, msg.length)).toString('hex')}`)

    if (type === 0x7534) {
      console.log('[SESSION] Device responded to session setup!')
      // Look for embedded V3 message
      for (let i = 16; i < msg.length - 12; i++) {
        if ((msg[i] >> 4) === 0xe) {
          try {
            const v3 = decodeV3Message(msg.subarray(i))
            console.log(`[SESSION-V3] cmd=0x${v3.msgType.toString(16)}`)
            for (const a of v3.attributes) {
              console.log(`  tag=0x${a.tag.toString(16)} hex=${a.value.toString('hex').substring(0, 60)}`)
            }
          } catch { /* skip */ }
          break
        }
      }
    }

    if (type === 0x8000) {
      console.log('[CONN] Connection control from device')
      if (msg.length >= 32) {
        const proposedSession = msg.readUInt32BE(24)
        console.log(`  proposedDataSession=0x${proposedSession.toString(16)}`)
      }
    }

    if (type === 0x8001) {
      console.log('[KEEPALIVE] from device')
    }
  })

  // Step 1: Send P2P server request
  console.log('\n=== Sending P2P server request ===')
  const req = buildV3Request(++seqNum)
  for (const server of P2P_SERVERS) {
    socket.send(req, server.port, server.host)
    console.log(`Sent ${req.length}B to ${server.host}:${server.port}`)
  }

  // Wait for server response
  await new Promise(resolve => setTimeout(resolve, 2000))

  if (deviceSessionId === 0) {
    console.log('\nNo device session from P2P server. Stopping.')
    socket.close()
    return
  }

  // Step 2: Hole punch to device
  console.log('\n=== Hole punching to', deviceIp + ':' + devicePort, '===')
  const punch = Buffer.alloc(1)
  for (let i = 0; i < 10; i++) {
    socket.send(punch, devicePort, deviceIp)
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  // Step 3: Send session setup (0x7534) with embedded V3 PREVIEW_REQ
  console.log('\n=== Sending session setup (0x7534) ===')
  const serial = 'L38239367'
  const b64Serial = Buffer.from(serial).toString('base64')
  const now = new Date()
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0')
  const rand5 = String(Math.floor(10000 + Math.random() * 90000))
  const sessionKey = b64Serial + '1' + dateStr + rand5

  const v3setup = encodeV3Message({
    msgType: 0x0c00,
    seqNum: ++seqNum,
    reserved: 0x6234,
    mask: defaultMask({ saltVersion: 1, saltIndex: 3, is2BLen: true }),
    attributes: [
      { tag: 0x05, value: Buffer.from(sessionKey) },
      { tag: 0x71, value: Buffer.from([0x01]) },
      { tag: 0x82, value: Buffer.alloc(4) },
    ],
  })

  const sessionSetup = Buffer.alloc(28 + v3setup.length)
  sessionSetup.writeUInt16BE(0x7534, 0)
  sessionSetup.writeUInt16BE(1, 2) // session ID
  sessionSetup.writeUInt16BE(0xc000, 4) // SYN flags
  sessionSetup.writeUInt16BE(seqNum & 0xffff, 6)
  sessionSetup.writeUInt32BE(timestamp32(), 8)
  sessionSetup.writeUInt32BE(sourceId, 12)
  sessionSetup[16] = 0x80
  sessionSetup[17] = 0x7f
  v3setup.copy(sessionSetup, 28)

  // Send session setup multiple times
  for (let i = 0; i < 5; i++) {
    socket.send(sessionSetup, devicePort, deviceIp)
    console.log(`Sent 0x7534 ${sessionSetup.length}B to ${deviceIp}:${devicePort}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  // Step 4: Wait for data
  console.log('\n=== Waiting 60s for device response ===')

  // Send keepalives periodically
  const keepaliveInterval = setInterval(() => {
    const ka = Buffer.alloc(20)
    ka.writeUInt16BE(0x8001, 0)
    ka.writeUInt32BE(timestamp32(), 8)
    ka.writeUInt32BE(sourceId, 12)
    socket.send(ka, devicePort, deviceIp)
  }, 5000)

  await new Promise(resolve => setTimeout(resolve, 60000))
  clearInterval(keepaliveInterval)
  socket.close()
  console.log('Done.')
}

main().catch(console.error)
