#!/bin/bash
# One-shot full pipeline test: deploy to VPS, capture video, generate HLS, verify.
# Usage: ./scripts/test-full-pipeline.sh
# Requires: hcloud CLI configured, .env.local with credentials

set -e

echo "=== Hikvision P2P Full Pipeline Test ==="
echo ""

# 1. Create VPS
echo "[1/8] Creating VPS..."
IP=$(hcloud server create --name hikp2p --type cpx11 --location ash --image ubuntu-24.04 --ssh-key hikconnect 2>&1 | grep "IPv4" | awk '{print $2}')
echo "VPS IP: $IP"

# 2. Wait for boot
echo "[2/8] Waiting for VPS..."
sleep 25
ssh-keygen -f "$HOME/.ssh/known_hosts" -R "$IP" 2>/dev/null || true

# 3. Setup
echo "[3/8] Installing Node.js + FFmpeg..."
ssh -o StrictHostKeyChecking=no root@$IP 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs ffmpeg' >/dev/null 2>&1

echo "[4/8] Deploying code..."
rsync -az -e "ssh -o StrictHostKeyChecking=no" --exclude node_modules --exclude .next --exclude .git --exclude .claude . root@$IP:/root/hikconnect-web/
ssh root@$IP 'cd /root/hikconnect-web && npm install --silent' 2>/dev/null

# 4. Run test
echo "[5/8] Running P2P pipeline (45 seconds)..."
ssh root@$IP "cd /root/hikconnect-web && rm -rf /tmp/hls-output && PUBLIC_IP=$IP timeout 50 npx tsx scripts/test-p2p-to-ffmpeg.ts" 2>&1 | tee /tmp/pipeline-output.txt | grep -E "SRT-DATA.*#[0-9]+00|FFmpeg.*(Video|frame|time=|speed)|Status NAL|Final|HLS"

# 5. Check results
echo ""
echo "[6/8] Results:"
ssh root@$IP 'echo "HLS files:" && ls -la /tmp/hls-output/ 2>/dev/null && echo "---" && cat /tmp/hls-output/stream.m3u8 2>/dev/null || echo "No HLS output"'

# 6. Download first segment + raw data for local analysis
echo ""
echo "[7/8] Downloading segment for visual verification..."
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

# 7. Cleanup
echo ""
echo "[8/8] Cleaning up..."
hcloud server delete hikp2p --poll-interval 2s >/dev/null 2>&1
echo "Done! Check /tmp/pipeline-output.txt for full log."
