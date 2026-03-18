# Verify and Complete Streaming — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Get live preview and playback working in the browser via P2P (primary) and VTM (fallback).

**Architecture:** Verify-first approach. Confirm P2P output visually before deeper RE. If video is already playable, skip to VTM ECDH. If corrupted, use Frida side-by-side capture to debug.

**Tech Stack:** Node.js, TypeScript, FFmpeg, SRT, ECDH P-256, Frida, Ghidra, hcloud VPS

---

## High-Level Spec

> From [design doc](2026-03-18-verify-and-complete-streaming.md).

- **Phase 1:** VPS deploy → visual verify .ts segment → decision gate
- **Phase 2:** ECDH KDF for VTM/relay (Wireshark test vectors → Ghidra reimpl)
- **Phase 3:** Production hardening (teardown, userId, clientId, multi-channel)

---

## Task 1: Enhance test script to save raw data + downloadable segment

**Files:**
- Modify: `scripts/test-p2p-to-ffmpeg.ts`

The current script runs FFmpeg with `-hls_flags delete_segments` which can remove segments before we download them. We also need raw SRT data saved for debugging if video is corrupted.

**Step 1: Modify test script to save raw data and keep all segments**

Replace the FFmpeg args and add raw data dump in `scripts/test-p2p-to-ffmpeg.ts`:

```typescript
// After line 16 (import { spawn } from 'child_process'), add:
import { createWriteStream } from 'fs'

// After line 71 (mkdirSync), add:
const rawDump = createWriteStream('/tmp/raw-srt-packets.bin')

// In the p2pSession.on('data') handler (line 102), add raw dump:
p2pSession.on('data', (payload: Buffer) => {
  // Write length-prefixed raw packet for later analysis
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(payload.length, 0)
  rawDump.write(lenBuf)
  rawDump.write(payload)
  extractor.processPacket(payload)
})

// Change FFmpeg args: remove delete_segments, add -hls_list_size 0 to keep all
const ffmpeg = spawn('ffmpeg', [
  '-f', 'hevc',
  '-i', 'pipe:0',
  '-c:v', 'copy',
  '-f', 'hls',
  '-hls_time', '2',
  '-hls_list_size', '0',  // keep ALL segments
  `${hlsDir}/stream.m3u8`,
], { stdio: ['pipe', 'pipe', 'pipe'] })

// Before process.exit (line 138), close raw dump:
rawDump.end()
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/test-p2p-to-ffmpeg.ts
git commit -m "feat: save raw SRT packets + keep all HLS segments for debugging"
```

---

## Task 2: Enhance pipeline script to download and verify segments

**Files:**
- Modify: `scripts/test-full-pipeline.sh`

Add steps to download the first .ts segment and a few frames of raw data for local analysis.

**Step 1: Add segment download to pipeline script**

After the results section (line 36) in `scripts/test-full-pipeline.sh`, add:

```bash
# 6. Download first segment + raw data for local analysis
echo ""
echo "[6/7] Downloading segment for visual verification..."
mkdir -p /tmp/hls-verify
FIRST_SEG=$(ssh root@$IP 'ls /tmp/hls-output/stream*.ts 2>/dev/null | head -1')
if [ -n "$FIRST_SEG" ]; then
  scp -o StrictHostKeyChecking=no root@$IP:"$FIRST_SEG" /tmp/hls-verify/segment.ts
  scp -o StrictHostKeyChecking=no root@$IP:/tmp/raw-srt-packets.bin /tmp/hls-verify/ 2>/dev/null || true
  echo "Downloaded to /tmp/hls-verify/"
  echo "Verify: ffplay /tmp/hls-verify/segment.ts"
  echo "Probe:  ffprobe -show_frames /tmp/hls-verify/segment.ts 2>/dev/null | head -40"
else
  echo "No segments found!"
fi

# 7. Cleanup (renumber from 6)
echo ""
echo "[7/7] Cleaning up..."
```

