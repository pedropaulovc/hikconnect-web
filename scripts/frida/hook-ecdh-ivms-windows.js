/**
 * Frida hook — Capture ECDH KDF test vectors from iVMS-4200 (Windows, ecdhCryption.dll)
 *
 * Companion to docs/re/2026-06-04-ivms4200-ecdh-kdf-capture-task.md.
 * Produces the per-session "triple" the Linux side needs to reimplement GenerateSessionKey:
 *   client priv/pub, server pub, ECDH shared secret, session key, plaintext+ciphertext body,
 *   full on-wire packet, AND the CTR_DRBG internal state (raw AES key, V counter, Update seed).
 *
 * Target DLL build: ecdhCryption.dll x64 PE32+, preferred ImageBase 0x180000000,
 *   SHA256 C7768BF8CEE99E13DBD7D3051D744D6550DEA0B2F76011BE3B3A3A2B6D0B62DB.
 *
 * RE summary (from Ghidra, this build):
 *   - Session ctx is a global singleton: ECDHCryption_* exports operate on one active session.
 *   - ECDHCryption_GenerateMasterKey(serverPubKey, out32):
 *       ECDH P-256 = clientPriv(ctx+0x609, PEM) x serverPub(arg, 91B SPKI) -> 32B shared secret.
 *       ctx+0x589 = client public key (embedded in packet).
 *   - ECDHCryption_GenerateSessionKey(out32): AES-256 CTR_DRBG Generate -> 32B session key.
 *       Counter-mode KDF: increments 16B V at ctx+0x0F (big-endian), AES-encrypts V per block.
 *   - CTR_DRBG primitives (internal): FUN_180009cd0 = AES block encrypt, FUN_1800092f0 = AES-256
 *       key schedule (raw DRBG Key in), FUN_180016a60 = CTR_DRBG_Update (48B seed material in).
 *   - ECDHCryption_EncECDHReqPackage(...): builds + encrypts the ClnConnectReq packet.
 *   - FUN_180011fa0: body-cipher dispatch (switch on descriptor[+8], types 3-9).
 *
 * Usage:
 *   frida -p <PID of iVMS-4200.Video.C> -l scripts/frida/hook-ecdh-ivms-windows.js --runtime=v8
 *   (Video.C handles live preview/playback; it loads ecdhCryption.dll + OpenNetStream.dll.)
 *   Then trigger a live preview / playback over Hik-Connect cloud. If no ECDH fires, force the
 *   TCP relay/VTM path (block outbound UDP to the device + STUN/P2P) so the server presents a pubkey.
 *
 * Output: appended to OUT_FILE (below) AND echoed to stdout, every line tagged [S<n>] by session.
 */

'use strict';

var MODULE = 'ecdhCryption.dll';
var IMAGE_BASE = ptr('0x180000000');          // Ghidra/PE preferred base
var OUT_FILE = 'C:\\re\\captures\\ecdh-capture.log';

// ---- internal (non-exported) functions, addressed by RVA = ghidraAddr - IMAGE_BASE ----
var RVA = {
  FUN_aesKeySchedule: 0x92f0,   // FUN_1800092f0(aesCtx, rawKey, keyBits)  -> raw DRBG Key
  FUN_drbgUpdate:     0x16a60,  // FUN_180016a60(drbgCtx, providedData48)  -> CTR_DRBG_Update
  FUN_kdfGenerate:    0x16e00,  // FUN_180016e00(drbgCtx, out, len)        -> CTR_DRBG_Generate
  FUN_cipherSelect:   0x11fa0,  // FUN_180011fa0(slot, desc, withIV)       -> body cipher select
  FUN_aesBlock:       0x9cd0,   // FUN_180009cd0(aesCtx, in16, out16)      -> AES encrypt block
};

// ctx field offsets (from session base passed to the export wrappers as DAT_180047940)
var CTX_CLIENT_PUB  = 0x589;   // client public key  (set by SetPBKeyAndPRKey arg1)
var CTX_CLIENT_PRIV = 0x609;   // client private key (PEM, set by SetPBKeyAndPRKey arg3)

