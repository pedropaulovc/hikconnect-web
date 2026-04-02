/**
 * Frida hook to intercept P2P UDP sends at Java DatagramSocket level.
 * Captures the encrypted V3 body and BLOCKS sending (to keep token fresh).
 * Then we decrypt the body offline and send from VPS.
 */
Java.perform(function() {
  var DatagramSocket = Java.use("java.net.DatagramSocket");
  var interceptCount = 0;

  DatagramSocket.send.implementation = function(packet) {
    var addr = packet.getAddress();
    var host = addr ? addr.getHostAddress() : "unknown";
    var port = packet.getPort();
    var data = packet.getData();
    var offset = packet.getOffset();
    var length = packet.getLength();

    // Only intercept P2P server traffic (port 6000)
    if (port === 6000) {
      interceptCount++;
      console.log("\n=== INTERCEPTED P2P SEND #" + interceptCount + " ===");
      console.log("TO: " + host + ":" + port);
      console.log("LEN: " + length);

      // Extract actual bytes
      var hex = "";
      for (var i = offset; i < offset + length && i < data.length; i++) {
        hex += ("0" + ((data[i] + 256) % 256).toString(16)).slice(-2);
      }
      console.log("HEX=" + hex);

      // BLOCK the send - don't call original
      console.log("BLOCKED (token preserved for VPS use)");

      // After capturing 4 packets (2 type4 + 2 type2), allow future sends
      if (interceptCount >= 4) {
        console.log("Got all packets. Future sends will be allowed.");
      }
      return;
    }

    // Allow all other traffic
    return this.send(packet);
  };

  console.log("HOOK_READY: DatagramSocket.send intercepted for port 6000");
});
