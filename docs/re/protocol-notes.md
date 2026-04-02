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

#### iVMS-4200 Ghidra RE Findings (2026-03-17)

**Source:** `libCASClient.dll` from iVMS-4200 V3.13.2.5 (x86-64 PE), decompiled via Ghidra.

##### 0x0C00 Is a HOLE-PUNCH REQUEST (Not PREVIEW_RSP)

From `CP2PV3Client::HandleUdpData` case `0xc00`:
```
1. Verify session UUID matches our P2P_SETUP session
2. If socket mismatch: CLOSE old socket, adopt new socket from device packet
3. Set device-punched-through flag = true
4. HPR_SetTTL(socket, 0x80) — increase TTL for the punched connection
5. Record device's source IP:port as the peer address
6. FUN_180006d70 — saves device address for subsequent use
```

The log says "Recv Device PunchReq" — this is the device punching through to us, NOT a preview response. After receiving 0x0C00:
- The client knows the device's public IP:port
- The client should send a 0x0C01 (punch response) back to the device
- The punched socket is then used for UDT/SRT establishment

0x0C01 = "Device Punch Response Package" — sent when the device's punch arrives.

**Implication:** Our code receives 0x0C00 but doesn't respond with 0x0C01 and doesn't start the UDT/SRT connection. This explains why PLAY_REQUEST via server relay fails — the device expects direct communication after the punch.

##### PLAY_REQUEST Routing — DUAL PATH (Critical Finding)

`CP2PV3Client::SendRequest` sends PLAY_REQUEST via **two paths simultaneously**:

1. **UDT (direct to device):** If a UDT socket is established and in good state (not BROKEN/CLOSING/NONEXIST), send the raw PLAY_REQUEST (0x0C02) directly via SRT/UDT to the device. This is the fast path.
2. **P2P server relay (TRANSFOR_DATA):** Build a TRANSFOR_DATA (0x0B04) wrapper around the PLAY_REQUEST and send to P2P server. The server relays to device.

**Implication for our code:** We're only sending via path 2 (P2P server relay). The "Link status invalid" error (0xcb) likely means we need to establish the UDT/direct connection first via hole punching, then send PLAY_REQUEST directly on that socket.

The flow in the native code:
```
1. CASClient_SetupPreConnection → hole punch → UDT socket established
2. CASClient_BuildDataLink → CP2PV3Client::BuildAndSendPlayRequest
   a. Try UDT socket (srt_getsockstate check) → send PLAY_REQUEST directly
   b. Build TRANSFOR_DATA wrapper → send via P2P server relay
   c. Wait for response on either path
```

##### V3 Header Construction (Confirmed)

From `CV3Protocol::BuildMessage`:
```
Byte 0:  0xE2 (magic, -0x1E as signed byte)
Byte 1:  mask byte (bitfield: encrypt|expand|flags)
Byte 2-3: opcode (network byte order, htons)
Byte 4-7: sequence number (network byte order, htonl)
Byte 8-9: reserved (from param_2[0], the "0x6234" field)
Byte 10: total header length (base=12 + expand header length)
Byte 11: CRC-8 of bytes 0-10
```

Sequence number is a global incrementing counter with mutex lock.

##### P2P_SETUP (0x0B02) Sub-TLV Container (tag=0xFF) — Complete

From `FUN_180091cd0` (ComposeSetup sub-TLV builder):
```
tag=0x71 ('q'): param_3[0] — client NAT type (1 byte)
tag=0x72 ('r'): param_3[1] — protocol/relay flag (1 byte)
tag=0x75 ('u'): param_3[2] — support flags (1 byte)
tag=0x7F:       param_3[3] — NAT subtype / mobile network type (1 byte)
tag=0x74 ('t'): "IP:port" — client reflexive address (STUN-discovered, only if set)
tag=0x73 ('s'): "IP:port" — client local address (only if set)
tag=0x8C:       param_3+0x98 (4B BE) — clientId
```

**Key finding:** Tag `0x8C` is the **clientId** (4 bytes, big-endian). Our current code sends it but as zeros. The `StartPreconnection` log confirms params: `clientId`, `NATType`, `Channel`, `StreamType`, `casIP`, `stunIP`, `casPort`, `stunPort`.

##### PLAY_REQUEST (0x0C02) TLV Body — Complete

