#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDS oscilloscope, through the built
 * server over stdio (the same path an MCP client uses).
 *
 * Usage:  npm run hardware-check -- <scope-ip>
 *         npm run hardware-check -- <scope-ip> --docker <image>
 *
 * --docker runs the server from a Docker image instead of build/, with the
 * hardening flags the README documents (--read-only --cap-drop=ALL
 * --security-opt=no-new-privileges).
 *
 * - Injection probes try to change the timebase (TDIV) and the check reads it
 *   back: the payload is harmless and easy to verify. The SET50? probe reads
 *   the trigger level back instead, after setting it to 300 mV: run with no
 *   signal on the trigger channel, or one not centred near 300 mV, or a SET50
 *   that ran would leave the level where it was and the probe would pass.
 * - Changes C1 volts/div, the timebase, trigger settings and the waveform
 *   transfer setup (WFSU) while it runs, and restores the values it read at
 *   the start, also if a check fails or throws.
 * - Doesn't call `measure` or `measure_statistics`: they install measurements
 *   on the scope's display, which can't be read back and restored. The
 *   measurement path is checked with a read-only PAVA? query instead.
 * - The scope serves one TCP client at a time: close other programs using it
 *   (EasyScopeX, another MCP server) first.
 * - The audit log is a second, independent oracle: every security probe must
 *   be recorded as guard.refused with the expected rule, and no probe's
 *   payload may appear in any scpi.write.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ip = process.argv[2];
const dockerFlag = process.argv.indexOf("--docker");
const dockerImage = dockerFlag > 0 ? process.argv[dockerFlag + 1] : undefined;
if (!ip || ip.startsWith("--") || (dockerFlag > 0 && !dockerImage)) {
  console.error("Usage: npm run hardware-check -- <scope-ip> [--docker <image>]");
  process.exit(2);
}
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail.slice(0, 110)}]` : ""}`);
}

const sessions = new Set();
let started = 0;

// Every server session writes its full audit trail here. With --docker the
// directory is mounted at /audit and must be writable by the container's UID 1000.
const auditDir = mkdtempSync(path.join(tmpdir(), "sds-hardware-check-"));
chmodSync(auditDir, 0o777);
const auditFile = path.join(auditDir, "audit.jsonl");
const auditEnv = { SIGLENT_AUDIT_LOG: dockerImage ? "/audit/audit.jsonl" : auditFile };

/** [label, tool, arguments, the rule the audit log must record] for every probe. */
const expected = [];

// The server's own environment. With --docker it goes into the container as
// -e flags; the docker CLI itself only gets PATH, HOME and the variables
// that select a daemon (DOCKER_HOST, DOCKER_CONTEXT), when they're set.
function serverCommand(serverEnv) {
  if (!dockerImage) {
    return { command: process.execPath, args: [serverPath], env: { PATH: process.env.PATH ?? "", ...serverEnv } };
  }
  return {
    command: "docker",
    args: [
      "run", "--rm", "-i",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "-v", `${auditDir}:/audit`,
      ...Object.entries(serverEnv).flatMap(([k, val]) => ["-e", `${k}=${val}`]),
      dockerImage,
    ],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...Object.fromEntries(
        ["DOCKER_HOST", "DOCKER_CONTEXT"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])
      ),
    },
  };
}

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    ...serverCommand({ SIGLENT_IP: ip, ...auditEnv, ...extraEnv }),
    stderr: "pipe",
  });
  const client = new Client({ name: "hardware-check", version: "1.0.0" });
  await client.connect(transport);
  started++;
  // Drain stderr: a pipe nobody reads fills up. The server doesn't stall on it
  // (its writer is non-blocking), but it would drop audit events.
  transport.stderr?.on("data", () => {});
  sessions.add(client);
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      return { ok: !r.isError, text, content: r.content ?? [] };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err), content: [] };
    }
  };
  // Auto-connect runs in the background; connect explicitly to be deterministic.
  const conn = await call("connect");
  const close = async () => {
    sessions.delete(client);
    await client.close().catch(() => {});
  };
  return { client, call, conn, close };
}

/** The edge trigger's source channel ("C1"), or null for EX, LINE, ... */
function triggerChannel(trse) {
  return /(?:^|,)SR,(C\d)(?:,|$)/.exec(trse)?.[1] ?? null;
}

/**
 * The settings this script changes. The trigger level is per channel, and
 * setting <ch>:TRLV also switches the trigger source to <ch> on SDS1000X-E,
 * so it's read for the current source and restored before TRSE.
 */
