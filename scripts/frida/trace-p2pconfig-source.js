/**
 * Trace where com.ezplayer.common.AccountHandler.getP2PConfigInfo gets the
 * P2PServerKey (+ salt) from — so it can be fetched from username/password.
 *
 * 1. Hooks AccountHandler.getP2PConfigInfo: dumps return value + all instance
 *    fields (the cached config object the key is read from).
 * 2. Hooks OkHttp Response so we can see which HTTP endpoint delivered the key
 *    (search the logged URLs/bodies for the key hex c031e9f5… or its base64).
 *
 * Usage: frida -U -f com.connect.enduser -l scripts/frida/trace-p2pconfig-source.js -o /tmp/p2pcfg.log
 */
Java.perform(function () {
  var Log = Java.use('android.util.Log');
  var Exception = Java.use('java.lang.Exception');
  function st() { return Log.getStackTraceString(Exception.$new()).split('\n').slice(0, 14).join('\n'); }

  function bytesToHex(arr) {
    var h = '';
    for (var i = 0; i < arr.length; i++) h += ('0' + ((arr[i] + 256) % 256).toString(16)).slice(-2);
    return h;
  }

  function dump(obj, label, depth) {
    depth = depth || 0;
    if (obj === null || depth > 2) { console.log('  '.repeat(depth) + label + '=' + obj); return; }
    try {
      var cls = obj.getClass();
      var cn = cls.getName();
      if (cn.indexOf('java.lang.String') === 0 || cn.indexOf('java.lang.Integer') === 0 ||
          cn.indexOf('java.lang.Long') === 0 || cn.indexOf('java.lang.Boolean') === 0) {
        console.log('  '.repeat(depth) + label + '(' + cn + ')=' + obj);
        return;
      }
      console.log('  '.repeat(depth) + label + ' {' + cn + '}');
      var fields = cls.getDeclaredFields();
      for (var i = 0; i < fields.length; i++) {
        fields[i].setAccessible(true);
        var name = fields[i].getName();
        var val = fields[i].get(obj);
        if (val === null) { console.log('  '.repeat(depth + 1) + name + '=null'); continue; }
        var t = val.getClass ? val.getClass().getName() : typeof val;
        if (t === '[B' || t === '[S') {
          var arr = Java.array(t === '[B' ? 'byte' : 'short', val);
          console.log('  '.repeat(depth + 1) + name + '(' + t + '[' + arr.length + '])=' + bytesToHex(arr));
        } else if (t.indexOf('java.lang.') === 0 || t === '[Ljava.lang.String;') {
          console.log('  '.repeat(depth + 1) + name + '=' + val);
        } else if (depth < 1) {
          dump(val, name, depth + 1);
        } else {
          console.log('  '.repeat(depth + 1) + name + '(' + t + ')=' + val);
        }
      }
    } catch (e) { console.log('  dump err ' + label + ': ' + e); }
  }

  try {
    var AH = Java.use('com.ezplayer.common.AccountHandler');
    AH.getP2PConfigInfo.overloads.forEach(function (ov, idx) {
      ov.implementation = function () {
        console.log('\n##### AccountHandler.getP2PConfigInfo#' + idx + ' argc=' + arguments.length);
        for (var k = 0; k < arguments.length; k++) dump(arguments[k], 'arg' + k);
        var ret = ov.apply(this, arguments);
        dump(ret, 'RETURN');
        console.log('STACK:\n' + st());
        return ret;
      };
    });
    console.log('hooked AccountHandler.getP2PConfigInfo (' + AH.getP2PConfigInfo.overloads.length + ')');
  } catch (e) { console.log('AccountHandler hook failed: ' + e); }

  // OkHttp Response interceptor — find the endpoint carrying the key.
  try {
    var Response = Java.use('okhttp3.Response');
    Response.body.implementation = function () {
      try {
        var req = this.request();
        var url = req.url().toString();
        if (url.indexOf('p2p') >= 0 || url.indexOf('P2P') >= 0 || url.indexOf('config') >= 0 ||
            url.indexOf('secret') >= 0 || url.indexOf('key') >= 0 || url.indexOf('preconnect') >= 0 ||
            url.indexOf('sdk') >= 0 || url.indexOf('token') >= 0) {
          console.log('\n@@@ OkHttp ' + req.method() + ' ' + url);
        }
      } catch (e) {}
      return this.body.apply(this, arguments);
    };
    console.log('hooked okhttp3.Response.body');
  } catch (e) { console.log('OkHttp hook failed: ' + e); }

  console.log('P2PCFG_TRACE_READY');
});
