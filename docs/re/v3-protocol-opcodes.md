# Hik-Connect V3 Protocol Opcodes and Message Format

Extracted from `libezstreamclient.so` via Ghidra decompilation of `CV3Protocol` and `CP2PV3Client` classes.

## Message Header Format (12 bytes)

From `CV3Protocol::BuildMessage` (@ 0x003daa50) and `CV3Protocol::ParseMessage` (@ 0x003ddd34):

```
Offset  Size  Field         Description
------  ----  -----         -----------
0x00    1     magic_flags   High nibble = 0xE (magic), low nibble unused
                            ParseMessage validates: (byte >> 4) == 0xE
0x01    1     mask          Bit field:
                              bit 7: encrypt flag (1 = body is AES-128-CBC encrypted)
                              bit 6: salt version flag
                              bit 5-3: salt index (3 bits)
                              bit 2: expand header present
                              bit 1: is2BLen (attribute length uses 2 bytes when tag == 0x07)
                              bit 0: unused
0x02    2     msgType       Command/opcode (big-endian, byte-swapped on read)
0x04    4     seqNum        Sequence number (big-endian, 32-bit, byte-swapped)
0x08    2     reserved      Bitfield info from tag_BitFlagInfo
0x0A    1     headerLen     Total header length (0x0C minimum, larger if expand header present)
0x0B    1     crc8          CRC-8 checksum over entire message (set to 0 during calculation)
```

The first byte written to the header is always `0xE2` (magic nibble 0xE, plus lower nibble bits).

### Mask Byte Construction (from BuildMessage)

```c
mask = (encrypt_flag << 7) | (salt_version & 1) << 6 | (salt_index & 7) << 3
     | (expand_header & 1) << 2 | (is2BLen & 1) << 1;
```

### Header Length

- Base header: 12 bytes (0x0C)
- If expand header is present: `headerLen = 0x0C + expand_header_length`
- Body length: `total_message_length - headerLen`

### CRC-8

Computed via `CheckCode_CRC8()` over the entire message with byte[0x0B] set to 0, then written back to byte[0x0B].

## Message Type Opcodes (param_1 field at offset +0x08 in tag_V3Attribute)

From `ComposeMsgBody` (@ 0x003dafa8), `StartStream`, `StopStream`, `P2PPlayBackControl`, and `BuildAndSendP2PSetupRequest`:

### Setup / Connection (0x0Bxx range)

| Opcode | Name | Description |
|--------|------|-------------|
| `0x0B00` | TRANSFOR_SETUP | Transport setup - writes attrs 0x00 (transfor data) and 0xFF (end marker) |
| `0x0B02` | P2P_SETUP | P2P setup request. Attrs: 0x05 (session key), 0x06, 0x00, busType byte, 0x04, 0xFF |
| `0x0B03` | TRANSFOR_CTRL | Transport control. Attrs: 0x02 (4-byte big-endian value), 0x05, 0xFF |
| `0x0B04` | TRANSFOR_DATA | Transport data. Attrs: 0x00, 0x07 |
| `0x0B05` | TRANSFOR_DATA2 | Transport data variant. Attrs: 0x02 (4-byte value), 0x07 |

### Stream Control (0x0Cxx range)

