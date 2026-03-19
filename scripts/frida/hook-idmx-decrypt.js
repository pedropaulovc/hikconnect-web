/**
 * Frida script to hook IDMX_AES_decrypt_128 in libPlayCtrl.so
 * Captures the actual AES key, input data, and decrypt parameters.
 *
 * Usage:
 *   frida -U -f com.connect.enduser -l scripts/frida/hook-idmx-decrypt.js
 *   (then start a live preview in the app)
 *
 * What we need to capture:
 * - param_1: data pointer (in-place decrypt)
 * - param_2: data length (should be 0x10 for H.265)
 * - param_3: AES key pointer (16 bytes)
 * - param_4: rounds parameter (expected 3 for H.265)
 */

'use strict';

function findExport(lib, name) {
    const addr = Module.findExportByName(lib, name);
    if (addr) return addr;
    // Try finding by scanning symbols
    const mod = Process.findModuleByName(lib);
    if (!mod) return null;
    for (const exp of mod.enumerateExports()) {
        if (exp.name.includes(name)) return exp.address;
    }
    return null;
}

function hexdump16(ptr) {
    return Array.from(new Uint8Array(ptr.readByteArray(16)))
        .map(b => ('0' + b.toString(16)).slice(-2))
        .join('');
}

function hookIDMXDecrypt() {
    const lib = 'libPlayCtrl.so';
    const mod = Process.findModuleByName(lib);
    if (!mod) {
        console.log('[!] ' + lib + ' not loaded yet, waiting...');
        return false;
    }

    // Find IDMX_AES_decrypt_128 — search exports
    let target = null;
    for (const exp of mod.enumerateExports()) {
        if (exp.name.includes('IDMX_AES_decrypt_128')) {
            target = exp.address;
            console.log('[+] Found ' + exp.name + ' at ' + target);
            break;
        }
    }

    if (!target) {
        // Try known offsets from Ghidra analysis
        const offsets = [0x004a41bc, 0x00231890];
        for (const off of offsets) {
            target = mod.base.add(off);
            console.log('[?] Trying offset 0x' + off.toString(16) + ' → ' + target);
        }
    }

    if (!target) {
        console.log('[!] Could not find IDMX_AES_decrypt_128');
        return false;
    }

    let callCount = 0;

    Interceptor.attach(target, {
        onEnter: function(args) {
            this.data = args[0];
            this.len = args[1].toInt32();
            this.key = args[2];
            this.rounds = args[3] ? args[3].toInt32() : -1;

            if (callCount < 10) {
                console.log('\n[IDMX_AES_decrypt_128] call #' + callCount);
                console.log('  data_ptr: ' + this.data);
                console.log('  length: ' + this.len + ' (0x' + this.len.toString(16) + ')');
                console.log('  rounds: ' + this.rounds);
                console.log('  key[0..15]: ' + hexdump16(this.key));
                if (this.len <= 32) {
                    console.log('  input[0..15]: ' + hexdump16(this.data));
                }
            }
        },
        onLeave: function(retval) {
            if (callCount < 10) {
                if (this.len <= 32) {
                    console.log('  output[0..15]: ' + hexdump16(this.data));
                    const nalType = (this.data.readU8() >> 1) & 0x3f;
                    console.log('  decrypted NAL type: ' + nalType);
                }
            }
            callCount++;
            if (callCount === 10) {
                console.log('\n[+] Suppressing further output (10 calls logged)');
            }
        }
    });

    console.log('[+] Hooked IDMX_AES_decrypt_128 at ' + target);
    return true;
}

// Also hook PlayM4_SetSecretKey to see what key is passed
function hookSetSecretKey() {
    const lib = 'libPlayCtrl.so';
    const mod = Process.findModuleByName(lib);
    if (!mod) return;

    for (const exp of mod.enumerateExports()) {
        if (exp.name === 'PlayM4_SetSecretKey') {
            Interceptor.attach(exp.address, {
                onEnter: function(args) {
                    const port = args[0].toInt32();
                    const keyType = args[1].toInt32();
                    const keyData = args[2];
                    const keyLen = args[3].toInt32();
                    console.log('\n[PlayM4_SetSecretKey]');
                    console.log('  port: ' + port);
                    console.log('  keyType: ' + keyType);
                    console.log('  keyLen: ' + keyLen);
                    if (keyData && !keyData.isNull()) {
                        const strKey = keyData.readUtf8String();
                        console.log('  keyData (string): "' + strKey + '"');
                        console.log('  keyData (hex): ' + hexdump16(keyData));
                    }
                }
            });
            console.log('[+] Hooked PlayM4_SetSecretKey');
            break;
        }
    }
}

// Also hook IDMX_SetDecrptKey to see the key at the IDMX level
function hookSetDecrptKey() {
    const lib = 'libPlayCtrl.so';
    const mod = Process.findModuleByName(lib);
    if (!mod) return;

    for (const exp of mod.enumerateExports()) {
        if (exp.name.includes('IDMX_SetDecrptKey')) {
            Interceptor.attach(exp.address, {
                onEnter: function(args) {
                    console.log('\n[IDMX_SetDecrptKey]');
                    console.log('  arg0 (handle): ' + args[0]);
                    if (args[1] && !args[1].isNull()) {
                        console.log('  arg1 (key hex): ' + hexdump16(args[1]));
                        try { console.log('  arg1 (string): "' + args[1].readUtf8String() + '"'); } catch(e) {}
                    }
                    console.log('  arg2 (keyLen): ' + args[2]);
                    console.log('  arg3 (keyType): ' + args[3]);
                }
            });
            console.log('[+] Hooked IDMX_SetDecrptKey');
            break;
        }
    }
}

// Try hooking immediately, or wait for lib to load
if (!hookIDMXDecrypt()) {
    const interval = setInterval(function() {
        if (hookIDMXDecrypt()) {
            hookSetSecretKey();
            hookSetDecrptKey();
            clearInterval(interval);
        }
    }, 1000);
} else {
    hookSetSecretKey();
    hookSetDecrptKey();
}

console.log('[*] IDMX decrypt hook script loaded');
console.log('[*] Start a live preview in the Hik-Connect app to trigger decryption');
