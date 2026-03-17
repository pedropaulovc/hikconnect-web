import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

export const STUN_MAGIC_COOKIE = 0x2112a442

export function buildBindingRequest(transactionId?: Buffer): Buffer {
  const txId = transactionId ?? randomBytes(12)
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(0x0001, 0) // Binding Request
  msg.writeUInt16BE(0, 2) // message length (no attributes)
  msg.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  txId.copy(msg, 8)
  return msg
}

export type StunResult = { address: string; port: number }

export function parseBindingResponse(buf: Buffer): StunResult {
  const msgType = buf.readUInt16BE(0)
  if (msgType !== 0x0101) {
    throw new Error(`Not a binding response: 0x${msgType.toString(16)}`)
  }

  const msgLen = buf.readUInt16BE(2)
  let offset = 20

  while (offset < 20 + msgLen) {
    const attrType = buf.readUInt16BE(offset)
    const attrLen = buf.readUInt16BE(offset + 2)

    // XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001)
    if (attrType === 0x0020 || attrType === 0x0001) {
      const family = buf[offset + 5]
      if (family !== 0x01) {
        throw new Error(`Unsupported address family: ${family}`)
      }

      let port = buf.readUInt16BE(offset + 6)
      let ip = buf.readUInt32BE(offset + 8)

      if (attrType === 0x0020) {
        port ^= STUN_MAGIC_COOKIE >> 16
        ip ^= STUN_MAGIC_COOKIE
      }

      // Use unsigned right shift to avoid sign issues
      const address = [
        (ip >>> 24) & 0xff,
        (ip >>> 16) & 0xff,
        (ip >>> 8) & 0xff,
        ip & 0xff,
      ].join('.')

      return { address, port }
    }

    offset += 4 + attrLen
    if (attrLen % 4 !== 0) offset += 4 - (attrLen % 4) // padding
  }

  throw new Error('No MAPPED-ADDRESS found in STUN response')
}

export async function stunBind(stunHost: string, stunPort: number): Promise<StunResult> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('STUN binding timeout'))
    }, 3000)

    socket.on('message', (msg) => {
      clearTimeout(timeout)
      socket.close()
      resolve(parseBindingResponse(msg))
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      socket.close()
      reject(err)
    })

    const req = buildBindingRequest()
    socket.send(req, stunPort, stunHost)
  })
}
