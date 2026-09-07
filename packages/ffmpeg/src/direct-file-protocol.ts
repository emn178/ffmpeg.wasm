export const DIRECT_FILE_CONTROL_WORDS = 16;
export const DIRECT_FILE_DEFAULT_BUFFER_SIZE = 1024 * 1024;

export const enum DirectFileIndex {
  State, Op, Result, Error, OffsetLow, OffsetHigh, Length, Cancel, Sequence, MaxChunk,
}
export const enum DirectFileState { Idle, Request, Response }
export const enum DirectFileOp { Open = 1, Write, Seek, Truncate, Flush, Close, GetSize }

export const createDirectFileBuffer = (payloadSize = DIRECT_FILE_DEFAULT_BUFFER_SIZE): SharedArrayBuffer => {
  if (typeof SharedArrayBuffer === "undefined") throw new DOMException("SharedArrayBuffer requires cross-origin isolation", "NotSupportedError");
  if (!Number.isSafeInteger(payloadSize) || payloadSize < 4096) throw new RangeError("payloadSize must be at least 4096 bytes");
  return new SharedArrayBuffer(DIRECT_FILE_CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT + payloadSize);
};

export const joinOffset = (low: number, high: number): number => {
  const value = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("File offset exceeds JavaScript safe integer range");
  return result;
};

export const splitOffset = (value: number): [number, number] => {
  const n = BigInt(value);
  return [Number(n & 0xffffffffn), Number((n >> 32n) & 0xffffffffn)];
};

export const directFileErrorCode = (error: unknown): number => {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return 125;
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return 13;
    if (error.name === "QuotaExceededError") return 28;
    if (error.name === "InvalidStateError") return 9;
  }
  return 5;
};