var mod = null;
var out = null;
var sessionId = 0;
var AES_BLOCK_BUDGET = 16;     // max AES-block logs per session (reset on each GenerateMasterKey)
var aesBlockCalls = 0;         // throttle per-block AES logging (reset per session)

function openLog() {
  try { out = new File(OUT_FILE, 'a'); } catch (e) { out = null; }
}
function log(line) {
  var tagged = '[S' + sessionId + '] ' + line;
  console.log(tagged);
  if (out) { try { out.write(tagged + '\n'); out.flush(); } catch (e) {} }
}
function banner(line) {
  console.log(line);
  if (out) { try { out.write(line + '\n'); out.flush(); } catch (e) {} }
}

function hex(ptrOrNull, len) {
  if (!ptrOrNull || ptrOrNull.isNull() || len <= 0) return '(null)';
  try {
    var bytes = new Uint8Array(ptrOrNull.readByteArray(len));
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  } catch (e) { return '(unreadable:' + e + ')'; }
}

// Read a NUL-terminated PEM/ASCII key blob (private key is stored as PEM text)
function readPem(p, max) {
  if (!p || p.isNull()) return '(null)';
  try {
    var s = p.readCString(max || 512);
    if (s && s.indexOf('-----') >= 0) return JSON.stringify(s);
  } catch (e) {}
  return null;
}

function resolve(rva) {
  return mod.base.add(rva);
}