function settingsFor(trse) {
  const ch = triggerChannel(trse);
  return ["C1:VDIV?", "TDIV?", ...(ch ? [`${ch}:TRLV?`] : []), "TRSE?", "TRMD?", "WFSU?"];
}

/**
 * Read the settings this script changes. Throws if any read fails or comes
 * back empty: an error text must never be stored (and later "restored") as
 * an original value.
 */
async function snapshot(call) {
  const trse = await call("scpi_query", { command: "TRSE?" });
  if (!trse.ok || trse.text.trim() === "") {
    throw new Error(`could not read TRSE?: ${trse.text || "empty reply"}`);
  }
  const out = {};
  for (const query of settingsFor(trse.text.trim())) {
    const r = await call("scpi_query", { command: query });
    if (!r.ok || r.text.trim() === "") {
      throw new Error(`could not read ${query}: ${r.text || "empty reply"}`);
    }
    out[query] = r.text.trim();
  }
  return out;
}

const q = async (call, command) => (await call("scpi_query", { command })).text;

/** Remove the audit directory, on every exit path. */
function cleanupAudit() {
  try {
    if (dockerImage) {
      // The container's files belong to UID 1000; remove them through the image.
      execFileSync("docker", ["run", "--rm", "--user", "0", "-v", `${auditDir}:/audit`, "--entrypoint", "sh", dockerImage, "-c", "rm -rf /audit/*"], { stdio: "ignore" });
    }
    rmSync(auditDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** The probe payload ("TDIV 2MS" or "TDIV 5MS"), set once the baseline is read. */
let payload;

/**
 * The audit file's text. With --docker it belongs to the container's UID 1000
 * with mode 0600, which a different host user can't read on Linux, so it's
 * read through the image as that user.
 */
function auditText() {
  try {
    return dockerImage
      ? execFileSync("docker", ["run", "--rm", "-v", `${auditDir}:/audit`, "--entrypoint", "cat", dockerImage, "/audit/audit.jsonl"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : readFileSync(auditFile, "utf8");
  } catch {
    return ""; // not written yet
  }
}

/** The audit records, once every session has written its server.stop. */
async function readAudit() {
  // Each --docker read starts a container, so it polls less often; about 10 s either way.
  const [tries, interval] = dockerImage ? [10, 1000] : [100, 100];
  for (let t = 0; t < tries; t++) {
    const records = [];
    for (const line of auditText().split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // a line still being written: read again
      }
    }
    if (records.filter((r) => r["event.name"] === "server.stop").length >= started) return records;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`fewer than ${started} server.stop records in the audit log`);
}

async function auditChecks() {
  console.log("\n4. Audit log (an independent record of what the servers refused and wrote)");
  const records = await readAudit();
  const refusals = records.filter((r) => r["event.name"] === "guard.refused");
  const unrecorded = expected
    .filter(([, tool, args, rule]) => {
      if (tool === "connect") return !refusals.some((r) => r.rule === rule && r["server.address"] === args.host);
      const ids = records
        .filter((r) => r["event.name"] === "mcp.request" && r["gen_ai.tool.name"] === tool &&
          r["gen_ai.tool.call.arguments"] === JSON.stringify(args))
        .map((r) => `${r["service.instance.id"]}/${r["jsonrpc.request.id"]}`);
      return !refusals.some((r) => r.rule === rule && ids.includes(`${r["service.instance.id"]}/${r["jsonrpc.request.id"]}`));
    })
    .map(([label]) => label);
  check(
    "every probe recorded as guard.refused with its rule",
    expected.length > 0 && unrecorded.length === 0,
    unrecorded.length ? `missing: ${unrecorded.join("; ")}` : `${expected.length} probes`
  );
  // A leak: a refused query written as a query, a refused command written as
  // a command, or the timebase payload anywhere in a write (the F2 probes
  // would smuggle it inside a longer line: "C1:VDIV 500mV\nTDIV 2MS"). No
  // legitimate write contains it: restore writes the baseline, the other value. (The F5 probes send
  // "C1:VDIV?" and "*OPC?" through scpi_command; the server writes those
  // strings as queries all the time, so the kind matters.)
  const refusedAs = (tool) => new Set(expected.filter(([, t]) => t === tool).map(([, , args]) => args.command));
  const refusedQueries = refusedAs("scpi_query");
  const refusedCommands = refusedAs("scpi_command");
  const writeRecords = records.filter((r) => r["event.name"] === "scpi.write");
  const writes = writeRecords.map((r) => String(r["scpi.command"]));
  const leaked = writeRecords
    .filter((r) => {
      const w = String(r["scpi.command"]);
      const kind = r["scpi.kind"];
      return (
        (refusedQueries.has(w) && kind !== "command") ||
        (refusedCommands.has(w) && kind === "command") ||
        (payload !== undefined && w.includes(payload))
      );
    })
    .map((r) => `${r["scpi.kind"]} ${r["scpi.command"]}`);
  check("no probe's payload reached the wire", writes.length > 0 && leaked.length === 0, `${writes.length} writes${leaked.length ? `, leaked: ${leaked.join(", ")}` : ""}`);
}

async function main() {
  console.log(`Hardware check: ${ip}\n`);

  console.log("1. Default configuration (raw SCPI off)");
  const s = await startServer();
  check("connect + identify", s.conn.ok && /SDS/.test(s.conn.text), s.conn.text.replace(/\n/g, " "));
  if (!s.conn.ok) {
    await s.close();
    cleanupAudit();
    process.exit(1);
  }
  let original;
  try {
    original = await snapshot(s.call);
  } catch (err) {
    // Nothing has been changed yet: stop before the checks change anything.
    check("read original settings", false, err.message);
    await s.close();
    console.log("\nAborted before changing any settings.");
    cleanupAudit();
    process.exit(1);
  }
  console.log(`  info  original: ${JSON.stringify(original)}`);

  try {
    await runChecks(s);
  } catch (err) {
    check("checks completed without an exception", false, err instanceof Error ? err.message : String(err));
  } finally {
    await restore(original);
  }
  try {
    await auditChecks();
  } catch (err) {
    check("audit log read", false, err instanceof Error ? err.message : String(err));
  }
  cleanupAudit();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runChecks(s) {
  console.log("\n  Functional");
  const ch = await s.call("get_channel", { channel: "C1" });
  check("get_channel C1", ch.ok && /volts_per_div/.test(ch.text));

  let r = await s.call("configure_channel", { channel: "C1", vdiv: "500mV" });
  const vdivNow = await q(s.call, "C1:VDIV?");
  check("configure_channel C1 vdiv 500mV", r.ok && parseFloat(vdivNow) === 0.5, `C1:VDIV ${vdivNow}`);

  r = await s.call("configure_acquisition", { timebase: "1MS" });
  const tdivNow = await q(s.call, "TDIV?");
  check("configure_acquisition timebase 1MS", r.ok && parseFloat(tdivNow) === 0.001, `TDIV ${tdivNow}`);

  r = await s.call("get_acquisition_status");
  check("get_acquisition_status", r.ok && /sample_rate/.test(r.text));

  r = await s.call("scpi_query", { command: "C1:PAVA? PKPK" });
  check("scpi_query C1:PAVA? PKPK (read-only measurement)", r.ok && /PKPK/.test(r.text), r.text);

  r = await s.call("get_waveform", { channel: "C1", max_points: 100 });
  check("get_waveform C1 (100 points)", r.ok && /"returned_points"/.test(r.text), r.ok ? "" : r.text);

  r = await s.call("screenshot");
  check("screenshot", r.ok && r.content.some((c) => c.type === "image"), r.ok ? "" : r.text);

  // Payload: a timebase different from the current one.
  const baseline = await q(s.call, "TDIV?");
  const payloadTdiv = parseFloat(baseline) === 0.002 ? "5MS" : "2MS";
  const unchanged = async (call) => {
    const now = await q(call, "TDIV?");
    return { same: now === baseline, now };
  };
  console.log(`\n  Security (payload: TDIV ${payloadTdiv}; TDIV must stay ${baseline})`);
  payload = `TDIV ${payloadTdiv}`;
  const probes = [
    ["F1 setter via scpi_query", "scpi_query", { command: `TDIV ${payloadTdiv}` }, "query.not_a_query"],
    ["F1 compound query hides setter", "scpi_query", { command: `TDIV?;TDIV ${payloadTdiv}` }, "wire.compound"],
    ["F1 parameters after query header", "scpi_query", { command: `TDIV? ${payloadTdiv}` }, "query.parameters_not_allowed"],
    ["F1 reset in query form", "scpi_query", { command: "*RST?" }, "query.common_not_allowed"],
    ["F1 auto setup in query form", "scpi_query", { command: "ASET?" }, "query.action_command"],
    ["F2 newline injection in vdiv", "configure_channel", { channel: "C1", vdiv: `500mV\nTDIV ${payloadTdiv}` }, "schema.invalid"],
    ["F2 compound injection in trigger_level", "configure_acquisition", { trigger_level: `0V;TDIV ${payloadTdiv}` }, "schema.invalid"],
    ["F2 newline injection in timebase", "configure_acquisition", { timebase: `1MS\nTDIV ${payloadTdiv}` }, "schema.invalid"],
  ];
  expected.push(...probes);
  for (const [label, tool, args] of probes) {
    const res = await s.call(tool, args);
    const st = await unchanged(s.call);
    check(label, !res.ok && st.same, `rejected=${!res.ok}, TDIV=${st.now}`);
  }

  // SET50 moves the trigger level to the middle of the signal, not the
  // timebase. Set a level away from the middle first (there's no signal, or
  // one centred near 0 V), so a SET50 that ran would show in the readback.
  const trigCh = triggerChannel(await q(s.call, "TRSE?"));
  const set50Label = "F1 trigger-level action in query form (SET50?)";
  if (!trigCh) {
    check(set50Label, false, "trigger source isn't a channel; set an edge trigger on C1-C4");
  } else {
    r = await s.call("configure_acquisition", { trigger_level: "300mV" });
    const levelBefore = await q(s.call, `${trigCh}:TRLV?`);
    if (!r.ok || Math.abs(parseFloat(levelBefore) - 0.3) > 0.05) {
      check(set50Label, false, `could not set the trigger level to 300 mV first: ${r.ok ? levelBefore : r.text}`);
    } else {
      expected.push([set50Label, "scpi_query", { command: "SET50?" }, "query.action_command"]);
      const res = await s.call("scpi_query", { command: "SET50?" });
      const levelAfter = await q(s.call, `${trigCh}:TRLV?`);
      const st = await unchanged(s.call);
      check(
        set50Label,
        !res.ok && levelAfter === levelBefore && st.same,
        `rejected=${!res.ok}, ${trigCh}:TRLV ${levelBefore} -> ${levelAfter}, TDIV=${st.now}`
      );
    }
  }

  const { tools } = await s.client.listTools();
  check("scpi_command not exposed by default", !tools.some((t) => t.name === "scpi_command"), `${tools.length} tools`);

  // Any private-LAN address other than the scope's, which is allowed.
  const probeHost = ip === "192.168.1.1" ? "192.168.1.2" : "192.168.1.1";
  expected.push([`F3 connect to ${probeHost}`, "connect", { host: probeHost }, "host.not_allowed"]);
  r = await s.call("connect", { host: probeHost });
  const idn = await q(s.call, "*IDN?");
  check(`F3 connect to another LAN host (${probeHost}) rejected, session intact`, !r.ok && /SDS/.test(idn), r.text);

  await s.close();
  await new Promise((res) => setTimeout(res, 500)); // let the scope release the socket

  console.log("\n2. Raw SCPI enabled");
  const raw = await startServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  check("connect", raw.conn.ok, raw.conn.text.replace(/\n/g, " "));

  for (const command of ["C1:VDIV?", "*OPC?"]) {
    expected.push([`F5 query "${command}" as a command`, "scpi_command", { command }, "command.is_query"]);
    r = await raw.call("scpi_command", { command });
    const after = await q(raw.call, "TDIV?");
    check(
      `F5 query "${command}" as a command is rejected, next reply not stale`,
      !r.ok && /is a query/.test(r.text) && after === baseline,
      `next TDIV? -> ${after}`
    );
  }

  expected.push(["F2 newline injection in scpi_command", "scpi_command", { command: `TDIV ${payloadTdiv}\nTDIV 5MS` }, "wire.control_char"]);
  r = await raw.call("scpi_command", { command: `TDIV ${payloadTdiv}\nTDIV 5MS` });
  const st = await unchanged(raw.call);
  check("F2 newline injection in scpi_command", !r.ok && st.same, `TDIV=${st.now}`);
  await raw.close();
}

/** Restore the snapshot in a fresh session, whatever happened before. */
async function restore(original) {
  console.log("\n3. Restore original settings");
  for (const client of sessions) await client.close().catch(() => {});
  sessions.clear();
  await new Promise((res) => setTimeout(res, 500));

  const r = await startServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  try {
    for (const [query, value] of Object.entries(original)) {
      await r.call("scpi_command", { command: `${query.replace("?", "")} ${value}` });
    }
    let restored;
    try {
      restored = await snapshot(r.call);
    } catch (err) {
      check("settings restored", false, `verification read failed: ${err.message}`);
      return;
    }
    check("settings restored", JSON.stringify(restored) === JSON.stringify(original), JSON.stringify(restored));
  } finally {
    await r.close();
  }
}

main().catch((err) => {
  console.error(err);
  cleanupAudit();
  process.exit(1);
});
