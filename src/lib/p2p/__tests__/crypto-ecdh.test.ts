import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  deriveSharedSecret,
  ecdhDeriveSessionKey,
  buildEcdhReqPacket,
  rawPublicKeyToSpki,
  spkiPublicKeyToRaw,
} from '../crypto'

describe('ECDH crypto', () => {
  it('generates valid P-256 key pair', () => {
    const kp = generateKeyPair()
    expect(kp.publicKey.length).toBe(65) // uncompressed P-256 = 65 bytes
    expect(kp.publicKey[0]).toBe(0x04)   // uncompressed point prefix
    expect(kp.privateKey.length).toBe(32)
  })

  it('derives shared secret between two parties', () => {
    const alice = generateKeyPair()
    const bob = generateKeyPair()

    const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(secretA.length).toBe(32)
    expect(secretA).toEqual(secretB)
  })

  it('derives session key from master key via AES-ECB counter KDF', () => {
    const masterKey = Buffer.alloc(32, 0xAA)
    const sessionKey = ecdhDeriveSessionKey(masterKey, 32)

    expect(sessionKey.length).toBe(32)
    // Should be deterministic
    const sessionKey2 = ecdhDeriveSessionKey(masterKey, 32)
    expect(sessionKey).toEqual(sessionKey2)

    // Different master key → different session key
    const otherMaster = Buffer.alloc(32, 0xBB)
    const otherSession = ecdhDeriveSessionKey(otherMaster, 32)
    expect(otherSession).not.toEqual(sessionKey)
  })

  it('derives 16-byte session key', () => {
    const masterKey = Buffer.alloc(32, 0xCC)
    const sessionKey = ecdhDeriveSessionKey(masterKey, 16)
    expect(sessionKey.length).toBe(16)
  })

  it('converts raw pubkey to SPKI/DER and back', () => {
    const kp = generateKeyPair()
    const spki = rawPublicKeyToSpki(kp.publicKey)
    expect(spki.length).toBe(91)

    const raw = spkiPublicKeyToRaw(spki)
    expect(raw).toEqual(kp.publicKey)
  })

  it('builds ECDH request packet with correct structure', () => {
    const kp = generateKeyPair()
    const masterKey = Buffer.alloc(32, 0xDD)
    const sessionKey = ecdhDeriveSessionKey(masterKey, 32)

    const packet = buildEcdhReqPacket({
      sessionKey,
      masterKey,
      clientPublicKey: kp.publicKey,
      channelId: 0x09,
      bodyLength: 0,
    })

    // Header (11) + encrypted master (32) + SPKI pubkey (91) + HMAC (32) = 166
    expect(packet.length).toBe(166)
    expect(packet[0]).toBe(0x24) // '$' magic
    expect(packet[1]).toBe(0x01) // version
    expect(packet[5]).toBe(0x01) // constant
    expect(packet[6]).toBe(0x09) // channelId
    expect(packet.readUInt32BE(7)).toBe(1) // seqNum default
  })

  it('builds ECDH request packet with body', () => {
    const kp = generateKeyPair()
    const masterKey = Buffer.alloc(32, 0xEE)
    const sessionKey = ecdhDeriveSessionKey(masterKey, 32)
    const body = Buffer.from('hello world')

    const packet = buildEcdhReqPacket({
      sessionKey,
      masterKey,
      clientPublicKey: kp.publicKey,
      channelId: 0x01,
      bodyLength: body.length,
      body,
    })

    // 11 + 32 + 91 + 11 (body) + 32 (HMAC) = 177
    expect(packet.length).toBe(177)
    expect(packet.readUInt16BE(3)).toBe(body.length)
  })

  it('full ECDH handshake simulation', () => {
    // Simulate: client generates keys, computes shared secret with server pubkey
    const serverKp = generateKeyPair()
    const clientKp = generateKeyPair()

    // Client computes shared secret (master key)
    const masterKey = deriveSharedSecret(clientKp.privateKey, serverKp.publicKey)
    expect(masterKey.length).toBe(32)

    // Derive session key
    const sessionKey = ecdhDeriveSessionKey(masterKey, 32)
    expect(sessionKey.length).toBe(32)

    // Build request packet
    const packet = buildEcdhReqPacket({
      sessionKey,
      masterKey,
      clientPublicKey: clientKp.publicKey,
      channelId: 0x09,
      bodyLength: 0,
    })

    expect(packet.length).toBe(166)
    expect(packet[0]).toBe(0x24)
  })
})
