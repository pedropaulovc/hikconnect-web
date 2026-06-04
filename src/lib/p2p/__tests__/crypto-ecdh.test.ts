import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  deriveSharedSecret,
  generateSessionKey,
  wrapSessionKey,
  crc32,
  buildEcdhReqPacket,
  rawPublicKeyToSpki,
  spkiPublicKeyToRaw,
} from '../crypto'

// Ground-truth vectors captured from the live iVMS-4200 ecdhCryption.dll (Windows) and
// independently verified with Python `cryptography`. See docs/re/ecdh-kdf-vectors.md.
const CLIENT_PRIV_SCALAR = Buffer.from(
  'c239658bfd8dfdc543185e5bba757be5571d99d899fbc1dbf441cad43d0a266b', 'hex') // 32B raw d
const ECDH_VECTORS = [
  { serverPub: '3059301306072a8648ce3d020106082a8648ce3d03010703420004ddd78ae590ba8d8f7c3f12a5c088e55294c423517d725341a6551da23599914bda4a69e12f7e1c5352c0b2d999481d8dd785217e750fc7eb360d3e56088fa865',
    secret: '5633e1372ef8656d2939fbedcecd0230fc1d971153645fd9feca8d61dab913bc' },
  { serverPub: '3059301306072a8648ce3d020106082a8648ce3d03010703420004f3970ab63fa84e1724c7faca7af75000a2345ffe29936cc906ffb7e24a3f6c9c8f90dc186556879ad53b5276795868392215884caa8f25786c18d035ba5e7c56',
    secret: '263c20d5b9bba76e5cfdd63dd5d52a0563a17922fd9c7e0d29d2c694b38c0092' },
  { serverPub: '3059301306072a8648ce3d020106082a8648ce3d03010703420004d63963cd33cfd61ef9c5ac7213eebccbac755e83a6a7bed174e8c583ce6e6eeb0a10bb45c52420ed9d05d793e4e6296bc2d302eb7529fd234f27c8364b2a9774',
    secret: 'fe59ef118a2d3020a16582a5acb08aa8985983f8273370c202f50d6265e39fe9' },
]
// Verified session-key wrap: AES-256-ECB(S).encrypt(K)
const WRAP_S = Buffer.from('5633e1372ef8656d2939fbedcecd0230fc1d971153645fd9feca8d61dab913bc', 'hex')
const WRAP_K = Buffer.from('5163023492d45e7b2f11a83b9523bf7170b1a948590cf60f95937778e037fd23', 'hex')
const WRAP_OUT = '555a9210d6ed8d712cad8ffedb1fb46e9c28d36c35bf8e49d18eafc5be87a1bd'
// Verified ChaCha20 body: key=session key, counter 0, nonce {1,0,0}
const CHACHA_PT = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021222324252627', 'hex')
const CHACHA_CT = '4d6e35baf580790ced939eb7cd5aa01f51cba5626b198a43ea8b01982b2948b9041aa2beb92f9b1e'

describe('ECDH key handling', () => {
  it('generates valid P-256 key pair', () => {
    const kp = generateKeyPair()
    expect(kp.publicKey.length).toBe(65)
    expect(kp.publicKey[0]).toBe(0x04)
    expect(kp.privateKey.length).toBe(32)
  })

  it('derives a symmetric shared secret', () => {
    const alice = generateKeyPair()
    const bob = generateKeyPair()
    const a = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const b = deriveSharedSecret(bob.privateKey, alice.publicKey)
    expect(a.length).toBe(32)
    expect(a).toEqual(b)
  })

  it('reproduces the captured ECDH shared secrets (DLL ground truth)', () => {
    for (const v of ECDH_VECTORS) {
      const serverPubRaw = spkiPublicKeyToRaw(Buffer.from(v.serverPub, 'hex'))
      const secret = deriveSharedSecret(CLIENT_PRIV_SCALAR, serverPubRaw)
      expect(secret.toString('hex')).toBe(v.secret)
    }
  })

  it('converts raw pubkey to SPKI/DER and back', () => {
    const kp = generateKeyPair()
    const spki = rawPublicKeyToSpki(kp.publicKey)
    expect(spki.length).toBe(91)
    expect(spkiPublicKeyToRaw(spki)).toEqual(kp.publicKey)
  })
})

