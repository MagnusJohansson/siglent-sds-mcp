import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { SiglentConnection, channelCountFromModel } from "../../src/connection.js";

/**
 * Fake scope on a local TCP port. Records each chunk it receives separately
 * and answers *OPC? only after a configurable "busy" delay, the way the real
 * scope does after a slow setting such as VDIV.
 */
async function startFakeScope(busyMs: number, { silent = false } = {}) {
  const chunks: string[] = [];
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
    sock.on("data", (buf) => {
      if (silent) return; // like a scope already serving another client
      const text = buf.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        if (line === "*IDN?") sock.write("Siglent,SDS1202X-E,TEST,1.3.27\n");
        if (line === "*OPC?") setTimeout(() => sock.write("1\n"), busyMs);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { server, port, chunks, connections: () => connections };
}

describe("SiglentConnection.sendCommand", () => {
  let scope: Awaited<ReturnType<typeof startFakeScope>>;
  let conn: SiglentConnection;

  beforeEach(async () => {
    scope = await startFakeScope(100);
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    scope.chunks.length = 0;
  });

  afterEach(async () => {
    conn.disconnect();
    await new Promise((r) => scope.server.close(r));
  });

  it("waits for *OPC? before resolving", async () => {
    const t0 = Date.now();
    await conn.sendCommand("C2:VDIV 10mV");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it("sends the command and *OPC? as separate writes", async () => {
    // In one packet the scope mis-parses the command's numeric argument
    await conn.sendCommand("TDIV 50US");
    expect(scope.chunks).toEqual(["TDIV 50US\n", "*OPC?\n"]);
  });

  it("does not send the next command until the previous one completes", async () => {
    await Promise.all([
      conn.sendCommand("C2:VDIV 10mV"),
      conn.sendCommand("C2:OFST -30mV"),
    ]);
    expect(scope.chunks).toEqual([
      "C2:VDIV 10mV\n",
      "*OPC?\n",
      "C2:OFST -30mV\n",
      "*OPC?\n",
    ]);
  });
});

describe("channelCountFromModel", () => {
  it("reads the channel count from the model number", () => {
    expect(channelCountFromModel("SDS1202X-E")).toBe(2);
    expect(channelCountFromModel("SDS1104X-E")).toBe(4);
    expect(channelCountFromModel("SDS2104X Plus")).toBe(4);
    expect(channelCountFromModel("Unknown")).toBeUndefined();
  });
});

describe("SiglentConnection connection management", () => {
  let scope: Awaited<ReturnType<typeof startFakeScope>>;
  let conn: SiglentConnection;
  const savedIdle = process.env.SIGLENT_IDLE_TIMEOUT;

  afterEach(async () => {
    conn?.disconnect();
    if (savedIdle === undefined) delete process.env.SIGLENT_IDLE_TIMEOUT;
    else process.env.SIGLENT_IDLE_TIMEOUT = savedIdle;
    await new Promise((r) => scope.server.close(r));
  });

  it("rejects channels the model doesn't have", async () => {
    scope = await startFakeScope(0); // identifies as SDS1202X-E
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    await expect(conn.checkChannel("C2")).resolves.toBeUndefined();
    await expect(conn.checkChannel("C3")).rejects.toThrow(
      "C3 does not exist on the SDS1202X-E (2 channels: C1-C2)"
    );
  });

  it("explains a scope that accepts the connection but never answers", async () => {
    scope = await startFakeScope(0, { silent: true });
    conn = new SiglentConnection();
    await expect(conn.connect("127.0.0.1", scope.port)).rejects.toThrow(
      /probably in use by another program/
    );
  }, 10_000);

  it("gives calls made during a failing connect the same busy error", async () => {
    scope = await startFakeScope(0, { silent: true });
    conn = new SiglentConnection();
    // Like the startup auto-connect: fire-and-forget, then a tool call arrives
    const startup = conn.connect("127.0.0.1", scope.port).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await expect(conn.query("C1:VDIV?")).rejects.toThrow(
      /probably in use by another program/
    );
    await startup;
  }, 10_000);

  it("releases the connection when idle and reconnects on the next call", async () => {
    process.env.SIGLENT_IDLE_TIMEOUT = "0.2";
    scope = await startFakeScope(0);
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    expect(conn.isConnected()).toBe(true);

    await new Promise((r) => setTimeout(r, 400));
    expect(conn.isConnected()).toBe(false);

    expect(await conn.query("*IDN?")).toContain("SDS1202X-E");
    expect(conn.isConnected()).toBe(true);
    expect(scope.connections()).toBe(2);
  });

  it("stays connected when no idle timeout is set", async () => {
    delete process.env.SIGLENT_IDLE_TIMEOUT;
    scope = await startFakeScope(0);
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    await new Promise((r) => setTimeout(r, 300));
    expect(conn.isConnected()).toBe(true);
  });

  it("does not reconnect after an explicit disconnect", async () => {
    scope = await startFakeScope(0);
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    conn.disconnect();
    await expect(conn.query("*IDN?")).rejects.toThrow("Not connected");
    expect(scope.connections()).toBe(1);
  });
});
