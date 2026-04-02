/**
 * Frida hook to dump ALL InitParam fields when stream starts.
 * Usage: frida -U -p <PID> -l scripts/frida/dump-stream-params.js
 * Then switch resolution in the app to trigger a new stream.
 */
Java.perform(function() {
  var NativeApi = Java.use("com.ez.stream.NativeApi");
  NativeApi.createPreviewHandle.overload("com.ez.stream.InitParam").implementation = function(param) {
    console.log("\n=== createPreviewHandle ===");
    try {
      var fields = param.getClass().getDeclaredFields();
      for (var i = 0; i < fields.length; i++) {
        fields[i].setAccessible(true);
        var name = fields[i].getName();
        var val = fields[i].get(param);
        if (val == null) continue;
        var type = fields[i].getType().getName();

        if (type === "[B") {
          // byte array — hex dump
          var arr = Java.array("byte", val);
          var hex = "";
          for (var j = 0; j < Math.min(arr.length, 64); j++) hex += ("0" + ((arr[j] + 256) % 256).toString(16)).slice(-2);
          console.log("  " + name + " (" + type + " len=" + arr.length + ") = " + hex);
        } else if (type === "[S") {
          // short array — hex dump
          var arr = Java.array("short", val);
          var hex = "";
          for (var j = 0; j < Math.min(arr.length, 64); j++) hex += ("0" + ((arr[j] + 256) % 256).toString(16)).slice(-2);
          console.log("  " + name + " (" + type + " len=" + arr.length + ") = " + hex);
        } else {
          console.log("  " + name + " (" + type + ") = " + val);
        }
      }
    } catch(e) { console.log("ERROR: " + e); }
    return this.createPreviewHandle(param);
  };
  console.log("HOOK_READY: Waiting for createPreviewHandle...");
});
