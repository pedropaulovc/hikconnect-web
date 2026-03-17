# Phase 3: Native FFI Streaming Proxy — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Stream live video and playback from a Hikvision NVR to a web browser by loading `libezstreamclient.so` on an ARM64 VPS and piping decoded frames through FFmpeg to HLS.

**Architecture:** A thin Java bridge program loads the native `.so` libraries via JNI (they export `Java_com_ez_stream_NativeApi_*` functions), calls `createPreviewHandle`/`startPreview`, receives raw video frames via callback, and writes them to stdout. A Node.js parent process pipes that stdout into FFmpeg, which outputs HLS segments served to the browser via Next.js API routes.

**Tech Stack:** Java 21 (JNI bridge), Node.js 24 (orchestrator), FFmpeg (HLS transcoder), Next.js 16 (web frontend), ARM64 Linux

**Key constraint:** `libezstreamclient.so` exports JNI functions (`Java_com_ez_stream_NativeApi_*`), not plain C functions. All 245 exports require `JNIEnv*` + `jobject/jclass` as first args. A JVM is required to call them. The library also depends on `libandroid.so` and `liblog.so` — we must provide stubs for these on Linux.

---

## High-Level Spec

> From [design document](./2026-03-16-udp-p2p-proxy-design.md)

The native library handles the entire P2P protocol (CAS broker, STUN NAT traversal, UDP P2P tunnel, AES decryption, PS demuxing). We supply it with the same `InitParam` structure the Android app uses (captured via Frida: device serial, CAS server, STUN server, P2P keys, session JWT). It connects to the NVR and delivers decoded video frames via a callback. We pipe those frames to FFmpeg for HLS segmentation.

```
Browser ←─ HLS ─→ Node.js ←─ pipe ─→ Java bridge ←─ JNI ─→ libezstreamclient.so ←─ UDP P2P ─→ NVR
```

---

### Task 1: Extract and Catalog Native Libraries

**Files:**
- Create: `native/extract-libs.sh`
- Create: `native/libs/` (directory with .so files)
- Create: `native/deps.txt` (dependency graph)

**Step 1: Write extraction script**

```bash
#!/bin/bash
# native/extract-libs.sh
# Extract ARM64 native libraries from Hik-Connect APK
set -euo pipefail

XAPK_PATH="${1:?Usage: extract-libs.sh <path-to-xapk>}"
OUT_DIR="$(dirname "$0")/libs"
TEMP_DIR=$(mktemp -d)

mkdir -p "$OUT_DIR"

# Extract arm64 config APK from XAPK
7z x -y "$XAPK_PATH" config.arm64_v8a.apk -o"$TEMP_DIR" >/dev/null
# Extract .so files from config APK
7z x -y "$TEMP_DIR/config.arm64_v8a.apk" "lib/arm64-v8a/*.so" -o"$TEMP_DIR" >/dev/null

# Also extract from base APK (some libs are there)
7z x -y "$XAPK_PATH" com.connect.enduser.apk -o"$TEMP_DIR" >/dev/null
7z x -y "$TEMP_DIR/com.connect.enduser.apk" "lib/arm64-v8a/*.so" -o"$TEMP_DIR" 2>/dev/null || true

# Copy all .so files to output
cp "$TEMP_DIR"/lib/arm64-v8a/*.so "$OUT_DIR/"
rm -rf "$TEMP_DIR"

echo "Extracted $(ls "$OUT_DIR"/*.so | wc -l) libraries to $OUT_DIR/"
ls -lhS "$OUT_DIR"/*.so
```

**Step 2: Run the script**

```bash
chmod +x native/extract-libs.sh
bash native/extract-libs.sh "/mnt/c/Users/pedro/Downloads/Hik-Connect - for End User_6.11.150.0227_apkcombo.com.xapk"
```

**Step 3: Catalog dependencies**

```bash
for so in native/libs/libezstreamclient.so native/libs/libPlayCtrl.so; do
  echo "=== $(basename $so) ==="
  readelf -d "$so" | grep NEEDED
  echo ""
done > native/deps.txt
```

**Step 4: Verify all dependencies can be satisfied**