From `FUN_18008fbf0` case `0xc02`:
```
tag=0x76 ('v'): busType (1B) — 1=preview, 2=playback, 4=download
tag=0x05:       sessionKey (string, base64-encoded)
tag=0x78 ('x'): streamType (1B) — 0=main, 1=sub
tag=0x77 ('w'): channelNo (2B BE, uint16)
tag=0x7E ('~'): deviceSessionId (4B BE, uint32)
tag=0x79 ('y'): operationCode (string)
tag=0x7C ('|'): shareTicket (string)
tag=0x7D ('}'):  timeout/playSession (4B BE, uint32)
```

Conditional tags for playback (busType=0x02 or 0x04):
```
tag=0xAE: ecdhKeyVersion (4B BE) — only if param_4[0x13F] != 0
tag=0xAF: ecdhKeyInfo (4B BE) — only if param_4[0x140] != 0
```

##### TRANSFOR_DATA (0x0B04) TLV Body

```
tag=0x00: device serial (string)
tag=0x07: inner V3 message (the wrapped command, e.g., PLAY_REQUEST)
```

##### TRANSFOR_DATA_RSP (0x0B05) TLV Body

```
tag=0x02: result code (4B BE) — 0=success
tag=0x07: response data (inner V3 response)
```

##### BuildSendMsg Encryption Logic

From `CP2PTransfer::BuildSendMsg`:
- The P2PKey (32 bytes) is stored at `param_1 + 0x136` (the key buffer)
- P2PKey version is at `param_1[0xDE]` (2 bytes)
- If key version is 0: use userId directly as key material (up to `param_1[0xE6]` length)
- If key version > 0: use the P2PKey from `param_1 + 0xE2` (up to 32 bytes)
- UserId must be >= 32 chars, else error "userid is invalid"

##### P2P Protocol Version Dispatch

From `CTransferClient::InitP2PClient`:
- Version 2 → `CP2PV2Client` (legacy)
- **Version 3** → `CP2PV3Client` (our target, current Hik-Connect)
- Version 4 → `CP2PV21Client` (newer variant)

##### P2PServerKey Source

From `CP2PV3Client::BuildMsg` / `BuildTransMsg`:
- First checks `param_1 + 0x310` — if set, uses custom key from `param_1 + 0x311` (redirect info)
- Otherwise calls `FUN_180053f40(DAT_180172aa0, ...)` to get key from global config (`CGlobalInfo::SetP2PV3ConfigInfo`)
- Returns key + 2 version bytes (`local_38` and `local_37`)
- Error "P2PServer KeyInfo is invalid, maybe not init KEYINFO" if both version bytes are -1

##### StartStream Flow (CP2PV3Client::StartStream)

The high-level `StartStream` function in the native code:
1. Calls `srt_setrecvavail` to configure SRT on the punched socket
2. Parses P2P server group from config
3. Calls `BuildAndSendPlayRequest` (0x0C02) — this IS the stream start
4. For voice talk (busType=3): additionally sets up SRT session via `FUN_18008a6a0`/`FUN_18008a090`
5. On success: logs "StartStream success" with devSession, streamSession

**Key finding:** There is NO separate 0x7534/0x8000 session setup step in the P2P V3 path.
The 0x7534 (SESSION_SETUP) and 0x8000 (CONNECTION_CONTROL) packets are part of the
SRT/UDT transport layer, handled internally by srt.dll — NOT by the P2P protocol.
The PLAY_REQUEST response directly triggers video data flow.

**Implication for our code:** Our `sendSessionSetup()` that sends 0x7534 with embedded V3 0x0C00
may be incorrect for the P2P V3 path. After PLAY_REQUEST succeeds, the device should start
sending video data directly (possibly wrapped in SRT or raw UDP). The 0x7534/0x8000 packets
we see in captures may be SRT session establishment that the SRT library handles automatically.

##### Video Data Format (Hikvision Proprietary RTP over SRT)

From `CP2PV3Client::HandleVideoStream`:

Video data arrives in packets with a 12-byte header (RTP-like):
```
Offset 0-1:  packet type (2B, network order)
Offset 2-3:  sequence number (2B, network order)
Offset 4-7:  SSRC/session ID (4B, network order)
Offset 8-11: timestamp (4B, network order)
Offset 12+:  payload (up to 1588 bytes, max packet = 1600 bytes)
```

