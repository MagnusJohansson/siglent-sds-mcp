#!/usr/bin/env node
/**
 * End-to-end loopback check against real hardware: a Siglent SDG generator's
 * C1 output, a coax cable, and this server's scope on C1. The siglent-sdg-mcp
 * server generates a signal and this server measures it, both through their
 * MCP tools, so the check covers both servers and the signal between them.
 *
 * Usage:  npm run e2e-loopback -- <generator-ip> <scope-ip> [--sdg-entry <path>]
 *
 * Wiring: SDG CH1 output -> coax -> SDS CH1 input, no 50 ohm terminator. The
 * generator's load is set to Hi-Z to match the scope's 1 MOhm input.
 *
 * The generator server is a pinned siglent-sdg-mcp release from npm (run with
 * npx; --sdg-version <x.y.z> picks another), or a local build with
 * --sdg-entry <path to build/index.js>.
 *
 * For each signal, the scope's own measurements (read with PAVA?, which adds
 * nothing to the display) and an independent analysis of the get_waveform
 * samples are checked against what the generator was asked to produce.
 *
 * Safety: aborts if a generator output is already ON, or if C1 has modulation,
 * sweep or burst on; switches C1 ON only after the waveform is set; at most
 * 2 Vpp. At the end, also after a failure or a first Ctrl-C, it switches the
 * output OFF in a fresh session and reads it back, and warns if it can't
 * confirm that. A second Ctrl-C quits at once and skips this.
 *
 * Restores what it changes and reads it back: on the scope, C1 attenuation,
 * coupling, V/div, offset and trace, timebase, trigger delay, mode, level,
 * slope and source, and the waveform transfer setup; on the generator, the C1
 * load and basic wave (type, frequency, amplitude, offset, phase, and duty or
 * symmetry). Other basic-wave parameters (pulse width and edges, noise, the
 * arbitrary-wave selection) aren't restored; the read-back reports it.
 * The scope serves one TCP client at a time: close EasyScopeX and other MCP
 * servers using it first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { fileURLToPath } from "node:url";
import path from "node:path";

// The generator server release this check was last run against. Pinned, so a
// run is reproducible and doesn't start whatever was published most recently.
const SDG_VERSION = "2.0.4";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args.splice(i, 2)[1];
  return value ?? "";
};
const sdgEntry = option("--sdg-entry");
const sdgVersion = option("--sdg-version") ?? SDG_VERSION;
const [sdgIp, sdsIp] = args;
if (!sdgIp || !sdsIp || sdgEntry === "" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(sdgVersion)) {
  console.error("Usage: npm run e2e-loopback -- <generator-ip> <scope-ip> [--sdg-entry <path> | --sdg-version <x.y.z>]");
  process.exit(2);
}
const sdsEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");
// The generator server: a local build, or a pinned release from npm.
const sdgCommand = sdgEntry
  ? { command: process.execPath, args: [sdgEntry] }
  : { command: "npx", args: ["--yes", `siglent-sdg-mcp@${sdgVersion}`] };
const sdsCommand = { command: process.execPath, args: [sdsEntry] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ctrl-C: the first one stops the test and lets the cleanup run (output OFF,
// settings restored); a second one quits at once. A Ctrl-C in the terminal
// also stops the child servers, so the cleanup starts fresh sessions.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) {
      console.log("\n  Quitting without cleanup. Check that the generator's C1 output is OFF.");
      process.exit(130);
    }
    interrupted = true;
    console.log("\n  Interrupted: switching the output off and restoring settings. Press Ctrl-C again to quit at once.");
  });
}
let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
}

/** The last lines each server wrote to stderr, printed when something fails. */
const serverLogs = new Map();

