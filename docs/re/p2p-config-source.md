# P2P Configuration Source Analysis

**Binary:** `libezstreamclient.so` (project: hikconnect)
**CAS client version:** v2.16.2.20250108 (found in `CASClient_InitLib`)
**SDK source path:** `E:\ezplayer\v7.5.6\sdk\src\common\ez_stream_sdk\src\EZClientManager.cpp`

## Key Finding: No Hardcoded Server Addresses

The binary contains **zero** hardcoded IP addresses or port numbers for CAS, STUN, or P2P servers.
Searches for `34.194`, `43.130`, `6500`, `6002`, `apiius`, `hik-connect`, `ezvizlife` all returned
no results. All P2P configuration is injected from the Java/Android layer at runtime.

## Configuration Flow Overview

```
Android Java App (Hik-Connect / EZVIZ)
  |
  |  1. setP2PV3ConfigInfo(EZ_P2P_KEYINFO)  -- P2P link key + salt
  |  2. setP2PSelectInfo(string)             -- semicolon-delimited config string
  |  3. setTokens(string[])                  -- auth tokens (up to 50)
  |  4. selectP2PDevices(list<string>)       -- device serials to preconnect
  |
  v
JNI layer (Java_com_ez_stream_NativeApi_*)
  |
  v
ezstream_* wrapper functions
  |
  v
CGlobalInfo singleton   -- stores P2P key info + P2P tuning params
CP2POptMgr singleton    -- stores device selection/optimization info
EZClientManager         -- orchestrates preconnect + p2pStun flow
```

## Entry Point 1: `setP2PV3ConfigInfo` -- P2P Link Key

**JNI:** `Java_com_ez_stream_NativeApi_setP2PV3ConfigInfo` @ 0x0029b0cc
(Ghidra decompilation failed for this particular JNI wrapper, but the call chain is clear.)

**Flow:**
```
JNI wrapper -> ezstream_setP2PV3ConfigInfo(EZ_P2P_KEYINFO*) @ 0x002d3088
  -> CASClient_SetP2PV3ConfigInfo(ST_P2P_KEYINFO*) @ 0x0036de60
    -> CGlobalInfo::GetInstance() @ 0x0037c8d0  (returns static m_pInstance)
    -> CGlobalInfo::SetP2PV3ConfigInfo(ST_P2P_KEYINFO*) @ 0x0037d134
```

### `ST_P2P_KEYINFO` Structure (inferred from `SetP2PV3ConfigInfo`)

The struct is 0x42 bytes (66 bytes). Layout inferred from copy operations:

| Offset | Size | Description |
|--------|------|-------------|
| 0x00   | 16   | Key data block 1 (first 16 bytes of the P2P link key) |
| 0x10   | 16   | Key data block 2 |
| 0x20   | 16   | Key data block 3 |
| 0x30   | 16   | Key data block 4 |
| 0x40   | 1    | `saltIndex` (logged as `param_1[0x40]`) |
| 0x41   | 1    | `saltVer` (logged as `param_1[0x41]`) |

The key is 64 bytes total (0x00-0x3F), stored as raw bytes. The debug log line confirms:
```
"Update P2PServer keyinfo, saltIndex:%d, saltVer:%d, key:[0X%X], LastUpdate:%d"
```

### CGlobalInfo Key Storage

Within `CGlobalInfo`, the key info is stored at these offsets:

| CGlobalInfo offset | Content |
|--------------------|---------|
| 0xF4 - 0x133      | Current P2P key (64 bytes, 4 x 16-byte blocks) |
| 0x134              | Current `saltIndex` + `saltVer` (2 bytes) |
| 0x136 - 0x177      | Previous/last P2P key (backup before update) |

On each `SetP2PV3ConfigInfo` call, if the saltIndex/saltVer changed, the old key is
backed up into offsets 0x136-0x177 before the new key overwrites 0xF4-0x134.
This enables key rollover (the SDK can try both keys if one fails).

## Entry Point 2: `setP2PSelectInfo` -- P2P Server + Tuning Config String

**JNI:** `Java_com_ez_stream_NativeApi_setP2PSelectInfo` @ 0x002a1e50

**Flow:**
```
JNI wrapper -> ezstream_setPreconnectSelectInfo(string) @ 0x0027b6e0
  (routes to either CASClient_SetP2PSelectInfo or CGlobalInfo::SetP2PConfig)
```

### Path A: `CASClient_SetP2PSelectInfo` @ 0x0036ce50

Routes to `CP2POptMgr::DecodeSelectInfo()` which parses the select info JSON
for device-level P2P optimization decisions.

### Path B: `CGlobalInfo::SetP2PConfig(const char*)` @ 0x0037c948

This is the critical path for P2P tuning parameters. The input string is a
**semicolon-delimited list of `key:value` pairs**, parsed as follows:

