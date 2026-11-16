/**
 * Contract test: the SDK behaviours the transport hooks rely on
 * (src/audit/transport.ts), against the real stdio transport. An SDK upgrade
 * that changes any of them fails here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit } from "../../src/audit/audit.js";
import { loadConfig } from "../../src/config.js";
import { connectServer, createServer } from "../../src/server.js";
import { captureAudit, MemorySink } from "../helpers.js";

afterAll(() => audit.reset());

/** Collect JSON-RPC responses from the transport's stdout. */
function responses(stdout: PassThrough) {
  const got = new Map<string, Record<string, unknown>>();
  let buf = "";
  stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      if (msg.id !== undefined) got.set(String(msg.id), msg);
    }
  });
  return async (id: string) => {
    for (let t = 0; t < 200 && !got.has(id); t++) await new Promise((r) => setTimeout(r, 10));
    return got.get(id);
  };
}

describe("transport hooks on the stdio transport (SDK contract)", () => {
  it("sees a request written right after connect, carries its context into the tool callback, and sees the response", async () => {
    const sink = new MemorySink();
    captureAudit(sink);
    const config = loadConfig({});
    const server = createServer(config);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const waitFor = responses(stdout);
    const transport = new StdioServerTransport(stdin, stdout);
    await connectServer(server, transport, config);

    // Written immediately, with no delay after connect().
    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: "q-7", method: "tools/call", params: { name: "scpi_query", arguments: { command: "C1:VDIV 1V" } } }) +
        "\n"
    );
    expect(await waitFor("q-7")).toBeDefined();

    // The refusal is emitted inside the tool callback (in the connection):
    // its request id proves the context reached it.
    expect(sink.events("guard.refused")).toEqual([
      expect.objectContaining({ rule: "query.not_a_query", "jsonrpc.request.id": "q-7", cause: "tool-call" }),
    ]);
    // The send wrapper saw the response.
    expect(sink.events("mcp.response").find((r) => r["jsonrpc.request.id"] === "q-7")).toMatchObject({
      outcome: "tool_error",
    });
    // initialize's clientInfo is recorded as self-reported.
    expect(sink.events("mcp.request").find((r) => r["jsonrpc.request.id"] === "q-7")).toMatchObject({
      "client.name": "contract",
      "client.self_reported": true,
    });

    // A line that isn't JSON-RPC reaches onerror, not onmessage.
    stdin.write("this is not json\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(sink.events("mcp.malformed")).toHaveLength(1);

    // The SDK still reports schema failures with the prefix the hook looks for.
    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "configure_channel", arguments: { channel: "C1", vdiv: "1V\nX" } } }) + "\n"
    );
    const res = (await waitFor("9")) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(res.result?.isError).toBe(true);
    // The exact prefix the hook matches (transport.ts schemaErrorPrefix).
    expect(res.result?.content?.[0]?.text).toMatch(
      /^MCP error -32602: Input validation error: Invalid arguments for tool configure_channel:/
    );
    expect(sink.events("guard.refused").map((r) => r["rule"])).toContain("schema.invalid");

    // Arguments the audit code can't serialise (too deep for the stack): the
    // call is still handled and answered, and logged with a placeholder.
    const deep = `{"x":${"[".repeat(5000)}${"]".repeat(5000)}}`;
    stdin.write(`{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"get_channel","arguments":${deep}}}\n`);
    expect(await waitFor("11")).toBeDefined();
    const deepReq = sink.events("mcp.request").find((r) => r["jsonrpc.request.id"] === "11");
    expect(String(deepReq?.["gen_ai.tool.call.arguments"])).toMatch(/^\[arguments not logged/);
    expect(sink.events("mcp.response").some((r) => r["jsonrpc.request.id"] === "11")).toBe(true);

    // Cancellation follows the SDK's rule exactly. Each call and its cancel go
    // in one write, so the cancel is handled before the call completes.
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    const callAndCancel = (id: string | number, cancelId: string | number) =>
      stdin.write(
        line({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_channel", arguments: { channel: "C1" } } }) +
          line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelId } })
      );
    const outcomes = (id: string) =>
      sink.events("mcp.response").filter((r) => r["jsonrpc.request.id"] === id).map((r) => r["outcome"]);
    // Cancelled by the SDK: no response is sent, and the log says cancelled.
    callAndCancel(5, 5);
    // Not cancelled by the SDK (it ignores requestId 0, and "7" isn't 7): the
    // call is answered, and the log has its real outcome, not "cancelled".
    callAndCancel(0, 0);
    callAndCancel(7, "7");
    expect(await waitFor("0")).toBeDefined();
    expect(await waitFor("7")).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(outcomes("5")).toEqual(["cancelled"]);
    expect(outcomes("0")).toEqual(["tool_error"]); // "Not connected"
    expect(outcomes("7")).toEqual(["tool_error"]);

    await server.close();
  });
});
