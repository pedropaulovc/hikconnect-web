import { describe, it, expect } from 'vitest'
import { encryptPacket, decryptPacket, generateKeyPair, deriveSharedSecret } from '../crypto'

describe('ChaCha20 encryption', () => {
  it('encrypts and decrypts a payload round-trip', () => {
    const key = Buffer.alloc(32, 0xab)
    const hmacKey = Buffer.alloc(32, 0xcd)
    const plaintext = Buffer.from('Hello NVR')
    const seqNum = 1

    const encrypted = encryptPacket(key, hmacKey, plaintext, seqNum)
    // 11 header + 9 payload + 32 HMAC = 52
    expect(encrypted.length).toBe(52)
    expect(encrypted[0]).toBe(0x24) // '$'
    expect(encrypted[1]).toBe(0x02) // type

    const decrypted = decryptPacket(key, hmacKey, encrypted)
    expect(decrypted).toEqual(plaintext)
  })

  it('rejects tampered HMAC', () => {
    const key = Buffer.alloc(32, 0xab)
    const hmacKey = Buffer.alloc(32, 0xcd)
    const encrypted = encryptPacket(key, hmacKey, Buffer.from('test'), 1)
    encrypted[encrypted.length - 1] ^= 0xff // flip last HMAC byte
    expect(() => decryptPacket(key, hmacKey, encrypted)).toThrow('HMAC')
  })
})

describe('ECDH P-256', () => {
  it('derives matching shared secrets', () => {
    const alice = generateKeyPair()
    const bob = generateKeyPair()

    const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(secretA).toEqual(secretB)
    expect(secretA.length).toBe(32)
  })
})