async function start(name, server, env) {
  const transport = new StdioClientTransport({
    ...server,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  // Drain stderr (a full pipe would stall the server) and keep the tail.
  const log = [];
  serverLogs.set(name, log);
  transport.stderr?.on("data", (chunk) => {
    log.push(...String(chunk).split("\n").filter(Boolean));
    log.splice(0, Math.max(0, log.length - 20));
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      return { ok: !r.isError, text };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  };
  // For the test steps: stops at the next step after a Ctrl-C. The cleanup
  // uses call(), which doesn't.
  const must = async (name, args = {}) => {
    if (interrupted) throw new Error("interrupted");
    const r = await call(name, args);
    if (!r.ok) throw new Error(`${name}(${JSON.stringify(args)}) failed: ${r.text}`);
    return r.text;
  };
  return { client, call, must, close: () => client.close().catch(() => {}) };
}

const num = (s) => {
  const m = /([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(String(s).split(",").pop() ?? "");
  return m ? parseFloat(m[1]) : NaN;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const within = (v, target, tol) => Math.abs(v - target) <= tol;
const fmt = (v, unit = "") => (Number.isFinite(v) ? `${+v.toPrecision(4)}${unit}` : String(v));

/** Scope measurement via PAVA? (read-only; doesn't add a measurement to the display). */
async function pava(sds, param) {
  const vals = [];
  for (let i = 0; i < 3; i++) {
    if (interrupted) throw new Error("interrupted");
    const r = await sds.call("scpi_query", { command: `C1:PAVA? ${param}` });
    vals.push(r.ok ? num(r.text) : NaN);
    await sleep(300);
  }
  return median(vals.filter(Number.isFinite).length ? vals.filter(Number.isFinite) : vals);
}

/** Independent analysis of the samples returned by get_waveform. */
async function analyseWaveform(sds) {
  const wf = JSON.parse(await sds.must("get_waveform", { channel: "C1", max_points: 4000 }));
  const v = wf.data.map((d) => d.voltage);
  const t = wf.data.map((d) => d.time);
  const max = Math.max(...v);
  const min = Math.min(...v);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const mid = (max + min) / 2;
  // Rising crossings of the midpoint, with a little hysteresis against noise.
  const hyst = (max - min) * 0.1;
  const rising = [];
  let armed = v[0] < mid - hyst;
  for (let i = 1; i < v.length; i++) {
    if (v[i] < mid - hyst) armed = true;
    if (armed && v[i] >= mid) {
      rising.push(t[i]);
      armed = false;
    }
  }
  const freq =
    rising.length >= 2 ? (rising.length - 1) / (rising[rising.length - 1] - rising[0]) : NaN;
  const high = v.filter((x) => x > mid).length / v.length;
  // Settled amplitude, ignoring overshoot: median of the samples above and
  // below the midpoint (top and base of a square wave).
  const top = median(v.filter((x) => x > mid));
  const base = median(v.filter((x) => x <= mid));
  return { points: v.length, total: wf.total_points, vdiv: wf.volts_per_div, vpp: max - min, ampl: top - base, mean, freq, high, cycles: rising.length - 1 };
}

const SCENARIOS = [
  {
    name: "Sine 1 kHz, 1 Vpp, 0 V offset",
    wave: { waveform_type: "SINE", frequency: 1000, amplitude: 1, offset: 0 },
    scope: { vdiv: "200MV", offset: "0V", timebase: "500US", trigger_level: "0V" },
    expect: { freq: 1000, vpp: 1, mean: 0 },
  },
  {
    name: "Sine 1 kHz, 1 Vpp, +0.5 V offset",
    wave: { waveform_type: "SINE", frequency: 1000, amplitude: 1, offset: 0.5 },
    scope: { vdiv: "200MV", offset: "-500MV", timebase: "500US", trigger_level: "500MV" },
    expect: { freq: 1000, vpp: 1, mean: 0.5 },
  },
  {
    name: "Square 10 kHz, 2 Vpp, 50 % duty",
    wave: { waveform_type: "SQUARE", frequency: 10000, amplitude: 2, offset: 0, duty: 50 },
    scope: { vdiv: "500MV", offset: "0V", timebase: "50US", trigger_level: "0V" },
    expect: { freq: 10000, vpp: 2, mean: 0, duty: 50 },
  },
  {
    name: "Sine 100 kHz, 1 Vpp",
    wave: { waveform_type: "SINE", frequency: 100000, amplitude: 1, offset: 0 },
    scope: { vdiv: "200MV", offset: "0V", timebase: "5US", trigger_level: "0V" },
    expect: { freq: 100000, vpp: 1, mean: 0 },
  },
];

// Restored in this order. TRSE comes after C1:TRLV and C1:TRSL: setting a
// channel's trigger level makes that channel the trigger source.
const SDS_SETTINGS = [
  "C1:ATTN?", "C1:CPL?", "C1:VDIV?", "C1:OFST?", "C1:TRA?",
  "TDIV?", "TRDL?", "TRMD?", "C1:TRLV?", "C1:TRSL?", "TRSE?", "WFSU?",
];

async function main() {
  console.log(`End-to-end: SDG ${sdgIp} C1 -> coax -> SDS ${sdsIp} C1\n`);
  const sdg = await start("generator", sdgCommand, { SIGLENT_SDG_IP: sdgIp });
  const sds = await start("scope", sdsCommand, { SIGLENT_IP: sdsIp });
  // Set once the generator's original state is read, before anything on it
  // changes: from then on the cleanup switches the output OFF and restores.
  let sdgOriginal;
  let sdsOriginal;

  try {
    console.log("Setup");
    const sdgId = await sdg.must("connect");
    const sdsId = await sds.must("connect");
    check("SDG connect", /SDG/.test(sdgId), sdgId.replace(/\s+/g, " ").slice(0, 90));
    check("SDS connect", /SDS/.test(sdsId), sdsId.replace(/\s+/g, " ").slice(0, 90));
    console.log(`  info  servers: ${sdg.client.getServerVersion()?.name} ${sdg.client.getServerVersion()?.version}, ${sds.client.getServerVersion()?.name} ${sds.client.getServerVersion()?.version}`);

    const outs = {};
    for (const ch of ["C1", "C2"]) outs[ch] = await sdg.must("get_output", { channel: ch });
    if (!Object.values(outs).every((o) => /OUTP OFF/.test(o))) {
      console.log(`\n  ABORT: SDG outputs must both be OFF before the test. ${JSON.stringify(outs)}`);
      process.exitCode = 1;
      return;
    }
    // Modulation, sweep or burst would change the signal on C1.
    for (const tool of ["get_modulation", "get_sweep", "get_burst"]) {
      const state = await sdg.must(tool, { channel: "C1" });
      if (/STATE,ON/.test(state)) {
        console.log(`\n  ABORT: switch off modulation, sweep and burst on the generator's C1 first. ${state.trim()}`);
        process.exitCode = 1;
        return;
      }
    }
    const bswv = await sdg.must("get_basic_wave", { channel: "C1" });
    const settings = {};
    for (const q of SDS_SETTINGS) {
      const r = await sds.call("scpi_query", { command: q });
      if (!r.ok || !r.text.trim()) throw new Error(`could not read ${q}: ${r.text}`);
      settings[q] = r.text.trim();
    }
    sdgOriginal = { bswv, outp: outs.C1 };
    sdsOriginal = settings;
    console.log(`  info  SDG C1 before: ${sdgOriginal.bswv.trim()} | ${sdgOriginal.outp.trim()}`);
    console.log(`  info  SDS before: ${JSON.stringify(sdsOriginal)}`);

    // Scope: C1 DC 1 MOhm, 1X (coax straight in), edge trigger on C1, auto.
    await sds.must("configure_channel", { channel: "C1", coupling: "D1M", probe: 1, trace: true, vdiv: "200MV", offset: "0V" });
    await sds.must("configure_acquisition", {
      timebase: "500US",
      trigger_mode: "AUTO",
      trigger_source: "C1",
      trigger_slope: "POS",
      trigger_level: "0V",
      trigger_delay: "0S",
    });
    // Generator: Hi-Z load, since the scope input is 1 MOhm.
    await sdg.must("configure_output", { channel: "C1", state: "OFF", load: "HZ" });

    console.log("\nOutput OFF (baseline)");
    await sleep(1500);
    let pk = await pava(sds, "PKPK");
    check("scope sees no signal (Pk-Pk < 0.1 V)", pk < 0.1, `PKPK ${fmt(pk, " V")}`);

    for (const sc of SCENARIOS) {
      console.log(`\n${sc.name}`);
      await sdg.must("configure_basic_wave", { channel: "C1", ...sc.wave });
      await sds.must("configure_channel", { channel: "C1", vdiv: sc.scope.vdiv, offset: sc.scope.offset });
      await sds.must("configure_acquisition", { timebase: sc.scope.timebase, trigger_level: sc.scope.trigger_level });
      await sdg.must("configure_output", { channel: "C1", state: "ON" });

      // The generator reports what it was asked to generate.
      const bswv = await sdg.must("get_basic_wave", { channel: "C1" });
      const field = (k) => num((new RegExp(`${k},([^,]+)`).exec(bswv) ?? [])[1]);
      check(
        "SDG reads back the settings",
        bswv.includes(sc.wave.waveform_type) &&
          field("FRQ") === sc.wave.frequency &&
          field("AMP") === sc.wave.amplitude &&
          field("OFST") === sc.wave.offset,
        bswv.trim().slice(0, 90)
      );

      await sleep(1500);
      const e = sc.expect;
      const freq = await pava(sds, "FREQ");
      const pkpk = await pava(sds, "PKPK");
      const mean = await pava(sds, "MEAN");
      check("scope FREQ within 1 %", within(freq, e.freq, e.freq * 0.01), `${fmt(freq, " Hz")}, expected ${e.freq}`);
      if (e.duty === undefined) {
        check("scope Pk-Pk within 10 %", within(pkpk, e.vpp, e.vpp * 0.1), `${fmt(pkpk, " V")}, expected ${e.vpp}`);
      } else {
        // A square wave into an unterminated coax overshoots, and Pk-Pk
        // includes the overshoot. AMPL (top - base) is the settled amplitude.
        const ampl = await pava(sds, "AMPL");
        const ovsp = await pava(sds, "OVSP");
        check("scope AMPL (top - base) within 10 %", within(ampl, e.vpp, e.vpp * 0.1), `${fmt(ampl, " V")}, expected ${e.vpp}`);
        console.log(`  info  Pk-Pk ${fmt(pkpk, " V")} including overshoot (OVSP ${fmt(ovsp, " %")})`);
      }
      check("scope MEAN within 5 % of Vpp + 30 mV", within(mean, e.mean, e.vpp * 0.05 + 0.03), `${fmt(mean, " V")}, expected ${e.mean}`);
      if (e.duty !== undefined) {
        const duty = await pava(sds, "DUTY");
        check("scope DUTY within 2 points", within(duty, e.duty, 2), `${fmt(duty, " %")}, expected ${e.duty}`);
      }

      // Independent check from the raw samples.
      const w = await analyseWaveform(sds);
      const info = `${w.points} of ${w.total} points, ${w.cycles} cycles`;
      check("waveform: frequency within 2 %", within(w.freq, e.freq, e.freq * 0.02), `${fmt(w.freq, " Hz")}; ${info}`);
      if (e.duty === undefined) {
        check("waveform: Vpp within 12 %", within(w.vpp, e.vpp, e.vpp * 0.12), `${fmt(w.vpp, " V")}`);
      } else {
        check("waveform: top - base within 10 %", within(w.ampl, e.vpp, e.vpp * 0.1), `${fmt(w.ampl, " V")} (max - min ${fmt(w.vpp, " V")})`);
      }
      check("waveform: mean within 5 % of Vpp + 30 mV", within(w.mean, e.mean, e.vpp * 0.05 + 0.03), `${fmt(w.mean, " V")}`);
      // One ADC code is vdiv/25. Decoding the sample bytes wrongly (e.g.
      // subtracting 255 instead of 256 for negative codes) shifts the mean by
      // about half a code; agreement within a quarter code rules that out.
      // Only with zero scope offset: get_waveform applies the nominal offset,
      // while the scope's MEAN uses its calibrated one, which may differ by
      // about 1 % of the offset (within the scope's offset accuracy).
      if (sc.scope.offset === "0V") {
        check(
          "waveform mean agrees with scope MEAN within 1/4 code",
          Math.abs(w.mean - mean) <= w.vdiv / 100,
          `${fmt((w.mean - mean) * 1000, " mV")} apart, 1/4 code = ${fmt((w.vdiv / 100) * 1000, " mV")}`
        );
      }
      if (e.duty !== undefined) {
        check("waveform: time above midpoint 50 % +/- 3", within(w.high * 100, e.duty, 3), `${fmt(w.high * 100, " %")}`);
      }
    }

    console.log("\nOutput OFF again");
    await sdg.must("configure_output", { channel: "C1", state: "OFF" });
    await sds.must("configure_channel", { channel: "C1", vdiv: "200MV", offset: "0V" });
    await sds.must("configure_acquisition", { timebase: "500US", trigger_level: "0V" });
    await sleep(1500);
    pk = await pava(sds, "PKPK");
    check("signal gone after output OFF (Pk-Pk < 0.1 V)", pk < 0.1, `PKPK ${fmt(pk, " V")}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(interrupted ? "test completed (interrupted)" : "test ran without an exception", false, message);
  } finally {
    await sdg.close();
    await sds.close();
    // Fresh sessions for the cleanup: the test's sessions may have failed, or
    // been stopped by a Ctrl-C.
    if (sdgOriginal) await restoreGenerator(sdgOriginal);
    if (sdsOriginal) await restoreScope(sdsOriginal);
    if (failed > 0) {
      for (const [name, log] of serverLogs) {
        if (log.length) console.log(`\n  ${name} server stderr (last lines):\n    ${log.join("\n    ")}`);
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 && process.exitCode !== 1 ? 0 : 1;
  }
}

/**
 * Output OFF and read it back, whatever happened. The waveform is restored
 * only once OFF is confirmed: the original could be a high amplitude.
 */
async function restoreGenerator(original) {
  console.log("\nCleanup: generator");
  const sdg = await start("generator (cleanup)", sdgCommand, { SIGLENT_SDG_IP: sdgIp });
  try {
    const conn = await sdg.call("connect");
    await sdg.call("configure_output", { channel: "C1", state: "OFF" });
    const o = await sdg.call("get_output", { channel: "C1" });
    const off = conn.ok && /OUTP OFF/.test(o.text);
    check("SDG C1 output OFF", off, o.text.trim());
    if (!off) {
      console.log("\n  WARNING: could not confirm that the generator's C1 output is OFF.");
      console.log("  Check the front panel and switch the output off by hand.");
      console.log("  The C1 waveform was not restored.\n");
      return;
    }
    const b = original.bswv;
    const f = (k) => num((new RegExp(`${k},([^,]+)`).exec(b) ?? [])[1]);
    const type = /WVTP,(\w+)/.exec(b)?.[1];
    const load = /LOAD,(\w+)/.exec(original.outp)?.[1];
    const args = { channel: "C1", waveform_type: type, frequency: f("FRQ"), amplitude: f("AMP"), offset: f("OFST"), phase: f("PHSE") };
    if (type === "SQUARE" || type === "PULSE") args.duty = f("DUTY");
    if (type === "RAMP") args.symmetry = f("SYM");
    // Load first: the amplitude the generator reports depends on it.
    if (load) await sdg.call("configure_output", { channel: "C1", state: "OFF", load });
    await sdg.call("configure_basic_wave", args);
    const nowOut = await sdg.call("get_output", { channel: "C1" });
    const nowWave = await sdg.call("get_basic_wave", { channel: "C1" });
    check("SDG C1 load restored", /LOAD,(\w+)/.exec(nowOut.text)?.[1] === load, nowOut.text.trim());
    check("SDG C1 waveform restored", nowWave.text.trim() === b.trim(), nowWave.text.trim().slice(0, 90));
  } finally {
    await sdg.close();
  }
}

/** The scope's tools don't cover TRSE, TRDL or WFSU, so this uses raw SCPI. */
async function restoreScope(original) {
  console.log("\nCleanup: scope");
  await sleep(500); // the scope serves one client at a time
  const raw = await start("scope (cleanup)", sdsCommand, { SIGLENT_IP: sdsIp, SIGLENT_ALLOW_RAW_SCPI: "true" });
  try {
    const conn = await raw.call("connect");
    if (!conn.ok) throw new Error(conn.text);
    for (const q of SDS_SETTINGS) {
      await raw.call("scpi_command", { command: `${q.replace("?", "")} ${original[q]}` });
    }
    const back = {};
    for (const q of SDS_SETTINGS) back[q] = (await raw.call("scpi_query", { command: q })).text.trim();
    const diff = SDS_SETTINGS.filter((q) => back[q] !== original[q]);
    check("SDS settings restored", diff.length === 0, diff.length ? diff.map((q) => `${q} ${back[q]} != ${original[q]}`).join("; ") : "all match");
  } catch (err) {
    check("SDS settings restored", false, err instanceof Error ? err.message : String(err));
  } finally {
    await raw.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
