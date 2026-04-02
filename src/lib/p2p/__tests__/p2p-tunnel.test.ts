import { describe, it, expect, vi } from 'vitest'
import { P2PTunnel } from '../p2p-tunnel'
import { encryptPacket } from '../crypto'

const ENC_KEY = Buffer.alloc(32, 0xab)
const HMAC_KEY = Buffer.alloc(32, 0xcd)

function makeConfig() {
  return {
    peerAddress: '24.35.64.195',
    peerPort: 9020,
    encKey: ENC_KEY,
    hmacKey: HMAC_KEY,
  }
}

describe('P2PTunnel', () => {
  it('constructs with peer info', () => {
    const tunnel = new P2PTunnel(makeConfig())
    expect(tunnel).toBeDefined()
  })

  it('starts with seqNum 0', () => {
    const tunnel = new P2PTunnel(makeConfig())
    expect(tunnel.seqNum).toBe(0)
  })

  it('sendRaw throws when tunnel is not open', () => {
    const tunnel = new P2PTunnel(makeConfig())
    expect(() => tunnel.sendRaw(Buffer.from('hi'))).toThrow('Tunnel not open')
  })

  it('close is safe to call when not open', () => {
    const tunnel = new P2PTunnel(makeConfig())
    expect(() => tunnel.close()).not.toThrow()
  })

  it('opens and closes a UDP socket', async () => {
    const tunnel = new P2PTunnel(makeConfig())
    await tunnel.open()
    // Should not throw
    tunnel.close()
  })

  it('emits "data" when a valid encrypted packet is received', async () => {
    const tunnel = new P2PTunnel(makeConfig())
    await tunnel.open()

    const dataPromise = new Promise<Buffer>((resolve) => {
      tunnel.on('data', resolve)
    })

    // Build an encrypted packet and deliver it to the tunnel's socket
    const plaintext = Buffer.from('Hello NVR')
    const packet = encryptPacket(ENC_KEY, HMAC_KEY, plaintext, 1)

    // Get the local port the tunnel is bound to, then send a packet to it
    // We use a second UDP socket to deliver data to the tunnel
    const { createSocket } = await import('node:dgram')
    const sender = createSocket('udp4')
    const addr = tunnel.localAddress()
    sender.send(packet, addr.port, '127.0.0.1')

    const received = await dataPromise
    expect(received).toEqual(plaintext)
    expect(tunnel.seqNum).toBe(1)

    sender.close()
    tunnel.close()
  })

  it('emits "decrypt-error" on tampered packet', async () => {
    const tunnel = new P2PTunnel(makeConfig())
    await tunnel.open()

    const errorPromise = new Promise<Error>((resolve) => {
      tunnel.on('decrypt-error', resolve)
    })

    const plaintext = Buffer.from('test')
    const packet = encryptPacket(ENC_KEY, HMAC_KEY, plaintext, 1)
    packet[packet.length - 1] ^= 0xff // tamper HMAC

    const { createSocket } = await import('node:dgram')
    const sender = createSocket('udp4')
    const addr = tunnel.localAddress()
    sender.send(packet, addr.port, '127.0.0.1')

    const err = await errorPromise
    expect(err.message).toContain('decryption failed')

    sender.close()
    tunnel.close()
  })

  it('ignores packets that are too short', async () => {
    const tunnel = new P2PTunnel(makeConfig())
    await tunnel.open()

    const dataSpy = vi.fn()
    const errorSpy = vi.fn()
    tunnel.on('data', dataSpy)
    tunnel.on('decrypt-error', errorSpy)

    const { createSocket } = await import('node:dgram')
    const sender = createSocket('udp4')
    const addr = tunnel.localAddress()

    // Send a tiny packet (below HEADER_SIZE + HMAC_SIZE threshold)
    sender.send(Buffer.from('hi'), addr.port, '127.0.0.1')

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 50))

    expect(dataSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    sender.close()
    tunnel.close()
  })

  it('ignores packets without magic byte', async () => {
    const tunnel = new P2PTunnel(makeConfig())
    await tunnel.open()

    const dataSpy = vi.fn()
    const errorSpy = vi.fn()
    tunnel.on('data', dataSpy)
    tunnel.on('decrypt-error', errorSpy)

    const { createSocket } = await import('node:dgram')
    const sender = createSocket('udp4')
    const addr = tunnel.localAddress()

    // Send a packet that's long enough but starts with wrong magic
    const badPacket = Buffer.alloc(50, 0x00)
    sender.send(badPacket, addr.port, '127.0.0.1')

    await new Promise((r) => setTimeout(r, 50))

    expect(dataSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    sender.close()
    tunnel.close()
  })
})
