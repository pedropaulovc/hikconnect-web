/**
 * Frida hook for Hik-Connect — extract raw video frames to a named pipe.
 * Runs on the redroid Android container.
 *
 * Usage: frida -H 127.0.0.1:27042 -p <PID> -l hook-extract-frames.js
 *
 * The hook intercepts EZStreamCallback.onDataCallBack() and writes
 * raw video frames to /data/local/tmp/video_pipe (named pipe).
 * A separate process reads the pipe and feeds it to FFmpeg.
 */

var frameCount = 0;
var byteCount = 0;
var outputFd = -1;
var startTime = Date.now();

Java.perform(function() {
    console.log("[*] Frame extraction hooks loading...");

    // Hook NativeApi.setCallback to intercept the callback object
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");

        // Hook createPreviewHandle to log params
        NativeApi.createPreviewHandle.implementation = function(initParam) {
            console.log("\n=== createPreviewHandle ===");
            console.log("  serial: " + initParam.szDevSerial.value);
            console.log("  channel: " + initParam.iChannelNumber.value);
            console.log("  streamType: " + initParam.iStreamType.value);
            console.log("  vtmIP: " + initParam.szVtmIP.value + ":" + initParam.iVtmPort.value);
            console.log("  casIP: " + initParam.szCasServerIP.value + ":" + initParam.iCasServerPort.value);
            console.log("  p2pVersion: " + initParam.iP2PVersion.value);
            var handle = this.createPreviewHandle(initParam);
            console.log("  => handle: " + handle);
            return handle;
        };

        // Hook setSecretKey
        NativeApi.setSecretKey.implementation = function(handle, key) {
            console.log("[*] setSecretKey(handle=" + handle + ", key=" + key + ")");
            return this.setSecretKey(handle, key);
        };

        // Hook startPreview
        NativeApi.startPreview.implementation = function(handle) {
            console.log("[*] startPreview(handle=" + handle + ")");
            var result = this.startPreview(handle);
            console.log("  => result: " + result);
            return result;
        };

        // Hook getClientType to see connection method
        NativeApi.getClientType.implementation = function(handle) {
            var result = this.getClientType(handle);
            var types = ["PRIVATE_STREAM","P2P","DIRECT_INNER","DIRECT_OUTER","CLOUD_PLAYBACK","CLOUD_RECORDING","DIRECT_REVERSE","HCNETSDK","ANT_PROXY"];
            console.log("[*] getClientType => " + result + " (" + (types[result] || "UNKNOWN") + ")");
            return result;
        };

        console.log("[*] NativeApi hooks installed");
    } catch(e) {
        console.log("[!] NativeApi hook error: " + e);
    }

    // Hook the callback to extract frames
    // The callback is set via NativeApi.setCallback(handle, EZStreamCallback)
    // We need to intercept the onDataCallBack method on whatever object implements EZStreamCallback
    try {
        var NativeApi = Java.use("com.ez.stream.NativeApi");

        NativeApi.setCallback.implementation = function(handle, callback) {
            console.log("[*] setCallback(handle=" + handle + ")");

            if (callback) {
                // Wrap the callback to intercept frame data
                var CallbackWrapper = Java.registerClass({
                    name: "com.hikconnect.bridge.FrameExtractorCallback",
                    implements: [Java.use("com.ez.stream.EZStreamCallback")],
                    fields: {
                        originalCallback: "com.ez.stream.EZStreamCallback"
                    },
                    methods: {
                        onDataCallBack: function(dataType, data, dataLen) {
                            frameCount++;
                            byteCount += dataLen;

                            // Log frame info periodically
                            if (frameCount % 100 === 1) {
                                var elapsed = (Date.now() - startTime) / 1000;
                                var typeName = ["IDLE","HEADER","DATA","AUDIO","STREAMKEY","AESMD5"][dataType] || (dataType === 50 ? "FIRST_DATA" : dataType === 100 ? "END" : "UNK:" + dataType);
                                console.log("[FRAME] #" + frameCount + " type=" + typeName + " len=" + dataLen + " total=" + (byteCount/1024/1024).toFixed(1) + "MB rate=" + (byteCount/1024/elapsed).toFixed(0) + "KB/s");
                            }

                            // Write frame to stdout via send()
                            if (dataType === 1 || dataType === 2 || dataType === 3 || dataType === 50) {
                                // Send binary data to the host via Frida's send() mechanism
                                var buf = new Uint8Array(data.length);
                                for (var i = 0; i < data.length && i < dataLen; i++) {
                                    buf[i] = data[i] & 0xFF;
                                }
                                send({type: "frame", dataType: dataType, len: dataLen}, buf.buffer);
                            }

                            // Forward to original callback
                            this.originalCallback.value.onDataCallBack(dataType, data, dataLen);
                        },
                        onMessageCallBack: function(msgType, errorCode) {
                            console.log("[MSG] type=" + msgType + " error=" + errorCode);
                            this.originalCallback.value.onMessageCallBack(msgType, errorCode);
                        },
                        onStatisticsCallBack: function(statisticsType, json) {
                            console.log("[STATS] type=" + statisticsType);
                            this.originalCallback.value.onStatisticsCallBack(statisticsType, json);
                        }
                    }
                });

                var wrapper = CallbackWrapper.$new();
                wrapper.originalCallback.value = callback;
                console.log("[*] Callback wrapped for frame extraction");
                return this.setCallback(handle, wrapper);
            }

            return this.setCallback(handle, callback);
        };

        console.log("[*] Callback interception installed");
    } catch(e) {
        console.log("[!] Callback hook error: " + e);
    }

    console.log("[*] All hooks ready. Login and open a camera live view.");
});
