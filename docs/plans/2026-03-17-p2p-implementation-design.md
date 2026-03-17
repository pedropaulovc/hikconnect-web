# P2P Streaming Client — Implementation Design

**Date:** 2026-03-17
**Goal:** Build a TypeScript P2P streaming client in the existing Next.js app, supporting live preview and SD card playback from a Hikvision NVR via the Hik-Connect cloud infrastructure.

**Prerequisite:** Phase A static RE complete. CAS protobuf schemas to be extracted from binary before implementation.

---

## Phase B' — Protobuf Schema Extraction

Extract CAS broker message schemas from `libezstreamclient.so` instead of capturing live traffic.

**Approach:**
1. Search binary for embedded `FileDescriptorProto` (protobuf self-description)
2. Search for protobuf field name strings (`hik::ys::streamprotocol::PdsInfo`, etc.)
3. Decompile CAS message serialization functions to reconstruct message structures
4. Validate against existing Frida capture logs from Phase 2

**Fallback:** If schemas can't be extracted statically, provision Hetzner CAX11 ARM VM with proper firewall (see security requirements) for tcpdump capture.

## Phase C — TypeScript Implementation

### Architecture

```
Browser ←─ HLS ─→ Next.js API routes
                    ├── src/lib/hikconnect/    (existing: REST API client)
                    ├── src/lib/p2p/           (new: P2P network layer)
                    │   ├── cas-client.ts      CAS broker TCP client
                    │   ├── stun-client.ts     STUN NAT binding
                    │   ├── p2p-tunnel.ts      UDP hole-punch + data transfer
                    │   ├── crypto.ts          ChaCha20 + ECDH P-256 + HMAC-SHA256
                    │   └── packet.ts          11-byte header framing
                    ├── src/lib/demux/         (new: media demuxing)
                    │   └── ps-demuxer.ts      MPEG-PS → H.264 NALUs
                    └── src/lib/hls/           (new: HLS output)
                        └── ffmpeg-pipe.ts     stdin H.264 → HLS segments
```

### Crypto Layer (fully reversed)

- **Encryption:** ChaCha20 (Node.js `crypto.createCipheriv('chacha20')`)
- **Key exchange:** ECDH P-256 (Node.js `crypto.createECDH('prime256v1')`)
- **Authentication:** HMAC-SHA256 (Node.js `crypto.createHmac('sha256', key)`)
- **Session key:** 32 random bytes via `crypto.randomBytes(32)`
- **Master key:** ECDH shared secret (32 bytes)
- **Nonce:** `[seqnum_u32_le, 0x00000000, 0x00000000]` (12 bytes)

### Packet Format

```
Offset  Size  Field
0       1     Magic: 0x24 ('$')
1       1     Type: 0x02 (data)
2       1     Padding: 0x00
3       2     Payload length (big-endian)
5       2     Reserved: 0x0000
7       4     Sequence number (big-endian)
11      N     ChaCha20 encrypted payload
11+N    32    HMAC-SHA256
```

### Scope

| Feature | Priority | Status |
|---------|----------|--------|
| Crypto layer (ChaCha20/ECDH/HMAC) | P0 | Fully reversed, ready to implement |
| Packet framing (encode/decode) | P0 | Fully reversed, ready to implement |
| CAS broker client | P0 | Needs protobuf schemas |
| STUN client | P0 | Standard RFC 5389 (needs verification) |
| P2P tunnel (UDP hole-punch) | P0 | Architecture known, details need dynamic validation |
| MPEG-PS demuxer | P0 | Standard format, libraries available |
| FFmpeg HLS pipe | P0 | Straightforward |
| Live preview | P0 | All above combined |
| SD card playback | P1 | Additional CAS commands (pause/resume/seek/rate) |
| Recording list | P1 | Already implemented via REST API |

### Testing Strategy

- **Crypto:** RFC 8439 test vectors for ChaCha20, known ECDH test vectors
- **Packet framing:** Round-trip encode/decode unit tests
- **CAS client:** Integration test against real CAS broker
- **STUN client:** Integration test against public STUN servers
- **End-to-end:** Live video from NVR displayed in browser
