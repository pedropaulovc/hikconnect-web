---
name: hevc-passthrough-hvcc-fix
description: "HEVC passthrough fMP4 HLS needs -bsf:v hevc_metadata or hvcC is empty and won't decode"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b0e3edc-4078-4c34-a386-797cc4b00473
---

The `passthrough` encoder mode (`src/lib/hls/ffmpeg-pipe.ts`) stream-copies source HEVC into
fMP4 HLS for GPU-less hosts. The raw `-f hevc` demuxer leaves VPS/SPS/PPS only **in-band**, so a
plain `-c:v copy` never populates codec extradata → the mov muxer writes an **empty `hvcC` box**
(8 bytes, header only). ffprobe reads 4K metadata from init.mp4 but **cannot decode a frame**;
HLS.js/MSE has no decoder-config record → 4K stream never plays in-browser.

**Fix:** add `-bsf:v hevc_metadata` to the passthrough args. The BSF re-parses the parameter sets
back into extradata so the muxer emits a populated `hvcC` (119 bytes, payload `010160…`). Verified:
320 frames decode clean, `ffmpeg -f null` exit 0, real 3840×2160 frame extracted from the live VM.

**Why:** `extract_extradata` BSF does NOT fix it (still empty); only `hevc_metadata` does.
Regression-guarded by a test asserting `-bsf:v hevc_metadata` in the passthrough argv. Deployed via
[[azure-deploy-topology]].
