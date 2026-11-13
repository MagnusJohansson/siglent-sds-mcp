import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Start the real MCP server with config built from the given env, linked to an in-memory client. */
export async function createTestServer(env: Record<string, string> = {}) {
  const config = loadConfig(env);
  const server = createServer(config);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    server,
    config,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

/** Helper to call a tool and return the result */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  return client.callTool({ name, arguments: args });
}

/** Extract the text from the first text content block */
export function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}
