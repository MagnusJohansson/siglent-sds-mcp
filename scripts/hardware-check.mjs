#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDS oscilloscope, through the built
 * server over stdio (the same path an MCP client uses).
 *
 * Usage:  npm run hardware-check -- <scope-ip>
 *
 * - Injection probes try to change the timebase (TDIV) and the check reads it
 *   back: the payload is harmless and easy to verify.
 * - Changes C1 volts/div, the timebase, trigger settings and the waveform
 *   transfer setup (WFSU) while it runs, and restores the values it read at
 *   the start, also if a check fails or throws.
 * - Doesn't call `measure` or `measure_statistics`: they install measurements
 *   on the scope's display, which can't be read back and restored. The
 *   measurement path is checked with a read-only PAVA? query instead.
 * - The scope serves one TCP client at a time: close other programs using it
 *   (EasyScopeX, another MCP server) first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ip = process.argv[2];
if (!ip) {
  console.error("Usage: npm run hardware-check -- <scope-ip>");
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

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH ?? "", SIGLENT_IP: ip, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "hardware-check", version: "1.0.0" });
  await client.connect(transport);
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

const SETTINGS = ["C1:VDIV?", "TDIV?", "TRSE?", "TRMD?", "WFSU?"];

/**
 * Read the settings this script changes. Throws if any read fails or comes
 * back empty: an error text must never be stored (and later "restored") as
 * an original value.
 */
async function snapshot(call) {
  const out = {};
  for (const query of SETTINGS) {
    const r = await call("scpi_query", { command: query });
    if (!r.ok || r.text.trim() === "") {
      throw new Error(`could not read ${query}: ${r.text || "empty reply"}`);
    }
    out[query] = r.text.trim();
  }
  return out;
}

const q = async (call, command) => (await call("scpi_query", { command })).text;

async function main() {
  console.log(`Hardware check: ${ip}\n`);

  console.log("1. Default configuration (raw SCPI off)");
  const s = await startServer();
  check("connect + identify", s.conn.ok && /SDS/.test(s.conn.text), s.conn.text.replace(/\n/g, " "));
  if (!s.conn.ok) {
    await s.close();
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
  const probes = [
    ["F1 setter via scpi_query", "scpi_query", { command: `TDIV ${payloadTdiv}` }],
    ["F1 compound query hides setter", "scpi_query", { command: `TDIV?;TDIV ${payloadTdiv}` }],
    ["F1 parameters after query header", "scpi_query", { command: `TDIV? ${payloadTdiv}` }],
    ["F1 reset in query form", "scpi_query", { command: "*RST?" }],
    ["F1 auto setup in query form", "scpi_query", { command: "ASET?" }],
    ["F2 newline injection in vdiv", "configure_channel", { channel: "C1", vdiv: `500mV\nTDIV ${payloadTdiv}` }],
    ["F2 compound injection in trigger_level", "configure_acquisition", { trigger_level: `0V;TDIV ${payloadTdiv}` }],
    ["F2 newline injection in timebase", "configure_acquisition", { timebase: `1MS\nTDIV ${payloadTdiv}` }],
  ];
  for (const [label, tool, args] of probes) {
    const res = await s.call(tool, args);
    const st = await unchanged(s.call);
    check(label, !res.ok && st.same, `rejected=${!res.ok}, TDIV=${st.now}`);
  }

  const { tools } = await s.client.listTools();
  check("scpi_command not exposed by default", !tools.some((t) => t.name === "scpi_command"), `${tools.length} tools`);

  // Any private-LAN address other than the scope's, which is allowed.
  const probeHost = ip === "192.168.1.1" ? "192.168.1.2" : "192.168.1.1";
  r = await s.call("connect", { host: probeHost });
  const idn = await q(s.call, "*IDN?");
  check(`F3 connect to another LAN host (${probeHost}) rejected, session intact`, !r.ok && /SDS/.test(idn), r.text);

  await s.close();
  await new Promise((res) => setTimeout(res, 500)); // let the scope release the socket

  console.log("\n2. Raw SCPI enabled");
  const raw = await startServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  check("connect", raw.conn.ok, raw.conn.text.replace(/\n/g, " "));

  for (const command of ["C1:VDIV?", "*OPC?"]) {
    r = await raw.call("scpi_command", { command });
    const after = await q(raw.call, "TDIV?");
    check(
      `F5 query "${command}" as a command is rejected, next reply not stale`,
      !r.ok && /is a query/.test(r.text) && after === baseline,
      `next TDIV? -> ${after}`
    );
  }

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
  process.exit(1);
});
