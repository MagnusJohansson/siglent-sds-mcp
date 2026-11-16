/**
 * Audit hooks on the MCP transport.
 *
 * The SDK validates tool arguments before a tool's callback runs, so hooks in
 * the callbacks would miss invalid arguments, unknown tools and every
 * non-tool message. The transport sees each JSON-RPC message first.
 *
 * Must be installed before server.connect(transport):
 * - `onmessage` becomes an accessor, so whatever handler the SDK assigns is
 *   wrapped as it's assigned. Each request is dispatched inside its own audit
 *   context, which the SDK's handler promise (created synchronously in
 *   onmessage) carries into the tool callback.
 * - `send` is wrapped on the instance; the SDK looks it up at call time.
 * - `onerror` set here is chained by Protocol.connect. The stdio transport
 *   reports lines that aren't valid JSON-RPC there (the raw line isn't
 *   passed on).
 * tests/integration/audit-transport.test.ts pins these SDK behaviours.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { audit, withAuditContext, type AuditContext, type AuditLevel } from "./audit.js";
import { bound, boundArguments, firstText, summariseContent } from "./bounds.js";

export interface TransportAuditOptions {
  /** Whether scpi_command is registered; a call to it while disabled is a refusal. */
  rawScpiEnabled: boolean;
}

interface Pending {
  method: string;
  tool?: string;
  level: AuditLevel;
  startedAt: number;
}

type MessageHandler = NonNullable<Transport["onmessage"]>;

/**
 * The key for a request id, by type and value, as the SDK matches them: a
 * response or cancel for "7" is not one for 7.
 */
const idKey = (id: unknown): string => `${typeof id}:${String(id)}`;

/**
 * How the SDK reports a schema failure: a tool error that starts with exactly
 * this, then the tool's name (SDK 1.32, pinned by the contract test). Only the
 * start is matched: many tool errors repeat their input, so a substring match
 * would let anyone who controls an argument forge a schema.invalid refusal.
 */
const schemaErrorPrefix = (tool: string) => `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}:`;

/**
 * Audit work must never stop a message from being handled: a throw here (a
 * bug, or an argument the bounds can't serialise) is reported and swallowed,
 * and the SDK still gets the message.
 */