| Opcode | Name | Description |
|--------|------|-------------|
| `0x0C00` | PREVIEW_REQ / STREAM_START | Preview/live stream request (same handler as 0x0C01) |
| `0x0C01` | PREVIEW_REQ2 | Alternative preview request (shared handler with 0x0C00) |
| `0x0C02` | PLAY_REQUEST | Full play request (preview + playback). Set in `StartStream` with `local_3f0 = 0xC02`. Attrs: 0x76 (busType, 1 byte), 0x05 (session key), 0x78 (streamType, 1 byte), 0x77 (channelNo, 2 bytes BE), 0x7E (streamSession, 4 bytes BE), 0x79, 0x7C, 0x7D (4 bytes), optional: 0xAE, 0xAF (when busType==4 or 2), time ranges: 0x7A (startTime), 0x7B (stopTime), 0xB0 (time segment), 0x83, 0xB6, 0xB2, 0xB3, 0xB4, 0xB5 |
| `0x0C04` | TEARDOWN | Teardown/stop stream. Set in `StopStream` with `local_3a8 = 0xC04`. Attrs: 0x05 (session key), 0x76 (busType, 1 byte), 0x77 (channelNo, 2 bytes BE), 0x78 (streamType, 1 byte), 0x84 (4 bytes, device session) |
| `0x0C07` | VOICE_TALK | Voice talk control. Attrs: 0x05, 0x81 (2 bytes) |
| `0x0C08` | CT_CHECK | Connectivity check. Attrs: 0x09 (step byte), 0x0A |
| `0x0C0A` | STREAM_CTRL | Stream control. Attrs: 0x05 (session key), 0x80 |
| `0x0C0B` | DATA_LINK | Data link. Attrs: 0x07, 0x87 (4 bytes) |
| `0x0C10` | PLAYBACK_PAUSE | Playback pause (set in P2PPlayBackControl case 1). Attrs: 0x05, 0x84 |
| `0x0C12` | PLAYBACK_RESUME | Playback resume (set in P2PPlayBackControl case 2). Attrs: 0x05, 0x84 |
| `0x0C14` | PLAYBACK_SEEK | Playback seek/set rate (set in P2PPlayBackControl case 3). Attrs: 0x05, 0x84 (4 bytes), 0x85 (4 bytes), optional 0xB1 |
| `0x0C16` | PLAYBACK_SEARCH | Playback search/segment (set in P2PPlayBackControl case 4). Attrs: 0x05, 0x84, time segments via 0xB0, optional 0xB8 |
| `0x0C18` | PLAYBACK_CTRL3 | Playback control type 3 (set in P2PPlayBackControl case 5). Attrs: 0x05, 0x84, time segments via 0xB0 |

### Transparent/Notify (0x0Dxx range)

| Opcode | Name | Description |
|--------|------|-------------|
| `0x0D00` | TRANSPARENT | Transparent data passthrough. Attrs: 0x05, 0x7E (4 bytes), optional 0x8D |
| `0x0D02` | TRANSPARENT2 | Transparent data variant. Attrs: 0x05, 0x84 (4 bytes) |

## TLV Attribute Format

From `CV3Protocol::WriteAttribute` (@ 0x003e03f4) and `CV3Protocol::ReadAttribute` (@ 0x003df9dc):

### Standard TLV Structure

```
Offset  Size     Field
------  ----     -----
0x00    1 byte   Tag (attribute ID)
0x01    1 byte   Length (of value only, when tag != 0x07)
0x02    N bytes  Value

Special case when tag == 0x07 AND is2BLen flag is set:
0x00    1 byte   Tag (0x07)
0x01    2 bytes  Length (big-endian 16-bit, byte-swapped on read)
0x03    N bytes  Value
```

### WriteAttribute Logic

```
if tag == 0x07:
    write: [tag(1)] [length_be16(2)] [value(N)]    // 2-byte length, big-endian
else:
    write: [tag(1)] [length(1)] [value(N)]          // 1-byte length
```

### ReadAttribute Logic

1. Read first byte as tag
2. If tag == 0x07 and `is2BLen` flag is true: read next 2 bytes as big-endian length, data offset = 3
3. Otherwise: read next 1 byte as length, data offset = 2
4. Minimum input size: 3 bytes (for short form) or 6 bytes divided by 2 (Ghidra shows `< 6` check for short string)

## Attribute Tag Dictionary

From `ComposeMsgBody` switch cases:

