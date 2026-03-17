# CAS Broker Protocol Analysis

**Library:** libezstreamclient.so → CAS client component
**CAS Client Version:** v2.16.2.20250108

---

## Architecture

The CAS (Cloud Access Server) broker mediates P2P connections between client and NVR.

```
Client → TCP → CAS Broker (34.194.209.167:6500)
  │                  │
  │  ← session ID ←  │
  │  → device info →  │
  │  ← peer info  ←   │  (NVR's STUN-mapped address)
  │                    │
  └──── UDP P2P ──────→ NVR (24.35.64.195:9010/9020)
```

## Key Classes and Functions

### CAS Client Management
| Component | Purpose |
|-----------|---------|
| `CTransferClientMgr` | Singleton, manages all CAS sessions. Initialized with pool of 256 (0x100) sessions, port 10101 (0x2775) |
| `CTransferClient` | Individual CAS session. Created per stream request |
| `CMessageCallBack` | Message routing |
| `DeviceManager` | Device state tracking |
| `CallBackManager` | Callback dispatch |
| `CGlobalInfo` | Global configuration |
| `CP2POptMgr` | P2P optimization manager |

### Initialization Flow
```
CASClient_InitLib()
  ├── HPR_InitEx()                    // Hikvision Platform Runtime init
  ├── CTransferClientMgr::Init(256, 10101)  // 256 session pool, port 10101
  ├── ECDHCryption_InitLib(0)         // ECDH crypto init
  ├── ECDHCryption_SetPacketWindowSize(2)
  └── srt_startup()                   // SRT (Secure Reliable Transport) init
```

### Session Creation Flow
```
CASClient_CreateSessionEx(statusCallback, dataCallback, userData, param4)
  ├── CTransferClientMgr::CreateClient()
  ├── CTransferClient::GetSessionHandle()  // returns session ID
  └── CTransferClient::Init(statusCB, dataCB, userData, param4)
```

## Protocol Details (needs dynamic validation)

### Transport
- Primary: TCP to CAS broker
- The CAS client also initializes **SRT** (Secure Reliable Transport) — `srt_startup()` is called in InitLib
- SRT may be used as an alternative to raw UDP P2P for reliability

### Session Lifecycle
1. `CASClient_InitLib` — one-time library init
2. `CASClient_CreateSessionEx` — create session with callbacks
3. CAS broker assigns session handle
4. Client sends device info (serial, channel, stream type)
5. Broker returns peer connection info (NVR's STUN-mapped address)
6. P2P connection established
7. `CASClient_StopP2PPlay` / `CASClient_DestroySession` — teardown

### Configuration APIs
- `CASClient_SetIntConfigInfo` — set integer config
- `CASClient_SetStringConfigInfo` — set string config
- `CASClient_SetIntP2PSelectInfo` — P2P selection params
- `CASClient_SetP2PStatusChangeCallBack` — P2P status monitoring

### Statistics
- `CASClient_GetStatisticInformation` — general stats
- `CASClient_GetPreviewStatInformation` — preview-specific stats

## Dependencies
- **HPR** (Hikvision Platform Runtime): threading, mutex, TLS, networking
- **SRT**: Reliable UDP transport (fallback/alternative to raw P2P)
- **ECDH**: Packet encryption
- **protobuf**: `hik::ys::streamprotocol::PdsInfo` seen in function signatures

## Open Questions (need dynamic validation)
- Exact CAS TCP message format (likely protobuf based on PdsInfo reference)
- Session authentication (how JWT/session token is sent)
- Device lookup protocol (how serial maps to NVR address)
- SRT usage: always, or only as P2P fallback?
