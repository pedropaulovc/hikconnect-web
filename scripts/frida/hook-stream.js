/**
 * Frida hook for Hik-Connect — capture VTDU protocol bytes
 * Usage: frida -U -p <PID> -l hook-stream.js
 */

function dumpHex(buf, maxLen) {
    if (!buf) return "(null)";
    maxLen = maxLen || 256;
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

var interestingFds = {};

function findExport(lib, func) {
    if (lib) {
        var mod = Process.findModuleByName(lib);
        return mod ? mod.findExportByName(func) : null;
    }
    // Search all modules
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
            console.log("[*] Hooked " + func + (lib ? " in " + lib : ""));
            return true;
        }
        console.log("[!] " + func + " not found" + (lib ? " in " + lib : ""));
        return false;
    } catch(e) {
        console.log("[!] Failed to hook " + func + ": " + e);
        return false;
    }
}

// HOOK: connect()
tryHook(null, "connect", {
    onEnter: function(args) {
        try {
            var addr = args[1];
            var family = addr.readU16();
            if (family === 2) {
                var port = (addr.add(2).readU8() << 8) | addr.add(3).readU8();
                var ip = addr.add(4).readU8() + "." + addr.add(5).readU8() + "." + addr.add(6).readU8() + "." + addr.add(7).readU8();
                if (port === 8554 || port === 6123 || port === 8555 || ip.indexOf("148.153.") === 0 || port > 6000) {
                    var fd = args[0].toInt32();
                    console.log("\n[CONNECT] fd=" + fd + " -> " + ip + ":" + port);
                    interestingFds[fd] = ip + ":" + port;
                    this.fd = fd;
                }
            }
        } catch(e) {}
    },
    onLeave: function(retval) {
        if (this.fd !== undefined) {
            console.log("[CONNECT] fd=" + this.fd + " result=" + retval.toInt32());
        }
    }
});

// HOOK: sendto() — often used instead of send()
tryHook(null, "sendto", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var sent = retval.toInt32();
        if (sent > 0 && interestingFds[this.fd]) {
            console.log("\n[SENDTO] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + sent);
            try { console.log(dumpHex(this.buf.readByteArray(sent), 1024)); } catch(e) {}
        }
    }
});

// HOOK: send()
tryHook(null, "send", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var sent = retval.toInt32();
        if (sent > 0 && interestingFds[this.fd]) {
            console.log("\n[SEND] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + sent);
            try { console.log(dumpHex(this.buf.readByteArray(sent), 1024)); } catch(e) {}
        }
    }
});

// HOOK: recvfrom()
tryHook(null, "recvfrom", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var received = retval.toInt32();
        if (received > 0 && interestingFds[this.fd]) {
            console.log("\n[RECVFROM] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + received);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(received, 1024)), 1024)); } catch(e) {}
        }
    }
});

// HOOK: recv()
tryHook(null, "recv", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var received = retval.toInt32();
        if (received > 0 && interestingFds[this.fd]) {
            console.log("\n[RECV] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + received);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(received, 1024)), 1024)); } catch(e) {}
        }
    }
});

// HOOK: write() for non-file fds
tryHook(null, "write", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
        this.len = args[2].toInt32();
    },
    onLeave: function(retval) {
        var written = retval.toInt32();
        if (written > 0 && interestingFds[this.fd]) {
            console.log("\n[WRITE] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + written);
            try { console.log(dumpHex(this.buf.readByteArray(written), 1024)); } catch(e) {}
        }
    }
});

// HOOK: read()
tryHook(null, "read", {
    onEnter: function(args) {
        this.fd = args[0].toInt32();
        this.buf = args[1];
    },
    onLeave: function(retval) {
        var bytesRead = retval.toInt32();
        if (bytesRead > 0 && interestingFds[this.fd]) {
            console.log("\n[READ] fd=" + this.fd + " (" + interestingFds[this.fd] + ") len=" + bytesRead);
            try { console.log(dumpHex(this.buf.readByteArray(Math.min(bytesRead, 1024)), 1024)); } catch(e) {}
        }
    }
});

// Enumerate libezstreamclient exports after delay
setTimeout(function() {
    try {
        var mod = Process.findModuleByName("libezstreamclient.so") || Process.findModuleByName("libStreamClient.so");
        if (mod) {
            console.log("\n[*] libezstreamclient.so at " + mod.base + " (" + mod.size + " bytes)");
            var exports = mod.enumerateExports();
            console.log("[*] Exports: " + exports.length);
            exports.forEach(function(e) {
                if (e.name.indexOf("onnect") >= 0 || e.name.indexOf("nit") >= 0 ||
                    e.name.indexOf("reate") >= 0 || e.name.indexOf("tart") >= 0 ||
                    e.name.indexOf("andshake") >= 0 || e.name.indexOf("uth") >= 0 ||
                    e.name.indexOf("oken") >= 0 || e.name.indexOf("cdh") >= 0) {
                    console.log("  " + e.name);
                }
            });
        } else {
            console.log("[*] libezstreamclient.so not yet loaded");
        }
    } catch(e) { console.log("[!] " + e); }
}, 5000);

// Hook mbedtls after delay
setTimeout(function() {
    tryHook("libmbedtls.so", "mbedtls_ssl_write", {
        onEnter: function(args) { this.buf = args[1]; this.len = args[2].toInt32(); },
        onLeave: function(retval) {
            var w = retval.toInt32();
            if (w > 0) {
                console.log("\n[MBEDTLS_WRITE] len=" + w);
                try { console.log(dumpHex(this.buf.readByteArray(w), 1024)); } catch(e) {}
            }
        }
    });
    tryHook("libmbedtls.so", "mbedtls_ssl_read", {
        onEnter: function(args) { this.buf = args[1]; },
        onLeave: function(retval) {
            var r = retval.toInt32();
            if (r > 0) {
                console.log("\n[MBEDTLS_READ] len=" + r);
                try { console.log(dumpHex(this.buf.readByteArray(r), 1024)); } catch(e) {}
            }
        }
    });
}, 3000);

console.log("[*] Hooks loaded. Login and open a camera live view.");
