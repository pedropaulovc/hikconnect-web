# CAS Session Establishment Flow

Deep reverse engineering of the CAS (Cloud Access Service) broker session establishment
from `libezstreamclient.so` and `libstunClient.so` (Ghidra project: `hikconnect`).

## Overview

The CAS session establishment follows this sequence:

```
Client                  CAS Broker             Device
  |                        |                     |
  |--- STUN Binding ------>| (NAT type detect)   |
  |<-- STUN Response ------|                      |
  |                        |                      |
  |--- P2P_SETUP (0x0B02)->|                      |
  |                        |--- notify device --->|
  |<-- P2P_SETUP_RSP (0x0B05)                     |
  |                        |                      |
  |--- STREAM_REQ (0x0C02)>|--- relay/forward --->|
  |<-- STREAM_RSP ---------|<-- device response --|
  |                        |                      |
  |<======== data stream (P2P or relayed) =======>|
```

## 1. SDK Initialization (`ezstream_initSDK`)

**Function:** `ezstream_initSDK` @ `0x002d1810`

Takes a single string parameter (passed from Java via JNI `com.ez.stream.NativeApi.initSDK`).
Creates the global `EZClientManager` singleton via `EZClientManager::create()`.

```
ezstream_initSDK(configString)
  -> mutex lock
  -> if g_pManager == NULL:
       g_pManager = EZClientManager::create(configString)
  -> mutex unlock
  -> return 0 on success, 0x0E on failure
```

The `EZClientManager` constructor (@ `0x002bda04`) reveals the source path:
`E:\ezplayer\v7.5.6\sdk\src\common\ez_stream_sdk\src\EZClientManager.cpp`

It initializes:
- A thread pool named `"stun"` with 4 threads
- An `EZHandlerThread` for async operations
- `ReverseDirectUpnpStatistics` for connection method tracking
- Default config value: `0x20000047e` at offset `+0x78`

## 2. P2P Configuration (`SetP2PConfig`)

**Function:** `CGlobalInfo::SetP2PConfig` @ `0x0037c948`

P2P configuration is set as a semicolon-delimited key:value string, parsed by splitting on `";"` then `":"`.

The config string format is:
```
key1:value1;key2:value2;key3:value3;...
```

There are exactly **0x23 (35) configuration members** stored in a table `sm_MemberRoles[]`, each with
min/max validation via `sm_MemberMin[]` and `sm_MemberMax[]`. These are stored at `CGlobalInfo + 0x1D0`
as an array of 35 `int` values, accessed via `GetP2PInfo(memberIndex)` (@ `0x0037d508`).

Known member indices used in the P2P setup flow:
- Index `0x1C` (28): Controls whether to use the local AppIP or stored IP
- Index `0x22` (34): "Nat34 Forbidden" flag -- when 1, forces NAT type to UDP_BLOCK (7)

The same config format is used by `CJsonParser::sm_MemberRoles` and `CP2POptMgr::sm_MemberRoles`.

## 3. P2P Server Key Info

**Function:** `CGlobalInfo::GetP2PServerKeyInfo` @ `0x0037d3c4`

Retrieves a 64-byte key block + 2-byte version from the global info object:
- Offsets `0xF4..0x133` in CGlobalInfo: 64 bytes of key material (copied as 8x `undefined8`)
- Offset `0x134`: 2-byte key version (`uint16`)

