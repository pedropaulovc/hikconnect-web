/**
 * Frida hook - BROAD capture: all TCP connections + native lib exports
 * Usage: frida -U -p <PID> -l hook-stream-broad.js
 */

function dumpHex(buf, maxLen) {
    if (!buf) return "(null)";
    maxLen = maxLen || 512;
    var arr = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, maxLen)));
    var hex = "";
    var ascii = "";
    var result = "";
    for (var i = 0; i < arr.length; i++) {
        hex += ("0" + arr[i].toString(16)).slice(-2) + " ";
        ascii += (arr[i] >= 32 && arr[i] < 127) ? String.fromCharCode(arr[i]) : ".";
        if ((i + 1) % 16 === 0) {
            result += hex + " | " + ascii + "\n";
            hex = "";
            ascii = "";
        }
    }
    if (hex) result += hex.padEnd(48) + " | " + ascii + "\n";
    return result;
}

// Track ALL connections (no filtering)
var allFds = {};

function findExport(lib, func) {
    if (lib) {
        var mod = Process.findModuleByName(lib);
        return mod ? mod.findExportByName(func) : null;
    }
    var mods = Process.enumerateModules();
    for (var i = 0; i < mods.length; i++) {
        var ptr = mods[i].findExportByName(func);
        if (ptr) return ptr;
    }
    return null;
}

function tryHook(lib, func, callbacks) {
    try {
        var ptr = findExport(lib, func);
        if (ptr) {
            Interceptor.attach(ptr, callbacks);
            console.log("[*] Hooked " + func);
            return true;
        }
        console.log("[!] " + func + " not found");
        return false;
    } catch(e) {
        console.log("[!] Failed to hook " + func + ": " + e);
        return false;
    }
}

tryHook(null, "connect", {
    onEnter: function(args) {
        try {
            var addr = args[1];
            var family = addr.readU16();
            if (family === 2) { // AF_INET
                var port = (addr.add(2).readU8() << 8) | addr.add(3).readU8();
                var ip = addr.add(4).readU8() + "." + addr.add(5).readU8() + "." + addr.add(6).readU8() + "." + addr.add(7).readU8();
                var fd = args[0].toInt32();
                console.log("\n[CONNECT] fd=" + fd + " -> " + ip + ":" + port);
                allFds[fd] = ip + ":" + port;
                this.fd = fd;
            }
        } catch(e) {}
    },
    onLeave: function(retval) {
        if (this.fd !== undefined) {
            console.log("[CONNECT] fd=" + this.fd + " result=" + retval.toInt32());
        }
    }
});

// Hook sendto - capture first 256 bytes of all sends
tryHook(null, "sendto", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var sent = retval.toInt32();
        if (sent > 0 && allFds[this.fd]) {
            console.log("\n[SENDTO] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + sent);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(sent, 512)), 512)); } catch(e) {}
        }
    }
});

tryHook(null, "send", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var sent = retval.toInt32();
        if (sent > 0 && allFds[this.fd]) {
            console.log("\n[SEND] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + sent);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(sent, 512)), 512)); } catch(e) {}
        }
    }
});

tryHook(null, "recvfrom", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var received = retval.toInt32();
        if (received > 0 && allFds[this.fd]) {
            console.log("\n[RECVFROM] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + received);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(received, 512)), 512)); } catch(e) {}
        }
    }
});

tryHook(null, "recv", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var received = retval.toInt32();
        if (received > 0 && allFds[this.fd]) {
            console.log("\n[RECV] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + received);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(received, 512)), 512)); } catch(e) {}
        }
    }
});

// Also capture write/read on tracked fds (but filter out very small writes that are likely pipes)
tryHook(null, "write", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var written = retval.toInt32();
        if (written > 0 && allFds[this.fd]) {
            console.log("\n[WRITE] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + written);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(written, 512)), 512)); } catch(e) {}
        }
    }
});

tryHook(null, "read", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var bytesRead = retval.toInt32();
        if (bytesRead > 0 && allFds[this.fd]) {
            console.log("\n[READ] fd=" + this.fd + " (" + allFds[this.fd] + ") len=" + bytesRead);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(bytesRead, 512)), 512)); } catch(e) {}
        }
    }
});

// Enumerate native streaming libraries
setTimeout(function() {
    var libs = ["libezstreamclient.so", "libStreamClient.so", "libhcnetsdk.so",
                "libPlayCtrl.so", "libHCPreview.so", "libstunClient.so",
                "libConvergenceEncrypt.so"];
    libs.forEach(function(name) {
        var mod = Process.findModuleByName(name);
        if (mod) {
            console.log("\n[LIB] " + name + " loaded at " + mod.base + " (" + mod.size + " bytes)");
            var exports = mod.enumerateExports();
            console.log("[LIB] " + name + " has " + exports.length + " exports");
            exports.forEach(function(e) {
                console.log("  " + e.type + " " + e.name);
            });
        }
    });

    // Also check for any loaded module with "stream" or "vtdu" in name
    Process.enumerateModules().forEach(function(mod) {
        var lower = mod.name.toLowerCase();
        if (lower.indexOf("stream") >= 0 || lower.indexOf("vtdu") >= 0 ||
            lower.indexOf("p2p") >= 0 || lower.indexOf("play") >= 0 ||
            lower.indexOf("hcnet") >= 0 || lower.indexOf("stun") >= 0) {
            console.log("[MOD] " + mod.name + " at " + mod.base + " (" + mod.size + ")");
        }
    });
}, 2000);

console.log("[*] Broad hooks loaded — capturing ALL connections.");
