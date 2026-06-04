import { createCipheriv, createDecipheriv, createHmac, createECDH, randomBytes } from 'node:crypto'

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

// --- ECDH relay session key + packet (from ecdhCryption.dll RE, 2026-06-04) ---
// See docs/re/ecdh-kdf-vectors.md. Every primitive below is byte-verified against the live DLL.
//
// Crucial correction to the earlier guess: there is NO secret->sessionKey KDF.
// ECDHCryption_GenerateSessionKey emits a *random* 32-byte session key (verified non-deterministic).
// The shared-secret binding happens entirely inside EncECDHReqPackage (buildEcdhReqPacket below).

/** Fresh random 32-byte session key (matches ECDHCryption_GenerateSessionKey's random output). */
export function generateSessionKey(): Buffer {
  return randomBytes(32)
}

/** Standard CRC-32 (reflected, poly 0xEDB88320, init/final 0xFFFFFFFF) — matches FUN_180001000
 *  (verified: CRC32("123456789") == 0xCBF43926). */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** AES-256-ECB(key = shared secret) of the 32-byte session key — the off-11 "wrap" (verified). */
export function wrapSessionKey(masterKey: Buffer, sessionKey: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error(`Expected 32-byte master key, got ${masterKey.length}`)
  if (sessionKey.length !== 32) throw new Error(`Expected 32-byte session key, got ${sessionKey.length}`)
  const cipher = createCipheriv('aes-256-ecb', masterKey, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(sessionKey), cipher.final()])
}

/** ChaCha20 with key = session key, counter 0, nonce words {1,0,0} (verified). */
function encryptBody(sessionKey: Buffer, body: Buffer): Buffer {
  // cryptography/OpenSSL ChaCha20 IV = 16B (state words 12..15, little-endian each):
  // counter(word12)=0, nonce(words13..15)={1,0,0} => 00000000 01000000 00000000 00000000
  const iv = Buffer.alloc(16)
  iv.writeUInt32LE(1, 4)
  const cipher = createCipheriv('chacha20', sessionKey, iv)
  return cipher.update(body)
}

/**
 * Build the ECDH `ClnConnectReq` packet for the relay/VTM connection.
 * From Ghidra RE of EncECDHReqPackage / FUN_180002b30 (all primitives byte-verified):
 *
 *   off 0   : 0x24 0x01 0x00
 *   off 3-4 : body_length (2B BE)        (plaintext == ciphertext length, ChaCha20 is a stream cipher)
 *   off 5   : 0x01
 *   off 6   : channel_id (1B)
 *   off 7-10: sequence (4B BE)           — the DLL hard-codes 1 here
 *   off 11  : AES-256-ECB(masterKey).encrypt(sessionKey)   (32B wrap of the random session key)
 *   off 43  : client public key (91B SPKI/DER)
 *   off 134 : ChaCha20(sessionKey).encrypt(body)           (if body present)
 *   end     : HMAC-SHA256(masterKey) over sprintf("%u%u", crc32(body), crc32(header[0:134]))  (32B)
 *
 * The caller generates `sessionKey` randomly (generateSessionKey) and keeps it to decrypt responses.
 */
export function buildEcdhReqPacket(opts: {
  sessionKey: Buffer       // 32-byte RANDOM session key (also used to decrypt the relay's response body)
  masterKey: Buffer        // 32-byte ECDH shared secret
  clientPublicKey: Buffer  // 91-byte SPKI/DER or 65-byte raw
  channelId: number        // channel id byte
  bodyLength?: number      // ignored (kept for call-site compat); derived from body
  body?: Buffer            // optional plaintext body (encrypted with the session key)
  seqNum?: number          // header sequence (DLL hard-codes 1)
}): Buffer {
  const { sessionKey, masterKey, clientPublicKey, channelId, body, seqNum = 1 } = opts
  const bodyLen = body?.length ?? 0

  // off 11: wrap the random session key with the shared secret (AES-256-ECB)
  const wrap = wrapSessionKey(masterKey, sessionKey)

  // client public key must be 91-byte SPKI/DER
  let pubKey = clientPublicKey
  if (pubKey.length === 65) pubKey = rawPublicKeyToSpki(pubKey)
  if (pubKey.length !== 91) throw new Error(`Expected 91-byte SPKI public key, got ${pubKey.length}`)

  // header (11B)
  const header = Buffer.alloc(11)
  header[0] = 0x24
  header[1] = 0x01
  header[2] = 0x00
  header.writeUInt16BE(bodyLen, 3)
  header[5] = 0x01
  header[6] = channelId
  header.writeUInt32BE(seqNum, 7)

  // off 134: ChaCha20 body
  const encBody = body && body.length > 0 ? encryptBody(sessionKey, body) : Buffer.alloc(0)

  // header[0:134] = header + wrap + pubkey (0x86 = 134 bytes)
  const head134 = Buffer.concat([header, wrap, pubKey])

  // MAC = HMAC-SHA256(masterKey, ascii("%u%u" % (crc32(header[0:134]), crc32(body))))
  // Arg order confirmed from FUN_180002b30 disassembly: sprintf_s(buf,0x20,"%u%u", R9D=crcHeader,
  // [rsp+0x20]=crcBody) — i.e. HEADER crc first, then BODY crc.
  const crcHead = crc32(head134)
  const crcBody = crc32(encBody)
  const macMsg = Buffer.from(`${crcHead >>> 0}${crcBody >>> 0}`, 'ascii')
  const mac = createHmac('sha256', masterKey).update(macMsg).digest()

  return Buffer.concat([head134, encBody, mac])
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