describe('ECDH relay session crypto', () => {
  it('generates a random 32-byte session key (not a KDF of the secret)', () => {
    const a = generateSessionKey()
    const b = generateSessionKey()
    expect(a.length).toBe(32)
    expect(a).not.toEqual(b)
  })

  it('wraps the session key with AES-256-ECB(sharedSecret) — DLL ground truth', () => {
    expect(wrapSessionKey(WRAP_S, WRAP_K).toString('hex')).toBe(WRAP_OUT)
  })

  it('computes standard CRC-32 (FUN_180001000 check value)', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
  })

  it('encrypts the body with ChaCha20(sessionKey) — DLL ground truth', () => {
    // body lives at offset 134; verify the packet's body region matches the captured ChaCha20 vector
    const packet = buildEcdhReqPacket({
      sessionKey: WRAP_K,
      masterKey: WRAP_S,
      clientPublicKey: generateKeyPair().publicKey,
      channelId: 0x01,
      body: CHACHA_PT,
    })
    expect(packet.subarray(134, 134 + CHACHA_PT.length).toString('hex')).toBe(CHACHA_CT)
  })
})

describe('buildEcdhReqPacket', () => {
  it('produces the documented layout (no body)', () => {
    const kp = generateKeyPair()
    const packet = buildEcdhReqPacket({
      sessionKey: generateSessionKey(),
      masterKey: Buffer.alloc(32, 0xdd),
      clientPublicKey: kp.publicKey,
      channelId: 0x09,
    })
    // header(11) + wrap(32) + SPKI(91) + HMAC(32) = 166
    expect(packet.length).toBe(166)
    expect(packet[0]).toBe(0x24)
    expect(packet[1]).toBe(0x01)
    expect(packet[5]).toBe(0x01)
    expect(packet[6]).toBe(0x09)
    expect(packet.readUInt32BE(7)).toBe(1) // DLL hard-codes seq=1
    // off 11 wrap == AES-256-ECB(masterKey).encrypt(sessionKey)
  })

  it('embeds the wrap and client pubkey at the right offsets', () => {
    const kp = generateKeyPair()
    const sessionKey = generateSessionKey()
    const masterKey = Buffer.alloc(32, 0x11)
    const packet = buildEcdhReqPacket({ sessionKey, masterKey, clientPublicKey: kp.publicKey, channelId: 0x02 })
    expect(packet.subarray(11, 43)).toEqual(wrapSessionKey(masterKey, sessionKey))
    expect(packet.subarray(43, 134)).toEqual(rawPublicKeyToSpki(kp.publicKey))
  })

  it('includes the body and sets body_length (header == ciphertext length)', () => {
    const kp = generateKeyPair()
    const body = Buffer.from('hello world')
    const packet = buildEcdhReqPacket({
      sessionKey: generateSessionKey(),
      masterKey: Buffer.alloc(32, 0xee),
      clientPublicKey: kp.publicKey,
      channelId: 0x01,
      body,
    })
    // 11 + 32 + 91 + 11 (body) + 32 (HMAC) = 177
    expect(packet.length).toBe(177)
    expect(packet.readUInt16BE(3)).toBe(body.length)
  })

  it('MACs with the shared secret (changes with masterKey, fixed 32B)', () => {
    const kp = generateKeyPair()
    const sessionKey = generateSessionKey()
    const base = { sessionKey, clientPublicKey: kp.publicKey, channelId: 0x09 }
    const p1 = buildEcdhReqPacket({ ...base, masterKey: Buffer.alloc(32, 0x01) })
    const p2 = buildEcdhReqPacket({ ...base, masterKey: Buffer.alloc(32, 0x02) })
    expect(p1.subarray(-32)).not.toEqual(p2.subarray(-32)) // MAC keyed by shared secret
    expect(p1.subarray(-32).length).toBe(32)
  })

  it('full handshake simulation', () => {
    const serverKp = generateKeyPair()
    const clientKp = generateKeyPair()
    const masterKey = deriveSharedSecret(clientKp.privateKey, serverKp.publicKey)
    const sessionKey = generateSessionKey()
    const packet = buildEcdhReqPacket({ sessionKey, masterKey, clientPublicKey: clientKp.publicKey, channelId: 0x09 })
    expect(packet.length).toBe(166)
    expect(packet[0]).toBe(0x24)
    // server recovers the session key: AES-256-ECB-decrypt the off-11 wrap with the shared secret
  })
})
