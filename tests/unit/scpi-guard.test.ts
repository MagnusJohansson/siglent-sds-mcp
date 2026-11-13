import { describe, it, expect } from "vitest";
import {
  assertBinaryQuery,
  assertIsCommand,
  assertIsQuery,
  assertWireSafe,
  ScpiPolicyError,
} from "../../src/security/scpi-guard.js";

describe("assertWireSafe", () => {
  it.each(["C1:VDIV 500mV", "TDIV 1US", "TRSE EDGE,SR,C2", "*IDN?"])("accepts %s", (cmd) => {
    expect(() => assertWireSafe(cmd)).not.toThrow();
  });

  it.each([
    ["newline", "C1:VDIV 1V\nARM"],
    ["carriage return", "C1:VDIV 1V\rARM"],
    ["NUL", "C1:VDIV 1V\0"],
    ["tab", "C1:VDIV\t1V"],
    ["compound", "C1:VDIV 1V;ARM"],
    ["non-ASCII", "C1:VDIV 1µV"],
    ["empty", ""],
    ["too long", "A".repeat(513)],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertWireSafe(cmd)).toThrow(ScpiPolicyError);
  });
});

describe("assertIsQuery", () => {
  it.each([
    "C1:VDIV?",
    ":TDIV?",
    "SARA?",
    "*IDN?",
    "*OPC?",
    "*STB?",
    "C1:PAVA? FREQ",
    "PAVA? STAT3",
    "C2:PARAMETER_VALUE? PKPK",
  ])("accepts %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).not.toThrow();
  });

  it.each([
    ["setter", "C1:VDIV 1V"],
    ["action without ?", "ARM"],
    ["parameters on a non-parameter query", "C1:VDIV? 1V"],
    ["two PAVA parameters", "C1:PAVA? FREQ,PKPK"],
    ["*RST?", "*RST?"],
    ["*CAL?", "*CAL?"],
    ["*TST?", "*TST?"],
    ["auto setup", "ASET?"],
    ["long-form auto setup", "AUTO_SETUP?"],
    ["force trigger", "FRTR?"],
    ["screen dump as text", "SCDP?"],
    ["compound", "C1:VDIV?;ARM"],
    ["space before ?", "C1:VDIV ?"],
    ["INR? (reads and clears)", "INR?"],
    ["*ESR? (reads and clears)", "*ESR?"],
    ["CMR? (reads and clears)", "CMR?"],
    ["EXR? (reads and clears)", "EXR?"],
    ["DDR? (reads and clears)", "DDR?"],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(ScpiPolicyError);
  });
});

describe("assertBinaryQuery", () => {
  it.each(["SCDP", "C1:WF? DAT2", "C4:WF? DESC"])("accepts %s", (cmd) => {
    expect(() => assertBinaryQuery(cmd)).not.toThrow();
  });

  it.each(["C1:VDIV?", "C5:WF? DAT2", "C1:WF? DAT2,ALL", "SCDP\nARM", "WFSU SP,0"])(
    "rejects %s",
    (cmd) => {
      expect(() => assertBinaryQuery(cmd)).toThrow(ScpiPolicyError);
    }
  );
});

describe("assertIsCommand", () => {
  it.each(["C1:VDIV 500mV", "ARM", "TRSE EDGE,SR,C2", "*RST"])("accepts %s", (cmd) => {
    expect(() => assertIsCommand(cmd)).not.toThrow();
  });

  it.each([
    ["a query", "C1:VDIV?"],
    ["*OPC? (answers like the acknowledgement)", "*OPC?"],
    ["a query with parameters", "C1:PAVA? FREQ"],
    ["a screen dump", "SCDP"],
    ["a long-form screen dump", ":SCREEN_DUMP"],
    ["an injected second command", "ARM\nSTOP"],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertIsCommand(cmd)).toThrow(ScpiPolicyError);
  });
});