Update the cleanup step number accordingly.

**Step 2: Commit**

```bash
git add scripts/test-full-pipeline.sh
git commit -m "feat: download HLS segment + raw data for visual verification"
```

---

## Task 3: Deploy to VPS and visually verify video output

**Files:**
- No code changes — operational task

**Step 1: Run the full pipeline**

```bash
./scripts/test-full-pipeline.sh
```

Wait for completion (~2 minutes: VPS creation + boot + install + 45s capture + cleanup).

**Step 2: Verify the downloaded segment**

```bash
# Play the segment
ffplay /tmp/hls-verify/segment.ts

# Or take a screenshot frame
ffmpeg -i /tmp/hls-verify/segment.ts -vframes 1 -f image2 /tmp/hls-verify/frame.png
```

**Step 3: Compare with reference**

Open `/tmp/hls-verify/frame.png` side-by-side with `docs/re/reference-frames/lobby-live-android-2026-03-18.png`.

**Decision gate:**
- If frame shows recognizable Lobby camera image → **video works, skip to Task 6**
- If frame is gray/green/garbled → **continue to Task 4 (debug)**

**Step 4: Save result frame as evidence**

```bash
cp /tmp/hls-verify/frame.png docs/re/reference-frames/p2p-pipeline-output-2026-03-18.png
git add docs/re/reference-frames/
git commit -m "docs: add P2P pipeline output frame for comparison"
```

---

## Task 4: Debug corrupted video with Frida side-by-side capture (CONDITIONAL — only if Task 3 shows garbled output)

**Files:**
- Modify: `scripts/frida/hook-extract-frames.js` (may need updates)
- Create: `scripts/compare-frames.ts`

**Step 1: Capture raw frames from Android app via Frida**

On the host machine, with Android emulator running Hik-Connect:

```bash
# Find PID
adb shell pidof com.connect.enduser

# Create named pipe on emulator
adb shell mkfifo /data/local/tmp/video_pipe 2>/dev/null || true

# Start Frida hook
frida -U -p <PID> -l scripts/frida/hook-extract-frames.js

# In another terminal, pull the captured data
adb shell cat /data/local/tmp/video_pipe > /tmp/frida-frames.bin &

# Wait for Lobby stream to run ~10 seconds in the app, then Ctrl+C
```

**Step 2: Write comparison script**

Create `scripts/compare-frames.ts`:

```typescript
/**
 * Compare raw SRT packets from our pipeline vs Frida-captured frames.
 * Usage: npx tsx scripts/compare-frames.ts /tmp/hls-verify/raw-srt-packets.bin /tmp/frida-frames.bin
 */
import { readFileSync } from 'fs'

const [, , ourFile, fridaFile] = process.argv
if (!ourFile || !fridaFile) {
  console.log('Usage: npx tsx scripts/compare-frames.ts <our-raw.bin> <frida-frames.bin>')
  process.exit(1)
}

const ourData = readFileSync(ourFile)
const fridaData = readFileSync(fridaFile)

console.log(`Our raw data: ${ourData.length} bytes`)
console.log(`Frida data:   ${fridaData.length} bytes`)

// Parse our length-prefixed packets
const ourPackets: Buffer[] = []
let offset = 0
while (offset + 4 <= ourData.length) {
  const len = ourData.readUInt32BE(offset)
  if (offset + 4 + len > ourData.length) break
  ourPackets.push(ourData.subarray(offset + 4, offset + 4 + len))
  offset += 4 + len
}
console.log(`Our packets: ${ourPackets.length}`)

// Show first 5 packets hex dump (first 64 bytes each)
for (let i = 0; i < Math.min(5, ourPackets.length); i++) {
  const pkt = ourPackets[i]
  const type = pkt.readUInt16BE(0)
  console.log(`\nPacket ${i}: type=0x${type.toString(16)} len=${pkt.length}`)
  console.log('  ' + pkt.subarray(0, Math.min(64, pkt.length)).toString('hex'))
}

// Show first 256 bytes of Frida data
console.log(`\nFrida first 256 bytes:`)
console.log(fridaData.subarray(0, Math.min(256, fridaData.length)).toString('hex'))
```