| Tag | Size | Name/Description |
|-----|------|-----------------|
| `0x00` | variable | Transfor data / generic data |
| `0x01` | variable | Expand header: key version |
| `0x02` | 4 bytes | Expand header: client ID (big-endian uint32) / generic 4-byte value |
| `0x03` | 2 bytes | Expand header: device channel (big-endian uint16) |
| `0x04` | variable | busType encoding / additional data |
| `0x05` | variable | Session key (string) |
| `0x06` | variable | Additional session info |
| `0x07` | variable | Large data blob (uses 2-byte length field) |
| `0x09` | 1 byte | CT check step number |
| `0x0A` | variable | CT check data |
| `0x71` | 1 byte | BusType byte for preview/stream (used in 0x0C00/0x0C01) |
| `0x76` | 1 byte | BusType (device business type: 1=preview, 2=playback, 3=talk, 4=playback-v2) |
| `0x77` | 2 bytes | Channel number (big-endian uint16) |
| `0x78` | 1 byte | Stream type (main=0, sub=1) |
| `0x79` | variable | Session/stream info |
| `0x7A` | string | Start time (formatted via ConvertTimeFormat) |
| `0x7B` | string | Stop time (formatted via ConvertTimeFormat) |
| `0x7C` | variable | Additional stream param |
| `0x7D` | 4 bytes | Device session or related 4-byte value (big-endian) |
| `0x7E` | 4 bytes | Stream session ID (big-endian uint32) |
| `0x80` | variable | Stream control data |
| `0x81` | 2 bytes | Voice talk encoding type (big-endian uint16) |
| `0x82` | 4 bytes | Port count for preview (big-endian uint32) |
| `0x83` | variable | Stream metadata |
| `0x84` | 4 bytes | Device session / playback control value (big-endian uint32) |
| `0x85` | 4 bytes | Playback seek rate value (big-endian uint32) |
| `0x87` | 4 bytes | Data link value (big-endian uint32) |
| `0x8D` | variable | Transparent data extension |
| `0xAE` | 4 bytes | Extended stream param 1 (when busType==4 or 2, and value != 0) |
| `0xAF` | 4 bytes | Extended stream param 2 |
| `0xB0` | string | Time segment (format: "startTime;stopTime") |
| `0xB1` | variable | Playback seek metadata |
| `0xB2` | variable | Optional stream metadata 1 |
| `0xB3` | variable | Optional stream metadata 2 |
| `0xB4` | variable | Optional stream metadata 3 |
| `0xB5` | 1 byte | Stream flag byte |
| `0xB6` | variable | Optional stream metadata 4 |
| `0xB8` | variable | Playback search extension |
| `0xFF` | 0 | End-of-attributes marker |

## Expand Header Format

From `CV3Protocol::ComposeExpandHeader` (@ 0x003dd888):

The expand header is a TLV-encoded block inserted between the base 12-byte header and the message body. It contains:

| Order | Tag | Size | Description |
|-------|-----|------|-------------|
| 1 | `0x00` | 2 bytes | Key version (big-endian uint16) |
| 2 | `0x01` | variable | Key info data |
| 3 | `0x02` | 4 bytes | Client ID (big-endian uint32) |
| 4 | `0x03` | 2 bytes | Device channel (big-endian uint16) |

## Encryption

From `BuildMessage`:
- When encryption is enabled (bit 7 of mask byte), the message body is encrypted with AES-128-CBC using PKCS5 padding
- The key is passed as `param_2` (char*) to `BuildMessage`, which calls `Aes128CbcEncrypt_PKCS5`
- On parse, decryption uses either the P2P server key, the P2P link key (from `param_3->userId`), or an empty key as fallback

### Key Sources (from BuildSendMsg @ 0x003c61a4)

- `param_1[0x308]`: 32-byte key buffer (P2P server key or link key)
- `param_1[0x238]`: User ID based key (when P2PKeyVer != 0)
- Keys are 32 bytes, copied via `__memcpy_chk(..., 0x20)`
- The version/index fields at `param_1[0x230]` (P2PKeyVer, 2 bytes) and `param_1[0x321]` (salt version) control which key path is used

## Message Flow

### BuildSendMsg (@ 0x003c61a4) - Top-level message builder

1. Creates a `CV3Protocol` instance
2. Sets `param_1->protocol_version = 3`
3. Copies key material from `param_1[0x308]` (32 bytes)
4. Sets salt version and index from `param_1[0x321]` and `param_1[800]`
5. For certain opcodes (`0xC02-0xC18`, `0xD02`, `0xD00`), logs detailed debug info including serial, clientId, channel, key version
6. If P2PKeyVer == 0, uses a default key; otherwise uses the userId-derived key
7. Calls `CV3Protocol::BuildMessage` which:
   a. Increments global sequence counter (thread-safe via mutex)
   b. Calls `ComposeMsgBody` to serialize attributes based on opcode
   c. Optionally encrypts the body (AES-128-CBC)
   d. Constructs the 12-byte header
   e. Optionally inserts expand header
   f. Appends body
   g. Computes and writes CRC-8

