/**
 * Frida hook — Capture ECDH key material from libezstreamclient.so
 *
 * Hooks:
 *   ezviz_ecdh_generatePublicAndPrivateKey — captures client key pair
 *   ezviz_ecdh_generateMasterKey — captures ECDH shared secret
 *   ezviz_ecdh_generateSessionKey — captures derived session key
 *   ezviz_ecdh_getSelfPublicKey — captures client public key
 *   ezviz_ecdh_getPeerPublickey — captures server public key
 *   ezviz_ecdh_SetSessionEncKey — captures final encryption key
 *   ezviz_ecdh_encECDHReqPackage — captures encrypted request packets
 *   ezviz_ecdh_init — captures initialization label
 *
 * Usage: frida -U -p <PID> -l hook-ecdh-keys.js
 * Then trigger a stream in the app to capture ECDH traffic.
 */

function readBytes(ptr, len) {
    if (!ptr || ptr.isNull()) return "(null)";
    try {
        return ptr.readByteArray(len);
    } catch(e) {
        return "(unreadable: " + e + ")";
    }
}

function bufToHex(buf, maxLen) {
    if (!buf) return "(null)";
    var arr = new Uint8Array(buf);
    maxLen = maxLen || arr.length;
    var hex = "";
    for (var i = 0; i < Math.min(arr.length, maxLen); i++) {
        hex += ("0" + arr[i].toString(16)).slice(-2);
    }
    if (arr.length > maxLen) hex += "...";
    return hex;
}

function ptrToHex(ptr, len) {
    if (!ptr || ptr.isNull()) return "(null)";
    try {
        var buf = ptr.readByteArray(len);
        return bufToHex(buf);
    } catch(e) {
        return "(err: " + e + ")";
    }
}

// Store captured values
var captured = {
    clientPublicKey: null,
    clientPrivateKey: null,
    serverPublicKey: null,
    masterKey: null,
    sessionKey: null,
    encKey: null,
    initLabel: null,
};

