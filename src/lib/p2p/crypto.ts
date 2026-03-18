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

// --- ECDH Session Key Derivation (from ecdhCryption.dll RE) ---

/**
 * Counter-mode KDF using AES-128-ECB.
 * From Ghidra RE of ECDHCryption_GenerateSessionKey / FUN_180016e00:
 * - Uses first 16 bytes of master key as AES key
 * - Increments a 1-byte counter for each 16-byte block
 * - Produces `length` bytes of derived key material
 */
export function ecdhDeriveSessionKey(masterKey: Buffer, length: number): Buffer {
  const aesKey = masterKey.subarray(0, 16)
  const blocks: Buffer[] = []
  let remaining = length

  // The counter block is 16 bytes, last byte is the counter
  const counterBlock = Buffer.alloc(16)
  let counter = 1 // Counter starts at 1 (incremented before first use in native code)

  while (remaining > 0) {
    counterBlock[15] = counter & 0xff
    counter++

    // AES-128-ECB: encrypt the counter block with the master key
    const cipher = createCipheriv('aes-128-ecb', aesKey, null)
    cipher.setAutoPadding(false)
    const block = cipher.update(counterBlock)

    const take = Math.min(remaining, 16)
    blocks.push(block.subarray(0, take))
    remaining -= take
  }

  return Buffer.concat(blocks)
}

/**
 * Build ECDH encrypted request packet for relay/VTM connection.
 * From Ghidra RE of EncECDHReqPackage / FUN_180002b30:
 *
 * Packet format:
 *   Byte 0:      0x24 ('$') magic
 *   Byte 1:      0x01 (version)
 *   Byte 2:      0x00
 *   Byte 3-4:    body_length (2B BE)
 *   Byte 5:      0x01
 *   Byte 6:      channel_id
 *   Byte 7-10:   sequence (4B BE)
 *   Byte 11-42:  AES-ECB encrypted shared secret (32B)
 *   Byte 43-133: client public key (91B SPKI/DER)
 *   Byte 134+:   body payload (if any)
 *   Last 32B:    HMAC-SHA256
 */
export function buildEcdhReqPacket(opts: {
  sessionKey: Buffer       // 32-byte derived session key
  masterKey: Buffer        // 32-byte ECDH shared secret
  clientPublicKey: Buffer  // 91-byte SPKI/DER or 65-byte raw
  channelId: number        // channel/session byte
  bodyLength: number       // length of encrypted body following the fixed header
  body?: Buffer            // optional body payload
  seqNum?: number          // sequence number (default: 1)
}): Buffer {
  const { sessionKey, masterKey, clientPublicKey, channelId, body, seqNum = 1 } = opts
  const bodyLen = body?.length ?? 0

  // Encrypt the master key with session key using AES-128-ECB
  const encKey = sessionKey.subarray(0, 16)
  const cipher1 = createCipheriv('aes-128-ecb', encKey, null)
  cipher1.setAutoPadding(false)
  const encMasterPart1 = cipher1.update(masterKey.subarray(0, 16))

  const cipher2 = createCipheriv('aes-128-ecb', encKey, null)
  cipher2.setAutoPadding(false)
  const encMasterPart2 = cipher2.update(masterKey.subarray(16, 32))

  const encryptedMaster = Buffer.concat([encMasterPart1, encMasterPart2])

  // Ensure public key is 91 bytes (SPKI/DER format)
  let pubKey = clientPublicKey
  if (pubKey.length === 65) {
    pubKey = rawPublicKeyToSpki(pubKey)
  }
  if (pubKey.length !== 91) {
    throw new Error(`Expected 91-byte SPKI public key, got ${pubKey.length}`)
  }

  // Build header (11 bytes)
  const header = Buffer.alloc(11)
  header[0] = 0x24  // '$' magic
  header[1] = 0x01  // version
  header[2] = 0x00
  header.writeUInt16BE(bodyLen, 3)
  header[5] = 0x01
  header[6] = channelId
  header.writeUInt32BE(seqNum, 7)

  // Fixed-size client info (32B encrypted master + 91B pubkey)
  const clientInfo = Buffer.concat([encryptedMaster, pubKey])

  // Copy body (self public key material, 91 bytes)
  const preHmac = body
    ? Buffer.concat([header, clientInfo, body])
    : Buffer.concat([header, clientInfo])

  // Compute CRC32 of header and body, format as string, then HMAC-SHA256
  // Simplified: HMAC-SHA256 over the full packet content
  const hmac = createHmac('sha256', sessionKey)
  hmac.update(preHmac)
  const mac = hmac.digest()

  return Buffer.concat([preHmac, mac])
}

/**
 * Convert raw 65-byte EC public key to 91-byte SPKI/DER format.
 * DER structure: SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING { pubkey } }
 */
export function rawPublicKeyToSpki(rawKey: Buffer): Buffer {
  if (rawKey.length !== 65) {
    throw new Error(`Expected 65-byte raw public key, got ${rawKey.length}`)
  }
  // SPKI/DER prefix for P-256 uncompressed public key
  const prefix = Buffer.from(
    '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'hex'
  )
  return Buffer.concat([prefix, rawKey])
}

/**
 * Parse SPKI/DER public key to raw 65-byte format.
 */
export function spkiPublicKeyToRaw(spki: Buffer): Buffer {
  // The raw key starts at offset 26 (after the DER prefix)
  if (spki.length !== 91) {
    throw new Error(`Expected 91-byte SPKI public key, got ${spki.length}`)
  }
  return spki.subarray(26)
}
