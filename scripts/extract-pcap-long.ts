/**
 * Extract ~1 min of H.265 video from the long pcap capture.
 * Produces /tmp/pcap-long-video.h265 → /tmp/pcap-long-video.mp4
 *
 * Usage: npx tsx scripts/extract-pcap-long.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp.js'

const PCAP_PATH = 'scripts/frida/stream-long.pcap'
const HEX_TMP = '/tmp/pcap-long-hex.txt'
const H265_PATH = '/tmp/pcap-long-video.h265'
const MP4_PATH = '/tmp/pcap-long-video.mp4'

// Step 1: Extract UDP payloads from device (port 17193)
console.log('Extracting UDP payloads from pcap...')
execSync(
  `tshark -r ${PCAP_PATH} -Y "udp.srcport == 17193 && data.len > 20" -T fields -e data > ${HEX_TMP} 2>/dev/null`
)
const hex = readFileSync(HEX_TMP, 'utf-8').trim()
const payloads = hex.split('\n').filter(Boolean).map(line => Buffer.from(line, 'hex'))
console.log(`${payloads.length} UDP payloads extracted`)

// Step 2: Feed to HikRtpExtractor
const extractor = new HikRtpExtractor()
const nalUnits: Buffer[] = []
extractor.on('nalUnit', (data: Buffer) => nalUnits.push(data))
for (const payload of payloads) extractor.processPacket(payload)
extractor.flush()

// NAL type stats
const nalTypes = new Map<number, number>()
for (const nal of nalUnits) {
  if (nal.length < 5) continue
  const nalType = (nal[4] >> 1) & 0x3f
  nalTypes.set(nalType, (nalTypes.get(nalType) ?? 0) + 1)
}
const names: Record<number, string> = {
  0: 'TRAIL_N', 1: 'TRAIL_R', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
  32: 'VPS', 33: 'SPS', 34: 'PPS',
}
console.log(`\n${nalUnits.length} NAL units extracted`)
console.log('NAL types:', Object.fromEntries(
  [...nalTypes.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => [`${t}(${names[t] ?? '?'})`, c])
))

const idrCount = nalTypes.get(19) ?? nalTypes.get(20) ?? 0
const trailCount = nalTypes.get(1) ?? 0
console.log(`\nKeyframes (IDR): ${idrCount}`)
console.log(`Inter frames (TRAIL_R): ${trailCount}`)
console.log(`Estimated duration @ 25fps: ${((idrCount + trailCount) / 25).toFixed(1)}s`)

// Step 3: Write Annex B stream
const annexB = Buffer.concat(nalUnits)
writeFileSync(H265_PATH, annexB)
console.log(`\nWrote ${(annexB.length / 1024 / 1024).toFixed(2)}MB H.265 to ${H265_PATH}`)

// Step 4: Convert to MP4 (copy, no re-encode)
console.log('\nConverting to MP4...')
try {
  const out = execSync(
    `ffmpeg -y -f hevc -i ${H265_PATH} -c:v copy ${MP4_PATH} 2>&1`,
    { timeout: 30000 }
  ).toString()

  const streamLine = out.split('\n').find(l => l.includes('Video:'))
  if (streamLine) console.log('Codec:', streamLine.trim())

  const timeLine = out.split('\n').find(l => l.includes('time='))
  if (timeLine) console.log('Duration:', timeLine.trim())

  // Step 5: Extract first + last frame for visual comparison
  console.log('\nExtracting first and last frames...')
  execSync(`ffmpeg -y -i ${MP4_PATH} -frames:v 1 -f image2 /tmp/pcap-long-first.png 2>/dev/null`, { timeout: 15000 })
  execSync(`ffmpeg -y -sseof -1 -i ${MP4_PATH} -frames:v 1 -f image2 /tmp/pcap-long-last.png 2>/dev/null`, { timeout: 15000 })

  const firstSize = readFileSync('/tmp/pcap-long-first.png').length
  const lastSize = readFileSync('/tmp/pcap-long-last.png').length
  console.log(`First frame: ${(firstSize / 1024).toFixed(1)}KB`)
  console.log(`Last frame:  ${(lastSize / 1024).toFixed(1)}KB`)

  // Get actual duration via ffprobe
  const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${MP4_PATH} 2>/dev/null`).toString().trim()
  console.log(`\nActual video duration: ${parseFloat(durationStr).toFixed(2)} seconds`)

  if (parseFloat(durationStr) >= 60) {
    console.log('\n✓ SUCCESS: Video is 1+ minutes long!')
  } else {
    console.log(`\n⚠ Video is ${parseFloat(durationStr).toFixed(1)}s — need 60s for 1 minute`)
  }
} catch (e: any) {
  console.error('FFmpeg error:', e.stderr?.toString() || e.message)
}
