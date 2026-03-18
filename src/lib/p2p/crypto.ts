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
 * Implements the exact Hikvision custom hash-based KDF from ecdhCryption.dll.
 * From Ghidra RE: FUN_180016730 (custom hash) → FUN_180016a60 (key derivation).
 *
 * The hash uses a Matyas-Meyer-Oseas construction with AES-256-ECB:
 * 1. Pad input: [3 zero bytes, counter, 12 zeros, 4-byte BE length, 3 zeros,
 *    0x30, data, 0x80 padding]
 * 2. XOR 16-byte blocks into state, AES-256-ECB encrypt after each XOR
 * 3. Repeat 3 times (incrementing counter) to produce 48 bytes
 * 4. Use those 48 bytes as new AES-256 key, produce 48 more output bytes
 */
export function ecdhDeriveSessionKey(masterKey: Buffer, length: number): Buffer {
  // Phase 1: Custom hash (FUN_180016730) of the master key → 48 bytes
  const hashResult = hikCustomHash(masterKey)

  // Phase 2: Use hash result as AES-256 key, counter-mode for final output
  // From FUN_180016a60: the hash result feeds into a new AES key expansion,
  // then counter-mode AES produces the session key bytes
  return hikCounterMode(hashResult.subarray(0, 32), length)
}

/**
 * Hikvision custom hash (FUN_180016730 from ecdhCryption.dll).
 * Input: arbitrary bytes. Output: 48 bytes.
 *
 * Uses Matyas-Meyer-Oseas construction: H(m) = E_H(m) XOR m
 * with AES-256-ECB as the block cipher.
 */
function hikCustomHash(data: Buffer): Buffer {
  // Build the padded message buffer (0x1A0 = 416 bytes)
  const buf = Buffer.alloc(0x1a0)
  // Byte 3: counter (starts at 0, incremented before each use in the outer loop)
  // buf[3] = 0 (will be incremented in the loop)
  // Bytes 16-19: big-endian length of input data
  buf[16] = (data.length >> 24) & 0xff
  buf[17] = (data.length >> 16) & 0xff
  buf[18] = (data.length >> 8) & 0xff
  buf[19] = data.length & 0xff
  // Byte 23: 0x30 (output size indicator)
  buf[23] = 0x30
  // Bytes 24+: input data
  data.copy(buf, 24)
  // Byte after data: 0x80 (Merkle-Damgård padding)
  buf[24 + data.length] = 0x80

  // Initial AES-256 key: [0x00, 0x01, 0x02, ..., 0x1F]
  const initialKey = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) initialKey[i] = i

  // Set up AES-256-ECB context
  // local_368 is the AES context, initialized with the key [0..31]
  let aesKey = initialKey

  // Total bytes to process: param_3 + 0x19 (data length + 25 header bytes)
  const totalBytes = data.length + 0x19

  // Outer loop: produce 3 x 16 = 48 bytes
  const intermediate = Buffer.alloc(48)

  for (let block = 0; block < 3; block++) {
    // Increment counter byte (local_1e5 = buf[3])
    buf[3] = buf[3] + 1

    // Inner loop: XOR 16-byte chunks from buf into state, then AES-ECB encrypt
    const state = Buffer.alloc(16)
    let remaining = totalBytes
    let offset = 0 // Read from start of buf (lVar9 starts at 0x60 relative to &local_248,
                    // which = 0x248 - 0x1e8 = 0x60 offset into buf... so offset 0 of buf)

    while (remaining > 0) {
      // XOR 16 bytes from buf[offset] into state
      for (let i = 0; i < 16; i++) {
        state[i] ^= buf[offset + i]
      }
      offset += 16

      // Consume min(remaining, 16) bytes
      const consume = Math.min(remaining, 16)
      remaining -= consume

      // AES-256-ECB encrypt state in-place
      const cipher = createCipheriv('aes-256-ecb', aesKey, null)
      cipher.setAutoPadding(false)
      const encrypted = cipher.update(state)
      encrypted.copy(state)
    }

    // Store 16 bytes of result
    state.copy(intermediate, block * 16)
  }

  // Phase 2: Use intermediate (48 bytes) as new AES-256 key (first 32 bytes)
  aesKey = intermediate.subarray(0, 32)

  // Produce 48 bytes of final output via AES-256-ECB (self-encrypting state)
  const result = Buffer.alloc(48)
  const finalState = Buffer.alloc(16) // starts as zeros

  for (let block = 0; block < 3; block++) {
    const cipher = createCipheriv('aes-256-ecb', aesKey, null)
    cipher.setAutoPadding(false)
    const encrypted = cipher.update(finalState)
    encrypted.copy(result, block * 16)
    encrypted.copy(finalState) // feed output as next input (ECB chaining)
  }

  return result
}

/**
 * AES-256-ECB counter mode key derivation.
 * From FUN_180016a60 phase 2 and FUN_180016e00.
 */
function hikCounterMode(aesKey: Buffer, length: number): Buffer {
  const blocks: Buffer[] = []
  let remaining = length
  const counterBlock = Buffer.alloc(16)
  let counter = 1

  while (remaining > 0) {
    // Increment counter at byte 15 (big-endian style from native code)
    counterBlock[15] = counter & 0xff
    counter++

    const cipher = createCipheriv('aes-256-ecb', aesKey, null)
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
