# Design: audit log and OpenTelemetry export

**Status:** revision 4, after three design reviews; decisions confirmed. **Implemented in siglent-sdg-mcp 2.1.0 and siglent-sds-mcp 2.1.0**, both the JSONL audit log and the OpenTelemetry export (see "Implementation notes"). The same document is in both repositories.

## Problem

Both threat models list **"No audit trail of tool calls"** as a residual risk. Today, if a prompt injection makes the model call `scpi_query("C1:OUTP ON")`, the guard refuses it, and nobody learns that it happened. The refusal goes back to the model and is gone. There's also no record of what the server actually sent to the instrument, which is what matters after an incident on the bench.

## Goals

1. Record every guard decision that refuses something, with the rule that refused it, **by default**.
2. Record every MCP message the server receives, and its outcome.
3. Record every line written to the instrument socket, and every connect and disconnect, attributed to the tool call that caused it.
4. Make losses detectable: a reader of the log can tell that events are missing, while the server is still running.
5. Optionally ship events off the machine over OpenTelemetry (OTLP), so that events exported before a compromise can't be changed by the compromised process.
6. Never block or fail instrument work because of the audit log.

## Non-goals

- **Caller identity.** Over stdio there is no authenticated caller. The client's name and version come from its own `initialize` request and are recorded as self-reported. Real identity comes with the planned HTTP transport and OAuth, which will add a `subject` field from the token.
- **Tamper-proof logs.** See "Integrity".
- **Traces and metrics.** Only the OTEL logs signal. Traces get sampled, and sampling is wrong for an audit trail.
- **Log rotation and retention.** Left to the environment (logrotate, the collector, the backend).
- **Using the log as a control.** The audit log records decisions; it doesn't make them. Nothing is allowed or refused because of it.

## Where events are emitted

Both servers have a single choke point for instrument traffic: `SiglentConnection` in `src/connection.ts`. Every command and query passes through it, and so do the guards. In sdg, the guards are `assertWireSafe` and `assertIsQuery`. sds also has `assertIsCommand` (which refuses queries and data-returning commands such as `SCDP` sent as commands) and `assertBinaryQuery`. The socket is written in exactly two places in sdg (`sendCommand` and `drainQueue`) and in one in sds (`writeLine` inside `drainQueue`).

| Source | Hook | Events |
|---|---|---|
| MCP transport | Wrap `transport.onmessage`, `transport.send` and `transport.onerror` in `src/index.ts`, after `await server.connect(transport)` | `mcp.request`, `mcp.response`, `mcp.malformed`, and `guard.refused` for a disabled `scpi_command` |
| Guards | `ScpiPolicyError`, thrown by the SCPI guard and the host policy, caught and re-thrown in `SiglentConnection` | `guard.refused` |
| Socket | Immediately before each `socket.write`, and when the reply, timeout, write error or close arrives | `scpi.write`, `scpi.result` |
| Connection | `connect`, `close`/`disconnect`, (sds) idle close and the resets after a timeout or an out-of-step reply | `instrument.connect`, `instrument.disconnect` |