```bash
# List all .so files we have
ls native/libs/*.so | xargs -I{} basename {} | sort > /tmp/have.txt
# List all NEEDED deps
for so in native/libs/*.so; do readelf -d "$so" 2>/dev/null | grep NEEDED | grep -oP '\[.*\]' | tr -d '[]'; done | sort -u > /tmp/need.txt
# Find missing
comm -23 /tmp/need.txt /tmp/have.txt
```

Expected missing: `libandroid.so`, `liblog.so`, `libc.so`, `libm.so`, `libdl.so`, `libz.so`, `libEGL.so`, `libGLESv2.so`, `libmediandk.so`. These are Android system libs — `libc/libm/libdl/libz` exist on Linux, the rest need stubs.

**Step 5: Commit**

```bash
git add native/
git commit -m "feat: extract ARM64 native libraries from Hik-Connect APK"
```

---

### Task 2: Create Android Stub Libraries

**Files:**
- Create: `native/stubs/android_stubs.c`
- Create: `native/stubs/Makefile`

The native libraries call Android-specific functions. We need stub implementations that do nothing (or log to stderr).

**Step 1: Write the stubs**

```c
// native/stubs/android_stubs.c
// Stub implementations for Android system libraries
// These satisfy linker requirements on Linux ARM64

#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// === liblog.so stubs ===
int __android_log_print(int prio, const char *tag, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[%s] ", tag ? tag : "?");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    return 0;
}

int __android_log_write(int prio, const char *tag, const char *msg) {
    fprintf(stderr, "[%s] %s\n", tag ? tag : "?", msg ? msg : "");
    return 0;
}

int __android_log_vprint(int prio, const char *tag, const char *fmt, va_list ap) {
    fprintf(stderr, "[%s] ", tag ? tag : "?");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    return 0;
}

int __android_log_buf_write(int bufID, int prio, const char *tag, const char *msg) {
    return __android_log_write(prio, tag, msg);
}

int __android_log_is_loggable(int prio, const char *tag, int default_prio) {
    return 1;
}

// === libandroid.so stubs ===
// AAssetManager, ALooper, ANativeWindow — return NULL/0 for everything
void* AAssetManager_fromJava(void *env, void *obj) { return NULL; }
void* AAssetManager_open(void *mgr, const char *fn, int mode) { return NULL; }
int AAsset_getLength(void *asset) { return 0; }
int AAsset_read(void *asset, void *buf, int count) { return 0; }
void AAsset_close(void *asset) {}
void* ANativeWindow_fromSurface(void *env, void *surface) { return NULL; }
void ANativeWindow_release(void *window) {}
int ANativeWindow_setBuffersGeometry(void *w, int width, int height, int fmt) { return 0; }
void* ANativeWindow_lock(void *w, void *buf, void *rect) { return NULL; }
int ANativeWindow_unlockAndPost(void *w) { return 0; }
int ANativeWindow_getWidth(void *w) { return 0; }
int ANativeWindow_getHeight(void *w) { return 0; }

// === libmediandk.so stubs ===
void* AMediaFormat_new() { return calloc(1, 64); }
void AMediaFormat_delete(void *fmt) { free(fmt); }
void AMediaFormat_setString(void *fmt, const char *name, const char *val) {}
void AMediaFormat_setInt32(void *fmt, const char *name, int32_t val) {}
int AMediaFormat_getInt32(void *fmt, const char *name, int32_t *out) { return 0; }
void* AMediaCodec_createDecoderByType(const char *mime) { return NULL; }
int AMediaCodec_configure(void *codec, void *fmt, void *surface, void *crypto, uint32_t flags) { return -1; }
int AMediaCodec_start(void *codec) { return -1; }
int AMediaCodec_stop(void *codec) { return 0; }
int AMediaCodec_delete(void *codec) { return 0; }
```

**Step 2: Write the Makefile**

```makefile
# native/stubs/Makefile
CC ?= gcc
CFLAGS = -shared -fPIC -O2

all: liblog.so libandroid.so libmediandk.so

liblog.so: android_stubs.c
	$(CC) $(CFLAGS) -o ../libs/$@ $< -Wl,-soname,$@

libandroid.so: android_stubs.c
	$(CC) $(CFLAGS) -o ../libs/$@ $< -Wl,-soname,$@

libmediandk.so: android_stubs.c
	$(CC) $(CFLAGS) -o ../libs/$@ $< -Wl,-soname,$@

# EGL/GLES stubs (empty — only used for display which we don't need)
libEGL.so:
	$(CC) $(CFLAGS) -o ../libs/$@ -x c /dev/null -Wl,-soname,$@

libGLESv2.so:
	$(CC) $(CFLAGS) -o ../libs/$@ -x c /dev/null -Wl,-soname,$@

clean:
	rm -f ../libs/liblog.so ../libs/libandroid.so ../libs/libmediandk.so ../libs/libEGL.so ../libs/libGLESv2.so
```

