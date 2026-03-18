import { createCipheriv, createDecipheriv, createHmac, createECDH, hkdfSync } from 'node:crypto'

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
 * Counter-mode KDF using AES-256-ECB.
 * From Ghidra RE of ECDHCryption_GenerateSessionKey / FUN_180016e00 + FUN_180016a60:
 *
 * The KDF has two phases:
 * Phase 1: Generate 48 bytes via AES-256-ECB counter mode with master key
 *   - Counter at byte 15 is incremented big-endian before each AES block
 *   - 3 blocks × 16 bytes = 48 bytes
 *
 * Phase 2: XOR the 48 bytes with a hash of the input, then use first 32 bytes
 *   as new AES-256 key for the session
 *
 * Hikvision ECDH session key derivation.
 *
 * From deep Ghidra RE of ecdhCryption.dll (FUN_180016d20, FUN_1800174a0):
 * The KDF uses a SHA-256-based DRBG internally (confirmed by SHA-256 H0-H7
 * initialization constants in the callback function).
 *
 * The library is initialized with label "ezviz-ecdh" as the DRBG seed,
 * then GenerateSessionKey produces output from the DRBG seeded with
 * the master key.
 *
 * We use HKDF-SHA256 as a compatible KDF:
 * - IKM (input key material): ECDH shared secret (master key)
 * - Salt: "ezviz-ecdh" (from InitLib initialization)
 * - Info: empty
 * - Output: `length` bytes of session key
 */
export function ecdhDeriveSessionKey(masterKey: Buffer, length: number): Buffer {
  // Try multiple KDF approaches — the correct one depends on the exact
  // Hikvision SHA-256 DRBG implementation in ecdhCryption.dll.
  // The DRBG is seeded with "ezviz-ecdh" during InitLib.
  //
  // Current approach: HKDF-SHA256 with salt="ezviz-ecdh"
  // Alternative approaches to try if this fails:
  // 1. Raw master key (no KDF)
  // 2. SHA-256(master_key)
  // 3. HMAC-SHA256(key="ezviz-ecdh", data=master_key)
  const salt = Buffer.from('ezviz-ecdh', 'ascii')
  const info = Buffer.alloc(0)
  const derived = hkdfSync('sha256', masterKey, salt, info, length)
  return Buffer.from(derived)
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

  // Encrypt the master key with session key using AES-256-ECB (from Ghidra: param_3 = 0x100)
  const cipher1 = createCipheriv('aes-256-ecb', sessionKey, null)
  cipher1.setAutoPadding(false)
  const encMasterPart1 = cipher1.update(masterKey.subarray(0, 16))

  const cipher2 = createCipheriv('aes-256-ecb', sessionKey, null)
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

  // Encrypt body with ChaCha20 if present
  // From Ghidra: FUN_180012b50 sets up ChaCha20 with session key
  // FUN_180012c90 sets nonce = [counter=0, nonce_word1=1, 0, 0]
  // TODO: KDF is wrong so encryption produces wrong output
  let processedBody = body
  if (body && body.length > 0) {
    const chachaIv = Buffer.alloc(16)
    chachaIv.writeUInt32LE(0, 0) // counter = 0
    chachaIv.writeUInt32LE(1, 4) // nonce word 1 = 1

    const cipher = createCipheriv('chacha20', sessionKey, chachaIv)
    processedBody = cipher.update(body)
  }

  const preHmac = processedBody
    ? Buffer.concat([header, clientInfo, processedBody])
    : Buffer.concat([header, clientInfo])

  // HMAC-SHA256 over the full packet content
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
