Java.perform(function(){
  var NativeApi = Java.use("com.ez.stream.NativeApi");
  NativeApi.createPreviewHandle.overload("com.ez.stream.InitParam").implementation = function(param) {
    console.log("PREVIEW_HANDLE_CALLED");
    try {
      var keyField = param.getClass().getDeclaredField("stP2PServerKey");
      keyField.setAccessible(true);
      var keyObj = keyField.get(param);
      if (keyObj) {
        var fields = keyObj.getClass().getDeclaredFields();
        for (var i = 0; i < fields.length; i++) {
          fields[i].setAccessible(true);
          var name = fields[i].getName();
          var val = fields[i].get(keyObj);
          if (val != null) {
            if (name === "szP2PKey") {
              var arr = Java.array("short", val);
              var s = [];
              for (var j = 0; j < arr.length; j++) s.push(arr[j]);
              console.log("P2P_KEY_SHORTS=" + JSON.stringify(s));
              var hex = "";
              for (var j = 0; j < s.length; j++) hex += ("0"+((s[j]+256)%256).toString(16)).slice(-2);
              console.log("P2P_KEY_HEX=" + hex);
            } else {
              console.log("P2P_KEY_" + name + "=" + val);
            }
          }
        }
      }
    } catch(e) { console.log("ERROR=" + e); }
    return this.createPreviewHandle(param);
  };
  console.log("HOOK_READY");
});
