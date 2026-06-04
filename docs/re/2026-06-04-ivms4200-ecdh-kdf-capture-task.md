# TASK: Capture ECDH KDF test vectors from iVMS-4200 on Windows (Frida)

**For:** a separate Claude Code instance running on a **Windows** host with iVMS-4200 installed.
**Created:** 2026-06-04 (handoff from the Linux/WSL dev host — you do NOT share its chat context, so this doc is self-contained).
**Status:** NOT STARTED.

---

## 1. One-paragraph objective

The relay and VTM streaming paths in this project are blocked on **one unknown**: the custom
**key-derivation function (KDF)** that turns the ECDH P-256 shared secret into the session key used
to encrypt the relay/VTM connection request (`ClnConnectReq`). We have the function decompiled in
Ghidra but cannot reproduce it without **test vectors**. Your job is to run iVMS-4200 on Windows,
hook `ecdhCryption.dll` with Frida, force it through an ECDH handshake, and **capture the
inputs→outputs of every stage** so we can byte-match a TypeScript reimplementation against ground
truth. You are NOT implementing the KDF in TS — you are producing the vectors that let the Linux
side implement and verify it.

## 2. Why this matters (context you won't otherwise have)

- This project (`hikconnect-web`) streams Hikvision NVR video via the Hik-Connect cloud.
- The **direct P2P/UDP path works** (hole-punching) but requires a non-SNAT public-IP host — i.e. a
  full VM, which we want to stop paying for.
- The **relay/VTM path is TCP outbound only** → it would run on any serverless/managed host. It is
  the unlock for cheap deployment. It is fully reverse-engineered EXCEPT the ECDH session-key crypto.
- Per `CRelayClient::SendClnConnectReq`: **if the relay/VTM server presents a public key, ECDH is
  REQUIRED**, and the server closes the connection if `ClnConnectReq`'s body isn't encrypted with the
  derived session key. We currently get **relay error `0x2715`** (or an immediate socket close).
- The Android app could NOT be used to capture this: the test NVR (L38239367) has `udpEcdh=0` and an
  all-zero `vtduServerPublicKey`, so the Android native path never triggers ECDH. **iVMS-4200's relay
  path is server-driven** — it does ECDH whenever the *relay/VTM server* offers a public key,
  independent of the device flag. That's why this task targets iVMS-4200, not the phone.

## 3. The crypto we need vectors for (from `ecdhCryption.dll` Ghidra RE)

Three stages. Stage 1 is standard; stages 2–3 are the unknowns.

| Stage | Ghidra fn (from our DB) | What it does | Known? |
|-------|------------------------|--------------|--------|
| `GenerateMasterKey` | `FUN_180002130` | Standard ECDH P-256 (secp256r1): client priv × server pub → 32-byte shared secret. | ✅ |
| `GenerateSessionKey` (**KDF**) | `FUN_180016e00` | Counter-mode KDF. Increments counter at `ctx+0x0F`, calls block fn `FUN_180009cd0` per 16-byte block, emits 32 bytes of key material. Looks like NIST SP 800-108 counter mode but on a **custom Matyas-Meyer-Oseas hash + SHA-256 DRBG**. | ❌ **PRIMARY TARGET** |
| Block fn | `FUN_180009cd0` | The per-16-byte AES/HMAC primitive the KDF calls. | ❌ |
| Init / cipher select | `FUN_180011fa0` | Sets which body cipher is used (switch types 3–9: AES-128/256 ECB/CBC, ChaCha20, or AES-GCM — exact one unknown). | ❌ |
| `EncECDHReqPackage` | `FUN_180002b30` | Builds + encrypts the request packet (format below). | partial |

> ⚠️ **Addresses are from OUR Ghidra DB of a specific `ecdhCryption.dll` build.** Your installed
> iVMS-4200 may differ. ALWAYS verify by signature/xref, not raw address. If your DLL differs,
> first confirm the same functions exist (search for the P-256 curve constants, the `0x24 '$'`
> packet magic, SPKI/DER pubkey handling) and record the mapping in your output.