**Step 3: Run comparison**

```bash
npx tsx scripts/compare-frames.ts /tmp/hls-verify/raw-srt-packets.bin /tmp/frida-frames.bin
```

Analyze: Are the payloads identical (parsing bug) or different (encryption)?

**Step 4: If encrypted — hook decryption key**

If the data differs and Frida frames are plaintext H.265 while ours look like ciphertext, add a Frida hook for the decryption function:

```javascript
// Add to hook-extract-frames.js:
// Hook the native decrypt function to capture the key
Interceptor.attach(Module.findExportByName("libStreamSDK.so", "AES_set_decrypt_key"), {
  onEnter: function(args) {
    console.log("[AES] decrypt key: " + hexdump(args[0], { length: 16 }));
  }
});
```

**Step 5: Commit**

```bash
git add scripts/compare-frames.ts scripts/frida/hook-extract-frames.js
git commit -m "feat: add frame comparison tool + decryption key hook"
```

---

## Task 5: Fix video extraction based on debug findings (CONDITIONAL — only if Task 4 reveals a bug)

**Files:**
- Modify: `src/lib/p2p/hik-rtp.ts` (parsing fix or add decryption)

This task depends entirely on what Task 4 reveals. Possible fixes:

**If parsing bug:** Fix offsets/header detection in `HikRtpExtractor.processPacket()`.

**If encryption with session key:** Add decryption using the key captured in Task 4:
```typescript
// In HikRtpExtractor constructor, accept a decryption key
constructor(private decryptKey?: Buffer) { super() }

// In processNalUnit, decrypt slice data before emitting
private processNalUnit(data: Buffer): void {
  if (this.decryptKey && nalType >= 0 && nalType <= 21) {
    data = this.decryptSlice(data, this.decryptKey)
  }
  // ... rest of existing logic
}
```

**Step 1: Write failing test reproducing the bug**
**Step 2: Implement fix**
**Step 3: Run tests to verify**
**Step 4: Re-deploy to VPS and verify visually**
**Step 5: Commit**

---

## Task 6: Add P2P TEARDOWN for clean session release

**Files:**
- Modify: `src/lib/p2p/p2p-session.ts:149-172` (stop method)
- Modify: `src/lib/p2p/v3-protocol.ts` (add TEARDOWN opcode if missing)
- Test: `src/lib/p2p/__tests__/p2p-session.test.ts`

**Step 1: Verify TEARDOWN opcode exists**

Check `src/lib/p2p/v3-protocol.ts` for opcode `0x0C04`. From `docs/re/v3-protocol-opcodes.md`:
```
0x0C04 | TEARDOWN | Attrs: 0x05 (session key), 0x76 (busType), 0x77 (channelNo), 0x78 (streamType), 0x84 (device session)
```

**Step 2: Add TEARDOWN to P2PSession.stop()**

In `src/lib/p2p/p2p-session.ts`, modify the `stop()` method to send TEARDOWN before SRT shutdown:

```typescript
stop(): void {
  if (this.state === 'stopped') return

  // Send P2P TEARDOWN (0x0C04) to release server-side session
  if (this.deviceSessionId) {
    try { this.sendTeardown() } catch {}
  }

  // Send SRT shutdown to cleanly release the device's stream slot
  if (this.srtPeerSocketId) {
    const shutdown = Buffer.alloc(16)
    shutdown.writeUInt16BE(0x8005, 0)
    shutdown.writeUInt16BE(0, 2)
    shutdown.writeUInt32BE(0, 4)
    shutdown.writeUInt32BE(timestamp32(), 8)
    shutdown.writeUInt32BE(this.srtPeerSocketId, 12)
    try { this.sendToDevice(shutdown) } catch {}
  }

  this.stopSrtAckTimer()
  if (this.keepaliveInterval) {
    clearInterval(this.keepaliveInterval)
    this.keepaliveInterval = null
  }

  this.socket?.close()
  this.socket = null
  this.transition('stopped')
}

private sendTeardown(): void {
  // TEARDOWN body TLVs (from v3-protocol-opcodes.md)
  const body = Buffer.concat([
    encodeTlv(0x05, Buffer.from(this.sessionKey, 'ascii')),  // sessionKey
    encodeTlv(0x76, Buffer.from([this.config.busType ?? 1])), // busType
    encodeTlv(0x77, encodeUint16BE(this.config.channelNo)),   // channelNo
    encodeTlv(0x78, Buffer.from([this.config.streamType])),   // streamType
    encodeTlv(0x84, encodeUint32BE(this.deviceSessionId!)),   // deviceSessionId
  ])

  // Send as TRANSFOR_DATA (0x0B04) wrapping TEARDOWN (0x0C04)
  // Same dual-path as PLAY_REQUEST
  const innerMsg = this.buildInnerV3(0x0C04, body)
  this.sendTransforData(innerMsg)
}
```

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: All pass (no existing teardown tests to break)

**Step 4: Commit**

```bash
git add src/lib/p2p/p2p-session.ts
git commit -m "feat: send P2P TEARDOWN (0x0C04) on stop for clean session release"
```

---

## Task 7: Extract userId from session JWT

**Files:**
- Modify: `src/lib/hikconnect/client.ts` (add userId extraction)
- Modify: `src/app/api/stream/start/route.ts` (use extracted userId)
- Modify: `src/app/api/stream/playback/route.ts` (use extracted userId)
- Test: `src/lib/hikconnect/__tests__/client.test.ts`

**Step 1: Write failing test for userId extraction**

```typescript
it('extracts userId from session JWT', () => {
  // JWT payload: { aud: "fcfaec90a55f4a61b4e7211152a2d805", ... }
  const fakeJwt = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    + '.' + Buffer.from(JSON.stringify({ aud: 'fcfaec90a55f4a61b4e7211152a2d805' })).toString('base64url')
    + '.signature'
  expect(extractUserId(fakeJwt)).toBe('fcfaec90a55f4a61b4e7211152a2d805')
})
```

**Step 2: Implement userId extraction**

In `src/lib/hikconnect/client.ts`:

```typescript
export function extractUserId(sessionId: string): string {
  try {
    const payload = sessionId.split('.')[1]
    if (!payload) return ''
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return decoded.aud ?? ''
  } catch {
    return ''
  }
}
```

**Step 3: Run test**

Run: `npm test -- --run`
Expected: PASS

**Step 4: Wire into API routes**

In both `src/app/api/stream/start/route.ts` and `playback/route.ts`, replace:
```typescript
userId: '',
```
with:
```typescript
userId: extractUserId(client.getSession()!.sessionId),
```

**Step 5: Commit**

```bash
git add src/lib/hikconnect/client.ts src/app/api/stream/start/route.ts src/app/api/stream/playback/route.ts
git commit -m "feat: extract userId from session JWT aud claim"
```

---

## Task 8: Capture ECDH test vectors from iVMS-4200 via Wireshark

**Files:**
- Create: `docs/re/ecdh-test-vectors.md`

This is an RE/capture task, not a coding task.

**Step 1: Set up Wireshark capture**

On Windows (or VM) with iVMS-4200 installed:
```
1. Start Wireshark on the network interface
2. Filter: tcp.port == 8554 (VTM) or tcp.port == 6123 (relay)
3. Open iVMS-4200, connect to the NVR, start live preview
4. Stop capture after stream begins
```

**Step 2: Extract ECDH handshake packets**