1. Split the input on `;` (semicolon) delimiter
2. For each token, split on `:` (colon) into `key` and `value`
3. Trim whitespace from both key and value
4. Look up key in `sm_MemberRoles[]` array (35 entries, index 0..0x22)
5. Parse value as integer with `atoi()`
6. Validate against `sm_MemberMin[i]` and `sm_MemberMax[i]` bounds
7. Store at `CGlobalInfo + (index * 4) + 0x1D0`

After parsing, all 35 values are logged:
```
"P2PInfo, %s:%d"  (for each sm_MemberRoles entry)
```

The P2P config array occupies `CGlobalInfo` offsets **0x1D0 to 0x25C** (35 x 4 = 140 bytes).

### Default Values (from `CGlobalInfo::CGlobalInfo()`)

The constructor initializes this 35-entry array from `sm_MemberDefault[]`, with a fallback
that reveals some literal defaults embedded in packed 64-bit constants:

| Packed value            | Decoded pair (low, high 32-bit) |
|-------------------------|---------------------------------|
| 0x27100003a980          | 240000, 10000 |
| 0xfa000002710           | 10000, 250 |
| 0x1f4000001388          | 5000, 500 |
| 0x9c400001f40           | 8000, 40000 |
| 0x271000000bb8          | 3000, 10000 |
| 0x200000002             | 2, 2 |
| 0x271000000000          | 0, 10000 |
| ... etc                 | |

Also: a loop initializes 60 entries in a deque-like structure with values starting at
40000 and incrementing by 400 (40000, 40400, 40800, ...). These appear to be timeout
thresholds in milliseconds.

## Entry Point 3: P2P Server Addresses (via `ParseP2PServerGroupFromClient`)

**Function:** `CP2PTransfer::ParseP2PServerGroupFromClient` @ 0x003c6ffc

This parses a **semicolon-delimited string** of `IP:port` pairs into a vector of
`ST_SERVER_INFO` structures:

```
Format: "ip1:port1;ip2:port2;ip3:port3"
Example: "34.194.x.x:6500;43.130.x.x:6500"
```

### `ST_SERVER_INFO` Structure (0x42 bytes)

| Offset | Size | Description |
|--------|------|-------------|
| 0x00   | 64   | Server IP string (null-terminated, max 63 chars via `__strcpy_chk(&local, pvVar, 0x40)`) |
| 0x40   | 2    | Server port (unsigned short, from `atoi()` of port string) |

### How Server Addresses Flow

1. The Java app obtains server lists from the Hik-Connect cloud API
2. Passes them to native via `setP2PSelectInfo` or equivalent
3. `ParseP2PServerGroupFromClient` parses into `vector<ST_SERVER_INFO>`
4. `CP2PV3Client::SendP2PServerGroup` iterates the vector, sending UDP packets to each:
   ```
   "send udp(iSocket:%d) to p2p server[%s:%d]"
   ```
   It calls `CCtrlUtil::SendUDPDataWithSocket(socket, serverIP, serverPort, data, len)`

## Entry Point 4: `getP2PServerFieldValue` -- JNI Object Field Extraction

**Function:** `getP2PServerFieldValue` @ 0x0029afc8

Reads from a Java `_tagP2P_SERVER_INFO` object using JNI field IDs stored in two
global variables:

- **`gP2PServerKeyFields`** @ 0x001785f8 -- field IDs for key-related fields
- **`gP2PServerParamFields`** @ 0x0017860c -- field IDs for the server IP string + port

The companion `GetServerInfoField` @ 0x002a5764 extracts field IDs from a Java class
with these member names:
- `szServerIP` (type: `Ljava/lang/String;`) -- the server IP address
- `nServerPort` (type: `I` implied) -- the server port number

`GetServerInfoValue` @ 0x002a57f4 then reads these fields from a Java object instance,
copying the IP string (max 0x40 = 64 bytes) into a native `ST_SERVER_INFO`, and reading
the port as an unsigned short at offset 0x40.

## Entry Point 5: STUN Info Retrieval

**Function:** `EZClientManager::getP2PStunInfo` @ 0x002c1de4

This does NOT fetch STUN info from a remote server. Instead, it looks up a preconnect
client by device serial in an internal map, and if found, reads STUN info from the
preconnect client object:

- STUN server IP: at offset 0x3F0 from the preconnect client (read as C string)
- STUN mode/type: at offset 0x860 (read as int)

The STUN address itself was set during the preconnect phase, likely received as part
of the P2P server handshake response.

**`BavP2PSetStunAddress`** @ 0x004a4724 stores STUN addresses into `CBavGoldInfo::Instance()`:
- Primary STUN: 0x41 bytes of address data copied to offset 0x23C, port at 0x280
- Secondary STUN: 0x41 bytes copied to offset 0x284, port at 0x2C8

## Entry Point 6: `SetP2PLinkKey` -- Per-Session Key on CP2PV3Client

**Function:** `CP2PV3Client::SetP2PLinkKey(unsigned short keyVer, const char* key)` @ 0x003ce49c