**Step 3: Build (on ARM64 — will fail on x86_64, that's expected)**

If on x86_64 with cross-compiler:
```bash
cd native/stubs && CC=aarch64-linux-gnu-gcc make
```

If on ARM64:
```bash
cd native/stubs && make
```

**Step 4: Commit**

```bash
git add native/stubs/
git commit -m "feat: add Android stub libraries for Linux ARM64"
```

---

### Task 3: Java JNI Bridge — NativeApi Wrapper

**Files:**
- Create: `native/bridge/src/com/ez/stream/NativeApi.java`
- Create: `native/bridge/src/com/ez/stream/InitParam.java`
- Create: `native/bridge/src/com/ez/stream/EZStreamCallback.java`
- Create: `native/bridge/src/com/hikconnect/bridge/StreamBridge.java`

This is the critical piece. We create Java classes that match the package/class names the native library expects (`com.ez.stream.NativeApi`), then call the JNI functions.

**Step 1: Create the NativeApi class (matching native exports)**

```java
// native/bridge/src/com/ez/stream/NativeApi.java
package com.ez.stream;

import java.util.List;

public class NativeApi {
    static {
        System.loadLibrary("encryptprotect");
        System.loadLibrary("hpr");
        System.loadLibrary("mbedtls");
        System.loadLibrary("SystemTransform");
        System.loadLibrary("PlayCtrl");
        System.loadLibrary("FormatConversion");
        System.loadLibrary("NPQos");
        System.loadLibrary("ezstreamclient");
    }

    // Core lifecycle
    public static native int initSDK();
    public static native int uninitSDK();
    public static native long createPreviewHandle(InitParam initParam);
    public static native long createPlaybackHandle(InitParam initParam);
    public static native int startPreview(long handle);
    public static native int stopPreview(long handle);
    public static native int startPlayback(long handle, String startTime, String stopTime, String fileId);
    public static native int stopPlayback(long handle);
    public static native int destroyClient(long handle);
    public static native void destroyHandle(long handle);

    // Configuration
    public static native int setCallback(long handle, EZStreamCallback callback);
    public static native void setSecretKey(long handle, String key);
    public static native int setTokens(String[] tokens);
    public static native int clearTokens();
    public static native void setLocalNetIp(String ip);
    public static native int setLogPrintEnable(boolean enable, boolean fileLog, int level);
    public static native void setP2PPublicParam(int natType);
    public static native int setP2PV3ConfigInfo(short[] data, int saltIndex, int version);
    public static native void enableStreamClientCMDEcdh();
    public static native void setTimeoutOptimize(boolean enable);
    public static native void setMtuConfig(int mtu);

    // Query
    public static native int getClientType(long handle);
    public static native int getVideoEncodeType(long handle);
    public static native int getVideoWidth(long handle, int port);
    public static native int getVideoHeight(long handle, int port);
    public static native boolean isPlaying(long handle);
    public static native String getVersion();
}
```

**Step 2: Create InitParam class (matches JNI struct)**

```java
// native/bridge/src/com/ez/stream/InitParam.java
package com.ez.stream;

public class InitParam {
    public int iStreamSource;
    public int iStreamInhibit;
    public String szDevIP;
    public String szDevLocalIP;
    public int iDevCmdPort;
    public int iDevCmdLocalPort;
    public int iDevStreamPort;
    public int iDevStreamLocalPort;
    public int iStreamType;
    public int iVideoLevel;
    public int iChannelNumber;
    public String szSuperDeviceSerial;
    public String szDevSerial;
    public String szChnlSerial;
    public int iVoiceChannelNumber;
    public String szHardwareCode;
    public String szTtsIP;
    public String szTtsBackupIP;
    public int iTtsPort;
    public String szClientSession;
    public String szPermanetkey;
    public String szCasServerIP;
    public int iCasServerPort;
    public String szStunIP;
    public int iStunPort;
    public int iClnType;
    public int iVtmPort;
    public String szVtmIP;
    public String szVtmBackIP;
    public int iStreamTimeOut;
    public String szCloudServerIP;
    public String szCloudServerBackupIP;
    public int iCloudServerPort;
    public String szTicketToken;
    public String szStreamToken;
    public String szExtensionParas;
    public int iIPV6;
    public int iNeedProxy;
    public int iSupportNAT34;
    public int iChannelCount;
    public boolean support_new_talk;
    public int iInternetType;
    public int iCheckInterval;
    public int iP2PVersion;
    public String szUserID;
    public int iPlaybackSpeed;
    public int iNetSDKUserId = -1;
    public int iNetSDKChannelNumber;
    public EZP2PServerInfo[] p2pServerList;
    public int iStorageVersion = 1;
    public int iCloudVideoType = -1;
    public int iSDCardVideoType;
    public int iFrameInterval;
    public String szLid;
    public int usP2PKeyVer;
    public byte[] szP2PLinkKey = new byte[32];
    public int iShared;
    public int iSmallStream;
    public int isSmallMtu;
    public int iDevSupportAsyn;
    public int iSupportPlayBackEndFlag;
    public int iLinkEncryptV2;
    public String szStartTime;
    public String szStopTime;
    public String szFileID;
    public byte[] vtduServerPublicKey = new byte[91];
    public int vtduServerKeyVersion;
    public int iQosTalkVersion;
    public String szQosTaklIP;
    public int iQosTakPort;
    public String szExtInfo;
    public int iBusType;
    public int iClnIspType;
    public String szCallingId;
    public int iMicType;
    public int iTalkType;
    public int udpEcdh;
    public int iP2PSPS;
    public int iInterlaceFlag;
    public int iPreOpWhileStream;
    public String szChnlIndex;
    public P2PServerKey stP2PServerKey;
}
```

**Step 3: Create supporting classes**

```java
// native/bridge/src/com/ez/stream/EZStreamCallback.java
package com.ez.stream;

public interface EZStreamCallback {
    void onDataCallBack(int dataType, byte[] data, int dataLen);
    void onMessageCallBack(int msgType, int errorCode);
    void onStatisticsCallBack(int statisticsType, String json);
}

// native/bridge/src/com/ez/stream/EZP2PServerInfo.java
package com.ez.stream;

public class EZP2PServerInfo {
    public String szP2PServerIp;
    public int iP2PServerPort;
}

// native/bridge/src/com/ez/stream/P2PServerKey.java
package com.ez.stream;

public class P2PServerKey {
    public byte[] key;
    public int keyLen;
}
```

**Step 4: Create the bridge main class**

```java
// native/bridge/src/com/hikconnect/bridge/StreamBridge.java
package com.hikconnect.bridge;

import com.ez.stream.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

/**
 * Bridge program: loads libezstreamclient.so via JNI,
 * connects to NVR via P2P, writes raw video frames to stdout.
 *
 * Usage: java -Djava.library.path=native/libs com.hikconnect.bridge.StreamBridge <json-params>
 *
 * JSON params: { deviceSerial, channelNo, sessionId, ... }
 * Stdout: raw PS/H.264 stream data
 * Stderr: status/error messages
 */
public class StreamBridge implements EZStreamCallback {
    private final OutputStream output;
    private volatile boolean running = true;

    public StreamBridge(OutputStream output) {
        this.output = output;
    }

    @Override
    public void onDataCallBack(int dataType, byte[] data, int dataLen) {
        // dataType: 1=HEADER, 2=DATA, 3=AUDIO, 4=STREAMKEY, 5=AESMD5, 50=FIRST_DATA, 100=END
        try {
            if (dataType == 1 || dataType == 2 || dataType == 3 || dataType == 50) {
                // Write length-prefixed frame to stdout
                // Format: [4-byte type][4-byte length][data]
                byte[] header = new byte[8];
                header[0] = (byte)((dataType >> 24) & 0xFF);
                header[1] = (byte)((dataType >> 16) & 0xFF);
                header[2] = (byte)((dataType >> 8) & 0xFF);
                header[3] = (byte)(dataType & 0xFF);
                header[4] = (byte)((dataLen >> 24) & 0xFF);
                header[5] = (byte)((dataLen >> 16) & 0xFF);
                header[6] = (byte)((dataLen >> 8) & 0xFF);
                header[7] = (byte)(dataLen & 0xFF);
                output.write(header);
                output.write(data, 0, dataLen);
                output.flush();
            }
            if (dataType == 100) { // END
                System.err.println("[BRIDGE] Stream ended");
                running = false;
            }
        } catch (IOException e) {
            System.err.println("[BRIDGE] Write error: " + e.getMessage());
            running = false;
        }
    }

    @Override
    public void onMessageCallBack(int msgType, int errorCode) {
        System.err.println("[BRIDGE] Message: type=" + msgType + " error=" + errorCode);
        if (msgType == 1) { // ERROR
            running = false;
        }
    }

    @Override
    public void onStatisticsCallBack(int statisticsType, String json) {
        System.err.println("[BRIDGE] Stats: type=" + statisticsType + " " + json);
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Usage: StreamBridge <json-params>");
            System.exit(1);
        }

        // Parse JSON params from args or stdin
        String jsonParams = args[0];
        // TODO: parse JSON to populate InitParam

        System.err.println("[BRIDGE] Initializing SDK...");
        int initResult = NativeApi.initSDK();
        System.err.println("[BRIDGE] initSDK result: " + initResult);
        System.err.println("[BRIDGE] SDK version: " + NativeApi.getVersion());

        // Build InitParam from captured Frida data
        InitParam param = new InitParam();
        // TODO: populate from JSON

        System.err.println("[BRIDGE] Creating preview handle...");
        long handle = NativeApi.createPreviewHandle(param);
        System.err.println("[BRIDGE] Handle: " + handle);

        StreamBridge bridge = new StreamBridge(System.out);
        NativeApi.setCallback(handle, bridge);
        NativeApi.setSecretKey(handle, "ABCDEF"); // TODO: from params

        System.err.println("[BRIDGE] Starting preview...");
        int startResult = NativeApi.startPreview(handle);
        System.err.println("[BRIDGE] startPreview result: " + startResult);

        // Keep running until stream ends or killed
        while (bridge.running) {
            Thread.sleep(100);
        }

        System.err.println("[BRIDGE] Stopping...");
        NativeApi.stopPreview(handle);
        NativeApi.destroyClient(handle);
        NativeApi.uninitSDK();
    }
}
```

**Step 5: Commit**

```bash
git add native/bridge/
git commit -m "feat: add Java JNI bridge for libezstreamclient.so"
```

---

### Task 4: Validate Library Loading on ARM64

**This task must run on an ARM64 machine (VPS or local ARM device).**

**Files:**
- Create: `native/test-load.sh`

**Step 1: Write the validation script**

```bash
#!/bin/bash
# native/test-load.sh
# Test that native libraries can be loaded on ARM64 Linux
set -euo pipefail

NATIVE_DIR="$(dirname "$0")"
LIB_DIR="$NATIVE_DIR/libs"
BRIDGE_DIR="$NATIVE_DIR/bridge/src"

echo "=== Architecture check ==="
uname -m  # must be aarch64

echo ""
echo "=== Building stub libraries ==="
cd "$NATIVE_DIR/stubs" && make && cd -

echo ""
echo "=== Compiling Java bridge ==="
javac -d "$NATIVE_DIR/bridge/classes" \
  "$BRIDGE_DIR/com/ez/stream/NativeApi.java" \
  "$BRIDGE_DIR/com/ez/stream/InitParam.java" \
  "$BRIDGE_DIR/com/ez/stream/EZStreamCallback.java" \
  "$BRIDGE_DIR/com/ez/stream/EZP2PServerInfo.java" \
  "$BRIDGE_DIR/com/ez/stream/P2PServerKey.java" \
  "$BRIDGE_DIR/com/hikconnect/bridge/StreamBridge.java"

echo ""
echo "=== Testing library load ==="
export LD_LIBRARY_PATH="$LIB_DIR"
java -Djava.library.path="$LIB_DIR" \
  -cp "$NATIVE_DIR/bridge/classes" \
  -e "
    try {
        System.loadLibrary(\"ezstreamclient\");
        System.out.println(\"SUCCESS: libezstreamclient.so loaded\");
    } catch (UnsatisfiedLinkError e) {
        System.err.println(\"FAILED: \" + e.getMessage());
        System.exit(1);
    }
  "

echo ""
echo "=== Testing initSDK ==="
java -Djava.library.path="$LIB_DIR" \
  -cp "$NATIVE_DIR/bridge/classes" \
  com.ez.stream.NativeApi 2>&1 || echo "(expected — no main method, but loading is the test)"
```

**Step 2: Run on ARM64**

```bash
bash native/test-load.sh
```

Expected outcomes:
- **Best case:** Libraries load, `initSDK()` returns 0
- **Likely case:** Missing symbols from Android stubs — iterate on `android_stubs.c`
- **Worst case:** Library crashes due to Android-specific initialization — need deeper stubs

**Step 3: Iterate on stubs until loading succeeds**

Each missing symbol error tells you what stub to add. Add it to `android_stubs.c`, rebuild, retry.

**Step 4: Commit**

```bash
git add native/
git commit -m "feat: validate native library loading on ARM64 Linux"
```

---

### Task 5: Node.js StreamManager — Spawn Java Bridge

**Files:**
- Create: `src/lib/streaming/stream-manager.ts`
- Create: `src/lib/streaming/stream-manager.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/streaming/stream-manager.test.ts
import { describe, it, expect, vi } from 'vitest'
import { StreamManager } from './stream-manager'

describe('StreamManager', () => {
  it('creates a stream session with correct params', () => {
    const manager = new StreamManager({ nativeLibPath: '/opt/hikconnect/libs', bridgeClassPath: '/opt/hikconnect/bridge' })

    const session = manager.createSession({
      deviceSerial: 'L38239367',
      channelNo: 4,
      sessionId: 'test-session',
      secretKey: 'ABCDEF',
      casIp: '34.194.209.167',
      casPort: 6500,
      stunIp: '43.130.155.63',
      stunPort: 6002,
      vtmIp: '148.153.53.29',
      vtmPort: 8554,
      deviceIp: '24.35.64.195',
      p2pVersion: 3,
      p2pLinkKey: '6447f56b9e4229fb94b6f26776003e9c0',
      p2pKeyVersion: 101,
    })

    expect(session.id).toBeTruthy()
    expect(session.status).toBe('created')
  })

  it('generates unique session IDs', () => {
    const manager = new StreamManager({ nativeLibPath: '/tmp', bridgeClassPath: '/tmp' })
    const params = { deviceSerial: 'X', channelNo: 1, sessionId: 's', secretKey: 'k', casIp: '', casPort: 0, stunIp: '', stunPort: 0, vtmIp: '', vtmPort: 0, deviceIp: '', p2pVersion: 3, p2pLinkKey: '', p2pKeyVersion: 0 }
    const s1 = manager.createSession(params)
    const s2 = manager.createSession(params)
    expect(s1.id).not.toBe(s2.id)
  })
})
```

**Step 2: Run to verify RED**

```bash
npm test -- --run src/lib/streaming/stream-manager.test.ts
```

**Step 3: Implement**

```typescript
// src/lib/streaming/stream-manager.ts
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

export type StreamParams = {
  deviceSerial: string
  channelNo: number
  sessionId: string
  secretKey: string
  casIp: string
  casPort: number
  stunIp: string
  stunPort: number
  vtmIp: string
  vtmPort: number
  deviceIp: string
  p2pVersion: number
  p2pLinkKey: string
  p2pKeyVersion: number
}

export type StreamStatus = 'created' | 'starting' | 'streaming' | 'stopped' | 'error'

export type StreamSession = {
  id: string
  params: StreamParams
  status: StreamStatus
  process: ChildProcess | null
  ffmpegProcess: ChildProcess | null
  hlsDir: string
}

export type StreamManagerOptions = {
  nativeLibPath: string
  bridgeClassPath: string
  hlsBaseDir?: string
}

export class StreamManager {
  private options: StreamManagerOptions
  private sessions = new Map<string, StreamSession>()

  constructor(options: StreamManagerOptions) {
    this.options = options
  }

  createSession(params: StreamParams): StreamSession {
    const id = randomUUID()
    const hlsDir = `${this.options.hlsBaseDir ?? '/tmp/hls'}/${id}`
    const session: StreamSession = {
      id,
      params,
      status: 'created',
      process: null,
      ffmpegProcess: null,
      hlsDir,
    }
    this.sessions.set(id, session)
    return session
  }

  getSession(id: string): StreamSession | undefined {
    return this.sessions.get(id)
  }

  async startSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (session.status !== 'created') throw new Error(`Session ${id} is ${session.status}`)

    session.status = 'starting'

    const paramsJson = JSON.stringify(session.params)

    // Spawn Java bridge
    session.process = spawn('java', [
      `-Djava.library.path=${this.options.nativeLibPath}`,
      '-cp', this.options.bridgeClassPath,
      'com.hikconnect.bridge.StreamBridge',
      paramsJson,
    ], {
      env: { ...process.env, LD_LIBRARY_PATH: this.options.nativeLibPath },
    })

    // Spawn FFmpeg to convert raw stream to HLS
    const { mkdirSync } = await import('node:fs')
    mkdirSync(session.hlsDir, { recursive: true })

    session.ffmpegProcess = spawn('ffmpeg', [
      '-f', 'mpegps',       // input format: MPEG Program Stream
      '-i', 'pipe:0',       // read from stdin
      '-c:v', 'copy',       // copy video codec (no re-encode)
      '-c:a', 'aac',        // transcode audio to AAC
      '-f', 'hls',          // output format: HLS
      '-hls_time', '2',     // 2-second segments
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments',
      `${session.hlsDir}/stream.m3u8`,
    ])

    // Pipe: Java bridge stdout → FFmpeg stdin
    session.process.stdout?.pipe(session.ffmpegProcess.stdin!)

    session.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString()
      if (msg.includes('startPreview result: 0')) {
        session.status = 'streaming'
      }
      process.stderr.write(`[bridge:${id.slice(0, 8)}] ${msg}`)
    })

    session.process.on('exit', (code) => {
      if (session.status !== 'stopped') {
        session.status = code === 0 ? 'stopped' : 'error'
      }
    })
  }

  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return

    session.status = 'stopped'
    session.process?.kill('SIGTERM')
    session.ffmpegProcess?.kill('SIGTERM')
  }

  listSessions(): StreamSession[] {
    return Array.from(this.sessions.values())
  }
}
```

**Step 4: Run tests**

```bash
npm test -- --run src/lib/streaming/stream-manager.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/streaming/
git commit -m "feat: add StreamManager to spawn Java bridge + FFmpeg pipeline"
```

---

### Task 6: HLS Serving API Routes

**Files:**
- Create: `src/app/api/stream/[sessionId]/playlist/route.ts`
- Create: `src/app/api/stream/[sessionId]/segment/[filename]/route.ts`
- Create: `src/app/api/stream/start/route.ts`
- Create: `src/app/api/stream/stop/route.ts`

**Step 1: Create stream start route**

```typescript
// src/app/api/stream/start/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { StreamManager } from '@/lib/streaming/stream-manager'

// Global stream manager singleton
const streamManager = new StreamManager({
  nativeLibPath: process.env.NATIVE_LIB_PATH ?? '/opt/hikconnect/libs',
  bridgeClassPath: process.env.BRIDGE_CLASS_PATH ?? '/opt/hikconnect/bridge/classes',
})

export { streamManager }

export async function POST(request: Request) {
  try {
    const { deviceSerial, channelNo } = await request.json()
    if (!deviceSerial || !channelNo) {
      return NextResponse.json({ error: 'deviceSerial and channelNo required' }, { status: 400 })
    }

    const client = getAuthenticatedClient()
    const session = client.getSession()
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    // Get stream params from API
    const vtm = await client.getVtmInfo(deviceSerial, channelNo)
    const devices = await client.getDevices()
    const device = devices.find(d => d.deviceSerial === deviceSerial)

    const streamSession = streamManager.createSession({
      deviceSerial,
      channelNo,
      sessionId: session.sessionId,
      secretKey: process.env.DEVICE_VERIFICATION_CODE ?? 'ABCDEF',
      casIp: '34.194.209.167', // TODO: get from device info
      casPort: 6500,
      stunIp: '43.130.155.63',
      stunPort: 6002,
      vtmIp: vtm.externalIp,
      vtmPort: vtm.port,
      deviceIp: device?.deviceSerial ?? '',
      p2pVersion: 3,
      p2pLinkKey: '', // TODO: get from P2P config API
      p2pKeyVersion: 0,
    })

    await streamManager.startSession(streamSession.id)
    return NextResponse.json({ sessionId: streamSession.id, status: streamSession.status })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
```

**Step 2: Create playlist route**

```typescript
// src/app/api/stream/[sessionId]/playlist/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { streamManager } from '../../start/route'

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  const session = streamManager.getSession(sessionId)
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  try {
    const m3u8 = await readFile(`${session.hlsDir}/stream.m3u8`, 'utf-8')
    return new Response(m3u8, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Playlist not ready' }, { status: 404 })
  }
}
```

**Step 3: Create segment route**

```typescript
// src/app/api/stream/[sessionId]/segment/[filename]/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { streamManager } from '../../../start/route'

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string; filename: string }> }) {
  const { sessionId, filename } = await params
  const session = streamManager.getSession(sessionId)
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Sanitize filename to prevent path traversal
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  try {
    const data = await readFile(`${session.hlsDir}/${safe}`)
    return new Response(data, {
      headers: { 'Content-Type': 'video/mp2t' },
    })
  } catch {
    return NextResponse.json({ error: 'Segment not found' }, { status: 404 })
  }
}
```

**Step 4: Create stop route**

```typescript
// src/app/api/stream/stop/route.ts
import { NextResponse } from 'next/server'
import { streamManager } from '../start/route'

export async function POST(request: Request) {
  const { sessionId } = await request.json()
  await streamManager.stopSession(sessionId)
  return NextResponse.json({ ok: true })
}
```

**Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/app/api/stream/
git commit -m "feat: add HLS streaming API routes (start, playlist, segment, stop)"
```

---

### Task 7: Provision ARM64 VPS and Deploy

**This task is manual — instructions for the human.**

**Step 1: Create ARM64 VPS**

Oracle Cloud free tier (recommended):
- Shape: VM.Standard.A1.Flex (ARM)
- 4 OCPUs, 24GB RAM (free forever)
- OS: Ubuntu 24.04 ARM64

**Step 2: Install dependencies on VPS**

```bash
sudo apt update && sudo apt install -y openjdk-21-jdk ffmpeg build-essential
```

**Step 3: Deploy native libraries**

```bash
scp -r native/libs/ vps:/opt/hikconnect/libs/
scp -r native/stubs/ vps:/tmp/stubs/
ssh vps "cd /tmp/stubs && make"  # builds stub .so files into libs/
```

**Step 4: Deploy Java bridge**

```bash
scp -r native/bridge/ vps:/opt/hikconnect/bridge/
ssh vps "cd /opt/hikconnect/bridge && javac -d classes src/com/ez/stream/*.java src/com/hikconnect/bridge/*.java"
```

**Step 5: Test library loading on VPS**

```bash
ssh vps "cd /opt/hikconnect && LD_LIBRARY_PATH=libs java -Djava.library.path=libs -cp bridge/classes com.hikconnect.bridge.StreamBridge '{}'"
```

**Step 6: Deploy Next.js app**

```bash
# On VPS
git clone <repo> /opt/hikconnect/web
cd /opt/hikconnect/web
npm install
NATIVE_LIB_PATH=/opt/hikconnect/libs BRIDGE_CLASS_PATH=/opt/hikconnect/bridge/classes npm run build
NATIVE_LIB_PATH=/opt/hikconnect/libs BRIDGE_CLASS_PATH=/opt/hikconnect/bridge/classes npm start
```

---

## Testing Strategy

The plan is structured as validation gates:
1. **Task 1-2:** Can we extract and satisfy library dependencies? (Link-time validation)
2. **Task 3:** Can we create matching JNI classes? (Compile-time validation)
3. **Task 4:** Can `initSDK()` run on ARM64 Linux? (Runtime validation — **the critical gate**)
4. **Task 5-6:** Node.js orchestration (testable with mocks until Task 4 passes)
5. **Task 7:** End-to-end on real ARM64 VPS

If Task 4 fails (libraries won't load on Linux), we fall back to the Android emulator approach from the design doc.
