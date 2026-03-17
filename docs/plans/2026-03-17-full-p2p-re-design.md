# Full UDP P2P Protocol Reverse Engineering — Design

**Date:** 2026-03-17
**Goal:** Reverse engineer `libezstreamclient.so` to build a standalone TypeScript/Node.js implementation of the Hik-Connect CAS broker + STUN + UDP P2P streaming protocol, eliminating Android/redroid dependency.

**Supersedes:** Phase 3 (native FFI approach) which was blocked by bionic/glibc ABI incompatibility.

---

## Toolchain

| Tool | Version | Install method | Purpose |
|------|---------|----------------|---------|
| Ghidra | 11.3+ | Manual zip → `/opt/ghidra` | ARM64 static analysis/decompilation |
| kawaiidra-mcp | latest | `pip install kawaiidra-mcp` + MCP config | Headless Ghidra ↔ Claude Code bridge |
| tshark | 4.x | `apt install tshark` | pcap analysis (CLI) |
| Frida | 16.x | `pip install frida-tools` | Dynamic tracing (Phase B) |
| readelf/nm | system | already installed | Quick symbol enumeration |

### MCP Server Configuration

```json
{
  "mcpServers": {
    "kawaiidra": {
      "command": "kawaiidra-mcp",
      "args": ["--headless"],
      "env": {
        "GHIDRA_INSTALL_DIR": "/opt/ghidra"
      }
    }
  }
}
```

### Binaries to analyze

Primary targets (from APK extraction):

| Library | Size | Role |
|---------|------|------|
| `libezstreamclient.so` | 7.5MB | Main streaming engine — JNI entry points, P2P, CAS, framing |
| `libhpr.so` | 1.1MB | Hikvision platform runtime (threading, logging, config) |
| `libstunClient.so` | 863KB | STUN NAT traversal client |
| `libNPQos.so` | 2.1MB | QoS and packet scheduling |
| `libmbedtls.so` + `libmbedcrypto.so` | 632KB | TLS/crypto (AES, ECDH) |
| `libSystemTransform.so` | 1.4MB | Data format conversion |
| `libencryptprotect.so` | 10KB | Encryption wrapper (likely key derivation) |

---

## Architecture: Three-phase approach

### Phase A — Static RE with Ghidra + MCP (WSL2, no server)

**Duration estimate:** 2-4 weeks
**Cost:** $0 (local only)

Use Ghidra on WSL2 (x86_64) to cross-analyze ARM64 binaries. kawaiidra-mcp enables Claude to iteratively decompile, follow cross-references, and annotate findings.

#### Key functions to trace

Starting from JNI exports, trace inward:

1. **Connection setup:**
   - `NativeApi.createPreviewHandle(InitParam)` → CAS broker handshake → STUN binding → P2P tunnel
   - `NativeApi.startPreview(handle)` → video request → frame delivery loop

2. **Crypto:**
   - `NativeApi.setSecretKey(handle, key)` → AES key schedule
   - `NativeApi.generateECDHKey(keyInfo)` → ECDH P-256 key exchange
   - `libencryptprotect.so` → key derivation from verification code

3. **Protocol framing:**
   - UDP packet format (header: `0x55667788` marker)
   - ACK packets (`0x8002` prefix, 44 bytes)
   - Video packet structure (229-361 bytes observed)
   - PS container demuxing

4. **State machine:**
   - CAS broker TCP protocol (port 6500)
   - STUN binding request/response (port 6002)
   - P2P punch-through sequence
   - Stream start/stop signaling

#### Deliverables

- Protocol specification document with packet formats and state diagrams
- Annotated Ghidra project with renamed functions/structures
- List of unknowns requiring dynamic validation

### Phase B — Dynamic validation with Frida (Hetzner ARM VM)

**Duration estimate:** 1 week
**Cost:** ~€4/month (CAX11)
**Prerequisite:** Phase A identifies specific unknowns

Provision a new Hetzner CAX11 with **mandatory security hardening** (see [Security Requirements](./2026-03-16-status-update.md#security-requirements-for-redroid-deployment)):
- UFW default deny before starting any containers
- ADB bound to `127.0.0.1:5555` only
- Access via SSH tunnel exclusively

Tasks:
1. Hook internal C++ functions identified in Phase A
2. Capture traffic with `tcpdump -w capture.pcap`
3. Analyze with tshark locally (scp pcap to WSL2)
4. Validate packet format assumptions, byte offsets, state transitions
5. Capture ECDH key exchange in detail

### Phase C — TypeScript/Node.js implementation

**Duration estimate:** 2-3 weeks
**Prerequisite:** Protocol spec from Phase A, validated by Phase B

Build a standalone streaming client:

```
Browser ←─ HLS ─→ Node.js server
                    ├── CAS broker client (TCP)
                    ├── STUN client (UDP)
                    ├── P2P tunnel (UDP, AES encrypted)
                    ├── PS demuxer
                    └── FFmpeg (H.264 → HLS)
```

Components:
1. **CAS broker client** — TCP connection to `34.194.209.167:6500`, device registration, peer lookup
2. **STUN client** — UDP binding to `43.130.155.63:6002`, NAT type detection, address mapping
3. **P2P punch-through** — UDP hole-punching using STUN-mapped addresses
4. **AES decryptor** — Key from device verification code, decrypt video packets
5. **PS demuxer** — Extract H.264 NALUs from MPEG-PS container
6. **FFmpeg pipe** — stdin raw H.264 → HLS segments
7. **Next.js API routes** — Serve HLS playlist + segments to browser

---

## What we already know (from Frida Phase 2 captures)

| Parameter | Value |
|-----------|-------|
| NVR | L38239367 (HNR33P8-8/D) |
| NVR WAN IP | 24.35.64.195 |
| Command port | 9010 |
| Stream port | 9020 |
| CAS broker | 34.194.209.167:6500 |
| STUN server | 43.130.155.63:6002 |
| VTM relay | 148.153.53.29:8554 |
| P2P version | v3 |
| Link key version | 101 |
| Encryption | AES (key = 6-char verification code) |
| Stream inhibit | 10 (disable DIRECT_OUTER + DIRECT_REVERSE) |
| Frame marker | 0x55667788 |
| ACK format | 0x8002 prefix, 44 bytes |
| Callback data types | 1=HEADER, 2=DATA, 3=AUDIO, 50=FIRST_DATA, 100=END |

## What we don't know (Phase A targets)

- CAS broker TCP wire protocol (message framing, opcodes, serialization)
- STUN extensions (standard RFC 5389 or proprietary?)
- P2P punch-through sequence (who initiates, retry logic, fallback to relay)
- AES mode (CBC? CTR? GCM?) and IV derivation
- ECDH key exchange details (what's signed, what's the shared secret used for)
- UDP P2P packet header structure beyond the 0x55667788 marker
- PS container variant (standard MPEG-PS or Hikvision custom?)
- keepalive/heartbeat mechanism
- Error recovery and reconnection logic
