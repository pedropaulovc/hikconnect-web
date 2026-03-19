/**
 * Extract video from the Android app's pcap capture and decode a frame.
 * Proves the pcap contains valid, decodable video data.
 *
 * Usage: npx tsx scripts/extract-pcap-video.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp.js'

const PCAP_PATH = 'scripts/frida/stream-capture.pcap'

// --- Step 1: Extract UDP payloads using tshark → temp file (avoids ENOBUFS) ---

function extractPayloads(): Buffer[] {
  const tmpHex = '/tmp/pcap-hex-payloads.txt'
  execSync(
    `tshark -r ${PCAP_PATH} -Y "udp.srcport == 17193 && data.len > 20" -T fields -e data > ${tmpHex} 2>/dev/null`
  )
  const hex = readFileSync(tmpHex, 'utf-8').trim()
  return hex.split('\n').filter(Boolean).map(line => Buffer.from(line, 'hex'))
}

// Remove unused variable warning
void extractPayloads

// --- Main ---

const payloads = extractPayloads()
console.log(`Extracted ${payloads.length} UDP payloads from device`)

// Show packet type distribution
const typeCounts = new Map<string, number>()
for (const p of payloads) {
  if (p.length < 2) continue
  const t = `0x${p.readUInt16BE(0).toString(16).padStart(4, '0')}`
  typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
}
console.log('Packet types:', Object.fromEntries([...typeCounts.entries()].sort((a, b) => b[1] - a[1])))

// --- Step 2: Feed to HikRtpExtractor ---

const extractor = new HikRtpExtractor()
const nalUnits: Buffer[] = []

extractor.on('nalUnit', (data: Buffer) => {
  nalUnits.push(data)
})

for (const payload of payloads) {
  extractor.processPacket(payload)
}
extractor.flush()

console.log(`\nExtracted ${nalUnits.length} NAL units`)

// Show NAL type distribution
const nalTypes = new Map<number, number>()
for (const nal of nalUnits) {
  if (nal.length < 5) continue // skip start code check
  const nalType = (nal[4] >> 1) & 0x3f
  nalTypes.set(nalType, (nalTypes.get(nalType) ?? 0) + 1)
}
console.log('NAL types:', Object.fromEntries(
  [...nalTypes.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => {
    const names: Record<number, string> = {
      0: 'TRAIL_N', 1: 'TRAIL_R', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
      32: 'VPS', 33: 'SPS', 34: 'PPS',
    }
    return [`${t}(${names[t] ?? '?'})`, c]
  })
))

// --- Step 3: Write H.265 Annex B stream ---

const h265Path = '/tmp/pcap-video.h265'
const annexB = Buffer.concat(nalUnits)
writeFileSync(h265Path, annexB)
console.log(`\nWrote ${(annexB.length / 1024).toFixed(1)}KB H.265 stream to ${h265Path}`)

// --- Step 4: Decode first frame with FFmpeg ---

const framePath = '/tmp/pcap-frame.png'
try {
  const ffmpegOut = execSync(
    `ffmpeg -y -i ${h265Path} -frames:v 1 -f image2 ${framePath} 2>&1`,
    { timeout: 10000 }
  ).toString()

  // Extract codec info
  const streamLine = ffmpegOut.split('\n').find(l => l.includes('Video:'))
  if (streamLine) console.log('\nFFmpeg detected:', streamLine.trim())

  console.log(`\nDecoded frame saved to ${framePath}`)
  const frameSize = readFileSync(framePath).length
  console.log(`Frame size: ${(frameSize / 1024).toFixed(1)}KB`)

  if (frameSize > 5000) {
    console.log('\n✓ Frame is non-trivial size — likely contains real video content')
  } else {
    console.log('\n⚠ Frame is very small — may be blank/corrupted')
  }
} catch (e: any) {
  console.error('\nFFmpeg error:', e.stderr?.toString() || e.message)
}
