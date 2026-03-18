/**
 * Frida hook to capture P2PLinkKey from createPreviewHandle InitParam.
 */
Java.perform(function() {
  var NativeApi = Java.use("com.ez.stream.NativeApi");
  NativeApi.createPreviewHandle.overload("com.ez.stream.InitParam").implementation = function(param) {
    console.log("=== createPreviewHandle called ===");
    try {
      // Get all fields from InitParam
      var fields = param.getClass().getDeclaredFields();
      for (var i = 0; i < fields.length; i++) {
        fields[i].setAccessible(true);
        var name = fields[i].getName();
        var val = fields[i].get(param);
        if (val == null) continue;

        // P2PLinkKey
        if (name === "szP2PLinkKey") {
          var arr = Java.array("byte", val);
          var hex = "";
          for (var j = 0; j < arr.length; j++) hex += ("0" + ((arr[j] + 256) % 256).toString(16)).slice(-2);
          console.log("P2P_LINK_KEY_HEX=" + hex);
          console.log("P2P_LINK_KEY_LEN=" + arr.length);
        }
        // Also capture P2PServerKey for reference
        else if (name === "stP2PServerKey") {
          var keyFields = val.getClass().getDeclaredFields();
          for (var k = 0; k < keyFields.length; k++) {
            keyFields[k].setAccessible(true);
            var kname = keyFields[k].getName();
            var kval = keyFields[k].get(val);
            if (kval != null && kname === "szP2PKey") {
              var karr = Java.array("short", kval);
              var khex = "";
              for (var j = 0; j < karr.length; j++) khex += ("0"+((karr[j]+256)%256).toString(16)).slice(-2);
              console.log("P2P_SERVER_KEY=" + khex);
            }
          }
        }
        // P2PKeyVer
        else if (name === "usP2PKeyVer") {
          console.log("P2P_KEY_VER=" + val);
        }
        // Session and stream tokens
        else if (name === "szClientSession" || name === "szStreamToken" || name === "szTicketToken") {
          console.log(name + "=" + val.toString().substring(0, 50) + "...");
        }
        // Device serial
        else if (name === "szDevSerial") {
          console.log("DEVICE_SERIAL=" + val);
        }
      }
    } catch(e) { console.log("ERROR=" + e); }
    return this.createPreviewHandle(param);
  };
  console.log("HOOK_READY: Waiting for createPreviewHandle...");
});
