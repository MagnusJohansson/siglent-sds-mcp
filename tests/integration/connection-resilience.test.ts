/**
 * Connection behaviour against the simulator: replies stay matched to the
 * query that asked for them, overlapping connects don't tear each other down,
 * and reconnects obey the host policy.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { SdsSimulator, SIM_IDN } from "../simulator/sds-simulator.js";
import { SiglentConnection, type ConnectionOptions } from "../../src/connection.js";

let sim: SdsSimulator;
let port: number;
let conn: SiglentConnection;

function options(extra: Partial<ConnectionOptions> = {}): Partial<ConnectionOptions> {
  return { hostPolicy: { allowedHosts: ["127.0.0.1"], allowedPorts: [port] }, ...extra };
}

beforeAll(async () => {
  sim = new SdsSimulator();
  port = await sim.start();
});

afterAll(async () => {
  await sim.stop();
});

afterEach(() => {
  conn?.disconnect();
  sim.resetState();
  sim.clear();
});

describe("after a command times out", () => {
  it("resets the connection, so the late *OPC? reply can't answer the next query", async () => {
    conn = new SiglentConnection(options({ commandTimeoutMs: 200 }));
    await conn.connect("127.0.0.1", port);

    sim.opcDelayMs = 500; // slower than the command timeout, like *RST or an auto setup
    await expect(conn.sendCommand("C1:VDIV 2V")).rejects.toThrow(/timeout.*connection was reset/i);
    sim.opcDelayMs = 0;

    // Asked straight away, while the scope is still busy: its answers come in
    // order, so without the reset this query would receive the late "1".
    expect(await conn.query("C1:VDIV?")).toBe("2V");
  });
});

describe("a command that produces output", () => {
  it("resets before the next queued command reaches the scope", async () => {
    // The acknowledgement is checked in the reply handler, before the next
    // queued operation starts. Otherwise the setter queued behind would be
    // written, take effect, and still be reported as failed.
    conn = new SiglentConnection(options());
    await conn.connect("127.0.0.1", port);
    sim.clear();

    const [echo, setter] = await Promise.allSettled([
      conn.sendCommand("ECHO hello"),
      conn.sendCommand("C1:VDIV 5V"),
    ]);
    expect(echo.status === "rejected" && String(echo.reason)).toMatch(/Unexpected reply/);
    expect(setter.status).toBe("rejected");
    expect(sim.commands()).not.toContain("C1:VDIV 5V");
    expect(sim.get("C1:VDIV")).toBe("1.00E+00");

    // And the next query gets its own answer, not the late "1".
    expect(await conn.query("C1:VDIV?")).toBe("1.00E+00");
  });

  it("doesn't write the delayed *OPC? into a reconnected session", async () => {
    // The ECHO reply arrives before the 20 ms gap between a command and its
    // *OPC?. The reset happens, and the next call reconnects at once: the
    // old command's *OPC? must not end up on the new connection.
    conn = new SiglentConnection(options());
    await conn.connect("127.0.0.1", port);
    sim.clear();

    await expect(conn.sendCommand("ECHO early")).rejects.toThrow(/Unexpected reply/);
    expect(await conn.query("*IDN?")).toBe(SIM_IDN);
    await new Promise((r) => setTimeout(r, 50)); // past the 20 ms gap

    const logs = sim.connectionLogs();
    expect(logs[logs.length - 1]).toEqual(["CHDR OFF", "*OPC?", "*IDN?", "*IDN?"]);
  });

  it("rejects a query sent as a command before anything is written", async () => {
    conn = new SiglentConnection(options());
    await conn.connect("127.0.0.1", port);
    sim.clear();
    await expect(conn.sendCommand("*OPC?")).rejects.toThrow(/is a query/);
    expect(sim.commands()).toEqual([]);
  });
});

describe("overlapping connect calls", () => {
  it("lets the newer connect win without the older one tearing it down", async () => {
    // Like the startup auto-connect still initializing when the `connect` tool
    // is called. The scope serves one client at a time, so the superseded
    // attempt must not keep its socket either.
    conn = new SiglentConnection(options());
    const first = conn.connect("127.0.0.1", port);
    await new Promise((r) => setTimeout(r, 20));
    const second = conn.connect("127.0.0.1", port);

    const [r1, r2] = await Promise.allSettled([first, second]);
    expect(r1.status).toBe("rejected");
    expect(r2.status === "fulfilled" && r2.value).toBe(SIM_IDN);
    expect(await conn.query("*IDN?")).toBe(SIM_IDN);
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.connectionCount()).toBe(1);
  });

  it("handles two connects started at the same moment", async () => {
    conn = new SiglentConnection(options());
    const [r1, r2] = await Promise.allSettled([
      conn.connect("127.0.0.1", port),
      conn.connect("127.0.0.1", port),
    ]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("fulfilled");
    expect(await conn.query("*IDN?")).toBe(SIM_IDN);
  });
});

describe("host policy", () => {
  it("applies before any socket is opened", async () => {
    // Wait for sockets from earlier tests to finish closing on the server side.
    while (sim.connectionCount() > 0) await new Promise((r) => setTimeout(r, 10));
    conn = new SiglentConnection(); // default: private-LAN IPs on 5025 only
    await expect(conn.connect("127.0.0.1", port)).rejects.toThrow(/not allowed/);
    expect(sim.connectionCount()).toBe(0);
  });

  it("applies to automatic reconnects too", async () => {
    conn = new SiglentConnection(options({ idleTimeoutMs: 100 }));
    await conn.connect("127.0.0.1", port);
    await new Promise((r) => setTimeout(r, 250)); // idle close
    expect(conn.isConnected()).toBe(false);

    // Policy tightened (e.g. reconfigured): the reconnect must be refused.
    conn.configure({ hostPolicy: { allowedHosts: ["10.0.0.5"], allowedPorts: [port] } });
    await expect(conn.query("*IDN?")).rejects.toThrow(/not in the allowed list/);
  });
});