Sets a 32-byte link key on a specific P2P client session:
- Key version stored at `this + 0x1F0` (ushort)
- Key data (32 bytes) stored at `this + 0x1F8` (as std::string, appended with max 0x20 bytes)

Debug log:
```
"SetP2PLinkKey, P2PKeyVer:[%d], P2PLinkKey:[0X%0X] -%s"
```

## Entry Point 7: `setTokens` -- Authentication Tokens

**JNI:** `Java_com_ez_stream_NativeApi_setTokens` @ 0x00296250

Reads a Java string array (max 50 entries) and passes the native strings to
`ezstream_setTokens`. These tokens are session/auth tokens from the Hik-Connect
cloud, used to authenticate P2P relay connections.

## Preconnect Orchestration

**Function:** `EZClientManager::preconnect(INIT_PARAM*)` @ 0x002c05e8

Flow:
1. Extract device serial from `INIT_PARAM` at offset 0xC0 (std::string)
2. Try direct connection first via `direct(this, param, 2, timeout, 0)`
3. If direct fails, call `p2pStun(this, preconnectClient, param)` @ 0x002c3da8
4. `p2pStun` attempts up to 2 rounds of P2P hole-punching:
   - Calls `P2PPreconnectClient::init()` to initialize the STUN session
   - Calls `insertP2PPreconnectClient()` to register in the manager's map
   - Max 8 simultaneous P2P connections enforced (`getP2PClientCount < 8`)

## `CASClient_InitLib` Initialization Chain

**Function:** `CASClient_InitLib` @ 0x0035fb08

Initialization order:
1. `HPR_InitEx()` -- platform runtime init
2. Create TLS slots for error codes
3. `CTransferClientMgr::Init(0x100, 0x2775)` -- transfer client pool (256 clients, port 10101)
4. Create 256 mutex locks in `g_CasClientlockarray`
5. `CMessageCallBack::Setup()` -- message callback system
6. `DeviceManager::getInstance()` -- device registry
7. `CallBackManager::getInstance()` -- callback registry
8. `CTransferClientMgr::GetInstance()` -- (second ref, ensures initialized)
9. **`CGlobalInfo::GetInstance()`** -- P2P config singleton
10. **`CP2POptMgr::GetInstance()`** -- P2P optimization manager
11. `ECDHCryption_InitLib(0)` -- ECDH crypto init
12. `ECDHCryption_SetPacketWindowSize(2)` -- packet window
13. `srt_startup()` -- SRT (Secure Reliable Transport) init
14. `srt_setloghandler()` -- SRT logging

Note: `CGlobalInfo::GetInstance()` simply returns a static `m_pInstance` pointer.
The actual constructor (`CGlobalInfo::CGlobalInfo()`) is called lazily or during
static initialization.

## Summary: Where Each Config Element Comes From

| Config Element | Source | Native Entry Point |
|---------------|--------|--------------------|
| **CAS server IP:port** | Not in this binary; CAS connections managed at Java layer | N/A |
| **P2P server IP:port list** | Java app -> `setP2PSelectInfo` string | `ParseP2PServerGroupFromClient` parses `"ip:port;ip:port"` |
| **STUN server address** | Received during P2P handshake, stored in preconnect client | `BavP2PSetStunAddress`, `getP2PStunInfo` |
| **P2P link key (64 bytes)** | Java app -> `setP2PV3ConfigInfo` | `CGlobalInfo::SetP2PV3ConfigInfo` |
| **P2P link key version** | saltIndex + saltVer from same call | Stored at CGlobalInfo+0x134 |
| **Per-session key (32 bytes)** | Set during P2P session setup | `CP2PV3Client::SetP2PLinkKey` |
| **P2P tuning params (35 ints)** | Java app -> `setP2PSelectInfo` config string | `CGlobalInfo::SetP2PConfig` parses `"key:val;key:val"` |
| **Auth tokens** | Java app -> `setTokens(string[])` | `ezstream_setTokens` |

## Implication for Reimplementation

To establish a P2P connection without the Android app, we need to:

1. **Call the Hik-Connect cloud API** to obtain:
   - P2P server list (IPs and ports) -- likely from the device info or a dedicated endpoint
   - P2P link key + salt index/version -- from the session/device API
   - Auth tokens -- from the login flow

2. **Pass these to the native SDK** via the JNI functions, or replicate the protocol directly:
   - The P2P servers receive UDP packets (see `SendP2PServerGroup`)
   - The STUN info is obtained from the P2P server response (not from a separate STUN server endpoint)
   - The link key is used for encrypting the P2P tunnel

3. **The protocol is UDP-based** with P2P hole punching:
   - `CCtrlUtil::SendUDPDataWithSocket` sends to P2P servers
   - STUN is used for NAT traversal
   - SRT (Secure Reliable Transport) is used as a transport layer (initialized in `CASClient_InitLib`)
