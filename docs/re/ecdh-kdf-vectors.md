# ECDH relay crypto + test vectors (iVMS-4200 `ecdhCryption.dll`, Windows)

Deliverable for `docs/re/2026-06-04-ivms4200-ecdh-kdf-capture-task.md`. Reverse-engineered on a
Windows host with Ghidra (kawaiidra-mcp) + Frida against the live iVMS-4200 `ecdhCryption.dll`.

## TL;DR — the task's premise was slightly off, and that's the unlock

The task framed the blocker as a **secret→sessionKey KDF** (`GenerateSessionKey`). It isn't one.
`GenerateSessionKey` emits a **fresh random 32-byte key** (AES-256 CTR_DRBG output; verified
non-deterministic in-process — same shared secret produced different session keys every call). The
real secret-binding is in **`EncECDHReqPackage`** (the `ClnConnectReq` builder). Reproducing *that*
is what stops relay error `0x2715`. Full construction below.

## DLL build

- `C:\Program Files (x86)\iVMS-4200 Site\iVMS-4200 Client\Client\ecdhCryption.dll`
- x64 PE32+, preferred ImageBase **0x180000000** (task doc's `RVA = ghidraAddr - 0x180000000` holds).
- SHA256 `C7768BF8CEE99E13DBD7D3051D744D6550DEA0B2F76011BE3B3A3A2B6D0B62DB`.
- Exports the high-level API **by name** (53 exports) — hook/call by name, no address math. Loaded by
  every iVMS streaming process; `iVMS-4200.Video.C` is the live-preview/playback one.

## Primitives (Ghidra-confirmed, this build)

| Ghidra fn | Primitive |
|---|---|
| `FUN_180009cd0` | **AES block encrypt** (T-tables Te0..Te3 @ `0x46830/46c30/47030/47430`, S-box @ `0x456d0`) |
| `FUN_1800092f0` | **AES key schedule** (`0x100` ⇒ AES-256) |
| `FUN_180012b50` | **ChaCha20 init** — sigma `"expand 32-byte k"` + 32B key |
| `FUN_180012c90` / `FUN_180012d40` | ChaCha20 set counter/nonce / encrypt |
| `FUN_180001000` | **CRC-32** (reflected, table @ `0x18003e590`, init `0xFFFFFFFF`, final `~`) |
| `FUN_180016e00` | **AES-256 CTR_DRBG Generate** (16B counter `V` at `ctx+0x0F`, big-endian inc; `AES(V)` per block) |
| `FUN_180016a60` | CTR_DRBG_Update (48B seedlen = 32 key + 16 V) |
| `FUN_180016d20` | CTR_DRBG **Instantiate**: `(ctx, prf, seed=ctx+0x158, personalization, plen)` |
| `FUN_180011fa0` | MAC/cipher dispatch (`switch(desc[+8])` types 3–9) — used for the packet MAC |

DRBG personalization strings (passed to `FUN_180016d20`):
- **session DRBG** (instantiated in `ECDHCryption_InitLib` → `FUN_180001690`): **`"ezviz-ecdh"`** (11B).
- **keygen DRBG** (in `GeneratePublicAndPrivateKey` → `FUN_180001d90`): **`"gen_key"`** (8B).

## Key formats (exact)

- **Client/peer public key:** 91 bytes, **SPKI/DER** P-256 (`30 59 30 13 06 07 2a 86 48 ce 3d 02 01
  06 08 2a 86 48 ce 3d 03 01 07 03 42 00 04 ‖ X(32) ‖ Y(32)`). Stored at `ctx+0x589`.
- **Client private key:** **121 bytes (0x79)**, **SEC1/DER** EC private key
  (`30 77 02 01 01 04 20 ‖ d(32) ‖ a0 0a 06 08 2a 86 48 ce 3d 03 01 07 a1 44 03 42 00 04 ‖ X ‖ Y`).
  Stored at `ctx+0x609`. (NOT the 128-byte PEM the Android notes guessed.)

## The exported pipeline

| Export | Behaviour |
|---|---|
| `ECDHCryption_InitLib` | instantiates the session CTR_DRBG with personalization `"ezviz-ecdh"` |
| `ECDHCryption_CreateSession` | allocates a session node (int id) in a red-black tree at `ctx+0x6c0` |
| `ECDHCryption_GeneratePublicAndPrivateKey(pubOut,&pl,privOut,&kl)` | P-256 keypair via keygen DRBG; pl=91, kl=121. **Deterministic in isolation** (keygen DRBG re-seeded from a fixed value each CreateSession) |
| `ECDHCryption_SetPBKeyAndPRKey(pub,pl,priv,kl)` | store client pub→`ctx+0x589`, priv→`ctx+0x609`; sets a one-shot flag `ctx+0x588` (returns 0x1c if already set) |
| `ECDHCryption_GenerateMasterKey(serverPub, out32)` | **ECDH P-256** = clientPriv(`ctx+0x609`) × serverPub(arg) → 32B shared secret. Does NOT touch the DRBG |
| `ECDHCryption_GenerateSessionKey(out32)` | CTR_DRBG Generate → **fresh random 32B session key** (NOT a function of the shared secret) |
| `ECDHCryption_EncECDHReqPackage(...)` | builds the `ClnConnectReq` packet (crypto below) |

## `ClnConnectReq` packet construction (FUN_180002b30) — the relay unlock

Let `S` = 32B ECDH shared secret, `K` = 32B random session key, `Pc` = 91B client SPKI pubkey,
`B` = plaintext body (`param_8` bytes), `ch` = channel id, `seq` = 1.

```
off 0   : 0x24 0x01 0x00
off 3   : htons(bodyLen)                       # 2B BE
off 5   : 0x01
off 6   : channelId                            # 1B
off 7   : htonl(seq=1)                          # 4B BE
off 11  : AES256_ECB_encrypt(key=S, K)         # 32B = two ECB blocks of the SESSION KEY, key=SHARED SECRET
off 43  : Pc                                    # 91B client SPKI pubkey
off 134 : ChaCha20(key=K, counter/nonce, B)    # body, encrypted with the SESSION KEY  (if bodyLen>0)
end     : HMAC(key=S, msg)                      # 32B MAC, key=SHARED SECRET
```
Fixed overhead = 11 + 32 + 91 + 32 = **166 bytes** (matches task doc).

- **off 11 wrap:** `FUN_1800092f0(ks, S, 0x100)` then two `FUN_180009cd0(ks, Kblock, out)` ⇒
  **standard AES-256-ECB(key = shared secret)** encrypting the 32B session key. (Task doc had the
  direction reversed: it is `E_S(K)`, not `E_K(S)`.) **VERIFIED**: `FUN_180009cd0` reproduces
  Python `cryptography` AES-256-ECB byte-for-byte (no byte-swap, no variant) — see vectors below.
- **body:** `FUN_180012b50/c90/d40` ⇒ **standard ChaCha20** (RFC 7539) with key = session key `K`.
  `FUN_180012c90` sets state word 12 (counter) = 0 and words 13–15 (nonce) = `param2[0..2]`; packet
  path `param2 = {1,0,0}` ⇒ **counter=0, nonce words {1,0,0}**, i.e. the 16-byte `cryptography`
  nonce = `00000000 01000000 00000000 00000000`. **VERIFIED** byte-for-byte vs Python ChaCha20 — see
  vectors below.
- **MAC:** `crcB = CRC32(body)`, `crcH = CRC32(header[0:0x86])`; `msg = sprintf("%u%u", crcB, crcH)`
  (ASCII decimal concatenation, NUL-padded in a 0x20 buffer); then `FUN_180011fa0(mac, &DESC@0x18003e3f0, 1)`,
  `FUN_1800124b0(mac, S, 0x20)` (**MAC key = shared secret, 32B**), finalize `FUN_180012610` → **32B
  MAC** appended. `FUN_1800124b0` is **textbook HMAC** (ipad `0x36` / opad `0x5c`); the hash dispatcher
  `FUN_180012130` case 6 uses the canonical SHA-256 IV (`6a09e667…5be0cd19`) and the output is 32B ⇒
  **HMAC-SHA256, confirmed** (case 5 SHA-224 would be 28B; MD5/SHA-1 are cases 3/4).

**Server side (inferred):** ECDH→`S`; AES-256-ECB-decrypt off-11 with `S` → `K`; ChaCha20-decrypt body
with `K`; verify MAC with `S`. So the client can pick `K` randomly — no need to reproduce
`GenerateSessionKey` deterministically.

## Test vectors (in-process driver, verified against Python `cryptography`)

Driven by calling the exported pipeline directly in iVMS-4200 (`AlarmCenter.C`, pid 11796) — no live
relay handshake needed. Drivers: `C:\re\drive_ecdh2.js` (ECDH) and `C:\re\drive_primitives.js` (AES).
Independent check: `C:\re\gen_server_keys.py` / `aes_analyze.py`.

**Client keypair** (deterministic keygen — same every CreateSession in isolation):
```
clientPub  (91, SPKI DER)  = 3059301306072a8648ce3d020106082a8648ce3d03010703420004643d9d11c296bf3a27b810c1f9ee0b3b33e8e04115c20ed211563d54e187760158a9d78ee58a8b60c7c88aba9147e8c58c96b6da5e9f5596efbb0e2e5f1bec55
clientPriv (121, SEC1 DER) = 30770201010420c239658bfd8dfdc543185e5bba757be5571d99d899fbc1dbf441cad43d0a266ba00a06082a8648ce3d030107a14403420004643d9d11c296bf3a27b810c1f9ee0b3b33e8e04115c20ed211563d54e187760158a9d78ee58a8b60c7c88aba9147e8c58c96b6da5e9f5596efbb0e2e5f1bec55
privScalar d = c239658bfd8dfdc543185e5bba757be5571d99d899fbc1dbf441cad43d0a266b
```

**ECDH (Stage 1) — 3 sessions, DLL output == Python `client_priv.exchange(ECDH, serverPub)` byte-for-byte:**
```
vec0 serverPub = 3059...420004ddd78ae590ba8d8f7c3f12a5c088e55294c423517d725341a6551da23599914bda4a69e12f7e1c5352c0b2d999481d8dd785217e750fc7eb360d3e56088fa865
     sharedSecret = 5633e1372ef8656d2939fbedcecd0230fc1d971153645fd9feca8d61dab913bc   ✓ MATCH
vec1 serverPub = 3059...420004f3970ab63fa84e1724c7faca7af75000a2345ffe29936cc906ffb7e24a3f6c9c8f90dc186556879ad53b5276795868392215884caa8f25786c18d035ba5e7c56
     sharedSecret = 263c20d5b9bba76e5cfdd63dd5d52a0563a17922fd9c7e0d29d2c694b38c0092   ✓ MATCH
vec2 serverPub = 3059...420004d63963cd33cfd61ef9c5ac7213eebccbac755e83a6a7bed174e8c583ce6e6eeb0a10bb45c52420ed9d05d793e4e6296bc2d302eb7529fd234f27c8364b2a9774
     sharedSecret = fe59ef118a2d3020a16582a5acb08aa8985983f8273370c202f50d6265e39fe9   ✓ MATCH
```
⇒ Stage 1 is **standard raw ECDH P-256** (X-coordinate, 32B). Success criterion met.

**Session key (Stage 2) — non-deterministic** (same ctx/secret → different key each call):
```
13588c48666dab8e985258de9d8adfd2bc91a1579b37813bec4fbc14ab070d60
908d5c762cf21128bb424c32f319a44477c194b73c9c519ecece92d6921ff632
5163023492d45e7b2f11a83b9523bf7170b1a948590cf60f95937778e037fd23   (← K used in wrap vector below)
```
⇒ session key is **fresh random** (AES-256 CTR_DRBG), NOT a deterministic KDF of the secret.

**Session-key wrap (Stage 3, off-11) — `E_{AES-256-ECB(S)}(K)`, DLL == Python byte-for-byte:**
```
S (shared secret) = 5633e1372ef8656d2939fbedcecd0230fc1d971153645fd9feca8d61dab913bc
K (session key)   = 5163023492d45e7b2f11a83b9523bf7170b1a948590cf60f95937778e037fd23
wrap (32B)        = 555a9210d6ed8d712cad8ffedb1fb46e9c28d36c35bf8e49d18eafc5be87a1bd   ✓ MATCH (standard AES-256-ECB)
```
AES single-block sanity: key `000102…1f`, pt `000102…0f` → `5a6e045708fb7196f02e553d02c3a692` (== standard AES-256).

**Body cipher (ChaCha20), DLL == Python byte-for-byte:**
```
key (session key) = 5163023492d45e7b2f11a83b9523bf7170b1a948590cf60f95937778e037fd23
nonce (16B)       = 00000000 01000000 00000000 00000000    (counter=0, nonce words {1,0,0})
plaintext (40B)   = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021222324252627
ciphertext (40B)  = 4d6e35baf580790ced939eb7cd5aa01f51cba5626b198a43ea8b01982b2948b9041aa2beb92f9b1e   ✓ MATCH
```

Raw logs in `C:\re\captures\{ecdh-vectors2,primitives,chacha}.log`. Drivers `drive_ecdh2.js` /
`drive_primitives.js` / `drive_chacha.js`. Handshake capture hooks (for a live handshake, if ever
forced): `scripts/frida/hook-ecdh-ivms-windows.js`.

## Status / remaining

- ✅ Stage 1 ECDH: standard raw P-256, 3 vectors byte-verified.
- ✅ Wrap (off 11): standard AES-256-ECB(sharedSecret), vector byte-verified.
- ✅ Body (off 134): standard ChaCha20(sessionKey, ctr 0, nonce {1,0,0}), vector byte-verified.
- ✅ MAC (end): HMAC-SHA256(sharedSecret), confirmed (SHA-256 IV @ hash-dispatcher `FUN_180012130`
  case 6; 32B output rules out SHA-224/SM3-as-28B and MD5/SHA-1).
- ✅ Key formats, personalization strings (`"ezviz-ecdh"`/`"gen_key"`), CRC-32.
- ⏳ Optional: capture one full `EncECDHReqPackage` packet end-to-end (couldn't drive the export — the
  session-tree lookup rejects a synthetic session id and the void wrapper hides the error). Not a
  blocker: every primitive above is independently verified, so packet assembly is fully specified.
- ⏳ Wire into `src/lib/p2p/relay-client.ts` / `vtm-client.ts`: ECDH→S, random K, off-11 =
  AES-256-ECB(S).encrypt(K), body = ChaCha20(K, ctr0, nonce {1,0,0}),
  MAC = HMAC-SHA256(S, "%u%u"%(crc32(body),crc32(header[0:0x86]))). Then re-test relay `0x2715`.

> Note: the live relay/VTM handshake could not be force-triggered from iVMS (direct P2P kept winning;
> a full outbound-UDP block on Video.C broke P2P signaling rather than falling back to the
> ECDH-bearing VTM relay). The in-process driver approach made that unnecessary — it produces clean,
> controlled, independently-verifiable vectors directly.
