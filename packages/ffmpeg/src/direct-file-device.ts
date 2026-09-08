import { DIRECT_FILE_CONTROL_WORDS, DirectFileIndex as I, DirectFileOp as Op, DirectFileState as State } from "./direct-file-protocol.js";

type CoreWithFS = {
  FS: any;
  mountDirectFile?: (path: string, buffer: SharedArrayBuffer, port: MessagePort) => boolean;
  cancelDirectFile?: (path: string) => boolean;
};

const bridges = new Map<string, { control: Int32Array; payload: Uint8Array; port: MessagePort; position: number; closed: boolean }>();
const split = (value: number) => {
  const n = BigInt(value);
  return [Number(n & 0xffffffffn), Number((n >> 32n) & 0xffffffffn)];
};

export const mountDirectFileDevice = (core: CoreWithFS, path: string, buffer: SharedArrayBuffer, port: MessagePort): boolean => {
  if (core.mountDirectFile) return core.mountDirectFile(path, buffer, port);
  const FS = core.FS;
  const bridge = { control: new Int32Array(buffer, 0, DIRECT_FILE_CONTROL_WORDS), payload: new Uint8Array(buffer, DIRECT_FILE_CONTROL_WORDS * 4), port, position: 0, closed: false };
  const errno = (code: number) => new FS.ErrnoError(code || 5);
  const request = (op: Op, offset = 0, bytes?: Uint8Array): number => {
    if (Atomics.load(bridge.control, I.Cancel)) throw errno(125);
    const [low, high] = split(offset);
    Atomics.store(bridge.control, I.Op, op); Atomics.store(bridge.control, I.OffsetLow, low); Atomics.store(bridge.control, I.OffsetHigh, high);
    Atomics.store(bridge.control, I.Length, bytes?.length || 0); if (bytes) bridge.payload.set(bytes);
    Atomics.add(bridge.control, I.Sequence, 1); Atomics.store(bridge.control, I.State, State.Request); port.postMessage(0);
    while (Atomics.load(bridge.control, I.State) !== State.Response) {
      if (Atomics.load(bridge.control, I.Cancel)) throw errno(125);
      Atomics.wait(bridge.control, I.State, State.Request, 1000);
    }
    const error = Atomics.load(bridge.control, I.Error); const result = Atomics.load(bridge.control, I.Result);
    Atomics.store(bridge.control, I.State, State.Idle); if (error) throw errno(error); return result;
  };
  const getSize = (): number => {
    request(Op.GetSize);
    return Number((BigInt(Atomics.load(bridge.control, I.OffsetHigh) >>> 0) << 32n) | BigInt(Atomics.load(bridge.control, I.OffsetLow) >>> 0));
  };
  request(Op.Open);
  const dev = FS.makedev(64, 80 + bridges.size);
  FS.registerDevice(dev, {
    open: (stream: any) => { stream.seekable = true; },
    close: () => { if (!bridge.closed) { request(Op.Close); bridge.closed = true; } },
    write: (_stream: any, source: Uint8Array, offset: number, length: number, position?: number) => {
      let cursor = position == null ? bridge.position : Number(position); let written = 0;
      while (written < length) {
        const size = Math.min(length - written, bridge.payload.length);
        const count = request(Op.Write, cursor, source.subarray(offset + written, offset + written + size));
        if (count <= 0 || count > size) throw errno(5);
        written += count; cursor += count;
      }
      bridge.position = cursor; return written;
    },
    llseek: (_stream: any, offset: number, whence: number) => {
      const base = whence === 0 ? 0 : whence === 1 ? bridge.position : getSize();
      const next = base + Number(offset); if (next < 0) throw errno(22);
      bridge.position = next; request(Op.Seek, next); return next;
    },
    fsync: () => { request(Op.Flush); return 0; },
  });
  const node = FS.mkdev(path, 438, dev);
  const setattr = node.node_ops.setattr;
  node.node_ops = { ...node.node_ops, setattr: (target: any, attr: any) => { if (Object.hasOwn(attr, "size")) request(Op.Truncate, attr.size); return setattr(target, attr); } };
  bridges.set(path, bridge); return true;
};

export const cancelDirectFileDevice = (core: CoreWithFS, path: string): boolean => {
  if (core.cancelDirectFile) return core.cancelDirectFile(path);
  const bridge = bridges.get(path); if (!bridge) return false;
  Atomics.store(bridge.control, I.Cancel, 1); Atomics.notify(bridge.control, I.State); bridge.port.postMessage(0); return true;
};
