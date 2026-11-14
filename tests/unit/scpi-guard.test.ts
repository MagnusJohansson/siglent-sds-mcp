import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
    "TRUART:STOP?",
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
    ["stop with a root colon", ":STOP?"],
    ["screen dump as text", "SCDP?"],
    ["compound", "C1:VDIV?;ARM"],
    ["space before ?", "C1:VDIV ?"],
    ["INR? (reads and clears)", "INR?"],
    ["*ESR? (reads and clears)", "*ESR?"],
    ["CMR? (reads and clears)", "CMR?"],
    ["EXR? (reads and clears)", "EXR?"],
    ["DDR? (reads and clears)", "DDR?"],
    ["a read-and-clear query with a channel prefix", "C1:INR?"],
    ["a read-and-clear query with a numeric suffix", "INR1?"],
    ["a read-and-clear query with two prefixes", "C1:B1:INR?"],
    ["an empty header node", "C1::VDIV?"],
    ["an empty last node", "C1:VDIV:?"],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(ScpiPolicyError);
  });
});

describe("assertIsQuery: commands the guide documents without a query form", () => {
  it.each([
    "SET50?",
    "MEACL?",
    "MEASURE_CLEAR?",
    "REFSA?",
    "REF_SAVE?",
    "REFCL?",
    "REF_CLOSE?",
    "PFCM?",
    "PF_CREATEM?",
    "RCPN?",
    "STPN?",
    "REC?",
    "PACU?",
    "MEGS?",
    "MEGA?",
    "MEGB?",
    "DCPA?",
    "B1:DCIC?",
    "B2:DCLN?",
    "TRSPI:DATA?",
    "ARWV?",
    "CRAU?",
    "STOP?",
    "FRTR?",
    // Not in the guide; blocked anyway.
    "FORCE_TRIGGER?",
    // Spellings outside the guide's: a numeric suffix, a source prefix, lower case.
    "ASET1?",
    "C1:ASET?",
    "arm?",
    // More than one prefix, or a longer one.
    "C1:B1:ASET?",
    "DIGITAL1:ASET?",
    "C1:C2:STOP?",
    "ABCDE1:STOP?",
  ])("rejects %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(/action command/);
  });

  it.each([
    // Neighbours that share a name with an action but are documented queries.
    "TRUART:STOP?",
    "TRSPI:CLK?",
    "TRIIC:DATA?",
    "C1:VDIV?",
    "SAST?",
    "PF_SET?",
    "REF_DISPLAY?",
  ])("accepts the documented query %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).not.toThrow();
  });

  it("accepts every query the programming guide documents", () => {
    const guide = readFileSync(new URL("../../docs/programming-guide.md", import.meta.url), "utf8");
    // The guide's notation and typos ("PF_ SET?", "TRIIC :QUAL?", "DAT 2") to a query string.
    const normalise = (q: string) =>
      q
        .replace(/<\s*(channel|trace|trig_source|group)\s*>/gi, "C1")
        .replace(/<\s*digital\s*>/gi, "D0")
        .replace(/<\s*func\s*>/gi, "F1")
        .replace(/<\s*(index|n)\s*>/gi, "1")
        .replace(/<\s*sourceA-sourceB\s*>/gi, "C1-C2")
        .replace(/\^/g, "")
        .replace(/_\s+/g, "_")
        .replace(/\s+:/g, ":")
        .replace(/(\w)\s+(\d)/g, "$1$2")
        .trim();

    // 1. Every QUERY SYNTAX line.
    const fromSyntax = [...guide.matchAll(/QUERY SYNTAX\**\s*([^\n]*\?)/g)].map((m) => normalise(m[1]));
    // 2. The long and short name of every section marked "Query" or "Command/Query".
    const lines = guide.split("\n");
    const fromSections = lines.flatMap((line, i) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const marker = lines
        .slice(i + 1, i + 6)
        .map((l) => l.trim())
        .find((l) => /^(Command|Query)(\s*\/\s*Query)?$/.test(l));
      // Page numbers are headings too ("###### 19"), right above a section.
      if (!heading || /^\d+$/.test(heading[1].trim()) || !marker || marker === "Command") return [];
      // "CHANNEL VOLT_DIV | VDIV", "SERIAL TRIGGER TRIIC:SCL", "COMMON (*) *IDN?"
      return normalise(heading[1])
        .split("|")
        .map((name) => name.trim().split(/\s+/).pop() ?? "")
        .map((name) => (name.endsWith("?") ? name : `${name}?`));
    });
    const documented = new Set([...fromSyntax, ...fromSections]);
    expect(documented.size).toBeGreaterThan(250);

    // Documented, and rejected on purpose.
    const blockedOnPurpose = new Set([
      "INR?", // reads and clears the register
      "*CAL?", // starts a self-calibration
      "SCREEN_DUMP?", // binary: only through queryBinary()
      "SCDP?",
    ]);
    // A '-' in the header doesn't fit the query shape; this was never accepted.
    const notExpressible = new Set(["C1-C2:MEASURE_DELY?"]);

    const outcome = (q: string) => {
      try {
        assertIsQuery(q);
        return "accepted";
      } catch {
        return "rejected";
      }
    };
    const unexpected = [...documented].filter((q) => {
      if (notExpressible.has(q)) return false;
      return outcome(q) !== (blockedOnPurpose.has(q) ? "rejected" : "accepted");
    });
    expect(unexpected).toEqual([]);
    expect([...blockedOnPurpose].filter((q) => !documented.has(q))).toEqual([]);
  });

  it("rejects every command the programming guide documents without a query form", () => {
    const guide = readFileSync(new URL("../../docs/programming-guide.md", import.meta.url), "utf8");
    const lines = guide.split("\n");
    // 1. The long and short name of every section marked "Command" only.
    const fromSections = lines.flatMap((line, i) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (!heading || /^\d+$/.test(heading[1].trim())) return [];
      const marker = lines
        .slice(i + 1, i + 6)
        .map((l) => l.trim())
        .find((l) => /^(Command|Query)(\s*\/\s*Query)?$/.test(l));
      if (marker !== "Command") return [];
      return heading[1].split("|").map((name) => name.trim().split(/\s+/).pop() ?? "");
    });
    // 2. The index at the end: "AUTO_SETUP, ASET, Command, 39", "B<n>:DCIC, Command, 62".
    // Some commands have no marker line in their section (B<n>:DCIC) or only
    // appear in the index (CURSOR_AUTO, RECALL).
    const index = guide.slice(guide.lastIndexOf("\nIndex\n"));
    const fromIndex = [...index.matchAll(/^(.+), Command, \d+$/gm)].flatMap((m) =>
      m[1].split(",").map((name) => name.trim())
    );
    const commands = new Set(
      [...fromSections, ...fromIndex]
        .map((name) => name.replace(/<\s*n\s*>/gi, "1"))
        // The index drops the '*' of the common commands.
        .map((name) => (/^(OPC|RCL|RST|SAV)$/.test(name) ? `*${name}` : name))
    );
    expect(commands.size).toBeGreaterThan(40);

    // The index says "Command", but the section documents a query form.
    const indexErrors = ["FRAME_SET", "FRAM", "SKEW", "*OPC"];
    expect(indexErrors.filter((name) => !commands.has(name))).toEqual([]);

    const leaks = [...commands]
      .filter((name) => !indexErrors.includes(name))
      .flatMap((name) =>
        name.startsWith("*")
          ? [`${name}?`, `${name.toLowerCase()}?`]
          : [`${name}?`, `${name.toLowerCase()}?`, `C1:${name}?`, `${name}1?`]
      )
      .filter((q) => {
        try {
          assertIsQuery(q);
          return true;
        } catch {
          return false;
        }
      });
    expect(leaks).toEqual([]);
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
