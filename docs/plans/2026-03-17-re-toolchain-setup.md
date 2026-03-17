# RE Toolchain Setup + P2P Protocol Analysis — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Install Ghidra + kawaiidra-mcp + tshark on WSL2, import the ARM64 .so files into a Ghidra project, and begin systematic static reverse engineering of the Hik-Connect UDP P2P streaming protocol.

**Architecture:** Ghidra headless on WSL2 (x86_64) cross-analyzes ARM64 binaries. kawaiidra-mcp bridges Ghidra ↔ Claude Code via MCP (stdio). tshark available for future pcap analysis.

**Tech Stack:** Ghidra 12.0.4, kawaiidra-mcp (JPype), tshark 4.x, Python 3.14, JDK 21

---

## High-Level Spec

> From [design document](./2026-03-17-full-p2p-re-design.md) for reference.

Phase A of the full P2P RE plan: set up the static analysis toolchain and perform initial analysis of `libezstreamclient.so` and supporting libraries. No server needed — everything runs locally on WSL2.

---

### Task 1: Install Ghidra

**Files:**
- No project files changed

**Step 1: Download Ghidra 12.0.4**

```bash
wget -O /tmp/ghidra.zip "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.0.4_build/ghidra_12.0.4_PUBLIC_20260303.zip"
```

**Step 2: Extract to /opt/ghidra**

```bash
sudo unzip /tmp/ghidra.zip -d /opt
sudo mv /opt/ghidra_12.0.4_PUBLIC /opt/ghidra
rm /tmp/ghidra.zip
```

**Step 3: Verify installation**

```bash
/opt/ghidra/support/analyzeHeadless --help 2>&1 | head -5
```

Expected: Usage info for `analyzeHeadless` (no errors about missing JDK).

**Step 4: Add to PATH**

```bash
echo 'export GHIDRA_INSTALL_DIR=/opt/ghidra' >> ~/.bashrc
echo 'export PATH="$PATH:/opt/ghidra/support"' >> ~/.bashrc
source ~/.bashrc
```

---

### Task 2: Install tshark

**Files:**
- No project files changed

**Step 1: Install tshark**

```bash
sudo apt install -y tshark
```

When prompted about non-root capture, choose "No" (we only analyze saved pcap files).

**Step 2: Verify**

```bash
tshark --version | head -1
```

Expected: `TShark (Wireshark) 4.x.x`

---

### Task 3: Install kawaiidra-mcp

**Files:**
- No project files changed (MCP config goes in Claude Code settings)

**Step 1: Clone and install**

```bash
cd /opt
sudo git clone https://github.com/wagonbomb/kawaiidra-mcp.git
sudo chown -R $USER:$USER /opt/kawaiidra-mcp
cd /opt/kawaiidra-mcp
uv venv
source .venv/bin/activate
uv pip install -e .
uv pip install 'JPype1>=1.5.0'
deactivate
```

**Step 2: Test the server starts**

```bash
GHIDRA_INSTALL_DIR=/opt/ghidra /opt/kawaiidra-mcp/.venv/bin/python /opt/kawaiidra-mcp/run_server.py &
PID=$!
sleep 3
kill $PID 2>/dev/null
```

Expected: No crash. May print MCP server ready message or wait for stdio input.

**Step 3: Configure MCP server in Claude Code**

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "kawaiidra": {
      "type": "stdio",
      "command": "/opt/kawaiidra-mcp/.venv/bin/python",
      "args": ["/opt/kawaiidra-mcp/run_server.py"],
      "env": {
        "GHIDRA_INSTALL_DIR": "/opt/ghidra"
      }
    }
  }
}
```

**Step 4: Verify MCP server is visible**

Restart Claude Code and check that the kawaiidra tools appear in the available tools list. Key tools to confirm:
- `analyze_binary`
- `list_functions`
- `get_function_decompile`
- `analyze_jni_methods`
- `search_strings`

---

### Task 4: Extract .so files from APK

**Files:**
- Create: `native/libs/` (directory with .so files)
- Create: `native/extract-libs.sh` (already planned in phase3 doc)

**Step 1: Locate the XAPK**

```bash
ls -lh "/mnt/c/Users/pedro/Downloads/Hik-Connect"*.xapk
```

If not found, download from APKCombo or APKPure.

**Step 2: Run extraction**

```bash
mkdir -p native/libs
TEMP=$(mktemp -d)

