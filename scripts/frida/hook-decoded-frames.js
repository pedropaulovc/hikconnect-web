/**
 * Frida hook: capture decoded video frames from the native streaming library.
 * Shows what data the app receives AFTER decryption/demuxing.
 *
 * Usage: frida -U -p $(adb shell pidof com.connect.enduser) -l scripts/frida/hook-decoded-frames.js
 */
var frameCount = 0;

Java.perform(function() {
    console.log("[*] Hooking onDataCallBack for decoded frame capture...");

    var callbackClasses = [
        "com.ez.stream.EZStreamCallback",
        "com.ezviz.stream.EZStreamCallback"
    ];

    var hooked = false;
    callbackClasses.forEach(function(clsName) {
        try {
            var cls = Java.use(clsName);
            console.log("[+] Found: " + clsName);

            cls.onDataCallBack.implementation = function(handle, dataType, data, dataLen, width, height, timestamp) {
                var typeNames = {1:"HEADER", 2:"DATA", 3:"AUDIO", 4:"STREAMKEY", 5:"AESMD5", 50:"FIRST_DATA", 100:"END"};
                var typeName = typeNames[dataType] || ("UNK:" + dataType);

                frameCount++;

                // Show first 20 callbacks in detail, then every 100th
                if (frameCount <= 20 || frameCount % 100 === 0) {
                    var bytes = [];
                    var len = Math.min(dataLen, 64);
                    for (var i = 0; i < len; i++) {
                        bytes.push(('0' + (Memory.readU8(data.add(i)) & 0xff).toString(16)).slice(-2));
                    }
                    console.log("[CB #" + frameCount + "] type=" + typeName + "(" + dataType + ") len=" + dataLen + " w=" + width + " h=" + height + " ts=" + timestamp);
                    console.log("  hex: " + bytes.join(''));
                }

                // Always show key material
                if ((dataType === 4 || dataType === 5) && dataLen <= 256) {
                    var keyBytes = [];
                    for (var k = 0; k < dataLen; k++) {
                        keyBytes.push(('0' + (Memory.readU8(data.add(k)) & 0xff).toString(16)).slice(-2));
                    }
                    console.log("  *** KEY/AESMD5 DATA: " + keyBytes.join(''));
                }

                // Show HEADER in full (contains codec info)
                if (dataType === 1 && dataLen <= 512) {
                    var hdrBytes = [];
                    for (var j = 0; j < dataLen; j++) {
                        hdrBytes.push(('0' + (Memory.readU8(data.add(j)) & 0xff).toString(16)).slice(-2));
                    }
                    console.log("  HEADER FULL: " + hdrBytes.join(''));
                }

                return this.onDataCallBack(handle, dataType, data, dataLen, width, height, timestamp);
            };
            hooked = true;
        } catch(e) {
            console.log("[-] " + clsName + ": " + e);
        }
    });

    if (!hooked) {
        console.log("[!] No callback class found. Scanning...");
        Java.enumerateLoadedClasses({
            onMatch: function(name) {
                if (name.indexOf("StreamCallback") !== -1 || name.indexOf("DataCallBack") !== -1) {
                    console.log("  Found: " + name);
                }
            },
            onComplete: function() { console.log("  Done scanning."); }
        });
    }
});
