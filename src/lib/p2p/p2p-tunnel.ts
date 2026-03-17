import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { decryptPacket } from './crypto'
import { HEADER_SIZE, HMAC_SIZE } from './packet'

export type P2PConfig = {
  peerAddress: string
  peerPort: number
  encKey: Buffer
  hmacKey: Buffer
}

export class P2PTunnel extends EventEmitter {
  private socket: UdpSocket | null = null
  private _seqNum = 0

  constructor(private config: P2PConfig) {
    super()
  }

  get seqNum(): number {
    return this._seqNum
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createSocket('udp4')

      this.socket.on('message', (msg) => {
        this.handlePacket(msg)
      })

      this.socket.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.socket.bind(0, () => {
        this.sendPunch()
        resolve()
      })
    })
  }

  private sendPunch(): void {
    if (!this.socket) return
    // Send empty UDP packets for NAT hole-punching
    const punch = Buffer.alloc(1)
    for (let i = 0; i < 3; i++) {
      this.socket.send(punch, this.config.peerPort, this.config.peerAddress)
    }
  }

  sendRaw(data: Buffer): void {
    if (!this.socket) throw new Error('Tunnel not open')
    this.socket.send(data, this.config.peerPort, this.config.peerAddress)
  }

  private handlePacket(buf: Buffer): void {
    if (buf.length < HEADER_SIZE + HMAC_SIZE) return
    if (buf[0] !== 0x24) return // not our protocol

    try {
      const plaintext = decryptPacket(this.config.encKey, this.config.hmacKey, buf)
      this._seqNum++
      this.emit('data', plaintext)
    } catch {
      this.emit('decrypt-error', new Error('Packet decryption failed'))
    }
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
