---
name: vtdu_protocol_capture
description: Complete P2P + VTM streaming protocol captured via Frida, tcpdump, and Ghidra — server IPs, keys, packet formats, ECDH handshake
type: project
---

## Protocol Stack Overview (2026-03-17)

Two streaming paths, both reverse-engineered:

### Path A: P2P (UDP) — STATUS: Body fully decoded, blocked on "Link status invalid"

**P2P Server Handshake:**
- Servers: `52.5.124.127:6000`, `52.203.168.207:6000`
- Protocol: V3 TRANSFOR_DATA (0x0b04) → TRANSFOR_DATA2 (0x0b05)
- CRC-8: Custom Hikvision bitwise algorithm (NOT polynomial 0x39), verified against pcap
- Reserved field: 0x6234 (protocol version constant in all V3 headers)

**Two-Layer Encryption:**
- **Outer:** AES-128-CBC, key = P2PServerKey[0:16], IV = zeros
- **Inner:** AES-128-CBC, key = P2PLinkKey[0:16], IV = "01234567" + 8 zero bytes
- P2PServerKey: `e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5` (from GrayConfig, stable per account)
- P2PLinkKey: first 32 ASCII chars of API KMS `secretKey` (e.g., "6447f56b9e4229fb94b6f2677603e9c0")
- P2PLinkKey confirmed via Frida capture of `szP2PLinkKey` from `InitParam.createPreviewHandle`

**P2P Request Body Structure (fully decoded from Ghidra RE + pcap):**
```
Outer V3 envelope (12B header + AES-CBC encrypted body):
├── Routing header (11 bytes): static, contains serial last 3 chars
│   Hex: 30387e000c07050e + ASCII(serial[-3:])
├── tag=0x07 (3 bytes): 2-byte BE length of inner V3 message
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
        ├── tag=0x7d: timeout? (4B BE, value=180)
        ├── tag=0x7a: startTime ("YYYY-MM-DDTHH:MM:SS")
        ├── tag=0x7b: stopTime
        ├── tag=0x83: device serial
        ├── tag=0xb2: session UUID
        └── tag=0xb3: timestamp ms
```

**Error progression:** 0x101012 (wrong key) → 0x000003 (missing fields) → 0x101011 (wrong body) → 0x0c (12, expired session) → 0xcb (203, "Link status invalid") → SUCCESS (tag=0x02=0)

**Current blocker:** Error 203 "Link status invalid" from VPS. Server parses our request correctly but says the P2P link is invalid. Likely causes:
1. Need CAS/STUN registration step before PLAY_REQUEST (the native app goes through p2pnet_Init → STUN → CAS broker exchange first)
2. The routing header (first 11 bytes) may encode session-specific routing not yet understood
3. The clientId (0x0aed13f5) may be device-installation-specific

**Verified working from Android emulator:** The app successfully streams via direct UDP P2P to device 24.35.64.195:17193 (NAT-mapped port).

### Path B: VTM Relay (TCP) — STATUS: ECDH handshake partially decoded

**VTM Server:** `148.153.53.29:8554` (vtmvirginia.ezvizlife.com)

**VTM Public Key (P-256 SPKI/DER, 91 bytes):**
```
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqzR4o4/j2vzZ0mBmp2ym1CJkX3jzgqS8fIxQ1lDTcil7PE50SKxCXcevwE4NaJbUf5Sk9iyUDl+8/z2WbA4MYg==
```

**VTM uses protobuf (not V3 TLV):**
- Message types from Ghidra `get_msg_type()`:
  - 0x130 = StreamInfoReq
  - 0x131 = StreamInfoRsp
  - 0x132 = StreamKeepAliveReq
  - 0x13b = StopStreamReq
  - 0x145 = StartStreamReq
- StreamInfoReq field numbers (from Ghidra SerializeWithCachedSizes):
  1=streamurl(bytes), 2=vtmstreamkey(bytes), 3=clnversion(bytes), 4=proxytype(int32),
  5=pdsstring(bytes), 6=useragent(bytes), 7=pdsnum(int32), 8=timeout(int32)
- URL scheme: `ysproto://host:port/serial?channel=N&stream=N&btype=N`

**VTM Framing (from Ghidra `send_msg`):**
- Unencrypted: `[0x24][0x00][len_BE_2B][type_stuff][0x10][subtype_LE]` (8 bytes)
- Encrypted: `[0x24][0x0a][len_BE_2B][type_stuff][0x10][subtype_LE]` (8 bytes)
- Byte 1 = 0x00 for plain, 0x0a for encrypted data messages
- VtduMux layer: `[3B link_id][1B channel][payload]` (from Ghidra `VtduMuxV1::demux`)