function safely(work: () => void): void {
  try {
    work();
  } catch (err) {
    audit.log(`audit: transport hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function auditTransport(transport: Transport, options: TransportAuditOptions): void {
  const pending = new Map<string, Pending>();
  let client: { name?: string; version?: string; protocolVersion?: string } = {};
  let inner: MessageHandler | undefined;

  const wrapped: MessageHandler = (message, extra) => {
    const m = message as { id?: string | number; method?: unknown; params?: Record<string, unknown> };
    if (typeof m.method !== "string") return inner?.(message, extra);
    const method = m.method;

    if (m.id === undefined) {
      safely(() => {
        audit.mcpRequest("full", { method: bound(method, 128), client }, { cause: "tool-call" });
        // A cancelled call gets no response from the SDK; close its entry here,
        // at the call's own level, so the default log shows how it ended. Its
        // instrument writes may still complete; the full trail shows them.
        if (method === "notifications/cancelled") {
          // Exactly the SDK's rule (Protocol._oncancel): a falsy requestId is
          // ignored, and the id matches by type and value. Anything the SDK
          // won't cancel still gets its real response, logged as usual.
          const id = (m.params as { requestId?: unknown } | undefined)?.requestId;
          const p = id ? pending.get(idKey(id)) : undefined;
          if (p) {
            pending.delete(idKey(id));
            audit.mcpResponse(p.level, {
              method: p.method,
              tool: p.tool,
              outcome: "cancelled",
              durationMs: Date.now() - p.startedAt,
            }, { requestId: String(id), cause: "tool-call" });
          }
        }
      });
      return inner?.(message, extra);
    }

    const ctx: AuditContext = { requestId: bound(String(m.id), 128), cause: "tool-call" };
    safely(() => record(m, method, ctx));
    return withAuditContext(ctx, () => inner?.(message, extra));
  };

  const record = (
    m: { id?: string | number; params?: Record<string, unknown> },
    method: string,
    ctx: AuditContext
  ): void => {
    if (method === "initialize") {
      const info = (m.params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
      client = {
        name: typeof info.name === "string" ? info.name : undefined,
        version: typeof info.version === "string" ? info.version : undefined,
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : undefined,
      };
    }
    const tool = method === "tools/call" ? bound(String(m.params?.name ?? ""), 128) : undefined;
    // A call to the disabled scpi_command is a security event too: its
    // refusal should have its request beside it at the default level.
    const disabledRaw = tool === "scpi_command" && !options.rawScpiEnabled;
    const level: AuditLevel =
      tool !== undefined && (audit.isStateChanging(tool) || disabledRaw) ? "security" : "full";
    const args = tool !== undefined ? boundArguments(m.params?.arguments) : undefined;
    pending.set(idKey(m.id), { method: bound(method, 128), tool, level, startedAt: Date.now() });
    audit.mcpRequest(level, {
      method: bound(method, 128),
      tool,
      arguments: args,
      annotations: tool !== undefined ? audit.registeredTools.get(tool) : undefined,
      client,
    }, ctx);
    if (disabledRaw) {
      audit.guardRefused({
        guard: "raw-scpi",
        rule: "raw.disabled",
        message: "scpi_command is disabled (SIGLENT_ALLOW_RAW_SCPI is not set).",
        command: typeof (m.params?.arguments as { command?: unknown })?.command === "string"
          ? ((m.params!.arguments as { command: string }).command)
          : undefined,
      }, ctx);
    }
  };

  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => (inner === undefined ? undefined : wrapped),
    set: (fn: MessageHandler | undefined) => {
      inner = fn;
    },
  });

  const send = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, sendOptions?: Parameters<Transport["send"]>[1]) => {
    const m = message as {
      id?: string | number;
      result?: { isError?: boolean; content?: unknown };
      error?: { code?: number; message?: string };
    };
    safely(() => recordResponse(m));
    return send(message, sendOptions);
  };

  const recordResponse = (m: {
    id?: string | number;
    result?: { isError?: boolean; content?: unknown };
    error?: { code?: number; message?: string };
  }): void => {
    const p = m.id !== undefined ? pending.get(idKey(m.id)) : undefined;
    if (p && ("result" in m || "error" in m)) {
      pending.delete(idKey(m.id));
      const ctx: AuditContext = { requestId: bound(String(m.id), 128), cause: "tool-call" };
      const durationMs = Date.now() - p.startedAt;
      if (m.error) {
        audit.mcpResponse(p.level, {
          method: p.method,
          tool: p.tool,
          outcome: "jsonrpc_error",
          errorType: String(m.error.code ?? "unknown"),
          statusCode: String(m.error.code ?? ""),
          errorMessage: firstText([{ type: "text", text: m.error.message ?? "" }]),
          durationMs,
        }, ctx);
      } else {
        const isError = m.result?.isError === true;
        const errorMessage = isError ? firstText(m.result?.content) : undefined;
        if (isError && p.tool !== undefined && errorMessage?.startsWith(schemaErrorPrefix(p.tool))) {
          audit.guardRefused({ guard: "schema", rule: "schema.invalid", message: errorMessage }, ctx);
        }
        audit.mcpResponse(p.level, {
          method: p.method,
          tool: p.tool,
          outcome: isError ? "tool_error" : "ok",
          errorType: isError ? "tool_error" : undefined,
          errorMessage,
          content: p.tool !== undefined ? summariseContent(m.result?.content) : undefined,
          durationMs,
        }, ctx);
      }
    }
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error: Error) => {
    safely(() => audit.mcpMalformed(error));
    previousOnError?.(error);
  };
}
