// Synchronous Emscripten FS device backed by an async worker through SAB/Atomics.
// Keep values in sync with packages/ffmpeg/src/direct-file-protocol.ts.
var DIRECT_FILE = {
  STATE: 0, OP: 1, RESULT: 2, ERROR: 3, OFFSET_LO: 4, OFFSET_HI: 5,
  LENGTH: 6, CANCEL: 7, SEQ: 8, MAX_CHUNK: 9, CONTROL_WORDS: 16,
  IDLE: 0, REQUEST: 1, RESPONSE: 2,
  OPEN: 1, WRITE: 2, SEEK: 3, TRUNCATE: 4, FLUSH: 5, CLOSE: 6, GET_SIZE: 7,
  nextDevice: 80,
  split: function(value) {
    var n = BigInt(value);
    return [Number(n & 0xffffffffn), Number((n >> 32n) & 0xffffffffn)];
  },
  errno: function(code) {
    var known = { 1: 1, 5: 5, 9: 9, 13: 13, 22: 22, 28: 28, 125: 125 };
    return new FS.ErrnoError(known[code] || 5);
  },
  request: function(bridge, op, offset, bytes) {
    var control = bridge.control;
    if (Atomics.load(control, DIRECT_FILE.CANCEL)) throw DIRECT_FILE.errno(125);
    var pair = DIRECT_FILE.split(offset || 0);
    Atomics.store(control, DIRECT_FILE.OP, op);
    Atomics.store(control, DIRECT_FILE.OFFSET_LO, pair[0]);
    Atomics.store(control, DIRECT_FILE.OFFSET_HI, pair[1]);
    Atomics.store(control, DIRECT_FILE.LENGTH, bytes ? bytes.length : 0);
    if (bytes) bridge.payload.set(bytes);
    Atomics.add(control, DIRECT_FILE.SEQ, 1);
    Atomics.store(control, DIRECT_FILE.STATE, DIRECT_FILE.REQUEST);
    bridge.port.postMessage(0);
    while (Atomics.load(control, DIRECT_FILE.STATE) !== DIRECT_FILE.RESPONSE) {
      if (Atomics.load(control, DIRECT_FILE.CANCEL)) throw DIRECT_FILE.errno(125);
      Atomics.wait(control, DIRECT_FILE.STATE, DIRECT_FILE.REQUEST, 1000);
    }
    var error = Atomics.load(control, DIRECT_FILE.ERROR);
    var result = Atomics.load(control, DIRECT_FILE.RESULT);
    Atomics.store(control, DIRECT_FILE.STATE, DIRECT_FILE.IDLE);
    if (error) throw DIRECT_FILE.errno(error);
    return result;
  },
  getSize: function(bridge) {
    DIRECT_FILE.request(bridge, DIRECT_FILE.GET_SIZE, 0);
    var control = bridge.control;
    return Number((BigInt(Atomics.load(control, DIRECT_FILE.OFFSET_HI) >>> 0) << 32n) |
      BigInt(Atomics.load(control, DIRECT_FILE.OFFSET_LO) >>> 0));
  }
};

Module.mountDirectFile = function(path, sab, port) {
  if (!(sab instanceof SharedArrayBuffer)) throw new TypeError("SharedArrayBuffer required");
  var byteOffset = DIRECT_FILE.CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT;
  var bridge = {
    control: new Int32Array(sab, 0, DIRECT_FILE.CONTROL_WORDS),
    payload: new Uint8Array(sab, byteOffset), port: port, position: 0, closed: false
  };
  DIRECT_FILE.request(bridge, DIRECT_FILE.OPEN, 0);
  var dev = FS.makedev(64, DIRECT_FILE.nextDevice++);
  FS.registerDevice(dev, {
    open: function(stream) { stream.seekable = true; stream.node.directFileBridge = bridge; },
    close: function(stream) {
      if (!bridge.closed) { DIRECT_FILE.request(bridge, DIRECT_FILE.CLOSE, 0); bridge.closed = true; }
    },
    write: function(stream, buffer, offset, length, position) {
      var cursor = position == null ? bridge.position : Number(position);
      var written = 0;
      while (written < length) {
        var size = Math.min(length - written, bridge.payload.length);
        var chunk = buffer.subarray(offset + written, offset + written + size);
        var count = DIRECT_FILE.request(bridge, DIRECT_FILE.WRITE, cursor, chunk);
        if (count <= 0 || count > size) throw DIRECT_FILE.errno(5);
        written += count; cursor += count;
      }
      bridge.position = cursor;
      return written;
    },
    llseek: function(stream, offset, whence) {
      var base = whence === 0 ? 0 : whence === 1 ? bridge.position : DIRECT_FILE.getSize(bridge);
      var next = base + Number(offset);
      if (next < 0) throw DIRECT_FILE.errno(22);
      bridge.position = next;
      DIRECT_FILE.request(bridge, DIRECT_FILE.SEEK, next);
      return next;
    },
    fsync: function() { DIRECT_FILE.request(bridge, DIRECT_FILE.FLUSH, 0); return 0; }
  });
  var node = FS.mkdev(path, 438, dev);
  var setattr = node.node_ops.setattr;
  node.node_ops = Object.assign({}, node.node_ops, {
    setattr: function(target, attr) {
      if (Object.prototype.hasOwnProperty.call(attr, "size")) {
        DIRECT_FILE.request(bridge, DIRECT_FILE.TRUNCATE, attr.size);
      }
      return setattr(target, attr);
    }
  });
  node.directFileBridge = bridge;
  return true;
};

Module.cancelDirectFile = function(path) {
  var node = FS.lookupPath(path).node;
  if (!node.directFileBridge) return false;
  Atomics.store(node.directFileBridge.control, DIRECT_FILE.CANCEL, 1);
  Atomics.notify(node.directFileBridge.control, DIRECT_FILE.STATE);
  node.directFileBridge.port.postMessage(0);
  return true;
};