From the TCP stream:
- **Client hello:** First packet after TCP handshake. Contains:
  - Byte 0: `0x24` magic
  - Bytes 11-42: encrypted shared secret (32B)
  - Bytes 43-133: client public key (91B SPKI)
  - Last 32B: HMAC
- **Server hello:** Server's response. Contains:
  - Server public key
  - Encrypted response body
  - HMAC

**Step 3: Document test vectors**

Save to `docs/re/ecdh-test-vectors.md`:
```markdown
# ECDH Test Vectors (from iVMS-4200 Wireshark capture)

## VTM Server (148.153.53.29:8554)

### Client Hello
Raw hex: <full packet hex>
- Client pubkey (bytes 43-133): <hex>
- Encrypted master (bytes 11-42): <hex>
- HMAC (last 32B): <hex>

### Server Hello
Raw hex: <full packet hex>
- Server pubkey: <hex>
- Response body: <hex>
- HMAC: <hex>

### Known Values
- Server public key (from API): MFkwEwYH...
- Shared secret (if capturable via Frida): <hex>
```

**Step 4: Commit**

```bash
git add docs/re/ecdh-test-vectors.md
git commit -m "docs: add ECDH test vectors from iVMS-4200 Wireshark capture"
```

---

## Task 9: Implement correct ECDH KDF from test vectors

**Files:**
- Modify: `src/lib/p2p/crypto.ts:110-124` (replace `ecdhDeriveSessionKey`)
- Test: `src/lib/p2p/__tests__/crypto-ecdh.test.ts`

**Step 1: Write failing test using captured test vectors**

In `src/lib/p2p/__tests__/crypto-ecdh.test.ts`, add:

```typescript
it('derives session key matching Wireshark capture', () => {
  // Values from docs/re/ecdh-test-vectors.md
  const sharedSecret = Buffer.from('<captured shared secret hex>', 'hex')
  const expectedEncryptedMaster = Buffer.from('<captured encrypted master hex>', 'hex')

  const sessionKey = ecdhDeriveSessionKey(sharedSecret, 32)

  // Encrypt 32 zero bytes with session key (AES-256-ECB)
  const cipher = createCipheriv('aes-256-ecb', sessionKey, null)
  cipher.setAutoPadding(false)
  const enc1 = cipher.update(Buffer.alloc(16))
  const cipher2 = createCipheriv('aes-256-ecb', sessionKey, null)
  cipher2.setAutoPadding(false)
  const enc2 = cipher2.update(Buffer.alloc(16))
  const encrypted = Buffer.concat([enc1, enc2])

  expect(encrypted).toEqual(expectedEncryptedMaster)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/crypto-ecdh.test.ts`
Expected: FAIL (current HKDF-based KDF produces wrong output)

**Step 3: Implement correct KDF**

Replace `ecdhDeriveSessionKey` in `src/lib/p2p/crypto.ts` with the implementation derived from Ghidra `FUN_180016730`. The exact implementation depends on the test vectors — possible approaches:
1. Counter-mode AES-256-ECB (already partially documented)
2. SHA-256 DRBG seeded with "ezviz-ecdh" + master key
3. HMAC-SHA256 based construction

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/crypto-ecdh.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/crypto.ts src/lib/p2p/__tests__/crypto-ecdh.test.ts
git commit -m "feat: implement correct ECDH KDF verified against Wireshark capture"
```

---

## Task 10: Wire ECDH into VTM client and verify streaming

**Files:**
- Modify: `src/lib/p2p/vtm-client.ts`
- Modify: `src/lib/p2p/relay-client.ts`
- Create: `scripts/test-vtm-stream.ts`

**Step 1: Update VTM client to use corrected ECDH**

The VTM client needs to:
1. TCP connect to VTM server
2. ECDH handshake (using corrected KDF from Task 9)
3. Send StreamInfoReq (protobuf)
4. Send StartStreamReq
5. Receive video data

**Step 2: Create VTM streaming test script**

Create `scripts/test-vtm-stream.ts`:

```typescript
/**
 * VTM streaming test — connects via relay, no VPS needed.
 * Usage: npx tsx scripts/test-vtm-stream.ts
 */
