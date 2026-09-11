const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;

/** Generates an RFC 9562 UUIDv7 using the current Unix millisecond timestamp. */
export function generateUuidV7(timestampMs: number = Date.now()): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_UUID_V7_TIMESTAMP) {
    throw new RangeError("UUIDv7 timestamp must be an unsigned 48-bit integer.");
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let remainingTimestamp = timestampMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp & 0xff;
    remainingTimestamp = Math.floor(remainingTimestamp / 0x100);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
