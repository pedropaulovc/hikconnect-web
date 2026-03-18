---
name: vtdu_protocol_capture
description: Complete P2P + VTM streaming protocol captured via Frida, tcpdump, and Ghidra — server IPs, keys, packet formats, ECDH handshake
type: project
---

## Protocol Stack Overview (updated 2026-03-18)

Two streaming paths, both reverse-engineered:

### Path A: P2P (UDP) — STATUS: Bidirectional device communication achieved

**P2P Connection Flow (verified on VPS with public IP):**
```
1. P2P_SETUP (0x0B02) → P2P server → registers link
2. Server responds 0x0B03 (device info: 192.168.0.101:17193)
3. Server notifies device → device punches UDP to our IP
4. Device sends 0x0C00 (PREVIEW_RSP) with echoed session key
5. TRANSFOR_DATA (0x0B04) with PLAY_REQUEST → P2P server
6. Server responds 0x0B05 with SUCCESS + deviceSessionId
7. Video data flows via UDP P2P
```

**P2P Servers:** `52.5.124.127:6000`, `52.203.168.207:6000`

**AES Encryption (universal for ALL V3 messages):**
- Algorithm: AES-128-CBC with PKCS5 padding
- **IV: `"01234567" + 8 zero bytes`** (0x30313233343536370000000000000000) — applies to ALL layers
- CRC-8: Custom Hikvision bitwise algorithm (NOT polynomial 0x39)
- Reserved field: 0x6234 (protocol version constant in all V3 headers)

**Two encryption keys:**
- **P2PServerKey** (outer): `e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5` (from GrayConfig via Frida, stable per account)
- **P2PLinkKey** (inner): first 32 ASCII chars of API KMS `secretKey` (confirmed via Frida capture of `szP2PLinkKey`)

#### Step 1: P2P_SETUP (0x0B02) — Link Registration

Standalone V3 message (NOT wrapped in TRANSFOR_DATA). Uses P2PServerKey, NO expand header.

```
V3 header (12B): magic=0xe2, mask=0xda, cmd=0x0B02, seq=0, reserved=0x6234, headerLen=12
Encrypted body (AES-128-CBC with P2PServerKey[0:16]):
  tag=0x05: sessionKey (base64(serial)+channel+timestamp+random, 32 chars)
  tag=0x06: userId (32 ASCII hex chars)
  tag=0x00: device serial (e.g., "L38239367")
  tag=0x04: protocol version (value=3)
  tag=0xFF: ComposeTransfor sub-TLVs as value:
    ├── 0x71: busType (1=preview)
    ├── 0x72: flag (value=3)
    ├── 0x75: flag (value=1)
    ├── 0x7f: NAT type (value=0x0a)
    ├── 0x74: local IP:port string
    └── 0x8c: routing value (4B BE, zeros)
```

**Response:** cmd=0x0B03 with device connection info (IP:port in tag=0x74 sub-TLV).
Also receives cmd=0x0C06 (CT_CHECK) with additional device info.

#### Step 2: TRANSFOR_DATA (0x0B04) — PLAY_REQUEST

Two-layer encrypted. Outer uses P2PServerKey, inner uses P2PLinkKey.

```
Outer V3 envelope (12B header + AES-CBC encrypted body):
├── tag=0x00: device serial (TLV: 00 09 "L38239367")
├── tag=0x07: inner V3 message (2-byte BE length)
└── Inner V3 message (PLAY_REQUEST 0x0c02):
    ├── 12B V3 header: magic=0xe2, mask=0xde, msgType=0x0c02, reserved=0x6234
    ├── 48B expand header (TLV):
    │   ├── tag=0x00: key version (2B, e.g., 101)
    │   ├── tag=0x01: userId (32B ASCII hex)
    │   ├── tag=0x02: clientId (4B BE)
    │   └── tag=0x03: channel (2B BE)
    └── Encrypted body (AES-128-CBC with P2PLinkKey, PKCS5):
        PLAY_REQUEST TLV attributes:
        ├── tag=0x76: busType (1=preview, 2=playback)
        ├── tag=0x05: sessionKey (base64(serial)+channel+timestamp+random)
        ├── tag=0x78: streamType (0=main, 1=sub)
        ├── tag=0x77: channelNo (2B BE)
        ├── tag=0x7e: streamSession (4B BE)
        ├── tag=0x7d: timeout (4B BE, value=180)
        ├── tag=0x7a: startTime ("YYYY-MM-DDTHH:MM:SS")
        ├── tag=0x7b: stopTime
        ├── tag=0x83: device serial
        ├── tag=0xb2: session UUID
        └── tag=0xb3: timestamp ms
```