// Login → get VTM config → ECDH handshake → StreamInfoReq → video data
```

**Step 3: Run VTM test locally (no VPS needed)**

```bash
npx tsx scripts/test-vtm-stream.ts
```

Expected: ECDH handshake succeeds, StreamInfoReq accepted, video data flows.

**Step 4: Verify video output**

Pipe VTM video data through HikRtpExtractor → FFmpeg → .ts segment, compare with reference frame.

**Step 5: Commit**

```bash
git add src/lib/p2p/vtm-client.ts src/lib/p2p/relay-client.ts scripts/test-vtm-stream.ts
git commit -m "feat: VTM streaming with working ECDH — NAT-friendly path"
```

---

## Task 11: Multi-channel support in API routes

**Files:**
- Modify: `src/app/api/stream/start/route.ts`
- Modify: `src/app/api/stream/playback/route.ts`
- Modify: `src/app/page.tsx` (if UI exists for channel selection)

**Step 1: Verify channel param is already plumbed**

The API routes already accept `channel` from the request body and pass it as `channelNo`. Verify the UI sends it.

**Step 2: Test with channel 2**

```bash
curl -X POST http://localhost:3000/api/stream/start \
  -H 'Content-Type: application/json' \
  -d '{"deviceSerial":"L38239367","channel":2,"streamType":1}'
```

**Step 3: Commit (if changes needed)**

```bash
git commit -m "feat: multi-channel support in stream API"
```

---

## Task 12: Dual-path failover (P2P → VTM)

**Files:**
- Modify: `src/lib/p2p/live-stream.ts`
- Modify: `src/app/api/stream/start/route.ts`

**Step 1: Add path selection to LiveStreamConfig**

```typescript
export type StreamPath = 'p2p' | 'vtm' | 'auto'

export type LiveStreamConfig = {
  // ... existing fields
  streamPath?: StreamPath  // default: 'auto'
}
```

**Step 2: Implement auto failover in LiveStream.start()**

```typescript
async start(): Promise<string> {
  const path = this.config.streamPath ?? 'auto'

  if (path === 'p2p' || path === 'auto') {
    try {
      return await this.startP2P()
    } catch (err) {
      if (path === 'p2p') throw err
      console.log(`[LiveStream] P2P failed, falling back to VTM: ${err}`)
    }
  }

  return await this.startVTM()
}
```

**Step 3: Run tests**

Run: `npm test -- --run`

**Step 4: Commit**

```bash
git add src/lib/p2p/live-stream.ts src/app/api/stream/start/route.ts
git commit -m "feat: dual-path failover — P2P with VTM fallback"
```

---

## Task Summary

| Task | Description | Conditional | Depends On |
|------|------------|-------------|------------|
| 1 | Enhance test script (raw dump + keep segments) | No | — |
| 2 | Enhance pipeline script (download segment) | No | 1 |
| 3 | Deploy to VPS, visually verify | No | 2 |
| 4 | Debug with Frida side-by-side | If Task 3 fails | 3 |
| 5 | Fix video extraction | If Task 4 finds bug | 4 |
| 6 | P2P TEARDOWN for clean shutdown | No | — |
| 7 | Extract userId from JWT | No | — |
| 8 | Capture ECDH test vectors (Wireshark) | No | — |
| 9 | Implement correct ECDH KDF | No | 8 |
| 10 | Wire ECDH into VTM, verify streaming | No | 9 |
| 11 | Multi-channel support | No | — |
| 12 | Dual-path failover (P2P → VTM) | No | 10 |

**Parallelizable:** Tasks 1-3, 6, 7, 8 can all run in parallel. Tasks 6+7 are independent of the VPS verification path. Task 8 (Wireshark capture) is a manual RE task that can happen alongside VPS testing.
