/**
 * Non-blocking native UDP observer for Hik-Connect.
 * Hooks libc sendto/recvfrom, decodes sockaddr_in, logs dst/src IP:port + packet
 * prefix. Does NOT block (calls original). Captures the native P2P/stream traffic
 * that the app's libezstreamclient.so sends — which emulator -tcpdump missed and
 * Java DatagramSocket hooks don't see.
 *
 * Usage: frida -U -n Hik-Connect -l scripts/frida/observe-net.js -o /tmp/net.log
 */
function ipPort(sa) {
  if (sa.isNull()) return null;
  var family = sa.readU16();
  if (family !== 2) return null; // AF_INET only
  var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
  var b = sa.add(4);
  var ip = b.readU8() + '.' + b.add(1).readU8() + '.' + b.add(2).readU8() + '.' + b.add(3).readU8();
  return ip + ':' + port;
}
function isLocal(ipp) {
  return !ipp || ipp.indexOf('10.0.2.') === 0 || ipp.indexOf('127.') === 0 ||
         ipp.indexOf(':53') >= 0 || ipp.indexOf('224.0.0') === 0;
}
function hexPrefix(buf, len) {
  var n = Math.min(len, 48);
  var arr = Memory.readByteArray(buf, n);
  var u = new Uint8Array(arr), h = '';
  for (var i = 0; i < u.length; i++) h += ('0' + u[i].toString(16)).slice(-2);
  return h;
}

function globalExport(name) {
  // Frida 17 removed Module.findExportByName(null, ...); use global lookup with fallbacks.
  if (typeof Module.findGlobalExportByName === 'function') return Module.findGlobalExportByName(name);
  if (typeof Module.getGlobalExportByName === 'function') return Module.getGlobalExportByName(name);
  var libc = Process.getModuleByName('libc.so');
  return libc.findExportByName(name);
}
function hook(name, fn) { var p = globalExport(name); if (p) Interceptor.attach(p, fn); else console.log('MISS ' + name); }

// connect() reveals every remote endpoint (TCP + connected-UDP), even when data
// later flows via send()/recv() instead of sendto()/recvfrom().
hook('connect', {
  onEnter: function (a) {
    var dst = ipPort(a[1]);
    if (isLocal(dst)) return;
    console.log('CONNECT -> ' + dst);
  },
});
hook('sendto', {
  onEnter: function (a) {
    var dst = ipPort(a[4]);
    if (dst === null || isLocal(dst)) return;
    var len = a[2].toInt32();
    console.log('SENDTO -> ' + dst + ' len=' + len + ' ' + hexPrefix(a[1], len));
  },
});
// Resolve a connected socket's remote endpoint via getpeername(fd).
var _getpeername = new NativeFunction(globalExport('getpeername'), 'int', ['int', 'pointer', 'pointer']);
var seen = {};
function peerOf(fd) {
  var sa = Memory.alloc(28), lenp = Memory.alloc(4);
  lenp.writeU32(28);
  if (_getpeername(fd, sa, lenp) !== 0) return null;
  return ipPort(sa);
}
function noteFd(fd, tag) {
  var p = peerOf(fd);
  if (p === null || isLocal(p)) return;
  var k = tag + ' ' + p;
  seen[k] = (seen[k] || 0) + 1;
  if (seen[k] <= 3) console.log(tag + ' fd=' + fd + ' -> ' + p);
}
hook('sendmsg', { onEnter: function (a) { noteFd(a[0].toInt32(), 'SENDMSG'); } });
hook('send', { onEnter: function (a) { noteFd(a[0].toInt32(), 'SEND'); } });
hook('recvmsg', { onEnter: function (a) { noteFd(a[0].toInt32(), 'RECVMSG'); } });
hook('recvfrom', {
  onEnter: function (a) { this.buf = a[1]; this.src = a[4]; },
  onLeave: function (ret) {
    var n = ret.toInt32(); if (n <= 0) return;
    var src = ipPort(this.src); if (src === null || isLocal(src)) return;
    console.log('RECVFROM <- ' + src + ' len=' + n + ' ' + hexPrefix(this.buf, n));
  },
});

console.log('NET_OBSERVER_READY');
