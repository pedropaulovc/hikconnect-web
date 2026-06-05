---
name: azure-deploy-topology
description: Azure deploy topology lesson for hikconnect-web — only a VM with instance-level public IP works; ACA/ACI/NAT-GW break P2P hole-punching. LIVE INFRA TORN DOWN 2026-06-04 (rg-hikconnect-wus2-1 deleted).
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b0e3edc-4078-4c34-a386-797cc4b00473
---

**TORN DOWN 2026-06-04:** the entire `rg-hikconnect-wus2-1` resource group (VM, OS disk, NIC,
public IP, NSG, VNet, ACR `ca0ea94d8f11acr`) was deleted on user request. Nothing runs in Azure
now. The notes below are the **deployment lesson** retained for if/when redeploy is needed.

Previously hikconnect-web ran on Azure as a **VM** (`vm-hikconnect`, public IP `20.59.17.168`,
RG `rg-hikconnect-wus2-1`, sub `07aba226-fd59-489a-b07b-4158fef12a5d`) running the container
with `docker run --network host`. Image: ACR `ca0ea94d8f11acr.azurecr.io/hikconnect-web:<tag>`
(tag `2` = the hvcC-fix build). Env: `HLS_ENCODER=passthrough`, no GPU.

**App listens on `:8080`** — NSG `vm-hikconnectNSG` inbound allows only 22 (ssh), **8080**
(`allow-web`), and UDP 1024-65535 (`allow-p2p-udp`). NOT 3000/80. Demo URL: `http://20.59.17.168:8080/`.

**`az` CLI works natively on Linux/WSL** (user confirmed 2026-06-04) — do NOT route through
`cmd.exe`/`/mnt/c`. `az vm run-command invoke ... --scripts @/tmp/x.sh` works directly. The old
"az is Windows-only" note was wrong.

**In-browser playback caveat (empirically verified 2026-06-04):** the VM's `passthrough` encoder
emits **HEVC** HLS, and WSL Chrome's **`MediaSource.isTypeSupported('hev1…'/'hvc1…')` → `false`**
(H.264 `avc1.640028` → true). Since HLS.js plays via MSE, it can't append HEVC → `<video>` stays
**black / videoWidth=0** even when the playlist loads. (Don't trust `canPlayType` alone — use
`MediaSource.isTypeSupported`.) So the live demo is NOT visually reproducible in WSL Chrome against
the passthrough VM. **Local dev on this GPU host (amet, RTX 3090) DOES work**: encoder auto-detect
picks `nvenc` (has `h264_nvenc`+`hevc_cuvid`) → HEVC→**H.264**, which MSE supports — verified live 4K
(`video 3840×2160`, real non-black frame) in headed WSL Chrome via `playwright-cli`. HLS temp dir:
`/tmp/<uid>/hls/<sessionId>/stream.m3u8`. The P2P hole-punch from Azure is also **intermittent**
(device sometimes doesn't send `0x0C00`; falls back to relay PLAY_REQUEST which the device rejects
with `Link status invalid,playstatus=0` until a punch lands); local dev behind home NAT punches reliably.

**Why a VM and nothing else:** the Hik P2P protocol needs UDP hole-punching — the device sends
`0x0C00` back to our NAT-mapped source addr. Azure Container Apps (ingress is HTTP/TCP-only +
egress SNAT), Container Instances (asymmetric ingress/egress IPs, SNAT), and NAT Gateway (remaps
egress source port) **all break the punch** — proven on-subscription with a STUN probe
(PORT_PRESERVED=false). Only a VM with an **instance-level public IP + host networking** (no SNAT,
source port preserved) lets the device reach us. Don't retry ACA/ACI/NAT-GW for streaming.

**Deploy a new build:** `docker build` locally in WSL → push to ACR → update VM via
`az vm run-command invoke ... RunShellScript` (docker pull + `docker rm -f hik` + re-`docker run`).
The `az` CLI is Windows-only here (run via `cmd.exe /c az ...` from `/mnt/c`; strip `\r`, pass
scripts as `@C:\temp\file.sh`). **Why:** login session is in-memory (no cookie) so creds never
touch the image. See [[hevc-passthrough-hvcc-fix]].
