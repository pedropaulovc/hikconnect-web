/**
 * Frida Java-level hooks for Hik-Connect protocol capture.
 * Hooks the JNI bridge classes (NativeApi, EZStreamSDKJNA, CASClient)
 * to capture parameters passed to native streaming functions.
 *
 * Usage: frida -U -p <PID> -l hook-java.js
 */

Java.perform(function() {
    console.log("[*] Java hooks starting...");

    // Hook NativeApi.createPreviewHandle — captures InitParam for live streams
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");

        NativeApi.createPreviewHandle.implementation = function(initParam) {
            console.log("\n=== NativeApi.createPreviewHandle ===");
            console.log("InitParam: " + initParam.toString());
            console.log("  devSerial: " + initParam.szDevSerial.value);
            console.log("  devIP: " + initParam.szDevIP.value);
            console.log("  devLocalIP: " + initParam.szDevLocalIP.value);
            console.log("  vtmIP: " + initParam.szVtmIP.value);
            console.log("  vtmPort: " + initParam.iVtmPort.value);
            console.log("  vtmBackIP: " + initParam.szVtmBackIP.value);
            console.log("  ttsIP: " + initParam.szTtsIP.value);
            console.log("  ttsPort: " + initParam.iTtsPort.value);
            console.log("  stunIP: " + initParam.szStunIP.value);
            console.log("  stunPort: " + initParam.iStunPort.value);
            console.log("  streamType: " + initParam.iStreamType.value);
            console.log("  streamSource: " + initParam.iStreamSource.value);
            console.log("  channelNo: " + initParam.iChannelNumber.value);
            console.log("  clientSession: " + initParam.szClientSession.value);
            console.log("  permanentKey: " + initParam.szPermanetkey.value);
            console.log("  ticketToken: " + initParam.szTicketToken.value);
            console.log("  streamToken: " + initParam.szStreamToken.value);
            console.log("  p2pVersion: " + initParam.iP2PVersion.value);
            console.log("  streamInhibit: " + initParam.iStreamInhibit.value);
            console.log("  linkEncryptV2: " + initParam.iLinkEncryptV2.value);
            console.log("  vtduKeyVersion: " + initParam.vtduServerKeyVersion.value);
            try {
                var vtduKey = initParam.vtduServerPublicKey.value;
                if (vtduKey) {
                    var keyStr = "";
                    for (var i = 0; i < vtduKey.length && vtduKey[i] !== 0; i++) {
                        keyStr += String.fromCharCode(vtduKey[i] & 0xFF);
                    }
                    console.log("  vtduPublicKey: " + keyStr);
                }
            } catch(e) {}
            var result = this.createPreviewHandle(initParam);
            console.log("  => handle: " + result);
            return result;
        };
        console.log("[*] Hooked NativeApi.createPreviewHandle");
    } catch(e) {
        console.log("[!] NativeApi hook error: " + e);
    }

    // Hook NativeApi.startPreview
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.startPreview.implementation = function(handle) {
            console.log("\n=== NativeApi.startPreview(handle=" + handle + ") ===");
            var result = this.startPreview(handle);
            console.log("  => result: " + result);
            return result;
        };
        console.log("[*] Hooked NativeApi.startPreview");
    } catch(e) {
        console.log("[!] startPreview hook error: " + e);
    }

    // Hook NativeApi.createClient — generic client creation
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.createClient.implementation = function(initParam) {
            console.log("\n=== NativeApi.createClient ===");
            console.log("InitParam: " + initParam.toString());
            var result = this.createClient(initParam);
            console.log("  => handle: " + result);
            return result;
        };
        console.log("[*] Hooked NativeApi.createClient");
    } catch(e) {
        console.log("[!] createClient hook error: " + e);
    }

    // Hook EZStreamCallback.onDataCallBack — captures stream data type and payload
    try {
        var EZStreamCallback = Java.use("com.ez.stream.EZStreamCallback");
        // Can't hook interface directly, find implementations
        Java.choose("com.ez.stream.EZStreamCallback", {
            onMatch: function(instance) {
                console.log("[*] Found EZStreamCallback instance: " + instance);
            },
            onComplete: function() {}
        });
    } catch(e) {
        console.log("[!] EZStreamCallback search: " + e);
    }

    // Hook NativeApi.setTokens — see what tokens are set
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.setTokens.implementation = function(tokens) {
            console.log("\n=== NativeApi.setTokens ===");
            if (tokens) {
                for (var i = 0; i < tokens.length; i++) {
                    console.log("  token[" + i + "]: " + tokens[i]);
                }
            }
            return this.setTokens(tokens);
        };
        console.log("[*] Hooked NativeApi.setTokens");
    } catch(e) {
        console.log("[!] setTokens hook error: " + e);
    }

    // Hook NativeApi.setSecretKey — captures decryption key
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.setSecretKey.implementation = function(handle, key) {
            console.log("\n=== NativeApi.setSecretKey(handle=" + handle + ", key=" + key + ") ===");
            return this.setSecretKey(handle, key);
        };
        console.log("[*] Hooked NativeApi.setSecretKey");
    } catch(e) {
        console.log("[!] setSecretKey hook error: " + e);
    }

    // Hook NativeApi.generateECDHKey — captures ECDH key pair
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.generateECDHKey.implementation = function(keyInfo) {
            console.log("\n=== NativeApi.generateECDHKey ===");
            var result = this.generateECDHKey(keyInfo);
            console.log("  result: " + result);
            try {
                console.log("  publicKey len: " + keyInfo.iPBKeyLen.value);
                console.log("  privateKey len: " + keyInfo.iPRKeyLen.value);
            } catch(e) {}
            return result;
        };
        console.log("[*] Hooked NativeApi.generateECDHKey");
    } catch(e) {
        console.log("[!] generateECDHKey hook error: " + e);
    }

    // Hook NativeApi.getClientType — see what connection type was selected
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");
        NativeApi.getClientType.implementation = function(handle) {
            var result = this.getClientType(handle);
            console.log("[*] getClientType(handle=" + handle + ") => " + result +
                " (" + ["PRIVATE_STREAM","P2P","DIRECT_INNER","DIRECT_OUTER","CLOUD_PLAYBACK","CLOUD_RECORDING","DIRECT_REVERSE","HCNETSDK","ANT_PROXY"][result] + ")");
            return result;
        };
        console.log("[*] Hooked NativeApi.getClientType");
    } catch(e) {
        console.log("[!] getClientType hook error: " + e);
    }

    console.log("[*] All Java hooks installed. Login and open a camera live view.");
});
