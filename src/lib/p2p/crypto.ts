import { createCipheriv, createDecipheriv, createHmac, createECDH } from 'node:crypto'

export function encryptPacket(
  encKey: Buffer,
  hmacKey: Buffer,
  plaintext: Buffer,
  seqNum: number,
): Buffer {
  const header = Buffer.alloc(11)
  header[0] = 0x24 // '$'
  header[1] = 0x02 // data type
  header[2] = 0x00 // padding
  header.writeUInt16BE(plaintext.length, 3)
  header.writeUInt16BE(0, 5) // reserved
  header.writeUInt32BE(seqNum, 7)

  // OpenSSL chacha20 IV: 4-byte little-endian counter + 12-byte nonce
  // We set counter=0, nonce = 4-byte LE seqnum + 8 zero bytes
  const iv = Buffer.alloc(16)
  iv.writeUInt32LE(0, 0) // counter
  iv.writeUInt32LE(seqNum, 4) // nonce starts at byte 4

  const cipher = createCipheriv('chacha20', encKey, iv)
  const ciphertext = cipher.update(plaintext)

  const hmac = createHmac('sha256', hmacKey)
  hmac.update(header)
  hmac.update(ciphertext)
  const mac = hmac.digest()

  return Buffer.concat([header, ciphertext, mac])
}

export function decryptPacket(
  encKey: Buffer,
  hmacKey: Buffer,
  packet: Buffer,
): Buffer {
  const header = packet.subarray(0, 11)
  const payloadLen = header.readUInt16BE(3)
  const seqNum = header.readUInt32BE(7)
  const ciphertext = packet.subarray(11, 11 + payloadLen)
  const receivedMac = packet.subarray(11 + payloadLen, 11 + payloadLen + 32)

  // Verify HMAC
  const hmac = createHmac('sha256', hmacKey)
  hmac.update(header)
  hmac.update(ciphertext)
  const expectedMac = hmac.digest()

  if (!receivedMac.equals(expectedMac)) {
    throw new Error('HMAC verification failed')
  }

  // Decrypt ChaCha20
  const iv = Buffer.alloc(16)
  iv.writeUInt32LE(0, 0) // counter
  iv.writeUInt32LE(seqNum, 4) // nonce starts at byte 4
  const decipher = createDecipheriv('chacha20', encKey, iv)
  return decipher.update(ciphertext)
}

export type KeyPair = { publicKey: Buffer; privateKey: Buffer }

export function generateKeyPair(): KeyPair {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey(),
    privateKey: ecdh.getPrivateKey(),
  }
}

export function deriveSharedSecret(privateKey: Buffer, peerPublicKey: Buffer): Buffer {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateKey)
  return ecdh.computeSecret(peerPublicKey)
}