**ECDH Req Packet (from Ghidra `encECDHReqPackage`, 0x86+N+32 bytes):**
```
Offset  Size  Content
0       1     0x24 ('$')
1       1     0x01 (ECDH request type)
2       1     0x00
3-4     2     payload_length (BE, ChaCha20-encrypted protobuf size)
5       1     0x01
6       1     channel/session byte
7-9     3     0x00 0x00 0x00
10      1     0x01
11-42   32    AES-256-ECB(master_key, our_private_key) — 2 blocks × 16 bytes
43-133  91    Our ECDH public key in SPKI/DER format (same 91-byte format as server key)
134     N     ChaCha20(session_key, protobuf) — key=random 32B, nonce=[1,0,0...], counter=0
134+N   32    HMAC-SHA256(master_key, CRC32(header_134B) || CRC32(payload_NB))
```

**Key derivation:**
- `ECDHCryption_GenerateMasterKey(peer_pubkey)` → ECDH P-256 shared secret = master_key (32B)
- `ECDHCryption_GenerateSessionKey()` → 32 random bytes = session_key
- AES-256-ECB uses master_key to encrypt our private key (for server verification)
- ChaCha20 uses session_key to encrypt protobuf payload
- HMAC-SHA256 uses master_key over 8 bytes: [CRC32(header+keys) LE || CRC32(payload) LE]

**KEY INSIGHT:** The session_key is random and the server can't derive it from the packet alone. The server must:
1. Extract our pubkey from packet (offset 43, 91 bytes SPKI/DER)
2. ECDH with its private key → same master_key
3. Decrypt our private key (AES-256-ECB with master_key)
4. Use our private key somehow to derive the session_key, OR the session_key is transmitted separately

**CRITICAL REMAINING QUESTION:** How does the server obtain the ChaCha20 session_key? Either:
- The server uses the decrypted private key + its own pubkey = same shared secret, and the session key IS the shared secret (not random as the function name suggests)
- Or there's an additional key exchange step we haven't found

**Blocker:** Server rejects our ECDH packet at ~150ms. Likely causes:
1. Our pubkey should be 91 bytes SPKI/DER format (not 65-byte raw point)
2. Session key derivation is wrong
3. CRC32 endianness or HMAC data format differs

### Stream Tokens

**Endpoint:** `POST https://{apiDomain}/api/user/token/get`
**Body:** `sessionId={JWT}&clientType=55`
**Returns:** `{ tokenArray: ["ut.xxx...", ...] }` (20 tokens)

These tokens are set via `NativeApi.setTokens()` and consumed by the P2P client for stream authorization. The 96-byte dynamic tail in the P2P request body (bytes 90-185) likely contains a transformed stream token.

### Device Info (from Frida + API)

- Serial: L38239367
- Device IP: 24.35.64.195 (public), 192.168.0.101 (local)
- Ports: cmdPort=9010, streamPort=9020 (NAT maps to different ports, e.g., 17193)
- Verification code: ABCDEF (6-char AES key for frame decryption)
- API domain: apiius.hik-connect.com
- userId: fcfaec90a55f4a61b4e7211152a2d805

### Existing Implementation Status

| Component | File | Status |
|-----------|------|--------|
| V3 protocol (encode/decode/CRC) | v3-protocol.ts | ✅ Working, CRC verified |
| SafeProtocol STUN | stun-client.ts | ✅ Working |
| CAS TCP client | cas-client.ts | ✅ Working (framing) |
| P2P tunnel (ChaCha20+HMAC) | p2p-tunnel.ts | ✅ Built |
| P2P session manager | p2p-session.ts | ⚠️ Server handshake works, device won't connect (NAT) |
| VTM client (protobuf) | vtm-client.ts | ⚠️ Protobuf encoding works, ECDH handshake incomplete |
| Device P2P framing | device-p2p.ts | ✅ Built |
| IMKH media parser | imkh-parser.ts | ✅ Built |
| LiveStream (P2P→HLS) | live-stream.ts | ⚠️ Pipeline built, needs working P2P or VTM connection |
| FFmpeg HLS pipe | hls/ffmpeg-pipe.ts | ✅ Working |
| Web UI (login/devices/player) | app/page.tsx | ✅ Working |
| Stream API routes | app/api/stream/* | ✅ Working |

**Why:** These notes capture the complete protocol knowledge from one intensive reverse-engineering session so future work can pick up exactly where we left off.

**How to apply:** To get streaming working, fix either path A (deploy to VPS for P2P) or path B (fix ECDH pubkey format to 91-byte SPKI/DER and verify session key derivation).