This key is used for AES-128-CBC encryption of V3 protocol messages. The key info is set
during session establishment (likely from the API's `p2pServerInfo` response).

There is also a `GetLastP2PServerKeyInfo` for fallback when the current key doesn't match.

## 4. STUN NAT Type Detection

### Architecture

**Library:** `libstunClient.so`

**Source path:** `I:\android-workspace\StunClient\app\src\main\cpp\StunClientLib.cpp`

**Key functions:**
- `Stun_Init` @ `0x0010dd4c` -- reference-counted init
- `Stun_GetNATType` @ `0x0010e084` -- main entry point
- `CheckNatType` @ `0x0010d6cc` -- core NAT detection logic
- `BuildNatReq` @ `0x0010ced4` -- constructs XML request
- `PaserNatRsp` @ `0x0010d2c4` -- parses XML response
- `CreateReqEcho` @ `0x0010d5fc` -- wraps request in SafeProtocol frame

### STUN Protocol: PROPRIETARY (NOT standard RFC 5389)

The Hik STUN protocol is **completely proprietary**, not standard STUN:

1. **XML-based payloads** (not binary STUN attributes):
   - Request: `<?xml version="1.0" encoding="UTF-8"?><Request><DevSerial>...</DevSerial></Request>`
   - Response: `<Response><Client Address="..." Port="..."/></Response>`
   - Uses `pugixml` library for XML parsing

2. **SafeProtocol framing** with custom header/tail:
   - Magic: `0x9EBAACE9` (network byte order)
   - Version: `0x01000000`
   - Header structure (`SAFEPROTOCOL_HEADER`, 32 bytes / 0x20):
     ```
     Offset  Size  Field
     0x00    4     iProtocolFLG = 0x9EBAACE9 (magic, big-endian)
     0x04    4     iProtocolVER = 0x01000000 (version, big-endian)
     0x08    4     iProtocolSEQ (sequence, big-endian)
     0x0C    4     iProtocolTYP = 0x00000000
     0x10    4     iProtocolCMD (command, big-endian)
     0x14    4     iProtocolENC = 0x00000000
     0x18    4     iProtocolLEN (body length, big-endian)
     0x1C    4     iProtocolREG = 0x00000000
     ```
   - Tail: MD5 hash of the body (`SAFEPROTOCOL_TAIL`, 32 bytes / 0x20)
   - Total packet: header(0x20) + XML body + tail(0x20)

3. **Command codes** (set in `iProtocolCMD`):
   - `0x0812` -- NAT Binding Request (sent to primary STUN server, and second server for comparison)
   - `0x0813` -- NAT Binding Request variant 2 (sent to primary server)
   - `0x0814` -- NAT Binding Request variant 3 (sent to primary server)
   - `0x0811` -- Expected response command code (checked in `CheckNatType`)

4. **NAT type detection algorithm** (`CheckNatType` @ `0x0010d6cc`):

   Uses 4 request/response packages sent to 2 STUN servers:
   - Package 0: CMD=0x0812, sent to STUN server 1
   - Package 1: CMD=0x0813, sent to STUN server 1
   - Package 2: CMD=0x0814, sent to STUN server 1
   - Package 3: CMD=0x0812, sent to STUN server 2

   Detection logic (5 retries, `select()` with 1s timeout per round):
   ```
   After receiving responses:

   if pkg[0].received AND pkg[1].received:
     if localIP == pkg[0].response.Address:
       natType = 5  (NO_NAT / Open Internet)
     else:
       natType = 1  (FULL_CONE)

   if behindNAT AND pkg[0].received AND pkg[3].received:
     if pkg[0].response != pkg[3].response (different IP or port):
       natType = 4  (SYMMETRIC)

   if behindNAT AND pkg[0].received AND pkg[2].received AND NOT pkg[1].received:
     natType = 2  (RESTRICTED_CONE)

   Timeout cases:
   if NOT behindNAT AND pkg[0].received AND NOT pkg[1].received:
     natType = 6  (FIREWALL)

   if behindNAT AND pkg[0].received AND pkg[3].received AND NOT pkg[1].received AND NOT pkg[2].received:
     natType = 3  (PORT_RESTRICTED)

   if behindNAT AND pkg[0].received AND NOT pkg[3].received:
     natType = 8  (SYMMETRIC_FIREWALL)

   if nothing received:
     natType = 7  (UDP_BLOCKED)
   ```

### NAT Type Enum

| Value | Name | Description |
|-------|------|-------------|
| 0 | UNKNOWN | Detection not completed |
| 1 | FULL_CONE | Full cone NAT |
| 2 | RESTRICTED_CONE | Address-restricted cone NAT |
| 3 | PORT_RESTRICTED | Port-restricted cone NAT |
| 4 | SYMMETRIC | Symmetric NAT |
| 5 | NO_NAT | Open Internet (no NAT) |
| 6 | FIREWALL | Behind firewall (no NAT, but port-filtered) |
| 7 | UDP_BLOCKED | UDP completely blocked |
| 8 | SYMMETRIC_FIREWALL | Symmetric NAT + firewall |

## 5. P2P_SETUP Request (0x0B02)

### Function: `BuildAndSendP2PSetupRequest` @ `0x003cd7e0`

**Signature:** `CP2PV3Client::BuildAndSendP2PSetupRequest(bool isRedirect)`

This is the critical CAS broker registration message.

### Message Construction

1. **tag_V3Attribute initialization:**
   - `cmd = 0x0B02` (P2P_SETUP)
   - Serial/session key copied from `this + 0x1C8`
   - NAT type from `this + 0x16C`
   - Local port from `this + 0x168`
   - Port guess type from `this[0x1E9]`
   - Punch timeout from `this + 0xF48`

2. **NAT type overrides:**
   - If `GetP2PInfo(0x22) == 1`: NAT type forced to 7 (UDP_BLOCKED), logged as "Nat34 is Forbidden"
   - If `CCasP2PClient::CanAddUdpLink() == false`: NAT type forced to 7 (UDP_BLOCKED), logged as "Nat34 reach limit"

3. **Local IP selection:**
   - Calls `CGlobalInfo::GetAppLocalIP()` to get the app-visible IP
   - If `GetP2PInfo(0x1C) == 1` and the returned IP is non-empty: uses the returned IP
   - Otherwise: uses the stored IP at `this + 0x150`

4. **Key material:**
   - Via `BuildMsg` (@ `0x003d0fe8`): Copies P2PKeyVer, P2P key, session key, serial, userId
   - Gets P2PServerKeyInfo from CGlobalInfo (64-byte key + version)
   - Or uses custom key from `this + 0x211` if `this[0x210] != 0`

5. **Debug log reveals all fields:**
   ```
   P2PV3-Setup, NatType:%d, LocalIP:[%s:%d], AppIP:%s, PortGuessType:%d, punchtimeout:%d -%s
   ```

### Wire Format (V3 TLV body for 0x0B02)

From `ComposeMsgBody` case `0xb02`:

```
1. ComposeTransfor() -- writes transport info block:
     Attr 0x71: busType (1 byte)
     Attr 0x72: protocol version (1 byte)
     Attr 0x75: additional flag (1 byte)
     Attr 0x7F: transport flag (1 byte)
     Attr 0x74: local address "IP:port" (string, if non-empty)
     Attr 0x73: relay/mapped address "IP:port" (string, if non-empty)
     Attr 0x8C: session ID (4 bytes, big-endian uint32)

2. Attr 0x05: session key (variable length string)
3. Attr 0x06: additional session info (variable length string)
4. Attr 0x00: serial/device ID (variable length string)
5. busType byte appended as 1-byte value
6. Attr 0x04: encoded data
7. Attr 0xFF: end-of-attributes marker
```

### Send Mechanism

`BuildMsg` -> `BuildSendMsg` -> `BuildMessage` constructs the final packet, then:

`SendP2PSetupRequest` (@ `0x003d1a3c`) calls `SendP2PServerGroup` (@ `0x003d2048`) which:
- Iterates over the P2P server list (`vector<ST_SERVER_INFO>` at `this + 0x1B0`)
- Each `ST_SERVER_INFO` is 0x42 bytes: 64 bytes IP string + 2 bytes port (at offset 0x40)
- Sends UDP packet to each server via `CCtrlUtil::SendUDPDataWithSocket`
- Returns true if at least one send succeeds

### Retry Logic

```
timeout = 10000ms (10 seconds)
retryInterval = 2000ms
maxRetries = 3

while (not stopped):
  if (elapsed > timeout):
    if (no responses received): error = 0x0E0D (timeout)
    else: error = 0x101011 (device offline)
    break

  if (retryCount < 3 AND elapsed > retryInterval * (retryCount+1)):
    resend to all P2P servers
    retryCount++

  wait on event with 100ms poll interval

  if event signaled:
    lock mutex
    check this->resultCode (at offset 0x1130)
    if resultCode == 0x101011 (device offline, error 297):
      if (offlineCount < serverCount): continue waiting
      else: give up with 0x101011
    if resultCode == 0: success!
    else: error
```

### Redirect Handling

If `SendP2PSetupRequest` returns error `0x0240` (576) and this is not already a redirect:
1. `UpdateRedirectInfoToClient(this)` -- copies redirect server info from response
2. `GetRedirectVectorInfo(this, serverVector)` -- updates the server list
3. Recursively calls `BuildAndSendP2PSetupRequest(true)` with redirect flag

## 6. P2P_SETUP Response (0x0B05) Parsing

### Function: `ParseRecvRspMsg` @ `0x003c6778`

**Signature:** `CP2PTransfer::ParseRecvRspMsg(char* buf, int len, tag_V3Attribute& attrs, tag_p2pv3_response_attribute& response)`

### Parse Flow

1. Call `CV3Protocol::ParseMessage` to deserialize the header + body
2. If `cmd == 0x0B05`: check for embedded message in attribute at offset `0x60`
   - If present, recursively call `ParseMessage` on the embedded data
   - Sets `param_3[0x1F8] = 1` to mark as "from device"

3. Copy parsed attributes to `tag_p2pv3_response_attribute` response struct:

```
Response Field Mapping (tag_p2pv3_response_attribute):
Offset  Source Attr     Description
------  -----------     -----------
+0x00   attrs[0x08]     Command type (uint16)
+0x04   attrs[0x04]     Sequence number (uint32)
+0x08   attrs[0x178]    Response flag (byte)
+0x09   attrs[0x179]    Additional flag (byte)
+0x0C   attrs[0x00]     Error code (uint32)
+0x10   attrs[0x48]     Session key (string)
+0x28   attrs[0x1A0]    Mapped address (string)
+0x40   attrs[0x1B8]    Mapped port (uint16 -> uint32)
+0x48   attrs[0x180]    Device address (string)
+0x60   attrs[0x198]    Device port (uint16 -> uint32)
+0x68   attrs[0x138]    Relay address (string)
+0x80   attrs[0x150]    Relay port (uint16 -> uint32)
+0x88   attrs[0x1E0]    Additional data (string)
+0xA0   attrs[0x17B]    Flag byte 1 (byte -> uint32)
+0xA4   attrs[0x100]    Flag byte 2 (byte -> uint32)
+0xA8   attrs[0x108]    Extra string data
+0xC0   attrs[0x120]    Server list (vector<string>)
+0xD8   attrs[0x60]     Embedded message (string, for nested 0x0B05)
+0xF0   attrs[0xA8]     Value 1 (uint32)
+0xF4   attrs[0x1FC]    Value 2 (uint32)
+0xF8   attrs[0x218]    Extended data (string)
+0x110  attrs[0x158]    Extended port (uint16 -> uint32)
```

### Response Error Handling

In `ParseP2PServerMsg` (@ `0x003d3034`):
- If `cmd == 0x0B05`: error is processed via `ConvertP2PServerError(errorCode)`
- Error code 297 (0x129) maps to `0x101011` (device offline)
- Other device response opcodes (0x0C03..0x0C18 range) use `ConvertDeviceError`

## 7. Full Session Establishment Sequence

```
1. App calls ezstream_initSDK(configString)
   -> Creates EZClientManager singleton
   -> Starts "stun" thread pool (4 threads)

2. App calls CASClient_CreateSessionEx / ezstream_createCASClient
   -> Creates CP2PV3Client instance
   -> Stores P2P server list, serial, session key, userId

3. NAT detection (via libstunClient.so):
   -> Stun_GetNATType(localIP, stunIP1, port1, stunIP2, port2, &natType)
   -> Sends proprietary XML-over-SafeProtocol packets to 2 STUN servers
   -> Determines NAT type (1-8)
   -> Result stored via CGlobalInfo::SetClientNatType

4. P2P Setup (CAS broker registration):
   -> BuildAndSendP2PSetupRequest(false)
   -> Constructs V3 message: cmd=0x0B02
      - Transport info: NAT type, local IP:port, mapped IP:port
      - Session key, serial, busType
      - P2P key material (AES-128 encryption key)
   -> Sends UDP to all P2P/CAS servers in parallel
   -> Waits up to 10s with 2s retry (max 3 retries)
   -> Handles redirect (error 0x0240) by updating server list and retrying

5. P2P Setup Response:
   -> Receives 0x0B05 from CAS broker
   -> Extracts: device address/port, relay address/port, mapped address/port
   -> If contains embedded device message: parses nested P2P response
   -> Error 297 = device offline (may retry if multiple servers)

6. Stream Start:
   -> CP2PV2Client::StartStream / CP2PV3Client::StartStream
   -> CtrlSendPlay -> sends 0x0C02 (PLAY_REQUEST)
   -> Attributes: busType, channelNo, streamType, streamSession, sessionKey
   -> Starts StartStreamCheckThread for health monitoring

7. Data Transfer:
   -> Via 0x0B04 / 0x0B05 (TRANSFOR_DATA) using tag 0x07 (2-byte length field)
   -> Can use P2P direct, relay, or UDT fallback
```

## 8. P2P Configuration Source

P2P configuration flows from the cloud API through JNI:

1. **Java layer:** `com.ez.stream.NativeApi.initSDK(configString)` passes initial config
2. **JNI layer:** `getP2PServerFieldValue` (@ `0x0029afc8`) extracts server info from Java objects
   - Reads string field (IP address) and int field (port) from `_tagP2P_SERVER_INFO`
   - Uses global field descriptors `gP2PServerKeyFields` and `gP2PServerParamFields`
3. **Native layer:** `CGlobalInfo::SetP2PConfig(configString)` parses the key:value pairs
   - 35 config members with min/max validation
   - Stored at `CGlobalInfo + 0x1D0` as int array
4. **Key info:** `CGlobalInfo::GetP2PServerKeyInfo()` returns 64-byte key + 2-byte version
   from offsets `0xF4..0x134` in CGlobalInfo

The P2P servers, STUN servers, and encryption keys are all provided by the Hik-Connect
cloud API (fetched by the Java layer) and passed down to the native SDK.

## 9. Summary of Key Findings

| Finding | Detail |
|---------|--------|
| CAS protocol | V3 binary protocol, 12-byte header, TLV attributes, AES-128-CBC encrypted |
| P2P_SETUP cmd | `0x0B02` request, `0x0B05` response |
| STUN protocol | **Fully proprietary** -- XML payloads in SafeProtocol frames (magic `0x9EBAACE9`), NOT RFC 5389 |
| STUN commands | `0x0812`/`0x0813`/`0x0814` request, `0x0811` response |
| NAT types | 8 types (1=FullCone, 2=Restricted, 3=PortRestricted, 4=Symmetric, 5=NoNAT, 6=Firewall, 7=UDPBlocked, 8=SymFirewall) |
| Setup timeout | 10 seconds, 3 retries at 2s intervals |
| Redirect | Error `0x0240` triggers redirect to new server list |
| Device offline | Error 297 / `0x101011`, retried across multiple servers |
| Encryption | AES-128-CBC with PKCS5 padding; key from P2PServerKeyInfo (64 bytes) or userId-derived |
| Config format | Semicolon-delimited key:value pairs, 35 members with range validation |
| SDK source | `E:\ezplayer\v7.5.6\sdk\src\common\ez_stream_sdk\` |
