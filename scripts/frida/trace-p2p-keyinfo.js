/**
 * Find the ORIGIN of the P2PServerKey (+ saltIndex/saltVer) so it can be derived
 * from username/password instead of a Frida capture.
 *
 * Hooks com.ez.stream.NativeApi.setP2PV3ConfigInfo(...) — the call that pushes the
 * key to native — dumps the key bytes AND a Java stack trace (which method/HTTP
 * response produced the value). Also hooks setTokens / selectP2PDevices for context.
 *
 * Usage: frida -U -f com.connect.enduser -l scripts/frida/trace-p2p-keyinfo.js -o /tmp/keyinfo.log
 */
Java.perform(function () {
  var NativeApi = Java.use('com.ez.stream.NativeApi');
  var Log = Java.use('android.util.Log');
  var Exception = Java.use('java.lang.Exception');

  function trace() {
    return Log.getStackTraceString(Exception.$new()).split('\n').slice(0, 18).join('\n');
  }

  function dumpObjFields(obj, label) {
    try {
      var cls = obj.getClass();
      console.log('--- ' + label + ' class=' + cls.getName() + ' ---');
      var fields = cls.getDeclaredFields();
      for (var i = 0; i < fields.length; i++) {
        fields[i].setAccessible(true);
        var name = fields[i].getName();
        var val = fields[i].get(obj);
        if (val === null) { console.log('  ' + name + '=null'); continue; }
        // short[] / byte[] → hex
        var t = val.getClass ? val.getClass().getName() : typeof val;
        if (t === '[S' || t === '[B') {
          var arr = Java.array(t === '[S' ? 'short' : 'byte', val);
          var hex = '';
          for (var j = 0; j < arr.length; j++) hex += ('0' + ((arr[j] + 256) % 256).toString(16)).slice(-2);
          console.log('  ' + name + '(' + t + '[' + arr.length + '])=' + hex);
        } else {
          console.log('  ' + name + '=' + val);
        }
      }
    } catch (e) { console.log('  dump error: ' + e); }
  }

  // Hook every overload of setP2PV3ConfigInfo
  var overloads = NativeApi.setP2PV3ConfigInfo.overloads;
  overloads.forEach(function (ov, idx) {
    ov.implementation = function () {
      console.log('\n===== setP2PV3ConfigInfo overload#' + idx + ' argc=' + arguments.length + ' =====');
      for (var k = 0; k < arguments.length; k++) {
        var a = arguments[k];
        if (a !== null && typeof a === 'object' && a.getClass) dumpObjFields(a, 'arg' + k);
        else console.log('  arg' + k + '=' + a);
      }
      console.log('STACK:\n' + trace());
      return ov.apply(this, arguments);
    };
  });

  console.log('KEYINFO_TRACE_READY (hooked ' + overloads.length + ' overloads of setP2PV3ConfigInfo)');
});
