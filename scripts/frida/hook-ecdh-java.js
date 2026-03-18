/**
 * Frida hook — Capture ECDH key material via Java-level hooks
 *
 * Hooks NativeApi ECDH methods and EZEcdhKeyInfo class.
 * Also watches for native library loading.
 *
 * Usage: frida -U -p <PID> -l hook-ecdh-java.js
 */

function ptrToHex(ptr, len) {
    if (!ptr || ptr.isNull()) return "(null)";
    try {
        var buf = ptr.readByteArray(len);
        var arr = new Uint8Array(buf);
        var hex = "";
        for (var i = 0; i < arr.length; i++) {
            hex += ("0" + arr[i].toString(16)).slice(-2);
        }
        return hex;
    } catch(e) {
        return "(err: " + e + ")";
    }
}

function byteArrayToHex(javaByteArray) {
    if (!javaByteArray) return "(null)";
    try {
        var arr = Java.array("byte", javaByteArray);
        var hex = "";
        for (var i = 0; i < arr.length; i++) {
            hex += ("0" + ((arr[i] + 256) % 256).toString(16)).slice(-2);
        }
        return hex;
    } catch(e) {
        return "(err: " + e + ")";
    }
}

Java.perform(function() {
    // ========== Hook EZEcdhKeyInfo ==========
    try {
        var EZEcdhKeyInfo = Java.use("com.ez.stream.EZEcdhKeyInfo");
        console.log("\n[*] EZEcdhKeyInfo class found");

        // Enumerate all fields
        var fields = EZEcdhKeyInfo.class.getDeclaredFields();
        console.log("[*] EZEcdhKeyInfo fields (" + fields.length + "):");
        for (var i = 0; i < fields.length; i++) {
            console.log("    " + fields[i].getType().getName() + " " + fields[i].getName());
        }

        // Enumerate constructors
        var ctors = EZEcdhKeyInfo.class.getDeclaredConstructors();
        console.log("[*] EZEcdhKeyInfo constructors (" + ctors.length + "):");
        for (var i = 0; i < ctors.length; i++) {
            console.log("    " + ctors[i].toString());
        }

        // Try to hook the constructor
        if (EZEcdhKeyInfo.$init) {
            try {
                EZEcdhKeyInfo.$init.implementation = function() {
                    console.log("\n[ECDH_KEY_INFO] Constructor called");
                    this.$init.apply(this, arguments);
                    // Dump all fields after construction
                    var f = this.getClass().getDeclaredFields();
                    for (var i = 0; i < f.length; i++) {
                        f[i].setAccessible(true);
                        var name = f[i].getName();
                        var val = f[i].get(this);
                        if (val !== null) {
                            if (val.getClass && val.getClass().isArray()) {
                                try {
                                    var arr = Java.array("byte", val);
                                    var hex = "";
                                    for (var j = 0; j < arr.length; j++) {
                                        hex += ("0" + ((arr[j] + 256) % 256).toString(16)).slice(-2);
                                    }
                                    console.log("[ECDH_KEY_INFO]   " + name + " (" + arr.length + "B)=" + hex);
                                } catch(e2) {
                                    console.log("[ECDH_KEY_INFO]   " + name + "=" + val);
                                }
                            } else {
                                console.log("[ECDH_KEY_INFO]   " + name + "=" + val);
                            }
                        }
                    }
                };
                console.log("[+] Hooked EZEcdhKeyInfo constructor");
            } catch(e) {
                console.log("[!] Could not hook EZEcdhKeyInfo constructor: " + e);
            }
        }
    } catch(e) {
        console.log("[!] EZEcdhKeyInfo not found: " + e);
    }

    // ========== Hook NativeApi ECDH methods ==========
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        console.log("\n[*] NativeApi class found");

        // --- generateECDHKey ---
        try {
            var genMethods = NativeApi.generateECDHKey.overloads;
            console.log("[*] generateECDHKey has " + genMethods.length + " overloads");
            genMethods.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[ECDH_GEN_KEY] generateECDHKey called (overload " + idx + ")");
                    for (var i = 0; i < arguments.length; i++) {
                        var arg = arguments[i];
                        if (arg !== null && arg !== undefined) {
                            console.log("[ECDH_GEN_KEY]   arg" + i + " type=" + typeof arg + " value=" + arg);
                        }
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[ECDH_GEN_KEY] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked generateECDHKey");
        } catch(e) {
            console.log("[!] Could not hook generateECDHKey: " + e);
        }

        // --- setClientECDHKey ---
        try {
            var setKeyMethods = NativeApi.setClientECDHKey.overloads;
            console.log("[*] setClientECDHKey has " + setKeyMethods.length + " overloads");
            setKeyMethods.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[ECDH_SET_KEY] setClientECDHKey called (overload " + idx + ")");
                    for (var i = 0; i < arguments.length; i++) {
                        var arg = arguments[i];
                        if (arg !== null && arg !== undefined) {
                            var type = typeof arg;
                            if (type === "object" && arg.getClass) {
                                var className = arg.getClass().getName();
                                console.log("[ECDH_SET_KEY]   arg" + i + " class=" + className);
                                // If it's EZEcdhKeyInfo, dump fields
                                if (className.indexOf("EcdhKey") >= 0 || className.indexOf("Ecdh") >= 0) {
                                    var f = arg.getClass().getDeclaredFields();
                                    for (var j = 0; j < f.length; j++) {
                                        f[j].setAccessible(true);
                                        var name = f[j].getName();
                                        var val = f[j].get(arg);
                                        if (val !== null) {
                                            try {
                                                var ba = Java.array("byte", val);
                                                var hex = "";
                                                for (var k = 0; k < ba.length; k++) {
                                                    hex += ("0" + ((ba[k] + 256) % 256).toString(16)).slice(-2);
                                                }
                                                console.log("[ECDH_SET_KEY]     " + name + " (" + ba.length + "B)=" + hex);
                                            } catch(e2) {
                                                console.log("[ECDH_SET_KEY]     " + name + "=" + val);
                                            }
                                        }
                                    }
                                }
                            } else {
                                console.log("[ECDH_SET_KEY]   arg" + i + "=" + arg);
                            }
                        }
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[ECDH_SET_KEY] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked setClientECDHKey");
        } catch(e) {
            console.log("[!] Could not hook setClientECDHKey: " + e);
        }

        // --- enableStreamClientCMDEcdh ---
        try {
            NativeApi.enableStreamClientCMDEcdh.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[ECDH_ENABLE] enableStreamClientCMDEcdh called");
                    for (var i = 0; i < arguments.length; i++) {
                        console.log("[ECDH_ENABLE]   arg" + i + "=" + arguments[i]);
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[ECDH_ENABLE] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked enableStreamClientCMDEcdh");
        } catch(e) {
            console.log("[!] Could not hook enableStreamClientCMDEcdh: " + e);
        }

        // --- enableTTSCMDEcdh ---
        try {
            NativeApi.enableTTSCMDEcdh.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[ECDH_TTS] enableTTSCMDEcdh called");
                    for (var i = 0; i < arguments.length; i++) {
                        console.log("[ECDH_TTS]   arg" + i + "=" + arguments[i]);
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[ECDH_TTS] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked enableTTSCMDEcdh");
        } catch(e) {
            console.log("[!] Could not hook enableTTSCMDEcdh: " + e);
        }

        // --- createPreviewHandle ---
        // NOTE: This is a native JNI method. We must NOT modify how args are passed
        // or inspect complex JNI objects, as it can crash the native code.
        // Just log that it was called and dump safe string/int fields from InitParam.
        try {
            NativeApi.createPreviewHandle.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[CREATE_PREVIEW] createPreviewHandle called (overload " + idx + ")");
                    // Dump InitParam BEFORE calling native - only safe field types
                    if (arguments.length > 0 && arguments[0] !== null) {
                        var param = arguments[0];
                        try {
                            var f = param.getClass().getDeclaredFields();
                            for (var i = 0; i < f.length; i++) {
                                f[i].setAccessible(true);
                                var name = f[i].getName();
                                var fieldType = f[i].getType().getName();

                                // Only dump string and int fields (safe for JNI)
                                if (name.indexOf("P2P") >= 0 || name.indexOf("Key") >= 0 ||
                                    name.indexOf("ecdh") >= 0 || name.indexOf("Ecdh") >= 0 ||
                                    name.indexOf("ECDH") >= 0 || name.indexOf("Session") >= 0 ||
                                    name.indexOf("secret") >= 0 || name.indexOf("Serial") >= 0 ||
                                    name.indexOf("Token") >= 0 || name.indexOf("token") >= 0 ||
                                    name.indexOf("udp") >= 0) {
                                    var val = f[i].get(param);
                                    if (val === null) continue;

                                    if (fieldType === "java.lang.String") {
                                        console.log("[CREATE_PREVIEW]   " + name + " (String)=" + val.toString().substring(0, 100));
                                    } else if (fieldType === "int" || fieldType === "long" || fieldType === "short") {
                                        console.log("[CREATE_PREVIEW]   " + name + " (" + fieldType + ")=" + val);
                                    } else if (fieldType === "[B") {
                                        // Byte array - read carefully
                                        try {
                                            var ba = Java.array("byte", val);
                                            var hex = "";
                                            for (var k = 0; k < Math.min(ba.length, 128); k++) {
                                                hex += ("0" + ((ba[k] + 256) % 256).toString(16)).slice(-2);
                                            }
                                            console.log("[CREATE_PREVIEW]   " + name + " (" + ba.length + "B)=" + hex);
                                        } catch(e2) {
                                            console.log("[CREATE_PREVIEW]   " + name + " (byte[] read error)");
                                        }
                                    } else if (fieldType === "[S") {
                                        // Short array (like P2PKey)
                                        try {
                                            var sa = Java.array("short", val);
                                            var hex = "";
                                            for (var k = 0; k < Math.min(sa.length, 128); k++) {
                                                hex += ("0" + ((sa[k] + 256) % 256).toString(16)).slice(-2);
                                            }
                                            console.log("[CREATE_PREVIEW]   " + name + " (" + sa.length + " shorts)=" + hex);
                                        } catch(e2) {
                                            console.log("[CREATE_PREVIEW]   " + name + " (short[] read error)");
                                        }
                                    } else {
                                        console.log("[CREATE_PREVIEW]   " + name + " (type=" + fieldType + ")");
                                    }
                                }
                            }
                        } catch(e) {
                            console.log("[CREATE_PREVIEW] Error dumping param: " + e);
                        }
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[CREATE_PREVIEW] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked createPreviewHandle");
        } catch(e) {
            console.log("[!] Could not hook createPreviewHandle: " + e);
        }

        // --- initSDK / initSDKEx ---
        try {
            NativeApi.initSDK.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[INIT_SDK] initSDK called");
                    var result = method.call(this, ...arguments);
                    console.log("[INIT_SDK] returned: " + result);

                    // After SDK init, check for loaded native modules
                    setTimeout(function() {
                        var mods = Process.enumerateModules();
                        mods.forEach(function(m) {
                            if (m.name.indexOf("ezstream") >= 0 || m.name.indexOf("mbed") >= 0 ||
                                m.name.indexOf("Convergence") >= 0) {
                                console.log("[INIT_SDK] Native lib loaded: " + m.name + " @ " + m.base);
                            }
                        });
                    }, 2000);

                    return result;
                };
            });
            console.log("[+] Hooked initSDK");
        } catch(e) {
            console.log("[!] Could not hook initSDK: " + e);
        }

        // --- startPreview ---
        try {
            NativeApi.startPreview.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[START_PREVIEW] startPreview called");
                    for (var i = 0; i < arguments.length; i++) {
                        console.log("[START_PREVIEW]   arg" + i + "=" + arguments[i]);
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[START_PREVIEW] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked startPreview");
        } catch(e) {
            console.log("[!] Could not hook startPreview: " + e);
        }

        // --- setSecretKey ---
        try {
            NativeApi.setSecretKey.overloads.forEach(function(method, idx) {
                method.implementation = function() {
                    console.log("\n[SECRET_KEY] setSecretKey called");
                    for (var i = 0; i < arguments.length; i++) {
                        var arg = arguments[i];
                        if (arg !== null && arg !== undefined) {
                            if (typeof arg === "object" && arg.getClass) {
                                console.log("[SECRET_KEY]   arg" + i + " class=" + arg.getClass().getName());
                                // Dump byte arrays
                                try {
                                    var ba = Java.array("byte", arg);
                                    var hex = "";
                                    for (var k = 0; k < ba.length; k++) {
                                        hex += ("0" + ((ba[k] + 256) % 256).toString(16)).slice(-2);
                                    }
                                    console.log("[SECRET_KEY]   arg" + i + " hex=" + hex);
                                } catch(e2) {}
                            } else {
                                console.log("[SECRET_KEY]   arg" + i + "=" + arg);
                            }
                        }
                    }
                    var result = method.call(this, ...arguments);
                    console.log("[SECRET_KEY] returned: " + result);
                    return result;
                };
            });
            console.log("[+] Hooked setSecretKey");
        } catch(e) {
            console.log("[!] Could not hook setSecretKey: " + e);
        }

    } catch(e) {
        console.log("[!] NativeApi not found: " + e);
    }

    // ========== Hook StreamClientManager for ECDH flow ==========
    try {
        var SCM = Java.use("com.ezplayer.common.StreamClientManager");
        console.log("\n[*] StreamClientManager found");

        // Get methods related to ECDH
        var methods = SCM.class.getDeclaredMethods();
        for (var i = 0; i < methods.length; i++) {
            var name = methods[i].getName();
            if (name.toLowerCase().indexOf("ecdh") >= 0 ||
                name.toLowerCase().indexOf("key") >= 0 ||
                name.toLowerCase().indexOf("crypto") >= 0 ||
                name.toLowerCase().indexOf("encrypt") >= 0) {
                console.log("[*] StreamClientManager method: " + methods[i].toString());
            }
        }
    } catch(e) {
        console.log("[!] StreamClientManager: " + e);
    }

    // ========== Watch System.loadLibrary ==========
    try {
        var System = Java.use("java.lang.System");
        System.loadLibrary.implementation = function(name) {
            console.log("\n[LOAD_LIB] System.loadLibrary(" + name + ")");
            System.loadLibrary.call(this, name);
            console.log("[LOAD_LIB] " + name + " loaded successfully");

            // If it's the streaming lib, try hooking native ECDH
            if (name.indexOf("ezstream") >= 0) {
                setTimeout(function() {
                    var mod = Process.findModuleByName("lib" + name + ".so");
                    if (mod) {
                        console.log("[LOAD_LIB] Found module: " + mod.name + " @ " + mod.base);
                        var exports = mod.enumerateExports();
                        exports.forEach(function(e) {
                            if (e.name.indexOf("ecdh") >= 0) {
                                console.log("[LOAD_LIB]   ECDH export: " + e.name + " @ " + e.address);
                            }
                        });
                    }
                }, 1000);
            }
        };
        console.log("[+] Hooked System.loadLibrary");
    } catch(e) {
        console.log("[!] Could not hook System.loadLibrary: " + e);
    }

    try {
        var Runtime = Java.use("java.lang.Runtime");
        Runtime.loadLibrary0.overloads.forEach(function(method) {
            method.implementation = function() {
                var libName = arguments[arguments.length - 1];
                console.log("\n[LOAD_LIB0] Runtime.loadLibrary0(" + libName + ")");
                var result = method.call(this, ...arguments);
                return result;
            };
        });
        console.log("[+] Hooked Runtime.loadLibrary0");
    } catch(e) {
        console.log("[!] Could not hook Runtime.loadLibrary0: " + e);
    }

    console.log("\n[*] Java ECDH hooks ready. Trigger a stream now.");
});