# Extract arm64 config APK from XAPK
7z x -y "/mnt/c/Users/pedro/Downloads/Hik-Connect - for End User_6.11.150.0227_apkcombo.com.xapk" config.arm64_v8a.apk -o"$TEMP" >/dev/null
7z x -y "$TEMP/config.arm64_v8a.apk" "lib/arm64-v8a/*.so" -o"$TEMP" >/dev/null

# Also extract from base APK
7z x -y "/mnt/c/Users/pedro/Downloads/Hik-Connect - for End User_6.11.150.0227_apkcombo.com.xapk" com.connect.enduser.apk -o"$TEMP" >/dev/null
7z x -y "$TEMP/com.connect.enduser.apk" "lib/arm64-v8a/*.so" -o"$TEMP" 2>/dev/null || true

cp "$TEMP"/lib/arm64-v8a/*.so native/libs/
rm -rf "$TEMP"

echo "Extracted $(ls native/libs/*.so | wc -l) libraries"
ls -lhS native/libs/*.so | head -20
```

Expected: ~77 .so files, with `libezstreamclient.so` (~7.5MB) and `libPlayCtrl.so` (~7.4MB) being the largest.

**Step 3: Catalog dependencies for key libraries**

```bash
for so in native/libs/libezstreamclient.so native/libs/libhpr.so native/libs/libstunClient.so native/libs/libNPQos.so native/libs/libmbedcrypto.so native/libs/libencryptprotect.so; do
  echo "=== $(basename $so) ==="
  readelf -d "$so" 2>/dev/null | grep NEEDED
  echo ""
done | tee native/deps.txt
```

**Step 4: Verify native/libs is gitignored**

```bash
echo "native/libs/*.so" >> .gitignore
```

**Step 5: Commit**

```bash
git add .gitignore native/deps.txt
git commit -m "chore: add .so dependency catalog and gitignore native libs"
```

---

### Task 5: Create Ghidra project and import binaries

**Files:**
- Create: `native/ghidra/` (Ghidra project directory)

**Step 1: Create Ghidra project with headless analyzer**

```bash
mkdir -p native/ghidra
analyzeHeadless native/ghidra hikconnect -import native/libs/libezstreamclient.so -processor AARCH64:LE:64:v8A -overwrite
```

This will take several minutes. Ghidra auto-analyzes on import (disassembly, function detection, decompilation prep).

Expected: `INFO  ANALYZING...` followed by `INFO  ANALYZING all (libezstreamclient.so)` and eventually `INFO  REPORT: Analysis succeeded`.

**Step 2: Import supporting libraries into same project**

```bash
for so in libhpr.so libstunClient.so libNPQos.so libmbedcrypto.so libmbedtls.so libencryptprotect.so libSystemTransform.so; do
  echo "=== Importing $so ==="
  analyzeHeadless native/ghidra hikconnect -import "native/libs/$so" -processor AARCH64:LE:64:v8A -overwrite
done
```

**Step 3: Verify via kawaiidra-mcp**

Use the MCP `list_analyzed_binaries` tool to confirm all binaries are loaded. Then use `list_functions` on `libezstreamclient.so` to confirm JNI exports are detected.

**Step 4: Gitignore the Ghidra project (large binary files)**

```bash
echo "native/ghidra/" >> .gitignore
git add .gitignore
git commit -m "chore: add Ghidra project directory to gitignore"
```

---

### Task 6: Initial JNI function survey

**Files:**
- Create: `docs/re/jni-exports.md`

**Step 1: List all JNI exports**

Use kawaiidra-mcp `analyze_jni_methods` tool on `libezstreamclient.so`. If that tool isn't available, use `list_exports` and filter for `Java_com_ez_stream_NativeApi_`.

**Step 2: Decompile key entry points**

Use `get_function_decompile` for each of these priority functions:

1. `Java_com_ez_stream_NativeApi_createPreviewHandle` — connection setup
2. `Java_com_ez_stream_NativeApi_startPreview` — stream start
3. `Java_com_ez_stream_NativeApi_setSecretKey` — crypto key setup
4. `Java_com_ez_stream_NativeApi_generateECDHKey` — ECDH exchange
5. `Java_com_ez_stream_NativeApi_initSDK` — SDK initialization

**Step 3: Document findings**

Write `docs/re/jni-exports.md` with:
- Complete list of 245 JNI exports
- Decompiled pseudocode for the 5 priority functions
- Cross-references to internal functions
- Initial observations about the protocol flow

**Step 4: Commit**

```bash
git add docs/re/jni-exports.md
git commit -m "docs: add JNI export survey from Ghidra analysis"
```

---

### Task 7: Trace CAS broker protocol

**Files:**
- Create: `docs/re/cas-broker-protocol.md`

**Step 1: Follow createPreviewHandle into CAS connection**

Starting from the decompiled `createPreviewHandle`, use `get_function_xrefs` to trace the call chain into CAS broker connection logic. Look for:
- TCP socket creation (`socket`, `connect` calls)
- Message serialization (look for struct packing, protobuf, or custom binary format)
- Port 6500 references

**Step 2: Search for protocol constants**

Use `search_strings` for:
- `"6500"`, `"CAS"`, `"broker"`, `"register"`, `"login"`
- `"STUN"`, `"stun"`, `"5389"` (RFC number)
- `"P2P"`, `"punch"`, `"hole"`
- `"0x55667788"`, `"0x8002"`

**Step 3: Analyze crypto functions**

Use `find_crypto_constants` to detect AES S-boxes, ECDH curve parameters, etc. Cross-reference with `libmbedcrypto.so` imports.

**Step 4: Document CAS protocol**

Write `docs/re/cas-broker-protocol.md` with:
- TCP message framing format
- Message types/opcodes discovered
- Request/response sequences
- Serialization format

**Step 5: Commit**

```bash
git add docs/re/cas-broker-protocol.md
git commit -m "docs: add CAS broker protocol analysis from Ghidra RE"
```

---

### Task 8: Trace STUN + P2P tunnel setup

**Files:**
- Create: `docs/re/stun-p2p-protocol.md`

**Step 1: Find STUN client code**

Decompile key functions in `libstunClient.so` using `list_functions` + `get_function_decompile`. Look for:
- RFC 5389 STUN message building
- Any proprietary extensions to STUN
- Binding request/response handling

**Step 2: Trace P2P punch-through**

From `startPreview`, follow the call chain after CAS broker returns peer info. Look for:
- UDP socket creation
- Hole-punching sequence (simultaneous open)
- Fallback to relay (VTM)

**Step 3: Analyze packet framing**

Find the code that writes/reads the `0x55667788` marker and `0x8002` ACK prefix. Document:
- Full packet header structure
- Sequence numbering
- Acknowledgment mechanism
- Keepalive/heartbeat format

**Step 4: Document**

Write `docs/re/stun-p2p-protocol.md`.

**Step 5: Commit**

```bash
git add docs/re/stun-p2p-protocol.md
git commit -m "docs: add STUN + P2P tunnel protocol analysis"
```

---

### Task 9: Trace AES encryption + ECDH key exchange

**Files:**
- Create: `docs/re/crypto-analysis.md`

**Step 1: Decompile setSecretKey**

Trace from `setSecretKey` into the AES key schedule. Determine:
- AES mode (CBC, CTR, GCM?)
- IV derivation (fixed? per-packet? counter?)
- Key derivation from the 6-char verification code (raw bytes? hashed? KDF?)

**Step 2: Decompile generateECDHKey**

Trace the ECDH flow. Determine:
- Curve (P-256 per API response)
- What the shared secret is used for (session key? additional encryption layer?)
- Where public keys are exchanged (CAS broker? STUN? inline in P2P?)

**Step 3: Cross-reference with libencryptprotect.so**

This 10KB library is likely a thin wrapper. Decompile all its functions.

**Step 4: Document**

Write `docs/re/crypto-analysis.md`.

**Step 5: Commit**

```bash
git add docs/re/crypto-analysis.md
git commit -m "docs: add AES/ECDH crypto analysis from RE"
```

---

### Task 10: Update status doc with RE findings

**Files:**
- Modify: `docs/plans/2026-03-16-status-update.md`

**Step 1: Update approach viability table**

Change "Full UDP P2P protocol RE" from "Not tried" to "In progress" with summary of findings.

**Step 2: Update recommended next steps**

Reflect current state: what's been confirmed via static RE, what still needs dynamic validation.

**Step 3: Commit**

```bash
git add docs/plans/2026-03-16-status-update.md
git commit -m "docs: update project status with RE progress"
```

---

## Dependency Graph

```
Task 1 (Ghidra) ──┐
Task 2 (tshark)    ├── Task 4 (extract .so) ── Task 5 (Ghidra project) ── Task 6 (JNI survey)
Task 3 (MCP)   ──┘                                                           │
                                                                    ┌────────┼────────┐
                                                                    ▼        ▼        ▼
                                                              Task 7     Task 8    Task 9
                                                              (CAS)     (STUN)   (Crypto)
                                                                    └────────┼────────┘
                                                                             ▼
                                                                        Task 10
                                                                    (Status update)
```

Tasks 1-3 can run in parallel. Tasks 7-9 can run in parallel after Task 6.