**`EncECDHReqPackage` packet format (for sanity-checking your captures):**
```
Byte 0:      0x24 ('$') magic
Byte 1:      0x01 (version)
Byte 2:      0x00
Byte 3-4:    body_length (2B BE)
Byte 5:      0x01
Byte 6:      channel_id (1 byte)
Byte 7-10:   sequence (4B BE, starts at 1)
Byte 11-42:  AES-encrypted shared secret (32B, encrypted with session key)
Byte 43-133: client ECDH public key (91B SPKI/DER)
Byte 134+:   encrypted body payload (if body_length > 0)
Last 32B:    HMAC-SHA256 over CRC of body + header
```
Fixed overhead = 11 + 32 + 91 + 32 = 166 bytes.

## 4. The test-vector "triple" we need

For at least **3 independent ECDH sessions** (different ephemeral keys), capture a complete chain so
each stage can be verified in isolation:

1. **client ECDH private key** (PEM/DER, the ephemeral) and **client public key** (91B SPKI/DER)
2. **server public key** (91B SPKI/DER) presented by the relay/VTM
3. **shared secret** (32B) out of `GenerateMasterKey`  ← validates Stage 1
4. **session key** (32B) out of `GenerateSessionKey`  ← **the KDF ground truth**
5. any **KDF context/counter/label/salt bytes** read inside `FUN_180016e00` / passed to `FUN_180009cd0`
6. the **plaintext body** of `ClnConnectReq` and the resulting **ciphertext** (+ which cipher/IV/HMAC)  ← validates Stage 3
7. the full **on-wire packet** bytes from `EncECDHReqPackage`

Multiple sessions are required so we can tell fixed constants (labels, IV, salt) apart from
per-session values (keys, secrets).

## 5. Environment setup (Windows)

