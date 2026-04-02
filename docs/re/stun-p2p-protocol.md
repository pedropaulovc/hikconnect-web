# STUN + P2P Tunnel Protocol Analysis

**Library:** libezstreamclient.so → P2P network component
**P2P Net Version:** 1.1.0.211018

---

## Architecture

```
Client                    STUN Server                NVR
  │                     (43.130.155.63:6002)          │
  │── STUN Binding Req ──→│                           │
  │←─ STUN Binding Rsp ──│                            │
  │  (mapped addr)        │                            │
  │                       │                            │
  │───── CAS Broker exchanges punch info ─────────────│
  │                                                    │
  │◄════════════ UDP P2P Tunnel ════════════════════►  │
  │              (hole-punched)                        │
```

## Key Classes and Functions

### P2P Manager
| Component | Purpose |
|-----------|---------|
| `CP2PManager` | Singleton, manages P2P sessions |
| `CP2PNetProtocol` | P2P network protocol implementation |
| `CBavP2PNet` | BAV P2P network layer |

### Connection Flow
```
p2pnet_Init(uniqueId, logCB, logCtx)
  └── CP2PManager::SetUniqueId()

p2pnet_SetStunAddress(stunAddr, port)  // 43.130.155.63:6002

p2pnet_CreateSession(statusCB, dataCB, userData)
  └── CP2PManager::CreateSession()

p2pnet_GetSelfPunchInfo(session, addr, port, type)
  └── CP2PManager::GetSelfPunchInfo()
  // Returns: client's STUN-mapped public IP:port

// CAS broker exchanges punch info between client and NVR

p2pnet_SetPeerConnection(session, peerAddr, peerPort)
  └── CP2PManager::SetPeerConnection()
  // Initiates UDP hole-punching to NVR

p2pnet_SendData(session, data, len)  // send data over P2P tunnel

p2pnet_CloseSession(session)  // teardown
p2pnet_Fini()  // cleanup
```

### Callbacks
- `P2PNetNotify(sessionId, event, ...)` — connection status events
- `P2PNetRecvData(sessionId, data, len, ...)` — received data from peer

### Helper Functions
- `BavP2pnetGetPunchInfo` — alternative punch info getter
- `BavP2pnetSetPeerConnection` — alternative peer connection setter

## STUN Details

The STUN client is in `libstunClient.so` (844KB). Key dependencies:
- `libhpr.so` (Hikvision Platform Runtime)
- `libgnustl_shared.so`

STUN is used for:
1. NAT type detection
2. Getting the client's public IP:port mapping
3. This mapped address is sent to CAS broker, which relays it to the NVR
4. Both sides attempt simultaneous UDP hole-punching

## P2P Packet Format

From the `ezviz_ecdh_encECDHDataPackage` decompilation, encrypted packets have:

```
Offset  Size  Description
------  ----  -----------
0       1     Magic: 0x24 ('$')
1       1     Type: 0x02
2       1     Padding: 0x00
3       2     Payload length (big-endian)
5       2     Reserved: 0x0000
7       4     Sequence number (big-endian, auto-incrementing)
11      N     Encrypted payload (ChaCha20)
11+N    32    HMAC-SHA256 of [header + payload]
```

**Total packet size:** payload_length + 43 bytes (11 header + 32 HMAC)

## NAT Traversal

`iSupportNAT34` flag in InitParam suggests support for:
- NAT Type 3 (Port Restricted Cone)
- NAT Type 4 (Symmetric NAT)

`iStreamInhibit = 10` disables:
- DIRECT_OUTER (bit 1 = 2)
- DIRECT_REVERSE (bit 3 = 8)
- Total: 2 + 8 = 10

This forces traffic through P2P/relay rather than direct connection.

## Open Questions
- Exact STUN message format (standard RFC 5389 or proprietary extensions?)
- Hole-punching retry logic and timeout
- Fallback behavior when P2P fails (VTM relay at 148.153.53.29:8554?)
- SRT usage in P2P tunnel (seen in CAS init)