### BuildMsg (CP2PV3Client @ 0x003d0fe8) - Client-level wrapper

1. Copies session key from `this + 600` to `param_1 + 0x48`
2. Copies P2PKeyVer from `this + 0x1F0` to `param_1 + 0x230`
3. Copies P2P key and user ID strings
4. Retrieves P2P server key info from `CGlobalInfo`
5. Delegates to `CP2PTransfer::BuildSendMsg`

## String Constants Found

### V3 Protocol Related
- `CP2PV3Client` - Main V3 protocol client class
- `CV3Protocol` - Protocol serialization/deserialization
- `CP2PTransfer` - Transport layer
- `tag_V3Attribute` - Message attribute structure
- `tag_BitFlagInfo` - Header bit flags
- `tag_ExpandHearder` (sic) - Expand header structure
- `tag_V3Transfor` - Transport info structure

### Debug Format Strings
- `"BuildSendMsg, Cmd:%0X, Serial:%s, ClientId:%d, DevChannel:%d, P2PKeyVer:%d, P2PKey:%.2s***, P2PKeyLen:%u, UserId:%.2s***"`
- `"cmd:[0X%X], seq:%d, mask:0X%X, crc8:%d, msg-len:%d, Encrypt:%d, ExpandHeader:%d"`
- `"p2pv3 ParseMessage, cmd:0X%X, rspseq:%d, mask:0X%X, bufLen:%d, headerLen:%d, bodyLen:%d, is2BLen:%d, encrypt:%d, expand:%d, fromdev:%d, saltVer:%d, saltIndex:%d"`
- `"P2PPlayReq, BusType:%d, Channel:%d, Streamtype:%d, StreamSession:%d, SessionKey:%.10s***, timeout:%d"`

### Error Codes Referenced
- `0x0E01` - Invalid parameters
- `0x0E02` - Thread creation failure
- `0x0E0D` - Recv response timeout
- `0x0E0F` - Invalid user ID
- `0x0E10` - Stop stream error
- `0x0E16` - Decryption failed (empty key)
- `0x0E34` - BuildMsg failed
- `0x0E35` - Send request failed
- `0x0E48` - Key info mismatch
- `0x0E49` - Default key length invalid
- `0x0E4A` - Invalid protocol data (magic byte mismatch)
- `0x0E4B` - ParseMsgBody failed
- `0x0E4C` - P2P server decrypt failed
- `0x0E4D` - P2P link decrypt failed
- `0x0E4E` - Invalid message length
- `0x0E4F` - CRC-8 mismatch
- `0x101011` - Device offline (error code 297 from server)
- `0x0240` (576) - Redirect required

## Opcode Filtering in BuildSendMsg

The check `uVar6 = uVar5 - 0xc02; if (uVar6 < 0x17 && ((1 << uVar6) & 0x554325) != 0)` determines which opcodes get the detailed logging treatment. Breaking down the bitmask `0x554325`:

```
Bit  0 (0xC02): 1 -> PLAY_REQUEST
Bit  2 (0xC04): 1 -> TEARDOWN
Bit  5 (0xC07): 1 -> VOICE_TALK
Bit  8 (0xC0A): 1 -> STREAM_CTRL
Bit  9 (0xC0B): 1 -> DATA_LINK
Bit 14 (0xC10): 1 -> PLAYBACK_PAUSE
Bit 16 (0xC12): 1 -> PLAYBACK_RESUME
Bit 18 (0xC14): 1 -> PLAYBACK_SEEK
Bit 20 (0xC16): 1 -> PLAYBACK_SEARCH
Bit 22 (0xC18): 1 -> PLAYBACK_CTRL3
```

Additionally, `0xD02` and `0xD00` are handled separately with the same logging.
