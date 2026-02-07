import { describe, it, expect } from "vitest";
import { parseSampleRate, countTrailingZeros } from "../../src/tools/waveform.js";

describe("parseSampleRate", () => {
  it("parses GSa/s suffix", () => {
    expect(parseSampleRate("1.00GSa/s")).toBe(1e9);
  });

  it("parses MSa/s suffix", () => {
    expect(parseSampleRate("500.00MSa/s")).toBe(5e8);
  });

  it("parses scientific notation (CHDR OFF)", () => {
    expect(parseSampleRate("1.00E+09")).toBe(1e9);
  });

  it("parses kSa/s suffix", () => {
    expect(parseSampleRate("100.00kSa/s")).toBe(1e5);
  });

  it("handles whitespace", () => {
    expect(parseSampleRate("  2.50GSa/s  ")).toBe(2.5e9);
  });
});

describe("countTrailingZeros", () => {
  it("returns 11 for 0xF800 (RGB565 red mask)", () => {
    expect(countTrailingZeros(0xf800)).toBe(11);
  });

  it("returns 5 for 0x07E0 (RGB565 green mask)", () => {
    expect(countTrailingZeros(0x07e0)).toBe(5);
  });

  it("returns 0 for 0x001F (RGB565 blue mask)", () => {
    expect(countTrailingZeros(0x001f)).toBe(0);
  });

  it("returns 32 for 0", () => {
    expect(countTrailingZeros(0)).toBe(32);
  });

  it("returns 0 for odd numbers", () => {
    expect(countTrailingZeros(1)).toBe(0);
    expect(countTrailingZeros(7)).toBe(0);
  });
});