function hookEcdhFunctions(mod) {
    console.log("\n[*] Hooking ECDH functions in " + mod.name + " (base=" + mod.base + ")");

    var exports = mod.enumerateExports();
    var ecdhExports = [];
    exports.forEach(function(e) {
        if (e.name.toLowerCase().indexOf("ecdh") >= 0 ||
            e.name.toLowerCase().indexOf("master") >= 0 ||
            e.name.toLowerCase().indexOf("session") >= 0) {
            ecdhExports.push(e);
        }
    });

    console.log("[*] Found " + ecdhExports.length + " ECDH-related exports:");
    ecdhExports.forEach(function(e) {
        console.log("    " + e.type + " " + e.name + " @ " + e.address);
    });

    // --- ezviz_ecdh_init ---
    var initAddr = mod.findExportByName("ezviz_ecdh_init");
    if (initAddr) {
        Interceptor.attach(initAddr, {
            onEnter: function(args) {
                // First arg is typically the label string (e.g., "ezviz-ecdh")
                try {
                    var label = args[0].readCString();
                    console.log("\n[ECDH_INIT] label=" + JSON.stringify(label));
                    captured.initLabel = label;
                } catch(e) {
                    console.log("\n[ECDH_INIT] args[0]=" + args[0] + " (not a string)");
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_INIT] returned " + retval);
            }
        });
        console.log("[+] Hooked ezviz_ecdh_init");
    }

    // --- ezviz_ecdh_createSession ---
    var createSessionAddr = mod.findExportByName("ezviz_ecdh_createSession");
    if (createSessionAddr) {
        Interceptor.attach(createSessionAddr, {
            onEnter: function(args) {
                console.log("\n[ECDH_CREATE_SESSION] called");
                console.log("  args[0]=" + args[0] + " args[1]=" + args[1]);
            },
            onLeave: function(retval) {
                console.log("[ECDH_CREATE_SESSION] returned " + retval);
                // Return value is the session handle
                this.handle = retval;
            }
        });
        console.log("[+] Hooked ezviz_ecdh_createSession");
    }

    // --- ezviz_ecdh_generatePublicAndPrivateKey ---
    var genKeysAddr = mod.findExportByName("ezviz_ecdh_generatePublicAndPrivateKey");
    if (genKeysAddr) {
        Interceptor.attach(genKeysAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                console.log("\n[ECDH_GEN_KEYS] handle=" + args[0]);
            },
            onLeave: function(retval) {
                console.log("[ECDH_GEN_KEYS] returned " + retval);
            }
        });
        console.log("[+] Hooked ezviz_ecdh_generatePublicAndPrivateKey");
    }

    // --- ezviz_ecdh_getSelfPublicKey ---
    var getSelfPubAddr = mod.findExportByName("ezviz_ecdh_getSelfPublicKey");
    if (getSelfPubAddr) {
        Interceptor.attach(getSelfPubAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.outBuf = args[1];   // output buffer for public key
                this.outLen = args[2];   // output length pointer
                console.log("\n[ECDH_GET_SELF_PUBKEY] handle=" + args[0]);
            },
            onLeave: function(retval) {
                console.log("[ECDH_GET_SELF_PUBKEY] returned " + retval);
                if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                    // Try reading the output length
                    var len = 91; // SPKI DER format for P-256
                    try {
                        if (this.outLen && !this.outLen.isNull()) {
                            len = this.outLen.readU32();
                            console.log("[ECDH_GET_SELF_PUBKEY] outLen=" + len);
                        }
                    } catch(e) {}
                    var keyHex = ptrToHex(this.outBuf, len);
                    console.log("[ECDH_GET_SELF_PUBKEY] key (" + len + "B)=" + keyHex);
                    captured.clientPublicKey = keyHex;
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_getSelfPublicKey");
    }

    // --- ezviz_ecdh_getPeerPublickey ---
    var getPeerPubAddr = mod.findExportByName("ezviz_ecdh_getPeerPublickey");
    if (getPeerPubAddr) {
        Interceptor.attach(getPeerPubAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.outBuf = args[1];
                this.outLen = args[2];
                console.log("\n[ECDH_GET_PEER_PUBKEY] handle=" + args[0]);
            },
            onLeave: function(retval) {
                console.log("[ECDH_GET_PEER_PUBKEY] returned " + retval);
                if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                    var len = 91;
                    try {
                        if (this.outLen && !this.outLen.isNull()) {
                            len = this.outLen.readU32();
                        }
                    } catch(e) {}
                    var keyHex = ptrToHex(this.outBuf, len);
                    console.log("[ECDH_GET_PEER_PUBKEY] key (" + len + "B)=" + keyHex);
                    captured.serverPublicKey = keyHex;
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_getPeerPublickey");
    }

    // --- ezviz_ecdh_generateMasterKey ---
    // Signature: int ezviz_ecdh_generateMasterKey(handle, peerPubKey, peerPubKeyLen, outMasterKey, outLen)
    var genMasterAddr = mod.findExportByName("ezviz_ecdh_generateMasterKey");
    if (genMasterAddr) {
        Interceptor.attach(genMasterAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.peerPubKey = args[1];
                this.peerPubKeyLen = args[2].toInt32();
                this.outMasterKey = args[3];
                this.outLen = args[4];
                console.log("\n[ECDH_GEN_MASTER] handle=" + args[0] + " peerPubKeyLen=" + this.peerPubKeyLen);
                if (this.peerPubKey && !this.peerPubKey.isNull()) {
                    var peerHex = ptrToHex(this.peerPubKey, this.peerPubKeyLen);
                    console.log("[ECDH_GEN_MASTER] peerPubKey=" + peerHex);
                    captured.serverPublicKey = peerHex;
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_GEN_MASTER] returned " + retval);
                if (retval.toInt32() === 0 && this.outMasterKey && !this.outMasterKey.isNull()) {
                    var len = 32;
                    try {
                        if (this.outLen && !this.outLen.isNull()) {
                            len = this.outLen.readU32();
                        }
                    } catch(e) {}
                    var masterHex = ptrToHex(this.outMasterKey, len);
                    console.log("[ECDH_GEN_MASTER] masterKey (" + len + "B)=" + masterHex);
                    captured.masterKey = masterHex;
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_generateMasterKey");
    }

    // --- ezviz_ecdh_generateSessionKey ---
    var genSessionAddr = mod.findExportByName("ezviz_ecdh_generateSessionKey");
    if (genSessionAddr) {
        Interceptor.attach(genSessionAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.outKey = args[1];
                this.outLen = args[2];
                console.log("\n[ECDH_GEN_SESSION] handle=" + args[0]);
            },
            onLeave: function(retval) {
                console.log("[ECDH_GEN_SESSION] returned " + retval);
                if (retval.toInt32() === 0 && this.outKey && !this.outKey.isNull()) {
                    var len = 32;
                    try {
                        if (this.outLen && !this.outLen.isNull()) {
                            len = this.outLen.readU32();
                        }
                    } catch(e) {}
                    var sessionHex = ptrToHex(this.outKey, len);
                    console.log("[ECDH_GEN_SESSION] sessionKey (" + len + "B)=" + sessionHex);
                    captured.sessionKey = sessionHex;
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_generateSessionKey");
    }

    // --- ezviz_ecdh_SetSessionEncKey ---
    var setEncKeyAddr = mod.findExportByName("ezviz_ecdh_SetSessionEncKey");
    if (setEncKeyAddr) {
        Interceptor.attach(setEncKeyAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.key = args[1];
                this.keyLen = args[2].toInt32();
                console.log("\n[ECDH_SET_ENC_KEY] handle=" + args[0] + " keyLen=" + this.keyLen);
                if (this.key && !this.key.isNull()) {
                    var keyHex = ptrToHex(this.key, this.keyLen);
                    console.log("[ECDH_SET_ENC_KEY] key=" + keyHex);
                    captured.encKey = keyHex;
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_SET_ENC_KEY] returned " + retval);
            }
        });
        console.log("[+] Hooked ezviz_ecdh_SetSessionEncKey");
    }

    // --- ezviz_ecdh_setPBKeyAndPRKey ---
    var setPBPRAddr = mod.findExportByName("ezviz_ecdh_setPBKeyAndPRKey");
    if (setPBPRAddr) {
        Interceptor.attach(setPBPRAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.pubKey = args[1];
                this.pubKeyLen = args[2].toInt32();
                this.privKey = args[3];
                this.privKeyLen = args[4].toInt32();
                console.log("\n[ECDH_SET_PB_PR_KEY] pubKeyLen=" + this.pubKeyLen + " privKeyLen=" + this.privKeyLen);
                if (this.pubKey && !this.pubKey.isNull()) {
                    var pubHex = ptrToHex(this.pubKey, this.pubKeyLen);
                    console.log("[ECDH_SET_PB_PR_KEY] pubKey=" + pubHex);
                }
                if (this.privKey && !this.privKey.isNull()) {
                    var privHex = ptrToHex(this.privKey, this.privKeyLen);
                    console.log("[ECDH_SET_PB_PR_KEY] privKey=" + privHex);
                    captured.clientPrivateKey = privHex;
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_SET_PB_PR_KEY] returned " + retval);
            }
        });
        console.log("[+] Hooked ezviz_ecdh_setPBKeyAndPRKey");
    }

    // --- ezviz_ecdh_encECDHReqPackage ---
    var encReqAddr = mod.findExportByName("ezviz_ecdh_encECDHReqPackage");
    if (encReqAddr) {
        Interceptor.attach(encReqAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.inBuf = args[1];
                this.inLen = args[2].toInt32();
                this.outBuf = args[3];
                this.outLen = args[4];
                this.channelId = args[5];
                console.log("\n[ECDH_ENC_REQ] inLen=" + this.inLen + " channelId=" + this.channelId);
                if (this.inBuf && !this.inBuf.isNull() && this.inLen > 0) {
                    console.log("[ECDH_ENC_REQ] plaintext (" + this.inLen + "B)=" + ptrToHex(this.inBuf, Math.min(this.inLen, 256)));
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_ENC_REQ] returned " + retval);
                if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                    try {
                        var outLen = this.outLen.readU32();
                        console.log("[ECDH_ENC_REQ] ciphertext (" + outLen + "B)=" + ptrToHex(this.outBuf, Math.min(outLen, 256)));
                    } catch(e) {
                        console.log("[ECDH_ENC_REQ] could not read output: " + e);
                    }
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_encECDHReqPackage");
    }

    // --- ezviz_ecdh_decECDHReqPackage ---
    var decReqAddr = mod.findExportByName("ezviz_ecdh_decECDHReqPackage");
    if (decReqAddr) {
        Interceptor.attach(decReqAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.inBuf = args[1];
                this.inLen = args[2].toInt32();
                this.outBuf = args[3];
                this.outLen = args[4];
                console.log("\n[ECDH_DEC_REQ] inLen=" + this.inLen);
                if (this.inBuf && !this.inBuf.isNull() && this.inLen > 0) {
                    console.log("[ECDH_DEC_REQ] ciphertext (" + this.inLen + "B)=" + ptrToHex(this.inBuf, Math.min(this.inLen, 256)));
                }
            },
            onLeave: function(retval) {
                console.log("[ECDH_DEC_REQ] returned " + retval);
                if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                    try {
                        var outLen = this.outLen.readU32();
                        console.log("[ECDH_DEC_REQ] plaintext (" + outLen + "B)=" + ptrToHex(this.outBuf, Math.min(outLen, 256)));
                    } catch(e) {}
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_decECDHReqPackage");
    }

    // --- ezviz_ecdh_encECDHDataPackage / decECDHDataPackage ---
    var encDataAddr = mod.findExportByName("ezviz_ecdh_encECDHDataPackage");
    if (encDataAddr) {
        Interceptor.attach(encDataAddr, {
            onEnter: function(args) {
                this.inLen = args[2].toInt32();
                console.log("\n[ECDH_ENC_DATA] inLen=" + this.inLen);
            },
            onLeave: function(retval) {
                console.log("[ECDH_ENC_DATA] returned " + retval);
            }
        });
        console.log("[+] Hooked ezviz_ecdh_encECDHDataPackage");
    }

    var decDataAddr = mod.findExportByName("ezviz_ecdh_decECDHDataPackage");
    if (decDataAddr) {
        Interceptor.attach(decDataAddr, {
            onEnter: function(args) {
                this.handle = args[0];
                this.inBuf = args[1];
                this.inLen = args[2].toInt32();
                this.outBuf = args[3];
                this.outLen = args[4];
                // Only log first few data packets to avoid spam
                if (!this.constructor._dataCount) this.constructor._dataCount = 0;
                this.constructor._dataCount++;
                if (this.constructor._dataCount <= 5) {
                    console.log("\n[ECDH_DEC_DATA] #" + this.constructor._dataCount + " inLen=" + this.inLen);
                }
            },
            onLeave: function(retval) {
                if (this.constructor._dataCount <= 5) {
                    console.log("[ECDH_DEC_DATA] returned " + retval);
                    if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                        try {
                            var outLen = this.outLen.readU32();
                            console.log("[ECDH_DEC_DATA] plaintext (" + outLen + "B)=" + ptrToHex(this.outBuf, Math.min(outLen, 64)));
                        } catch(e) {}
                    }
                }
                if (this.constructor._dataCount === 5) {
                    console.log("[ECDH_DEC_DATA] (suppressing further data packet logs)");
                }
            }
        });
        console.log("[+] Hooked ezviz_ecdh_decECDHDataPackage");
    }

    // --- Also hook mbedtls_ecdh_calc_secret for raw shared secret ---
    var mbedMod = Process.findModuleByName("libmbedcrypto.so");
    if (mbedMod) {
        var calcSecretAddr = mbedMod.findExportByName("mbedtls_ecdh_calc_secret");
        if (calcSecretAddr) {
            Interceptor.attach(calcSecretAddr, {
                onEnter: function(args) {
                    this.ctx = args[0];
                    this.outLen = args[1];  // size_t *olen
                    this.outBuf = args[2];  // unsigned char *buf
                    this.bufLen = args[3].toInt32();  // size_t blen
                    console.log("\n[MBEDTLS_ECDH_CALC_SECRET] bufLen=" + this.bufLen);
                },
                onLeave: function(retval) {
                    console.log("[MBEDTLS_ECDH_CALC_SECRET] returned " + retval);
                    if (retval.toInt32() === 0 && this.outBuf && !this.outBuf.isNull()) {
                        var len = 32;
                        try {
                            len = this.outLen.readU32();
                        } catch(e) {}
                        var secretHex = ptrToHex(this.outBuf, len);
                        console.log("[MBEDTLS_ECDH_CALC_SECRET] sharedSecret (" + len + "B)=" + secretHex);
                        captured.masterKey = secretHex;
                    }
                }
            });
            console.log("[+] Hooked mbedtls_ecdh_calc_secret in " + mbedMod.name);
        }
    }

    // --- Hook mbedtls_ctr_drbg_random for session key generation ---
    if (mbedMod) {
        var drbgAddr = mbedMod.findExportByName("mbedtls_ctr_drbg_random");
        if (drbgAddr) {
            // This gets called a LOT, so we'll track calls from libezstreamclient only
            var modBase = mod.base;
            var modEnd = modBase.add(mod.size);
            Interceptor.attach(drbgAddr, {
                onEnter: function(args) {
                    this.ctx = args[0];
                    this.outBuf = args[1];
                    this.outLen = args[2].toInt32();
                    // Check if caller is from our target library
                    var retAddr = this.returnAddress;
                    this.isOurLib = retAddr.compare(modBase) >= 0 && retAddr.compare(modEnd) < 0;
                },
                onLeave: function(retval) {
                    if (this.isOurLib && retval.toInt32() === 0 && this.outLen === 32) {
                        var hex = ptrToHex(this.outBuf, this.outLen);
                        console.log("\n[MBEDTLS_CTR_DRBG] from libezstreamclient, " + this.outLen + "B=" + hex);
                        // This is likely the session key
                        captured.sessionKey = hex;
                    }
                }
            });
            console.log("[+] Hooked mbedtls_ctr_drbg_random (filtered to libezstreamclient callers)");
        }
    }

    // Print summary helper
    console.log("\n[*] All hooks installed. Trigger a stream to capture ECDH keys.");
    console.log("[*] Call printCaptured() to see captured values at any time.");
}

// Make printCaptured available
rpc.exports = {
    printCaptured: function() {
        return JSON.stringify(captured, null, 2);
    }
};

// Check if libezstreamclient.so is already loaded
var targetMod = Process.findModuleByName("libezstreamclient.so");
if (targetMod) {
    console.log("[*] libezstreamclient.so already loaded!");
    hookEcdhFunctions(targetMod);
} else {
    console.log("[*] libezstreamclient.so not yet loaded, watching for dlopen...");

    // Hook dlopen to catch when the library gets loaded
    // On modern Android, dlopen is in the linker namespace
    var dlopenNames = ["dlopen", "android_dlopen_ext"];
    var linkerName = Process.arch === "arm64" ? "linker64" : "linker";

    function onDlopen(args) {
        try {
            var path = args[0].readCString();
            if (path && path.indexOf("libezstreamclient") >= 0) {
                console.log("\n[*] dlopen(" + path + ") — target library loading!");
                this.isTarget = true;
            }
        } catch(e) {}
    }

    function onDlopenLeave(retval) {
        if (this.isTarget) {
            console.log("[*] dlopen returned " + retval);
            setTimeout(function() {
                var mod = Process.findModuleByName("libezstreamclient.so");
                if (mod) {
                    hookEcdhFunctions(mod);
                } else {
                    console.log("[!] Library loaded but not found by name — trying to enumerate...");
                    Process.enumerateModules().forEach(function(m) {
                        if (m.name.indexOf("ezstream") >= 0) {
                            console.log("[*] Found: " + m.name);
                            hookEcdhFunctions(m);
                        }
                    });
                }
            }, 500);
        }
    }

    var hooked = false;
    dlopenNames.forEach(function(name) {
        // Try null (any module), then linker specifically
        var locations = [null, linkerName];
        locations.forEach(function(mod) {
            if (hooked) return;
            try {
                var addr = Module.findExportByName(mod, name);
                if (addr) {
                    Interceptor.attach(addr, { onEnter: onDlopen, onLeave: onDlopenLeave });
                    console.log("[+] Watching " + name + " in " + (mod || "global") + " for libezstreamclient.so");
                    hooked = true;
                }
            } catch(e) {
                // Ignore — function may not exist in this module
            }
        });
    });

    if (!hooked) {
        console.log("[!] Could not hook dlopen — will poll for library loading instead");
        // Fallback: poll every 2 seconds
        var pollInterval = setInterval(function() {
            var mod = Process.findModuleByName("libezstreamclient.so");
            if (mod) {
                clearInterval(pollInterval);
                hookEcdhFunctions(mod);
            }
        }, 2000);
    }
}

// Also enumerate all currently loaded modules to find any streaming-related ones
console.log("\n[*] Currently loaded streaming-related modules:");
Process.enumerateModules().forEach(function(m) {
    var lower = m.name.toLowerCase();
    if (lower.indexOf("stream") >= 0 || lower.indexOf("ecdh") >= 0 ||
        lower.indexOf("cas") >= 0 || lower.indexOf("convergence") >= 0 ||
        lower.indexOf("mbed") >= 0 || lower.indexOf("ezviz") >= 0 ||
        lower.indexOf("stun") >= 0 || lower.indexOf("hcnet") >= 0 ||
        lower.indexOf("hccore") >= 0 || lower.indexOf("preview") >= 0) {
        console.log("  " + m.name + " @ " + m.base + " (" + m.size + "B)");
    }
});

console.log("\n[*] ECDH key capture hooks ready.");
console.log("[*] Now trigger a live stream in the Hik-Connect app.");
console.log("[*] Watch for [ECDH_*] log entries showing captured key material.");
