# Video Encryption Analysis — 2026-03-18

## Status: Key confirmed, decryption format unknown

## Confirmed Facts

1. **Verification code is "ABCDEF"** — Frida captured `NativeApi.setSecretKey(handle, "ABCDEF")` called 4x (once per camera). This is the device's encryption code.

2. **Video IS encrypted** — VPS/SPS/PPS arrive plaintext (FFmpeg detects HEVC Main 3840x2160 25fps), but all slice data comes as Hikvision NAL type 49 (0x62 0x01 header). Green frame output confirms no valid decoded content.

3. **ECDH is NOT used for this device** — `udpEcdh=0`, `vtduServerPublicKey` is all zeros. Encryption uses verification code, not session-derived keys.

4. **Native crypto libs invisible to Frida** — On x86_64 emulator with ARM64 NDK translation, `libezstreamclient.so` and `libmbedcrypto.so` don't appear in `Process.enumerateModules()`. Cannot hook native AES functions directly.

## Data Format

### Packet structure (after 12B Hik-RTP + 13B sub-header)
```
Plaintext NALs:     40 01 ... (VPS, type 32)
                    42 01 ... (SPS, type 33)
                    44 01 ... (PPS, type 34)
Length-prefixed:    00 NN 00 LL [data]

Encrypted I-frame:  62 01 [1362B payload] × N packets (N≈231 for 4K I-frame)
Encrypted P-frame:  52 52 / 55 55 / dd dd / etc. [payload] × M packets
```

### Key observations
- ALL encrypted I-frame packets start with `0x62 0x01` (2308 out of 3703 total)
- The `0x62` byte is CONSTANT across all I-frame packets — can't be AES-ECB ciphertext (would differ per block)
- `0x62 0x01` = H.265 NAL type 49 (UNSPEC) — Hikvision uses this as "encrypted slice" marker
- P-frame encrypted markers: various byte pairs (0x5252, 0x5555, 0xdddd, etc.)
- Each fragment is exactly 1364 bytes (1362 body + 2 header)
- Sub-header byte 4 increments sequentially (fragment counter within frame)

## Decryption Attempts

| Approach | Key | Result |
|----------|-----|--------|
| AES-128-ECB per NAL | MD5("ABCDEF") | Random NAL types (uniform distribution) |
| AES-128-ECB per NAL | SHA256("ABCDEF")[0:16] | ~64% valid types (near random) |
| AES-128-ECB skip 2B | MD5("ABCDEF") | PPS id out of range errors |
| AES-128-ECB reassembled | MD5("ABCDEF") | First block → NAL type 9 (AUD, valid!) but rest invalid |
| AES-128-CBC with Hik IV | MD5("ABCDEF") | First block → NAL type 17 (valid range) but rest invalid |
| XOR with MD5("ABCDEF") | MD5("ABCDEF") | NAL type 13 |
| AES-128-ECB | "ABCDEF\0..." padded | NAL type 8 |

### Most promising: AES-128-ECB on reassembled frame body (after stripping 0x6201 from each fragment)
- First 16-byte block decrypts to NAL type 9 (AUD) — this IS a valid start of a frame
- But subsequent blocks produce invalid data → wrong approach or wrong reassembly

## What We Don't Know

1. **Exact encryption boundary** — Does encryption start at the NAL body (after 2B header), at a specific offset, or on the full concatenated data?
2. **Is it partial encryption?** — Hikvision may only encrypt the first N bytes of each frame (a common optimization for video)
3. **Fragment reassembly order** — We assume sequential concatenation by sub-header counter, but maybe there's a different ordering
4. **AES mode** — ECB, CBC, CTR, or something custom?
5. **Whether the encrypted marker bytes (0x62, 0x52, etc.) encode the original NAL type** — `0x62 XOR 0x60 = 0x02` (TRAIL_R)... coincidence?

## Next Steps

1. **ARM64 emulator or physical device** — Would allow Frida to hook native `libezstreamclient.so` AES functions and capture the actual key + algorithm + block boundaries
2. **Ghidra the ARM64 .so** — Extract `libezstreamclient.so` from APK, decompile the decryption function
3. **iVMS-4200 Windows Frida** — Hook `ecdhCryption.dll` on Windows (x86 native, no translation issues)
4. **MITM + comparison** — If we could get decoded frames from the app AND our encrypted stream simultaneously, byte-level diff would reveal the exact transformation