Packet types:
```
0x0100: Video data (standard, possibly I-frame)
0x0200: Video data (standard, possibly P-frame)
0x0201: Control packet
0x8040: Connection info
0x804F: UDT session response (→ HandleUDTSessionRsp)
0x8050: Video data (alt framing)
0x8051: Video data (alt framing)
0x8060: Video data (alt framing, possibly audio)
0x807F: Session control
0x80FF: Command response
```

These packets flow OVER SRT (Secure Reliable Transport), not raw UDP.
The native code uses srt.dll with functions like `srt_setrecvavail`, `srt_sendmsg`,
`srt_getsockstate`, etc.

**Options for Node.js implementation:**
1. Use `node-srt` npm package (SRT bindings for Node.js)
2. Use raw UDP and handle reliability ourselves (risky, may not work)
3. Use the TRANSFOR_DATA relay path (P2P server relays, bypasses SRT)

##### Relay Client ECDH Requirement (Critical Finding)

From `CRelayClient::SendClnConnectReq`:
- If relay server provides a public key (publicKey.key != null), ECDH is REQUIRED
- Flow: `ECDHCryption_GenerateMasterKey(serverPubKey)` → `GenerateSessionKey` → `CreateSession`
- The body of ClnConnectReq is encrypted with the ECDH session key
- Relay server closes connection if body is not properly encrypted

This is the same ECDH P-256 handshake that blocks the VTM path.
Both relay and VTM use `ECDHCryption_*` functions from the same library.

**Tested:** Connecting to relay (148.153.39.254:6123) and sending unencrypted
ClnConnectReq results in immediate connection close.

##### ECDH Protocol (from ecdhCryption.dll Ghidra RE)

**Key generation:** Standard ECDH P-256 (secp256r1). Client generates ephemeral key pair.

**GenerateMasterKey:** `FUN_180002130`
1. Load client private key and server public key (both as EC points)
2. Select curve (param=3 → P-256)
3. Compute ECDH shared secret (32 bytes)
4. Output = shared secret bytes (stored as 4×8B = 32 bytes)

**GenerateSessionKey:** `FUN_180016e00` — Counter-mode KDF
1. Increments counter at context+0x0F
2. Calls AES/HMAC block function (FUN_180009cd0) per 16-byte block
3. Generates 32 bytes of session key material
4. Similar to NIST SP 800-108 counter mode

**EncECDHReqPackage:** `FUN_180002b30` — Request packet encryption
Packet format:
```
Byte 0:      0x24 ('$') magic
Byte 1:      0x01 (version)
Byte 2:      0x00
Byte 3-4:    body_length (2B BE)
Byte 5:      0x01
Byte 6:      channel_id (1 byte)
Byte 7-10:   sequence (4B BE, starts at 1)
Byte 11-42:  AES-encrypted shared secret (32B) — encrypted with session key
Byte 43-133: client ECDH public key (91B SPKI/DER format)
Byte 134+:   encrypted body payload (if body_length > 0)
Last 32B:    HMAC-SHA256 over CRC of body and header
```

Total fixed overhead: 11 (header) + 32 (enc master key) + 91 (pubkey) + 32 (HMAC) = 166 bytes

**Encryption algorithm dispatch** (switch on type 3-9):
- Type 3: possibly AES-128-ECB
- Type 4: possibly AES-128-CBC
- Type 5/6: possibly AES-256-ECB/CBC
- Type 7/8: possibly ChaCha20
- Type 9: possibly AES-GCM
The exact type is set during `FUN_180011fa0` initialization.

##### Key API Endpoints (from OpenNetStream.dll strings)

```
/api/sdk/p2p/dev/info/get   — device P2P info (serial, IP, ports, NAT type)
/api/sdk/p2p/user/info/get  — user P2P info (P2PServerKey, clientId)
/api/service/media/streaming/relay/server — VTM relay server info
/api/service/media/streaming/relay/ticket — relay stream ticket
```

These are the SDK API paths — the consumer app equivalents may differ (our API uses `/api/user/token/get`).

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
- Verification code: NOT NEEDED for cloud P2P streaming. iVMS-4200 and Hik-Connect app stream with just credentials. Verification code only applies to local RTSP/ISAPI or when "stream encryption" is explicitly enabled on the NVR.
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
