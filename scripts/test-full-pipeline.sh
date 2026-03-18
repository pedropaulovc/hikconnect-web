#!/bin/bash
# One-shot full pipeline test: deploy to VPS, capture video, generate HLS, verify.
# Usage: ./scripts/test-full-pipeline.sh
# Requires: hcloud CLI configured, .env.local with credentials

set -e

echo "=== Hikvision P2P Full Pipeline Test ==="
echo ""

# 1. Create VPS
echo "[1/6] Creating VPS..."
IP=$(hcloud server create --name hikp2p --type cpx11 --location ash --image ubuntu-24.04 --ssh-key hikconnect 2>&1 | grep "IPv4" | awk '{print $2}')
echo "VPS IP: $IP"

# 2. Wait for boot
echo "[2/6] Waiting for VPS..."
sleep 25
ssh-keygen -f "$HOME/.ssh/known_hosts" -R "$IP" 2>/dev/null || true

# 3. Setup
echo "[3/6] Installing Node.js + FFmpeg..."
ssh -o StrictHostKeyChecking=no root@$IP 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs ffmpeg' >/dev/null 2>&1

echo "[4/6] Deploying code..."
rsync -az -e "ssh -o StrictHostKeyChecking=no" --exclude node_modules --exclude .next --exclude .git --exclude .claude . root@$IP:/root/hikconnect-web/
ssh root@$IP 'cd /root/hikconnect-web && npm install --silent' 2>/dev/null

# 4. Run test
echo "[5/6] Running P2P pipeline (45 seconds)..."
ssh root@$IP "cd /root/hikconnect-web && rm -rf /tmp/hls-output && PUBLIC_IP=$IP timeout 50 npx tsx scripts/test-p2p-to-ffmpeg.ts" 2>&1 | tee /tmp/pipeline-output.txt | grep -E "SRT-DATA.*#[0-9]+00|FFmpeg.*(Video|frame|time=|speed)|Status NAL|Final|HLS"

# 5. Check results
echo ""
echo "[6/6] Results:"
ssh root@$IP 'echo "HLS files:" && ls -la /tmp/hls-output/ 2>/dev/null && echo "---" && cat /tmp/hls-output/stream.m3u8 2>/dev/null || echo "No HLS output"'

# 6. Cleanup
echo ""
echo "Cleaning up..."
hcloud server delete hikp2p --poll-interval 2s >/dev/null 2>&1
echo "Done! Check /tmp/pipeline-output.txt for full log."
