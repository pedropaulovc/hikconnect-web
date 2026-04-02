# Crypto Analysis — libezstreamclient.so

**Library:** EZVIZECDHCrypter class in libezstreamclient.so
**Crypto backend:** mbedTLS (libmbedcrypto.so, 388KB)

---

## Key Discovery: ChaCha20, NOT AES

The stream encryption uses **ChaCha20** (not AES as previously assumed). This was confirmed by decompiling `ezviz_ecdh_encECDHDataPackage`.

## ECDH Key Exchange

### Curve
- **secp256r1 (P-256)** — `mbedtls_ecdh_setup(ctx, 3)` where group ID 3 = `MBEDTLS_ECP_DP_SECP256R1`

### Key Format
- Private key: PEM format, 128 bytes (0x80), stored at `EZVIZECDHCrypter + 0x609`
- Public key (peer): DER format, 91 bytes (0x5B)
- Shared secret: 32 bytes from `mbedtls_ecdh_calc_secret()`

### Key Generation Flow
```
ezviz_ecdh_generatePublicAndPrivateKey()
  → generates EC P-256 key pair

ezviz_ecdh_generateMasterKey(peerPublicKey, outputSecret)
  ├── mbedtls_pk_parse_key(selfPrivateKey, 0x80)     // parse own private key
  ├── mbedtls_pk_parse_public_key(peerPubKey, 0x5B)  // parse peer public key
  ├── mbedtls_ecdh_setup(ctx, SECP256R1)
  ├── mbedtls_ecdh_get_params(ctx, self, OURS)
  ├── mbedtls_ecdh_get_params(ctx, peer, THEIRS)
  └── mbedtls_ecdh_calc_secret(ctx, &len, output, 32)
      → 32-byte ECDH shared secret

ezviz_ecdh_generateSessionKey(output)
  → 32 bytes of mbedtls_ctr_drbg_random (just random)
```

### Key Hierarchy
```
ECDH Private Key (P-256, PEM)  +  Peer Public Key (DER)
         │                              │
         └──── mbedtls_ecdh_calc_secret ────→ Master Key (32 bytes)
                                                  │
                                          ┌───────┴───────┐
                                          │               │
                                    Encryption Key   HMAC Key
                                    (ChaCha20)       (SHA-256)
```

## Stream Encryption (ChaCha20)

### Algorithm
- **ChaCha20** (RFC 8439 variant, via mbedTLS)
- NOT AES-CBC/CTR/GCM as previously hypothesized

### Parameters
- **Key:** 32 bytes (from ECDH shared secret or session key)
- **Nonce:** 12 bytes = `[seqnum_u32, 0, 0]` (4-byte sequence number + 8 zero bytes)
- **Initial counter:** 0

### Encryption Operation
```c
mbedtls_chacha20_init(ctx);
mbedtls_chacha20_setkey(ctx, key_32bytes);
mbedtls_chacha20_starts(ctx, nonce_12bytes, counter=0);
mbedtls_chacha20_update(ctx, plaintext_len, plaintext, ciphertext);
mbedtls_chacha20_free(ctx);
```

## Packet Authentication (HMAC-SHA256)

### Algorithm
- **HMAC-SHA256** (`mbedtls_md_info_from_type(6)` where 6 = `MBEDTLS_MD_SHA256`)
- 32-byte key (from key hierarchy)
- Applied to: 8-byte derived value (likely sequence + additional context)
- Output: 32-byte HMAC appended to packet

### HMAC Flow
```c
mbedtls_md_hmac_starts(ctx, hmac_key, 32);
mbedtls_md_hmac_update(ctx, derived_8bytes, 8);
mbedtls_md_hmac_finish(ctx, hmac_output);
// 32-byte HMAC appended to encrypted packet
```

## Encrypted Packet Format

```
┌─────────┬──────┬─────┬────────┬──────────┬──────────────┬──────────┐
│  Magic  │ Type │ Pad │ Length │ Reserved │   Seq Num    │          │
│  0x24   │ 0x02 │ 00  │  2B BE │  00 00   │    4B BE     │          │
├─────────┴──────┴─────┴────────┴──────────┴──────────────┤          │
│  Header (11 bytes)                                       │          │
├──────────────────────────────────────────────────────────┤          │
│  ChaCha20 encrypted payload (N bytes)                    │          │
├──────────────────────────────────────────────────────────┤          │
│  HMAC-SHA256 (32 bytes)                                  │          │
└──────────────────────────────────────────────────────────┘
Total: N + 43 bytes
```

### Header Fields
| Offset | Size | Field | Value |
|--------|------|-------|-------|
| 0 | 1 | Magic | `$` (0x24) |
| 1 | 1 | Type | 0x02 (data packet) |
| 2 | 1 | Padding | 0x00 |
| 3 | 2 | Payload length | big-endian |
| 5 | 2 | Reserved | 0x0000 |
| 7 | 4 | Sequence number | big-endian, auto-incrementing |

## Additional Crypto Functions

### Request Package Encryption
- `ezviz_ecdh_encECDHReqPackage` — encrypts control/request packets (likely different header format)
- `ezviz_ecdh_decECDHReqPackage` — decrypts incoming requests

### Key Management
- `ezviz_ecdh_SetSessionEncKey` — sets the session encryption key
- `ezviz_ecdh_setEcdhMTKeyPair` — sets Master Transport key pair
- `ezviz_ecdh_GetMTKey` / `ezviz_ecdh_SaveMTKey` — persistent MT key storage
- `ezviz_ecdh_SetPacketWindowSize` — replay protection window (set to 2 in init)

### CRC32
- `ezviz_ecdh_crc32` — CRC32 applied to header (11 bytes) and payload separately
  - Called twice: once for header, once for encrypted payload
  - Result likely stored in the "Reserved" field or used internally for integrity

## Implications for TypeScript Implementation

1. **Good news:** ChaCha20 is natively supported in Node.js (`crypto.createCipheriv('chacha20')`)
2. **Good news:** HMAC-SHA256 is trivial in Node.js (`crypto.createHmac('sha256', key)`)
3. **Good news:** ECDH P-256 is native in Node.js (`crypto.createECDH('prime256v1')`)
4. **Key exchange:** Need to match PEM/DER format for public key exchange with the server
5. **Nonce construction:** Simple — 4-byte seqnum + 8 zero bytes
6. **Packet framing:** 11-byte header + encrypted payload + 32-byte HMAC

## Open Questions
- Where does the "device verification code" (6 chars) fit in? Possibly the `szPermanetkey` field
- Is the HMAC key the same as the encryption key, or derived separately?
- Are request packets (`encECDHReqPackage`) using the same format as data packets?
- What triggers key rotation (the `ezviz_ecdh_updateECDHReqPackage`)?
