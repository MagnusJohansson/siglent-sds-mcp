import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConnectionTools } from "../src/tools/connection.js";
import { registerChannelTools } from "../src/tools/channel.js";
import { registerAcquisitionTools } from "../src/tools/acquisition.js";
import { registerMeasureTools } from "../src/tools/measure.js";
import { registerWaveformTools } from "../src/tools/waveform.js";
import { registerScpiTools } from "../src/tools/scpi.js";

export async function createTestServer() {
  const server = new McpServer({
    name: "siglent-sds-mcp-test",
    version: "1.0.0",
  });

  registerConnectionTools(server);
  registerChannelTools(server);
  registerAcquisitionTools(server);
  registerMeasureTools(server);
  registerWaveformTools(server);
  registerScpiTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    server,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

/** Helper to call a tool and return the text content from the first content block */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

/** Extract the text from the first text content block */
export function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}
