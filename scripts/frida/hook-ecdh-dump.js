/**
 * Frida hook — Dump ALL InitParam fields + ECDH key flow
 * Minimal intrusive — just logs, doesn't modify data flow.
 *
 * Usage: frida -U -p <PID> -l hook-ecdh-dump.js
 */

Java.perform(function() {
    var NativeApi = Java.use("com.ez.stream.NativeApi");

    // --- createPreviewHandle: dump all non-zero InitParam fields ---
    NativeApi.createPreviewHandle.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== createPreviewHandle ===");
            var p = arguments[0];
            if (p) {
                var f = p.getClass().getDeclaredFields();
                for (var i = 0; i < f.length; i++) {
                    f[i].setAccessible(true);
                    var n = f[i].getName();
                    var t = f[i].getType().getName();
                    var v = f[i].get(p);
                    if (v === null) continue;
                    if (t === "java.lang.String") {
                        var s = v.toString();
                        if (s.length === 0) continue;
                        if (s.length > 120) s = s.substring(0,120) + "...";
                        console.log("  " + n + " = " + JSON.stringify(s));
                    } else if (t === "int") {
                        if (v !== 0) console.log("  " + n + " = " + v);
                    } else if (t === "[B") {
                        try {
                            var ba = Java.array("byte", v);
                            var nonZero = false;
                            var h = "";
                            for (var k = 0; k < Math.min(ba.length, 128); k++) {
                                var b = (ba[k] + 256) % 256;
                                if (b !== 0) nonZero = true;
                                h += ("0" + b.toString(16)).slice(-2);
                            }
                            if (nonZero) console.log("  " + n + " (" + ba.length + "B) = " + h);
                        } catch(e) {}
                    } else if (t === "[S") {
                        try {
                            var sa = Java.array("short", v);
                            var nonZero = false;
                            var h = "";
                            for (var k = 0; k < Math.min(sa.length, 128); k++) {
                                var s = (sa[k] + 65536) % 65536;
                                if (s !== 0) nonZero = true;
                                h += ("0" + s.toString(16)).slice(-2);
                            }
                            if (nonZero) console.log("  " + n + " (" + sa.length + " shorts) = " + h);
                        } catch(e) {}
                    } else if (t === "boolean") {
                        if (v) console.log("  " + n + " = true");
                    } else if (t === "com.ez.stream.P2PServerKey") {
                        try {
                            var kf = v.getClass().getDeclaredFields();
                            for (var j = 0; j < kf.length; j++) {
                                kf[j].setAccessible(true);
                                var kn = kf[j].getName();
                                var kv = kf[j].get(v);
                                if (kv === null) continue;
                                var kt = kf[j].getType().getName();
                                if (kt === "[S") {
                                    try {
                                        var ks = Java.array("short", kv);
                                        var kh = "";
                                        for (var k = 0; k < ks.length; k++) kh += ("0"+((ks[k]+256)%256).toString(16)).slice(-2);
                                        console.log("  stP2PServerKey." + kn + " = " + kh);
                                    } catch(e) {}
                                } else if (kt === "int") {
                                    if (kv !== 0) console.log("  stP2PServerKey." + kn + " = " + kv);
                                }
                            }
                        } catch(e) {
                            console.log("  stP2PServerKey = (err: " + e + ")");
                        }
                    } else if (t.indexOf("EZP2PServerInfo") >= 0) {
                        try {
                            var arr = Java.array("Lcom.ez.stream.EZP2PServerInfo;", v);
                            for (var j = 0; j < arr.length; j++) {
                                if (arr[j] === null) continue;
                                var sf = arr[j].getClass().getDeclaredFields();
                                var info = "  p2pServer[" + j + "]: ";
                                for (var k = 0; k < sf.length; k++) {
                                    sf[k].setAccessible(true);
                                    var sv = sf[k].get(arr[j]);
                                    if (sv !== null) info += sf[k].getName() + "=" + sv + " ";
                                }
                                console.log(info);
                            }
                        } catch(e) {}
                    }
                }
            }
            var result = method.call(this, ...arguments);
            console.log("  => handle=" + result);
            return result;
        };
    });

    // --- setSecretKey ---
    NativeApi.setSecretKey.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== setSecretKey ===");
            console.log("  handle=" + arguments[0]);
            console.log("  secretKey=" + JSON.stringify(arguments[1] ? arguments[1].toString() : null));
            return method.call(this, ...arguments);
        };
    });

    // --- generateECDHKey ---
    NativeApi.generateECDHKey.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== generateECDHKey ===");
            var result = method.call(this, ...arguments);
            console.log("  returned: " + result);
            // Dump the EZEcdhKeyInfo output
            if (arguments[0]) {
                var info = arguments[0];
                var f = info.getClass().getDeclaredFields();
                for (var i = 0; i < f.length; i++) {
                    f[i].setAccessible(true);
                    var n = f[i].getName();
                    var v = f[i].get(info);
                    if (v === null) continue;
                    var t = f[i].getType().getName();
                    if (t === "[B") {
                        try {
                            var ba = Java.array("byte", v);
                            var h = "";
                            for (var k = 0; k < ba.length; k++) h += ("0"+((ba[k]+256)%256).toString(16)).slice(-2);
                            console.log("  " + n + " (" + ba.length + "B) = " + h);
                        } catch(e) {}
                    } else if (t === "int") {
                        console.log("  " + n + " = " + v);
                    }
                }
            }
            return result;
        };
    });

    // --- setClientECDHKey ---
    NativeApi.setClientECDHKey.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== setClientECDHKey ===");
            // args: byte[] pubKey, int pubKeyLen, byte[] privKey, int privKeyLen
            if (arguments[0]) {
                try {
                    var pub = Java.array("byte", arguments[0]);
                    var h = "";
                    for (var k = 0; k < pub.length; k++) h += ("0"+((pub[k]+256)%256).toString(16)).slice(-2);
                    console.log("  pubKey (" + arguments[1] + "B) = " + h);
                } catch(e) {}
            }
            if (arguments[2]) {
                try {
                    var priv = Java.array("byte", arguments[2]);
                    var h = "";
                    for (var k = 0; k < priv.length; k++) h += ("0"+((priv[k]+256)%256).toString(16)).slice(-2);
                    console.log("  privKey (" + arguments[3] + "B) = " + h);
                } catch(e) {}
            }
            return method.call(this, ...arguments);
        };
    });

    // --- enableStreamClientCMDEcdh ---
    NativeApi.enableStreamClientCMDEcdh.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== enableStreamClientCMDEcdh ===");
            return method.call(this, ...arguments);
        };
    });

    // --- enableTTSCMDEcdh ---
    NativeApi.enableTTSCMDEcdh.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== enableTTSCMDEcdh ===");
            return method.call(this, ...arguments);
        };
    });

    // --- startPreview ---
    NativeApi.startPreview.overloads.forEach(function(method) {
        method.implementation = function() {
            console.log("\n=== startPreview ===");
            for (var i = 0; i < arguments.length; i++) {
                console.log("  arg" + i + " = " + arguments[i]);
            }
            return method.call(this, ...arguments);
        };
    });

    console.log("[*] Hooks ready. Navigate to a camera.");
});
