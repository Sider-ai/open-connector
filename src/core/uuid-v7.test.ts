import { describe, expect, it } from "vitest";
import { generateUuidV7 } from "./uuid-v7.ts";

describe("generateUuidV7", () => {
  it("encodes the Unix millisecond timestamp with RFC 9562 version and variant bits", () => {
    const timestampMs = 1_788_739_200_123;
    const value = generateUuidV7(timestampMs);

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16)).toBe(timestampMs);
  });

  it("produces distinct identifiers and rejects invalid timestamps", () => {
    expect(new Set(Array.from({ length: 128 }, () => generateUuidV7())).size).toBe(128);
    expect(() => generateUuidV7(-1)).toThrow("unsigned 48-bit integer");
    expect(() => generateUuidV7(0x1000000000000)).toThrow("unsigned 48-bit integer");
  });
});