function attachExports() {
  // ECDHCryption_CreateSession() — new ECDH session boundary
  hookExport('ECDHCryption_CreateSession', {
    onLeave: function () {
      sessionId++;
      banner('\n==================== SESSION ' + sessionId + ' (CreateSession) ====================');
    },
  });

  // ECDHCryption_GeneratePublicAndPrivateKey() — ephemeral client keypair generated in-DLL
  hookExport('ECDHCryption_GeneratePublicAndPrivateKey', {
    onEnter: function () { log('GeneratePublicAndPrivateKey() called'); },
  });

  // ECDHCryption_SetPBKeyAndPRKey(pub, pubLen, priv, privLen) — keys provided externally
  hookExport('ECDHCryption_SetPBKeyAndPRKey', {
    onEnter: function (args) {
      var pub = args[0], pubLen = args[1].toInt32();
      var priv = args[2], privLen = args[3].toInt32();
      log('SetPBKeyAndPRKey: clientPub(' + pubLen + 'B)=' + hex(pub, pubLen));
      var pem = readPem(priv, privLen + 1);
      log('SetPBKeyAndPRKey: clientPriv(' + privLen + 'B)=' + (pem || hex(priv, privLen)));
    },
  });

  // ECDHCryption_GetSelfPublicKey(out, outLen*) — client public key (91B SPKI/DER)
  hookExport('ECDHCryption_GetSelfPublicKey', {
    onEnter: function (args) { this.outBuf = args[0]; this.outLen = args[1]; },
    onLeave: function () {
      var len = safeLen(this.outLen, 91);
      log('GetSelfPublicKey -> clientPub(' + len + 'B)=' + hex(this.outBuf, len));
    },
  });

  // ECDHCryption_GetPeerPublickey(arg1, out, outLen*) — server public key (91B SPKI/DER)
  hookExport('ECDHCryption_GetPeerPublickey', {
    onEnter: function (args) { this.outBuf = args[1]; this.outLen = args[2]; },
    onLeave: function () {
      var len = safeLen(this.outLen, 91);
      log('GetPeerPublickey -> serverPub(' + len + 'B)=' + hex(this.outBuf, len));
    },
  });

  // ECDHCryption_GenerateMasterKey(serverPubKey, out32) — ECDH shared secret
  hookExport('ECDHCryption_GenerateMasterKey', {
    onEnter: function (args) {
      this.serverPub = args[0];
      this.out = args[1];
      // serverPub is a 91B SPKI/DER blob (starts 30 59 30 13 06 07 2a 86 48 ce 3d ...)
      aesBlockCalls = 0;   // new ECDH session → refresh the AES-block logging budget
      log('GenerateMasterKey: serverPub(91B)=' + hex(this.serverPub, 91));
      // dump stored client keys from the global session ctx if reachable
      var ctxPtrPtr = mod.base.add(0x47940);           // DAT_180047940
      try {
        var ctx = ctxPtrPtr.readPointer();
        if (!ctx.isNull()) {
          log('GenerateMasterKey: ctx.clientPub(91B)=' + hex(ctx.add(CTX_CLIENT_PUB), 91));
          // client priv is 121B (0x79) SEC1/DER on this build (NOT 128B PEM) — read exactly 0x79
          var pem = readPem(ctx.add(CTX_CLIENT_PRIV), 512);
          log('GenerateMasterKey: ctx.clientPriv=' + (pem || hex(ctx.add(CTX_CLIENT_PRIV), 0x79)));
        }
      } catch (e) {}
    },
    onLeave: function () {
      log('GenerateMasterKey -> sharedSecret(32B)=' + hex(this.out, 32));
    },
  });

  // ECDHCryption_GenerateSessionKey(out32) — CTR_DRBG Generate -> session key
  hookExport('ECDHCryption_GenerateSessionKey', {
    onEnter: function (args) { this.out = args[0]; },
    onLeave: function () {
      log('GenerateSessionKey -> sessionKey(32B)=' + hex(this.out, 32));
    },
  });

  // ECDHCryption_SetSessionEncKey(...) — informational (MT-key cache)
  hookExport('ECDHCryption_SetSessionEncKey', {
    onEnter: function () { log('SetSessionEncKey() called'); },
  });

  // ECDHCryption_EncECDHReqPackage(seq, channelId, body, p4, p5, p6, outBuf, outLen*)
  // (wrapper drops the leading ctx arg; positions per FUN_1800028f0)
  hookExport('ECDHCryption_EncECDHReqPackage', {
    onEnter: function (args) {
      this.body = args[2];
      this.outBuf = args[6];
      this.outLen = args[7];
      log('EncECDHReqPackage: enter seq=' + args[0] + ' channelId=' + (args[1].toInt32() & 0xff) +
          ' bodyPtr=' + this.body);
      // body length is not directly an arg here; dump a bounded preview
      log('EncECDHReqPackage: bodyPlaintext[0:128]=' + hex(this.body, 128));
    },
    onLeave: function () {
      var len = safeLen(this.outLen, 256);
      if (len > 4096) len = 4096;
      log('EncECDHReqPackage -> packet(' + len + 'B)=' + hex(this.outBuf, len));
    },
  });
}