**Why the transport, not the tool callbacks.** The MCP SDK validates arguments against each tool's schema before the callback runs, so a wrapper around the callbacks would miss calls with invalid arguments, calls to unknown tools, and every non-tool message. Reviewed against `@modelcontextprotocol/sdk` 1.32.2 (both lockfiles):
- The hook is installed **before** `server.connect()`, as an accessor property for `onmessage` on the transport instance. Whatever handler the SDK assigns is wrapped as it's assigned, so the hook doesn't depend on timing. (Installing it after `await server.connect()` would also work today, because stdin data arrives on a later libuv callback than that continuation, but that's an ordering property, not a guarantee.)
- `_onrequest` schedules the handler with a promise created synchronously inside `onmessage`, so an `AsyncLocalStorage` context entered in the wrapper propagates into the tool callback.
- Responses go through `transport.send`, looked up at call time, so an instance-level wrapper sees them.
A contract test pins this behaviour, so an SDK upgrade that changes it fails CI: a request written to stdin immediately after `connect()` reaches a tool callback with its audit context, and its response passes through the `send` wrapper.

**What the transport doesn't see.** A line that isn't valid JSON, or isn't a valid JSON-RPC message, never reaches `onmessage`. The stdio transport reports it to `onerror` and sends nothing back. Wrapping `onerror` records it as `mcp.malformed`, with the raw line bounded.

**Prerequisite (sdg).** sds enforces the host policy inside `SiglentConnection.connect`, which covers the `connect` tool, auto-connect and reconnects. sdg enforces it separately in the `connect` tool (`src/tools/connection.ts`) and in auto-connect (`src/index.ts`). Moving the check into `SiglentConnection.connect`, as in sds, gives one place for the check and its audit event. It lands first, as its own change.

### Attributing instrument traffic to a tool call

Every event carries the JSON-RPC request id of the call that caused it, set with `AsyncLocalStorage` when the transport hands a request to the SDK.

**Rule: every event emitted inside `SiglentConnection` takes an explicit context, never the ambient one.** The ambient context there is wrong more often than it's missing. Callbacks run in the async context in which they were scheduled, which is frequently another call's:
- the socket's `data` handler runs in the context of the call that created the socket (the `connect` call, auto-connect, or the call that triggered an sds reconnect);
- the response timer, the write callbacks, the sds `*OPC?` gap timer and `close()` after a timeout or out-of-step reply run in whatever context scheduled them;
- the sds idle timer is scheduled from the last query's completion, so it would carry that tool call's id.

So:
- each `QueuedQuery` captures the audit context when it's enqueued, and every event about that query (its writes, its result, a reset it causes) uses the captured context;
- connection lifecycle events that no call caused use a synthetic context: `cause: idle-close`, `cause: reset`, `cause: shutdown`;
- a reconnect inside `ensureReady` keeps the id of the call that needed the connection, with `cause: reconnect`. Auto-connect at startup has no request id and `cause: auto-connect`.

Tests run two tool calls in parallel against the simulator and check that every wire event carries the right request id, including the cases "a query times out, then the next call runs" and "idle close after the last call".

## Event schema

One flat JSON object per event. The JSONL sinks write it as-is; the OTEL sink maps it to a log record (see "OpenTelemetry mapping"). Names follow the OpenTelemetry semantic conventions where one exists, so the two sinks use the same field names.

Common to every event:

| Field | Example | Notes |
|---|---|---|
| `time` | `2026-11-16T09:12:03.412Z` | ISO 8601, UTC, ms |
| `event.name` | `guard.refused` | One of the event names below, prefixed `siglent.audit.` in OTEL |
| `audit.sink`, `audit.seq` | `stderr`, `57` | Each sink numbers the events it accepts, starting at 1. A missing number within one sink means an event lost on the way to that sink. Events below a sink's level are never given a number by it, so a lower level doesn't create gaps. |
| `service.instance.id` | `3f0c…` | Random UUID per process start. Together with `audit.sink` and `audit.seq` it identifies a record uniquely. |
| `service.name`, `service.version` | `siglent-sdg-mcp`, `2.1.0` | |
| `jsonrpc.request.id` | `"12"` | The request that caused the event, as a string. **Omitted** when there is none (OTEL attributes can't be null). |
| `cause` | `tool-call` | `tool-call`, `auto-connect`, `reconnect`, `idle-close`, `reset`, `shutdown` |

Per event (**S** = also at the default security level, see "Sinks and levels"):

| Event | Level | Fields |
|---|---|---|
| `server.start` | S | Effective configuration: `raw_scpi_enabled`, `allowed_hosts`, `allowed_ports`, audit level and sinks. An OTLP endpoint is logged without userinfo or query string. Never environment variables in general. |
| `server.stop` | S | `reason` (`stdin_closed`, `signal`), `audit.lost` (total lost since start) |
| `audit.loss` | S | `audit.lost` (count since the previous `audit.loss`). Emitted on the first successful write after a loss, so losses show while the server runs. |
| `guard.refused` | S | `guard` (`wire`, `query`, `command`, `binary`, `host`, `raw-scpi`), `rule` (see below), `scpi.command` (bounded) or `server.address`/`server.port`, `error.message` (bounded) |
| `instrument.connect` | S | `server.address`, `server.port`, `outcome` (`connected`, `refused_by_policy`, `failed`, `superseded`), `instrument.idn` |
| `instrument.disconnect` | S | `server.address`, `reason` (`requested`, `replaced`, `idle`, `reset_after_timeout`, `reset_out_of_step`, `socket_error`, `socket_closed`, `shutdown`) |
| `mcp.request` | full; S for state-changing tools | Requests and notifications: `mcp.method.name`, `gen_ai.tool.name` (tools/call), `gen_ai.tool.call.arguments` (bounded, see "Content limits"), the registered tool's annotations (`read_only_hint`, `destructive_hint`), `client.name` and `client.version` from `initialize` with `client.self_reported: true`, `mcp.protocol.version` |
| `mcp.response` | full; S for state-changing tools | `outcome` (`ok`, `tool_error`, `jsonrpc_error`, `cancelled`), `error.type`, `rpc.status_code` for JSON-RPC errors, `error.message` (bounded), a content summary (types and byte sizes, not content), `duration_ms` |
| `mcp.malformed` | full | The raw line (bounded) and the parse error |
| `scpi.write` | full | `scpi.command` (bounded), `scpi.kind`, `server.address`, `server.port`, `scpi.write_id` |
| `scpi.result` | full | `scpi.write_id` (exactly one result per id), `outcome` (`written`, `replied`, `timeout`, `write_failed`, `out_of_step`, `connection_closed`, `not_written`), `reply.bytes`, `reply.text` (text replies only, bounded), `duration_ms` |

Notes:
- **`scpi.kind`** is `command` for anything that changes state, `query`, `binary-query`, or `opc` for the pacing `*OPC?`. In sds, `sendCommand` writes the setter as the `pre` of an `*OPC?` query (`CHDR OFF` at connect too); that setter is kind `command`, so an alert on `scpi.kind = command` catches every setter in both servers.
- **`scpi.write` is emitted inside the write path, immediately before each `socket.write`.** An attempt is on record even if the process dies during the write. - **Write ids are allocated when a write is planned**, at enqueue, one per line: an sds setter gets two (the `command` and its `opc`). Each id gets exactly one `scpi.result`. A write that never reached the socket gets `not_written`; one that was written but whose connection closed before the reply gets `connection_closed`. So when sds skips the delayed `*OPC?` because the socket was reset during the gap, the setter's id gets `written`, the `*OPC?` id gets `not_written` (it has no `scpi.write`), and the query's rejection by `close()` shows in its `mcp.response`, not as a second result.
- **State-changing tool calls** are recorded at the security level too, request and response: every tool annotated `readOnlyHint: false`. That covers `scpi_command` and sdg's `reset` (both also `destructiveHint: true`), and every tool that can change what reaches the terminals: in sdg, amplitude and offset through `configure_basic_wave`, the burst, modulation and sweep carrier settings, and `copy_channel`, the output and load through `configure_output`; in sds, input coupling (50 Ω) through `configure_channel`. The criterion comes from the annotations rather than a hand-kept list, so a new tool can't be missed. A test checks that every registered tool declares `readOnlyHint` explicitly. It's two lines per call; the wire-level events (`scpi.*`), 10 to 20 per configure call, stay in the full trail.
- **`notifications/cancelled`** is recorded as an `mcp.request`. Cancelling a call doesn't stop instrument writes it has already queued; the log shows both.
- **A disabled `scpi_command`.** When raw SCPI is off, `scpi_command` isn't registered, so a call to it is just an unknown tool to the SDK. The transport wrapper records it as `guard.refused` with `guard: raw-scpi`, `rule: raw.disabled`, in addition to the `mcp.request`. A model asking for raw commands is worth knowing about.

### Rule identifiers

`ScpiPolicyError` currently carries only a message. It gets a stable `rule` field, so refusals can be counted and alerted on without parsing messages. Proposed list, to be finalised against the guard code:

- `wire.empty`, `wire.too_long`, `wire.control_char`, `wire.compound`, `wire.non_ascii`;
- `query.not_a_query`, `query.parameters_not_allowed`, `query.action_command`, `query.read_and_clear`, `query.empty_node`;
- `command.is_query`, `command.returns_data` (sds);
- `binary.not_allowed` (sds);
- `host.not_allowed`, `host.port_not_allowed`;
- `raw.disabled` (synthesised at the transport, see above).

Two tests keep the list honest. One checks that every `throw new ScpiPolicyError` passes a rule from the list. The other produces every rule on the list at least once, so an orphaned rule fails too.

### Content limits

- Strings in arguments, commands, replies, raw lines and error messages are cut at 512 characters (the wire limit is already 512), with `…[truncated, N chars]` appended.
- Tool arguments are logged, bounded. The OTEL conventions make `gen_ai.tool.call.arguments` opt-in because arguments can contain personal data. Here they're instrument settings, and they're the main evidence. The README says so.
- Tool results are summarised, not copied: for each content item, its type and size. Screenshots and waveform data (sds) are never logged. Binary replies: `reply.bytes` only.
- Text replies are logged, bounded. They're the only evidence for the threat model's "prompt injection via instrument responses" row.
- Nothing from the environment is logged except the effective configuration in `server.start`. That matters for `OTEL_EXPORTER_OTLP_HEADERS`, which commonly holds an API key. An endpoint URL is logged without userinfo and query string, because endpoints sometimes carry keys (`https://user:pass@…`, `?api_key=`). The OTEL SDK's diagnostic logger stays at `WARN` or below.
- `instrument.idn` and `*IDN?` replies contain the instrument's serial number. That's fine locally; the README mentions it for users who export to a third-party backend.

## Sinks and levels

| `SIGLENT_AUDIT_LOG` | Local sink | Level |
|---|---|---|
| unset | stderr | security (the events marked S) |
| `stderr` | stderr | full |
| an absolute path | that file, created with mode `0600`, appended | full |
| `off` | none | — |

- **The security level** covers `server.start`/`server.stop`, `audit.loss`, `guard.refused`, `instrument.connect`/`disconnect`, and requests and responses for state-changing tools. That's a few lines per configure call and none for pure reads (sds's `measure` tools count as state-changing, since they install the measurement on the display), and it's what the problem statement asks for: a refusal no longer goes unnoticed. The full trail (every `mcp.*` event and the wire-level `scpi.*` events) is 10 to 20 events per configure call, so it's opt-in.
- **OTLP** is enabled by `SIGLENT_AUDIT_OTLP=1` with the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, or by `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` alone (see "Implementation notes"), and always receives the full trail. It's independent of `SIGLENT_AUDIT_LOG`: `off` plus an endpoint means OTLP only. The standard OTEL variables configure it (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, ...), with no server-specific duplicates.
- **Never stdout.** Stdout carries the MCP protocol. A test starts the server, makes calls that produce every event type, and checks that every line on stdout parses as JSON-RPC.

## Delivery and failure behaviour

- **Non-blocking writes.** On Linux, Node writes to pipes and files synchronously. A client that pipes the server's stderr and never reads it would fill the pipe (about 64 KB) and stall the event loop, and with it every tool call; so would a file on a hung network filesystem. The audit writer therefore never writes on the event loop. Events go into a bounded in-memory queue (4096 events); one `fs.write` at a time drains it on the libuv thread pool, to fd 2 or to the file. A stuck write ties up one pool thread, never the event loop. When the queue is full, new events are dropped and counted.
- **All stderr output goes through the same queue.** The server's human-readable lines (startup notes, auto-connect results, the sds idle-close message, the `uncaughtException`/`unhandledRejection` handlers in `src/index.ts`, and the loss warning itself) use one `log()` helper that enqueues them like audit events; `console.error` isn't used in `src/` any more, and a lint rule keeps it that way. Two writers outside `src/` are routed too: Node's process warnings (`DeprecationWarning`, `MaxListenersExceededWarning`, ...), whose default printer is replaced with a `warning` listener that calls `log()`, and the OTEL diagnostic logger, which gets a `log()`-based logger instead of `DiagConsoleLogger`. So the writer is the only thing that writes to fd 2 after startup: nothing on the event loop can block on a full pipe, and nothing can interleave with an event. The exception is the SDK's own `console.warn` for invalid tool names, which runs only at registration, before any traffic. The loss warning is only enqueued, never written directly, so a stuck pipe produces drops, not a stall. Human-readable lines are dropped and counted like events when the queue is full; startup configuration errors, which exit before the queue exists, are the one synchronous exception.
- **One line per event, written whole.** Each event is serialised to a single line; over-long events are cut field by field, longest first, and marked truncated, at 16 KB. Because the writer is the only writer, a short write is simply continued from the remaining bytes; atomicity at the platform's `PIPE_BUF` (4096 bytes on Linux, 512 on macOS) isn't relied on. `EAGAIN` (if the descriptor is non-blocking) is retried with exponential backoff from 10 ms to 1 s. `EPIPE` (the reader has gone) isn't retried: the rest of the queue is counted as lost, and the sink is closed.
- **At startup, fail closed.** If a configured file can't be opened, or the OTEL endpoint isn't a valid URL, the server exits with a configuration error. That matches the existing rule for invalid security configuration: no silent fallback.
- **At runtime, fail open, visibly.** A failed or dropped write, or an OTLP export the collector rejects or can't receive, never blocks or fails a tool call. Each loss is counted; an `audit.loss` event reports the count once writing works again, and a warning is enqueued for stderr, rate-limited to one per minute. `audit.seq` gaps show the loss in the backend.
- **An unreachable collector at startup** is a runtime failure, so it fails open. To make sure users don't believe they have a trail when they don't, the server exports `server.start` immediately and prints a clear warning on stderr if that fails.
- **OTEL batching.** The SDK's batch log record processor, with a bounded queue (2048 records) and a 1 s schedule.
- **Shutdown.**
  - The SDK's stdio transport doesn't listen for stdin `end`, so the server adds a listener. Today, an open instrument socket keeps the process alive after stdin closes. On stdin end, the server closes the instrument connection, flushes with the same 2 s limit as below, and exits. The client has usually gone, so stderr may be closed (`EPIPE`, counted as lost) or full.
  - Clients usually stop servers with SIGTERM. A SIGTERM/SIGINT handler replaces Node's default exit, so it flushes (2 s timeout) and then calls `process.exit`.
  - SIGKILL loses whatever is queued, including the final `server.stop`. That's why losses are reported incrementally (`audit.loss`), not only at stop.
- **Ordering.** JSONL sinks preserve emission order. OTLP batches may arrive out of order; the sink's `audit.seq` restores it.

## Integrity

What this design does and doesn't give:

- **Against an honest server with a buggy or misbehaving model:** a complete record, with detectable losses.
- **Against a compromised server process** (code execution inside it): nothing it produces after the compromise can be trusted. It can rewrite the local file, forge events, stop exporting, and send any command to the instrument without emitting an event, since the hooks run in the same process. It holds the export credentials (`OTEL_EXPORTER_OTLP_HEADERS` is in its environment), so it can even forge a continuous, gap-free `audit.seq` stream for the OTLP sink under the same `service.instance.id`. Records still in the batch queue (up to about 1 s) can be dropped.
- **What the OTLP export does give:** events exported *before* the compromise can't be changed by the process. That holds only if the backend is append-only and the configured key can only ingest, not delete or query. The README recommends an ingest-only key.
- **2.1.0 has no off-machine copy.** Its threat-model row must not claim integrity beyond "a record of an honest server's activity".
- **Hash-chaining the local file** wouldn't add anything on its own: the same process could rewrite the chain from the start. Out of scope.

## OpenTelemetry mapping

- **Signal and transport:** logs, via the official SDK: `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/resources`. OTLP/HTTP.
- **Record:** `eventName` = `siglent.audit.<event.name>`. Severity `INFO`, except `WARN` for `guard.refused`, `audit.loss` and failed results. The body is a one-line summary; every field above becomes an attribute.
- **Resource:** `service.name`, `service.version`, `service.instance.id`.
- **Semantic conventions.** The [MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md) are at **Development** status and define spans and metrics, not logs. This design reuses their attribute names on log records, because that's what backends and dashboards will recognise:
  - from the MCP conventions: `mcp.method.name`, `gen_ai.tool.name`, `jsonrpc.request.id`, `mcp.protocol.version`, `error.type`;
  - `rpc.status_code`, which replaces the deprecated `rpc.response.status_code`;
  - `server.address` and `server.port` from the general conventions.

  Attributes with no convention use the `scpi.`, `guard.`, `reply.`, `audit.` and `instrument.` prefixes. Because the conventions are still changing (one name has already been renamed), the names live in one module, and the CHANGELOG notes any rename.
- **Dependency cost.** Measured on 15 Nov 2026, the four packages pull in 11 packages in total, about 19 MB installed, all published by the OpenTelemetry project: `api`, `api-logs`, `core`, `exporter-logs-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `resources`, `sdk-logs`, `sdk-metrics`, `sdk-trace` and `semantic-conventions`. The transformer pulls in the trace and metrics SDKs.
  - They become regular dependencies. An optional dependency is installed by default anyway, so it would save nothing.
  - The exporter is loaded with a dynamic `import()` only when an endpoint is set, so a user without OTEL configured never runs that code.
  - The lockfile pins them in CI and in the Docker image. `npx` and `npm install` users resolve the declared ranges at install time, as with every other dependency. Dependabot proposes updates.

## Docker

- The default stderr sink works unchanged with `docker run --read-only`.
- A file sink needs a writable mount: `-v /host/audit:/audit -e SIGLENT_AUDIT_LOG=/audit/sdg.jsonl`. The directory must be writable by UID 1000. The README's claim that "the server writes no files" changes to "the server writes no files unless a file audit log is configured".
- OTLP needs network access to the collector, as instrument access already does. The README shows the headers passed by name (`-e OTEL_EXPORTER_OTLP_HEADERS`, so the value comes from the client's environment) or with `--env-file`, not inline in the client's JSON config, where `docker inspect` and `ps` would show the key.

## Differences between the two servers

| | siglent-sdg-mcp | siglent-sds-mcp |
|---|---|---|
| Host policy | In the `connect` tool and auto-connect today; moves into `SiglentConnection.connect` first (see "Prerequisite") | Already in `SiglentConnection.connect` |
| Guards | `assertWireSafe`, `assertIsQuery` | Also `assertIsCommand` and `assertBinaryQuery` |
| Setter writes | `sendCommand` writes directly: one `scpi.write` of kind `command` | `sendCommand` queues `*OPC?` with the setter as `pre`: a `command` write, then an `opc` write after `OPC_GAP_MS` (or `not_written` if the socket was reset in between) |
| Binary transfers | None in use | `queryBinary` for waveform data and screenshots: `reply.bytes` only |
| Connection lifecycle | Explicit connect and disconnect | Also idle close, reconnect on demand, and the resets after a timeout or an out-of-step reply |
| Physical effect | Output on/off. `configure_output` events are the most important ones to alert on. | None directly; `configure_channel` coupling to 50 Ω is the notable setting |

## Tests

- **Unit, with an in-memory sink:**
  - every registered tool produces `mcp.request` and `mcp.response`;
  - schema-invalid arguments, an unknown tool name, a disabled `scpi_command` and a malformed line are recorded;
  - every guard rule produces `guard.refused` with its `rule`, and no `scpi.write`; every listed rule is produced at least once;
  - attribution: two parallel calls, "timeout then the next call" and "idle close after the last call" (see "Attributing instrument traffic");
  - sds: a setter is a `command` write; a reset during the `*OPC?` gap gives `written` for the setter's id and `not_written` for the `*OPC?` id, and every write id has exactly one result;
  - state-changing tools (and only those) are recorded at the security level, and every registered tool declares `readOnlyHint`; strings are bounded; image and binary content isn't logged; the security level emits only the S events.
- **Writer:**
  - a stderr pipe nobody reads doesn't stall tool calls: fill it, cause drops so the loss warning fires, and check that a tool call still completes; `audit.loss` reports the drops once the pipe drains;
  - `EPIPE` on stderr counts the queue as lost and doesn't retry;
  - each sink numbers only the events it accepts: with stderr at the security level and the full trail elsewhere, stderr has no gaps;
  - a file sink is created with `0600`;
  - an unwritable path makes the server exit at startup.
- **Transport contract:** a test pins the three SDK behaviours the hooks rely on (listed under "Why the transport"), so an SDK upgrade that breaks them fails CI.
- **Process:** stdout carries only JSON-RPC, whichever sinks are configured. Stdin end and SIGTERM both flush within 2 s and exit, with an open instrument connection too. No `console.error` remains in `src/`, and a process warning goes through `log()`.
- **OTEL:** a local HTTP server stands in for the collector. It checks:
  - the POST to `/v1/logs` and the attribute names;
  - flush on shutdown;
  - the startup warning and the loss count when the collector is down;
  - that a tool call still succeeds while the collector is down;
  - that the logged endpoint has no userinfo or query string.
- **Hardware check:**
  - It drains the server's stderr, as `e2e-loopback.mjs` already does. Today it pipes stderr without reading it.
  - It runs with a file sink and uses the log as an independent oracle: every security probe must appear as `guard.refused` with the expected rule, and no refused command may appear in any `scpi.write`. Today the check reads instrument state back; this adds a record of what the server tried to write.
- **Container:** `scripts/check-image.sh` runs the hardened image with a mounted audit directory and checks that events arrive.

## Rollout

1. sdg: move the host-policy check into `SiglentConnection.connect` (its own PR, no behaviour change).
2. Both: add `rule` to `ScpiPolicyError` (no behaviour change). Make the hardware checks drain stderr.
3. Both, **2.1.0:** the audit core, the non-blocking writer (also for the human-readable stderr lines), the stderr and file sinks, the security and full levels, the transport and connection hooks, shutdown handling, and the tests. The threat-model row changes to describe what's recorded, with the integrity limits for a local-only log. The README gets an "Audit log" section.
4. Both, **also 2.1.0** (originally planned as 2.2.0; the maintainer chose to release both together): the OTLP sink, the startup export check, the README's collector example with an ingest-only key, and the threat-model update for the off-machine copy.

## Implementation notes (siglent-sdg-mcp 2.1.0)

Where the implementation makes the design concrete or departs from it:

- **Causes:** two more values. `socket`: the instrument or the network closed the socket. `internal`: no call involved (startup, malformed lines, loss reports).
- **Disconnect reasons:** `init_failed` added, for a connection that opened but failed `CHDR OFF` or `*IDN?`.
- **`mcp.malformed`** carries the transport's error message, not the raw line: the stdio transport doesn't pass the line on.
- **Schema refusals** are `guard.refused` with `guard: schema`, `rule: schema.invalid`, recognised only when a tool error *starts with* the SDK's exact text, `MCP error -32602: Input validation error: Invalid arguments for tool <name>:`. The contract test pins that text. A substring match would be forgeable: many tool errors repeat their input.
- **Audit work in the transport hook never stops a message:** a throw in it is logged on stderr and swallowed, and the SDK still gets the message. Arguments that can't be serialised (nested too deep for the stack) are logged as a placeholder.
- **Cancellation:** the SDK sends no response for a cancelled call, so the `notifications/cancelled` handler closes it with `mcp.response` `outcome: cancelled`, at the call's own level. The instrument side of the call still ends on record in the full trail.
- **A call to the disabled `scpi_command`** has its `mcp.request` at the security level, beside its `raw.disabled` refusal.
- **A socket error** closes off the queued queries as `not_written`, as a close does, instead of draining them into the dying socket.
- **One result per write id** is enforced structurally: a query settles once, and a write error that arrives after its query ended is ignored.
- **Rule list, final:** `wire.empty`, `wire.too_long`, `wire.control_char`, `wire.non_ascii`, `wire.compound`, `query.not_a_query`, `query.common_not_allowed`, `query.action_command`, `query.parameters_not_allowed`, `query.parameters_invalid`, `host.port_not_allowed`, `host.not_allowed`, `host.not_private_lan`, `raw.disabled`, `schema.invalid`. There's no `query.read_and_clear`: `*ESR?` is refused by the common-query allowlist (`query.common_not_allowed`). There's no `query.empty_node`: an empty node fails the query shape (`query.not_a_query`).
- **"A lint rule"** is a unit test that scans `src/` for `console.` and `process.stderr` outside `src/audit/`; the project has no linter.
- **Context:** the ambient context is read only at the synchronous start of the public `connect`, `disconnect`, `sendCommand` and `query`, which tools call directly. Everything later uses an explicit context: connect's own `CHDR OFF` and `*IDN?` get the connect call's, the queue drain, timers, and socket and write callbacks use the one captured in the `QueuedQuery`, and connection lifecycle events use a synthetic one.
- **Arguments:** each string is bounded at 512 characters, and the arguments as a whole at 4096.
- **The loss warning** on stderr is given when a loss is reported, once the sink accepts records again, not when the drop happens. At that moment stderr is usually the thing that's stuck, so a warning written then would be dropped too.
- **Shutdown** flushes for up to 1 s, then writes `server.stop`, then flushes for up to 1 s more, so a queue still full from a stalled stderr doesn't drop the final loss count. If a write is still in the thread pool after that (a file on a hung network filesystem, a FIFO nobody reads), the server sends itself SIGKILL: `process.exit` joins the thread pool and would wait for that write without a time limit. A second signal during shutdown does the same. On stderr this rarely matters, because Node makes fd 2 non-blocking once anything reads `process.stderr` (the SDK does), so a full pipe returns EAGAIN rather than blocking a thread.
- **Lengths:** names and ids from the client (tool, method, request id) are bounded at 128 characters, the protocol version at 64, and human-readable stderr lines at 4096.
- **The event schema is shared with siglent-sds-mcp,** so some values are never emitted by sdg: `opc` and `binary-query`, `out_of_step`, `idle`, `reset_after_timeout`, `reset_out_of_step`, and the causes `reconnect`, `idle-close` and `reset`.
- **A connect still in progress at shutdown** gets no final `instrument.connect` event.
- **OTLP export** (src/audit/otlp.ts):
  - The SDK is loaded with a dynamic `import()` only when an endpoint is set. The exporter reads the standard `OTEL_EXPORTER_OTLP_*` variables itself; the server only validates the endpoint (an invalid URL, or a scheme other than http/https, stops it at startup) and honours `OTEL_SDK_DISABLED`.
  - Only OTLP/HTTP with JSON payloads (`@opentelemetry/exporter-logs-otlp-http`). Another `OTEL_EXPORTER_OTLP_PROTOCOL` gets a startup note rather than being ignored silently.
  - The sink counts its own queue: it refuses records once 2048 are waiting (the batch processor's capacity), so the processor never drops one silently. A wrapper around the exporter counts every record an export failed to deliver as lost (the exporter calls back exactly once per export; retries happen inside it). Records a collector rejects in a partial-success answer, which the SDK calls a success, are counted from its diagnostic warning. When an export fails that contains an `audit.loss` record, the count that record carried is reported again (through `takeUnreported()`, which doesn't add to the totals a second time); for a rejected `audit.loss` record this isn't possible, because a partial-success answer doesn't say which records it rejected. At shutdown, `server.stop` goes to the `otlp` sink first and is flushed; the local sinks get theirs afterwards, with the OTLP totals that final export settled (`otlp.lost`, `otlp.unexported`), and stderr says how many records were lost. So the `otlp` sink's `audit.seq` gaps are accounted for, at the latest on the local sinks at shutdown.
  - The SDK's global error handler is replaced: the default one JSON-serialises the whole error, including its stack and the collector's HTTP response body, which can echo the key. Only the message and status code are logged.
  - Diagnostic and error lines are rate-limited: one per kind per minute, then a count of the suppressed ones.
  - **Opt-in (changed after review, confirmed by the maintainer on 16 Nov 2026).** The design enabled the export with the standard `OTEL_EXPORTER_OTLP_ENDPOINT`. Review showed that variable is often inherited from an environment set up for another application's telemetry, which would send tool arguments and the instrument's serial number to that collector. The export now needs `SIGLENT_AUDIT_OTLP=1`, or the logs-specific `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`; the generic endpoint alone gets a startup note. `OTEL_LOGS_EXPORTER` is honoured (`none` turns the export off; values other than `otlp` get a startup note).
  - The logged endpoint is the URL the exporter posts to: the generic endpoint with `/v1/logs` appended.
  - Flushes queue behind each other: the SDK returns at once from a flush started while another runs, so without that, a shutdown during the startup check's flush could skip exporting `server.stop`.
  - The startup check runs in the background: `server.start` is flushed right away (up to 10 s), and if no export has succeeded by then, a warning goes to stderr. The server doesn't wait for the collector to start serving.
  - The SDK's diagnostic logger (WARN and above) goes to `audit.log()`, with URL userinfo and query strings, and every configured header value and each whitespace-separated part of it, removed.
  - `service.name`, `service.version` and `service.instance.id` are resource attributes, not record attributes. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` can override the name and version, but not the instance id, which joins the OTLP records to the local ones.
  - Severity `WARN` also covers `mcp.malformed` and an `instrument.disconnect` caused by the socket.
  - An HTTP export doesn't use the thread pool, so the OTLP sink never makes shutdown kill the process.
- **sdg has no idle close or reconnect,** so the idle-close test applies to sds only.

## Implementation notes (siglent-sds-mcp 2.1.0)

The scope server follows the siglent-sdg-mcp implementation above, module for module (`src/audit/` is the same code). What differs is the connection:

- **The ambient context** is read at the start of the public `connect`, `disconnect`, `sendCommand`, `query`, `queryBinary` and `checkChannel`. Everything else, `ensureReady`'s reconnect included, gets an explicit context.
- **Reconnect:** `ensureReady` reconnects with the id of the call that needed the connection and `cause: reconnect`; the reconnect's own `CHDR OFF` and `*IDN?` carry it too.
- **Idle close:** `cause: idle-close`, no request id (the idle timer is scheduled from the last query's completion, so its ambient context would be that call's).
- **Resets:** after a timeout (`reset_after_timeout`) or an out-of-step reply (`reset_out_of_step`), with `cause: reset` and the id of the call whose query caused it.
- **Setter writes:** a setter paced by `*OPC?` is two writes with two ids allocated at enqueue: the setter (`scpi.kind: command`) and the `*OPC?` (`opc`). The setter's result is recorded when its write completes. If the connection resets during the 20 ms gap, the skipped `*OPC?` has no `scpi.write` and its result is `not_written`; a timeout in that gap is recorded as `not_written` too. An out-of-step reply gives the `*OPC?` the outcome `out_of_step`.
- **Binary queries** (`get_waveform`, `screenshot`) are `binary-query` writes, logged by size only.
- **"superseded"** means a newer connect cut the attempt short (the socket connected after a newer attempt started, or the handshake was interrupted by one). An attempt that was refused or timed out on its own is `failed`, even if a newer one had started.
- **Defence in depth:** a query settles once, and a write error that arrives after its query ended is ignored. No path reaching either was found in review; they keep "one result per write id" from depending on that.
- **Known, unchanged behaviour:** after a write error, the write callback drains the queue before the socket's error event, so the next queued line can be written into the dying socket. The log shows that write, with the result `connection_closed`. It's the existing resilience behaviour and isn't changed here.
- **Rules:** the scope adds `query.read_and_clear`, `binary.not_allowed`, `command.is_query` and `command.returns_data`; `wire.too_long` and `binary.not_allowed` aren't reachable through the tools (their schemas cap commands at 512 characters, and binary queries are fixed), only through the connection.
- **The hardware check** runs three server sessions (default, raw SCPI, restore), all writing to one audit file; the oracle waits for all their `server.stop` records.

## Decisions

Proposed after the design reviews and confirmed by the maintainer on 15 Nov 2026.

1. **Default:** on, at the security level (including state-changing tool calls), on stderr. The full trail is opt-in with `SIGLENT_AUDIT_LOG`. The writer is non-blocking either way.
2. **Arguments:** logged, bounded at 512 characters.
3. **Reply text:** logged, bounded. Binary replies are size only.
4. **Runtime failures:** fail open, with losses visible while the server runs.
5. **OpenTelemetry:** originally 2.2.0, to keep 2.1.0 free of new dependencies. Since 2.1.0 hadn't been released when the export was ready, both ship together in 2.1.0 (decided 16 Nov 2026), so no version exists without the other.