**Response:** cmd=0x0B05 with tag=0x02=0 (SUCCESS) and tag=0x84 (deviceSessionId).

**Key insight about outer body tag=0x00:** The old "routing header" bytes `30387e000c07050e333637` were actually `tag=0x00 serial` XORed with the AES IV during decryption with wrong IV. The true plaintext is `00 09 4c333832333933363 37` = tag=0x00, len=9, "L38239367".

**Error progression:** 0x101012 (wrong key) → 0x000003 (missing fields) → 0x101011 (wrong body) → 0x0c (expired session) → 0xcb (203, "Link status invalid" = missing P2P_SETUP) → SUCCESS

**Current status:** P2P_SETUP succeeds, device sends 0x0C00 PREVIEW_RSP packets. PLAY_REQUEST from separate socket still gets "Link status invalid" — need to figure out whether PLAY_REQUEST should go to device directly or requires different socket/timing.

### Path B: VTM Relay (TCP) — STATUS: ECDH handshake partially decoded

**VTM Server:** `148.153.53.29:8554` (vtmvirginia.ezvizlife.com)

**VTM Public Key (P-256 SPKI/DER, 91 bytes):**
```
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqzR4o4/j2vzZ0mBmp2ym1CJkX3jzgqS8fIxQ1lDTcil7PE50SKxCXcevwE4NaJbUf5Sk9iyUDl+8/z2WbA4MYg==
```

**VTM uses protobuf (not V3 TLV):**
- Message types: 0x130=StreamInfoReq, 0x131=StreamInfoRsp, 0x132=StreamKeepAliveReq, 0x13b=StopStreamReq, 0x145=StartStreamReq
- StreamInfoReq fields: 1=streamurl, 2=vtmstreamkey, 3=clnversion, 4=proxytype, 5=pdsstring, 6=useragent, 7=pdsnum, 8=timeout
- URL scheme: `ysproto://host:port/serial?channel=N&stream=N&btype=N`

**ECDH handshake:** Partially decoded from Ghidra. Server rejects at ~150ms. Blocked on pubkey format (65B raw vs 91B SPKI/DER) and session key derivation.

### Device Info (from Frida + API)

- Serial: L38239367
- Device IP: 24.35.64.195 (public), 192.168.0.101 (local)
- Ports: cmdPort=9010, streamPort=9020, NAT-mapped streamPort=17193
- Verification code: ABCDEF (6-char AES key for frame decryption)
- API domain: apiius.hik-connect.com
- userId: fcfaec90a55f4a61b4e7211152a2d805
- clientId: 0x0aed13f5 (from CGlobalInfo::GetClientId, hardcoded from capture)

### Implementation Status

| Component | File | Status |
|-----------|------|--------|
| V3 protocol (encode/decode/CRC) | v3-protocol.ts | ✅ Working, CRC verified |
| P2P_SETUP (0x0B02) | p2p-session.ts | ✅ Working, device responds with 0x0C00 |
| PLAY_REQUEST builder | p2p-session.ts | ✅ Built dynamically, body fully decoded |
| P2P session manager | p2p-session.ts | ⚠️ P2P_SETUP works, PLAY_REQUEST needs refinement |
| SafeProtocol STUN | stun-client.ts | ✅ Working |
| CAS TCP client | cas-client.ts | ✅ Working (framing) |
| VTM client (protobuf) | vtm-client.ts | ⚠️ ECDH handshake incomplete |
| Device P2P framing | device-p2p.ts | ✅ Built |
| IMKH media parser | imkh-parser.ts | ✅ Built |
| LiveStream (P2P→HLS) | live-stream.ts | ⚠️ Pipeline built, needs data session |
| FFmpeg HLS pipe | hls/ffmpeg-pipe.ts | ✅ Working |
| Web UI (login/devices/player) | app/page.tsx | ✅ Working |
| Stream API routes | app/api/stream/* | ✅ Working |
