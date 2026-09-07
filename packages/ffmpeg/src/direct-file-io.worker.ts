/// <reference lib="webworker" />
import { DIRECT_FILE_CONTROL_WORDS, DirectFileIndex as I, DirectFileOp as Op, DirectFileState as State, directFileErrorCode, joinOffset, splitOffset } from "./direct-file-protocol.js";

interface InitMessage { type: "INIT"; handle: FileSystemFileHandle; buffer: SharedArrayBuffer; port: MessagePort }
let writable: FileSystemWritableFileStream | undefined;
let fileHandle: FileSystemFileHandle;
let control: Int32Array;
let payload: Uint8Array;
let port: MessagePort;
let busy = false;
let size = 0;

const complete = (result: number, error = 0) => {
  Atomics.store(control, I.Result, result);
  Atomics.store(control, I.Error, error);
  Atomics.store(control, I.State, State.Response);
  Atomics.notify(control, I.State);
};

const service = async () => {
  if (busy || Atomics.load(control, I.State) !== State.Request) return;
  busy = true;
  try {
    if (Atomics.load(control, I.Cancel)) throw new DOMException("Direct file output cancelled", "AbortError");
    const op = Atomics.load(control, I.Op);
    const offset = joinOffset(Atomics.load(control, I.OffsetLow), Atomics.load(control, I.OffsetHigh));
    const length = Atomics.load(control, I.Length);
    switch (op) {
      case Op.Open: complete(0); break;
      case Op.Write: {
        if (!writable) throw new DOMException("Writable is closed", "InvalidStateError");
        const copy = payload.slice(0, length);
        await writable.write({ type: "write", position: offset, data: copy });
        size = Math.max(size, offset + length);
        if (length > Atomics.load(control, I.MaxChunk)) Atomics.store(control, I.MaxChunk, length);
        complete(length);
        break;
      }
      case Op.Seek: complete(offset); break;
      case Op.GetSize: {
        const [low, high] = splitOffset(size);
        Atomics.store(control, I.OffsetLow, low);
        Atomics.store(control, I.OffsetHigh, high);
        complete(0);
        break;
      }
      case Op.Truncate:
        if (!writable) throw new DOMException("Writable is closed", "InvalidStateError");
        await writable.truncate(offset); size = offset; complete(0); break;
      case Op.Flush:
        if (!writable) throw new DOMException("Writable is closed", "InvalidStateError");
        await writable.close();
        writable = await fileHandle.createWritable({ keepExistingData: true });
        complete(0); break;
      case Op.Close:
        if (writable) { await writable.close(); writable = undefined; }
        complete(0); break;
      default: throw new DOMException(`Unknown direct file operation ${op}`, "DataError");
    }
  } catch (error) { complete(-1, directFileErrorCode(error)); }
  finally { busy = false; }
};

self.onmessage = async ({ data }: MessageEvent<InitMessage>) => {
  if (data.type !== "INIT") return;
  try {
    if (!data.handle || typeof data.handle.createWritable !== "function") throw new DOMException("File System Access API is unavailable", "NotSupportedError");
    control = new Int32Array(data.buffer, 0, DIRECT_FILE_CONTROL_WORDS);
    payload = new Uint8Array(data.buffer, DIRECT_FILE_CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT);
    port = data.port;
    fileHandle = data.handle;
    writable = await data.handle.createWritable({ keepExistingData: false });
    port.onmessage = service;
    port.start();
    self.postMessage({ type: "READY" });
  } catch (error) {
    self.postMessage({ type: "INIT_ERROR", error: directFileErrorCode(error), message: error instanceof Error ? error.message : String(error) });
  }
};
