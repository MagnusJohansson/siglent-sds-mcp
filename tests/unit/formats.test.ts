import { describe, it, expect } from "vitest";
import { SIGNED_TIME, SIGNED_VOLTAGE, TIME, VOLTAGE } from "../../src/security/formats.js";

describe("parameter formats", () => {
  it.each(["500mV", "1V", "2", "0.5", "1.00E-01", "2E-1V", "10uV", ".5V"])("voltage accepts %s", (v) => {
    expect(VOLTAGE.test(v)).toBe(true);
  });
  it.each(["-1V", "1V,OFF", "1 V", "1V\nARM", "1V;ARM", "abc", "", "1VV"])("voltage rejects %j", (v) => {
    expect(VOLTAGE.test(v)).toBe(false);
  });
  it.each(["-200mV", "+1.5V", "0V", "-1.50E-01"])("signed voltage accepts %s", (v) => {
    expect(SIGNED_VOLTAGE.test(v)).toBe(true);
  });
  it.each(["1US", "500NS", "10MS", "1S", "1.00E-06", "50us"])("time accepts %s", (v) => {
    expect(TIME.test(v)).toBe(true);
  });
  it.each(["-1US", "1MIN", "1US\nARM", "1US,2"])("time rejects %j", (v) => {
    expect(TIME.test(v)).toBe(false);
  });
  it.each(["-4.8US", "0S", "+100NS"])("signed time accepts %s", (v) => {
    expect(SIGNED_TIME.test(v)).toBe(true);
  });
});