function attachInternals() {
  // FUN_1800092f0(aesCtx, rawKey, keyBits) — captures the raw AES-256 DRBG Key
  tryAttach(RVA.FUN_aesKeySchedule, 'aesKeySchedule', {
    onEnter: function (args) {
      var keyBits = args[2].toInt32();
      var keyBytes = (keyBits > 0 && keyBits <= 256) ? (keyBits / 8) : 32;
      log('AES-keySchedule: drbgKey(' + keyBytes + 'B, ' + keyBits + 'bit)=' + hex(args[1], keyBytes));
    },
  });

  // FUN_180016a60(drbgCtx, providedData48) — CTR_DRBG_Update; first call after master key = instantiate.
  // The 16-byte counter V occupies ctx[0x00..0x0F] (big-endian: MSB at +0x00, LSB/increment byte at
  // +0x0F), so hex(ctx,16) is the full V. AES key schedule for the DRBG lives at ctx+0x28.
  tryAttach(RVA.FUN_drbgUpdate, 'drbgUpdate', {
    onEnter: function (args) {
      this.ctx = args[0];
      log('CTR_DRBG_Update: V-before(16B @ ctx[0:16], LSB@+0x0F)=' + hex(this.ctx, 16) +
          ' providedData(48B)=' + hex(args[1], 48));
    },
    onLeave: function () {
      log('CTR_DRBG_Update: V-after(16B)=' + hex(this.ctx, 16));
    },
  });

  // FUN_180016e00(drbgCtx, out, len) — CTR_DRBG_Generate (the KDF body)
  tryAttach(RVA.FUN_kdfGenerate, 'kdfGenerate', {
    onEnter: function (args) {
      this.ctx = args[0];
      this.len = args[2].toInt32();
      log('KDF-generate: enter len=' + this.len + ' V-before(16B)=' + hex(this.ctx, 16));
    },
    onLeave: function () {
      log('KDF-generate: leave V-after(16B)=' + hex(this.ctx, 16));
    },
  });

  // FUN_180011fa0(slot, desc, withIV) — body cipher dispatch; desc[+8] = cipher type discriminant
  tryAttach(RVA.FUN_cipherSelect, 'cipherSelect', {
    onEnter: function (args) {
      try {
        var desc = args[1];
        var cipherType = desc.add(8).readU32();
        var blockSize = desc.add(0xd).readU8();
        log('cipherSelect: cipherType(switch)=' + cipherType + ' blockSize=' + blockSize +
            ' withIV=' + args[2].toInt32());
      } catch (e) { log('cipherSelect: (read failed: ' + e + ')'); }
    },
  });

  // FUN_180009cd0(aesCtx, in16, out16) — AES block (used by init/keygen/DRBG AND the off-11 wrap).
  // The budget is reset per session (in GenerateMasterKey.onEnter) so early init/keygen AES calls
  // don't starve the wrap/session-key blocks; logs up to AES_BLOCK_BUDGET blocks per session.
  tryAttach(RVA.FUN_aesBlock, 'aesBlock', {
    onEnter: function (args) { this.in = args[1]; this.out = args[2]; },
    onLeave: function () {
      if (aesBlockCalls < AES_BLOCK_BUDGET) {
        aesBlockCalls++;
        log('AES-block #' + aesBlockCalls + ' in=' + hex(this.in, 16) + ' out=' + hex(this.out, 16));
      }
    },
  });
}

// ---- helpers ----
function safeLen(lenPtr, fallback) {
  try {
    if (lenPtr && !lenPtr.isNull()) {
      var v = lenPtr.readU32();
      if (v > 0 && v < 65536) return v;
    }
  } catch (e) {}
  return fallback;
}

function hookExport(name, cbs) {
  var addr = mod.findExportByName(name);
  if (!addr) { banner('[!] export not found: ' + name); return; }
  Interceptor.attach(addr, cbs);
  banner('[+] hooked export ' + name + ' @ ' + addr);
}

function tryAttach(rva, label, cbs) {
  try {
    var addr = resolve(rva);
    Interceptor.attach(addr, cbs);
    banner('[+] hooked internal ' + label + ' @ ' + addr + ' (rva 0x' + rva.toString(16) + ')');
  } catch (e) {
    banner('[!] failed to hook ' + label + ' @ rva 0x' + rva.toString(16) + ': ' + e);
  }
}

// ---- entrypoint ----
var installed = false;
function install() {
  if (installed) return true;
  mod = Process.findModuleByName(MODULE);
  if (!mod) return false;
  installed = true;
  openLog();
  banner('[*] ' + MODULE + ' base=' + mod.base + ' size=' + mod.size + ' (image base ' + IMAGE_BASE + ')');
  banner('[*] writing captures to ' + OUT_FILE);
  attachExports();
  attachInternals();
  banner('[*] ECDH capture hooks installed (pid ' + Process.id + '). Trigger a live preview / playback.');
  return true;
}

// The module may not be loaded yet on a freshly-spawned process — poll until it appears.
if (!install()) {
  banner('[*] ' + MODULE + ' not loaded yet in pid ' + Process.id + ' — waiting for it to load...');
  var waits = 0;
  var timer = setInterval(function () {
    waits++;
    if (install() || waits > 1200) {   // give up after ~120s
      clearInterval(timer);
      if (!installed) banner('[!] gave up waiting for ' + MODULE + ' in pid ' + Process.id);
    }
  }, 100);
}
