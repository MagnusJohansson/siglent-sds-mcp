/**
 * SCPI guard: checks applied to every string before it is written to the
 * oscilloscope socket.
 *
 * Tool arguments come from a language model and must be treated as untrusted
 * input. The connection layer is the single choke point every command and
 * query passes through, so these checks live there rather than in each tool.
 */

/** Raised when a command or argument violates the security policy. */
export class ScpiPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScpiPolicyError";
  }
}

/**
 * Reject anything that could smuggle a second command onto the wire.
 *
 * - Control characters (incl. \n and \r): the connection terminates every
 *   command with "\n", so an embedded newline would start a new command.
 * - ';': the SCPI compound-command separator ("C1:VDIV?;C1:VDIV 5V").
 * - Non-printable or non-ASCII bytes: SCPI is ASCII; nothing legitimate needs them.
 */
export function assertWireSafe(cmd: string): void {
  if (cmd.length === 0) {
    throw new ScpiPolicyError("Empty SCPI command.");
  }
  if (cmd.length > 512) {
    throw new ScpiPolicyError("SCPI command too long (max 512 characters).");
  }
  for (let i = 0; i < cmd.length; i++) {
    const code = cmd.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new ScpiPolicyError(
        `SCPI command contains a control or non-ASCII character at position ${i} (code ${code}). ` +
          "Embedded newlines would inject additional commands."
      );
    }
  }
  if (cmd.includes(";")) {
    throw new ScpiPolicyError(
      "SCPI compound commands (';') are not allowed. Send one command per call."
    );
  }
}

/**
 * Query shape: an optional root colon or '*', a header, then '?' immediately
 * after it, optionally followed by parameters.
 *
 * This is a structural check (allowlist of shape), not a denylist of setter
 * keywords, so long-form headers or unusual setters cannot slip through:
 * anything without '?' directly after the header is not a query.
 */
const QUERY_PATTERN = /^(\*|:)?([A-Za-z][A-Za-z0-9_:]*)\?(?: ([A-Za-z0-9_,.+\-"/ ]*))?$/;

/**
 * Queries that legitimately take parameters after the '?'. For any other
 * query, trailing parameters are rejected: whether the instrument ignores
 * them or acts on them ("C1:VDIV? 5V") is firmware-dependent, so they are
 * not allowed through a tool that promises to be read-only.
 *
 * WF? (waveform data) is deliberately absent: its reply is binary, which the
 * text query path can't frame. The tools fetch it through queryBinary().
 */
const QUERY_PARAMETER_RULES: Array<{ name: string; header: RegExp; params: RegExp }> = [
  {
    // C1:PAVA? FREQ, PAVA? STAT1 (measurement name or statistics slot)
    name: "PAVA?",
    header: /^((C[1-4]|MATH|F[1-4]):)?PA(VA|RAMETER_VALUE)$/i,
    params: /^[A-Z][A-Z0-9]{1,9}$/i,
  },
];

/**
 * IEEE 488.2 common commands that are pure queries. Others that accept a '?'
 * form (*RST?, *CAL?, *TST?, *CLS?) are actions: *CAL? runs a self
 * calibration that takes minutes. *ESR? is left out because reading the
 * event status register also clears it.
 */
const COMMON_QUERIES = new Set(["IDN", "OPC", "STB", "ESE", "SRE", "OPT"]);

/**
 * Queries that read a status register and clear it as a side effect, so a
 * tool that promises to be read-only must not send them. INR? is documented
 * as read-and-clear in the SDS programming guide; CMR?, EXR? and DDR? are the
 * equivalent error registers on earlier Siglent/LeCroy firmware.
 */
const READ_AND_CLEAR_QUERIES = new Set(["INR", "CMR", "EXR", "DDR"]);

/**
 * Siglent action commands with no documented query form. The shape check
 * can't tell "ASET?" from a real query, and whether the firmware runs the
 * action is undocumented. Defence in depth, not the primary control:
 * undocumented headers remain a residual risk (see docs/threat-model.md).
 */
const ACTION_HEADERS = new Set([
  "ARM",
  "ARM_ACQUISITION",
  "STOP",
  "ASET",
  "AUTO_SETUP",
  "FRTR",
  "FORCE_TRIGGER",
  "PACL",
  "PARAMETER_CLR",
  "SCDP",
  "SCREEN_DUMP",
]);

export function assertIsQuery(cmd: string): void {
  assertWireSafe(cmd);
  const m = QUERY_PATTERN.exec(cmd.trim());
  if (!m) {
    throw new ScpiPolicyError(
      `Not a SCPI query: "${cmd}". A query must be a single header ending in '?' ` +
        "(e.g. 'C1:VDIV?'). Commands that change instrument state are not allowed here."
    );
  }
  const [, prefix, header, params] = m;
  const name = header.toUpperCase();

  if (prefix === "*" && !COMMON_QUERIES.has(name)) {
    throw new ScpiPolicyError(
      `"*${name}?" is not allowed: only the common queries ` +
        `${[...COMMON_QUERIES].map((q) => `*${q}?`).join(", ")} are permitted.`
    );
  }
  if (ACTION_HEADERS.has(name.split(":").pop()!)) {
    throw new ScpiPolicyError(`"${name}" is an action command, not a query.`);
  }
  if (READ_AND_CLEAR_QUERIES.has(name)) {
    throw new ScpiPolicyError(
      `"${name}?" is not allowed: reading this status register also clears it.`
    );
  }
  if (params !== undefined && params.trim() !== "") {
    const rule = QUERY_PARAMETER_RULES.find((r) => r.header.test(header));
    if (!rule) {
      throw new ScpiPolicyError(
        `Parameters after '?' are only allowed for ${QUERY_PARAMETER_RULES.map((r) => r.name).join(", ")}. ` +
          `"${cmd}" could be interpreted as a command by the instrument.`
      );
    }
    if (!rule.params.test(params.trim())) {
      throw new ScpiPolicyError(
        `Parameters "${params.trim()}" are not a documented form for ${rule.name}.`
      );
    }
  }
}

/**
 * Binary transfers the tools use: the screen dump and waveform data. This is
 * an exact allowlist; queryBinary() is not reachable from raw tool input.
 */
const BINARY_QUERIES: RegExp[] = [/^SCDP$/, /^C[1-4]:WF\? (DESC|DAT1|DAT2|ALL)$/];

export function assertBinaryQuery(cmd: string): void {
  assertWireSafe(cmd);
  if (!BINARY_QUERIES.some((re) => re.test(cmd))) {
    throw new ScpiPolicyError(`"${cmd}" is not an allowed binary query.`);
  }
}

/**
 * Commands sent through sendCommand() must not produce output: each is
 * followed by *OPC? and its "1" is the only reply expected. A query (even one
 * that answers "1", like "*OPC?" itself) or a data transfer such as SCDP would
 * put an extra reply on the wire that the next query would read. So they are
 * rejected before anything is written; the acknowledgement check in the
 * connection is the backstop for undocumented ones.
 */
const OUTPUT_COMMANDS = new Set(["SCDP", "SCREEN_DUMP"]);

export function assertIsCommand(cmd: string): void {
  assertWireSafe(cmd);
  if (cmd.includes("?")) {
    throw new ScpiPolicyError(
      `"${cmd}" is a query. Commands must not produce a reply; use scpi_query for queries.`
    );
  }
  const header = cmd.trim().split(/\s/, 1)[0].replace(/^:/, "").toUpperCase();
  if (OUTPUT_COMMANDS.has(header.split(":").pop()!)) {
    throw new ScpiPolicyError(`"${header}" returns data and can't be sent as a command.`);
  }
}