1. **iVMS-4200** installed and logged into the **same Hik-Connect account** this project uses
   (creds in the Linux repo's `.env.local` — ask the user to provide them; do NOT assume).
2. **Frida** for Windows: `pip install frida-tools` (use a venv). Confirm `frida-ps -W` lists
   `iVMS-4200.exe`-related processes.
3. Identify the process that loads `ecdhCryption.dll` (likely the streaming/preview child process,
   not the main UI). Use Process Explorer or `frida-ps` + module enumeration to find which PID has
   `ecdhCryption.dll` loaded. Also note `OpenNetStream.dll` (the relay/VTM client lives there).
4. Have **Ghidra** available if you need to re-derive addresses for your DLL build (optional but
   recommended). The corresponding decompiled notes live in `docs/re/protocol-notes.md` §"ECDH
   Protocol" and `docs/re/crypto-analysis.md`.

## 6. Forcing an ECDH handshake (the hard part)

ECDH only fires when iVMS-4200 connects through a **relay/VTM** that presents a server public key.
To guarantee that path instead of direct/P2P:

- Add a camera/NVR to iVMS-4200 via **Hik-Connect (cloud P2P)**, NOT by direct IP.
- Force the relay fallback: **block the device's direct + UDP P2P** so iVMS must use the TCP relay.
  Options, try in order:
  - Windows Firewall: block outbound UDP to the device's stream ports / the STUN+P2P servers, leaving
    TCP to the VTM relay (`148.153.53.29:8554`) open.
  - Or connect over a network where inbound UDP hole-punching fails (e.g. symmetric-NAT / restricted
    Wi-Fi), which pushes iVMS to relay.
- Confirm you're on the relay path: you should see iVMS connect TCP to the VTM/relay IP and
  `GenerateMasterKey` get hit. If `FUN_180002130` never fires, ECDH isn't being triggered — the
  server isn't presenting a public key on that path; revisit the firewall rules.

> If you genuinely cannot trigger ECDH against the live relay, fall back to **hooking
> `EncECDHReqPackage` and `GenerateSessionKey` purely as a unit test**: synthesize calls is not
> possible from Frida easily, so instead just capture whatever sessions DO occur (even non-streaming
> control connections may do the handshake). Document what you could and couldn't trigger.

## 7. What to write (Frida script)

Write a Frida JS script (model it on the project's existing hooks in `scripts/frida/` —
`hook-ecdh-dump.js`, `hook-ecdh-keys.js` — which you can read in the repo for style; they target the
Android `.so` but the Interceptor patterns transfer). For the Windows DLL:

- Resolve the base of `ecdhCryption.dll` via `Process.getModuleByName('ecdhCryption.dll').base` and
  add the RVA (Ghidra address − image base `0x180000000`) to get the runtime address. **Verify** each
  hook landed on the right function (log first bytes / a known string xref).
- `Interceptor.attach` each target:
  - `GenerateMasterKey` (`FUN_180002130`): on enter, dump the server-pubkey arg + client-priv; on
    leave, dump the 32B shared-secret output buffer.
  - `GenerateSessionKey` (`FUN_180016e00`): on enter, dump the context struct (esp. `ctx+0x0F`
    counter, any label/salt pointers); on leave, dump the 32B session key. Also log every call into
    `FUN_180009cd0` with its in/out 16B blocks (attach separately and correlate by thread+time).
  - `FUN_180011fa0`: dump the selected cipher type (the switch discriminant) so we know which
    algorithm decrypts the body.
  - `EncECDHReqPackage` (`FUN_180002b30`): on leave, dump the full output packet; on enter, dump the
    plaintext body if reachable.
- Hexdump buffers with `hexdump(ptr, {length: N})`. Tag every line with a **session id** (increment a
  JS counter each time `GenerateMasterKey` enters) so the triple can be reassembled.
- Write captures to a file (Frida `File` API) AND stdout.

## 8. Output / deliverables (what to hand back to the Linux repo)

Produce these and commit them (or hand to the user to commit) into the repo:

1. **`scripts/frida/hook-ecdh-ivms-windows.js`** — the working Frida script.
2. **`docs/re/ecdh-kdf-vectors.md`** — the captured test vectors: for each of ≥3 sessions, the full
   triple from §4 as labeled hex. This is the deliverable that unblocks the KDF.
3. **Update `docs/re/2026-06-04-ivms4200-ecdh-kdf-capture-task.md`** (this file) status section with:
   what worked, the runtime address↔Ghidra mapping for your DLL build, the resolved **cipher type**
   from `FUN_180011fa0`, and any KDF constants (label/salt/IV) you observed.
4. If you got far enough: a one-line statement of the KDF construction (e.g. "SP 800-108 counter mode,
   PRF = HMAC-SHA256, label=…, no salt, counter starts at 1, 2 blocks") — but **raw vectors are the
   priority**; the Linux side will derive the construction from them.

## 9. Success criteria

- ≥3 complete session triples captured (client priv/pub, server pub, shared secret, session key,
  plaintext+ciphertext body, full packet).
- The shared secret reproduces from (client priv, server pub) via standard ECDH P-256 — confirms you
  hooked the right function and the inputs are clean.
- The body cipher type is identified.
- Everything written to `docs/re/ecdh-kdf-vectors.md` in the repo.

When done, the Linux side will: reimplement `GenerateSessionKey` in TS, assert it reproduces your
captured session keys byte-for-byte, wire it into `src/lib/p2p/relay-client.ts` /
`vtm-client.ts`, and verify the relay stops returning `0x2715`.

## 10. Pointers into the repo

- `docs/re/protocol-notes.md` §"ECDH Protocol (from ecdhCryption.dll Ghidra RE)" — function table,
  packet format, master-key/session-key flow.
- `docs/re/crypto-analysis.md` — crypto algorithm notes from RE.
- `docs/re/ecdh-frida-capture.md` — the 2026-03-18 Android capture (why ECDH was disabled there +
  full Java API surface: `NativeApi.generateECDHKey/setClientECDHKey/enableStreamClientCMDEcdh`,
  `EZEcdhKeyInfo`/`EcdhKeyInfo` struct layouts).
- `docs/re/deferred-work.md` item 15 — the blocker entry this task closes.
- `scripts/frida/hook-ecdh-*.js` — existing Frida hook style to copy.
- `src/lib/p2p/relay-client.ts`, `src/lib/p2p/vtm-client.ts` — the consumers that need the session key.
