#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDS oscilloscope, through the built
 * server over stdio (the same path an MCP client uses).
 *
 * Usage:  npm run hardware-check -- <scope-ip>
 *
 * - Injection probes try to change the timebase (TDIV) and the check reads it
 *   back: the payload is harmless and easy to verify.
 * - Changes C1 volts/div, the timebase and trigger settings while it runs, and
 *   restores the values it read at the start. Nothing is connected to or
 *   driven from the scope's outputs.
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

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH ?? "", SIGLENT_IP: ip, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "hardware-check", version: "1.0.0" });
  await client.connect(transport);
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
  return { client, call, conn };
}

const q = async (call, command) => (await call("scpi_query", { command })).text;

async function main() {
  console.log(`Hardware check: ${ip}\n`);

  // ---------------------------------------------------------------- phase 1
  console.log("1. Default configuration (raw SCPI off)");
  const s = await startServer();
  check("connect + identify", s.conn.ok && /SDS/.test(s.conn.text), s.conn.text.replace(/\n/g, " "));
  if (!s.conn.ok) {
    await s.client.close();
    process.exit(1);
  }

  const original = {
    vdiv: await q(s.call, "C1:VDIV?"),
    tdiv: await q(s.call, "TDIV?"),
    trse: await q(s.call, "TRSE?"),
    trmd: await q(s.call, "TRMD?"),
  };
  console.log(`  info  original: C1:VDIV ${original.vdiv}, TDIV ${original.tdiv}, TRSE ${original.trse}, TRMD ${original.trmd}`);

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

  r = await s.call("measure", { channel: "C1", parameter: "PKPK" });
  check("measure C1 PKPK", r.ok, r.text);

  r = await s.call("get_waveform", { channel: "C1", max_points: 100 });
  check("get_waveform C1 (100 points)", r.ok && /"returned_points"/.test(r.text), r.ok ? "" : r.text);

  r = await s.call("screenshot");
  check("screenshot", r.ok && r.content.some((c) => c.type === "image"), r.ok ? "" : r.text);

  // Payload: a timebase different from the current one.
  const baseline = await q(s.call, "TDIV?");
  const payloadTdiv = parseFloat(baseline) === 0.002 ? "5MS" : "2MS";
  const unchanged = async () => {
    const now = await q(s.call, "TDIV?");
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
    const st = await unchanged();
    check(label, !res.ok && st.same, `rejected=${!res.ok}, TDIV=${st.now}`);
  }

  const { tools } = await s.client.listTools();
  check("scpi_command not exposed by default", !tools.some((t) => t.name === "scpi_command"), `${tools.length} tools`);

  r = await s.call("connect", { host: "192.168.1.1" });
  const idn = await q(s.call, "*IDN?");
  check("F3 connect to another LAN host rejected, session intact", !r.ok && /SDS/.test(idn), r.text);

  await s.client.close();
  await new Promise((res) => setTimeout(res, 500)); // let the scope release the socket

  // ---------------------------------------------------------------- phase 2
  console.log("\n2. Raw SCPI enabled");
  const raw = await startServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  check("connect", raw.conn.ok, raw.conn.text.replace(/\n/g, " "));

  r = await raw.call("scpi_command", { command: "C1:VDIV?" });
  const after = await q(raw.call, "TDIV?");
  check(
    "F5 a query sent as a command is rejected and the next reply is not stale",
    !r.ok && /Unexpected reply/.test(r.text) && after === baseline,
    `next TDIV? -> ${after}`
  );

  r = await raw.call("scpi_command", { command: `TDIV ${payloadTdiv}\nTDIV 5MS` });
  const rawSt = await q(raw.call, "TDIV?");
  check("F2 newline injection in scpi_command", !r.ok && rawSt === baseline, `TDIV=${rawSt}`);

  // ---------------------------------------------------------------- restore
  console.log("\n3. Restore original settings");
  await raw.call("scpi_command", { command: `C1:VDIV ${original.vdiv}` });
  await raw.call("scpi_command", { command: `TDIV ${original.tdiv}` });
  await raw.call("scpi_command", { command: `TRSE ${original.trse}` });
  await raw.call("scpi_command", { command: `TRMD ${original.trmd}` });
  const restored = {
    vdiv: await q(raw.call, "C1:VDIV?"),
    tdiv: await q(raw.call, "TDIV?"),
    trse: await q(raw.call, "TRSE?"),
    trmd: await q(raw.call, "TRMD?"),
  };
  check(
    "settings restored",
    JSON.stringify(restored) === JSON.stringify(original),
    `C1:VDIV ${restored.vdiv}, TDIV ${restored.tdiv}, TRSE ${restored.trse}, TRMD ${restored.trmd}`
  );
  await raw.client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
