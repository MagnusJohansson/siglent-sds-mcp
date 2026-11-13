# Threat model: siglent-sds-mcp

**Scope:** version 2.0.0, stdio transport, one Siglent SDS oscilloscope on a lab network.
**Out of scope for now:** an HTTP transport and authorization, the MCP client, and the model itself.

## What we are protecting

| Asset | Why it matters |
|-------|----------------|
| **The integrity of measurements** | A model, or the person reading its answer, acts on what the scope reports. A changed probe factor, offset or trigger, or a reply matched to the wrong query, gives wrong readings that look plausible. |
| **The scope's inputs** | On models with 50 Ω input coupling, switching a channel to 50 Ω with a large signal attached can exceed the input's rating. |
| **The scope's configuration** | A reset, a recalled setup or changed acquisition settings silently invalidate later measurements and the user's own setup. |
| **The lab network** | The server runs on a machine that can reach other hosts. It shouldn't become a way to reach them. |

## Trust boundaries

```
 user ──► MCP client + model ──(1)──► siglent-sds-mcp ──(2)──► TCP 5025 ──► SDS ◄── probes ── circuit
                ▲                            │
   documents, web pages, tool output        (3) any host:port the machine can reach
   (prompt injection enters here)
```

1. **Model → server.** Every tool argument is **untrusted**. The model may have been steered by content it read (a datasheet, a web page, a previous tool result). The server can't tell what the user asked for apart from what injected text asked for, so it has to enforce constraints that hold either way.
2. **Server → instrument.** SCPI over raw TCP: newline-terminated, no authentication, no integrity. Anything written to the socket is executed.
3. **Server → network.** The `connect` tool chooses where the socket goes.

Tool annotations such as `readOnlyHint` are **hints for the client, not controls**. Clients may auto-approve tools marked read-only, so a wrong annotation directly weakens the user's approval step.

## Findings in version 1.0.1 and their fixes

| # | Finding | Impact | Fix in 2.0.0 |
|---|---------|--------|--------------|
| F1 | `scpi_query` was annotated `readOnlyHint: true` but wrote any string to the socket, including setters. | A client auto-approving "read-only" tools would let a state change through without asking. | Every query is checked structurally: a single header immediately followed by `?` (an **allowlist of shape**, so long-form headers can't get around it). Parameters after `?` only for `PAVA?`, in its documented single-token form. `*` commands only as pure queries, and known action headers in `?` form (`ASET?`, `ARM`, `FRTR?`, ...) are refused. Enforced in `connection.query()`, so it covers every tool. Binary transfers (`SCDP`, `Cn:WF? DATn`) have their own exact allowlist. |
| F2 | String parameters (`configure_channel.vdiv` and `offset`, `configure_acquisition.timebase`, `trigger_level` and `trigger_delay`) were interpolated into commands unchecked. A `\n` or `;` injected extra commands. | Any tool with a string parameter was effectively a raw command channel. | Two layers. (a) **Command-boundary check** on every string written to the socket: no control characters, no `;`, ASCII only, max length. (b) **Strict formats** for each free-text parameter (voltages such as `500mV`, times such as `1US`). Layer (a) stops command smuggling even if a schema is wrong; layer (b) stops unexpected text inside a single command (`1V,OFF`), which (a) can't see. |
| F3 | `connect` accepted any host and port. | Combined with raw SCPI: a line-oriented TCP client to anything reachable, e.g. a cloud metadata endpoint or internal services. | Hosts restricted to `SIGLENT_IP` and `SIGLENT_ALLOWED_HOSTS`. If neither is set, only private-LAN IP literals (no host names, loopback or link-local). Ports restricted to 5025 and the configured port. **Enforced inside `connection.connect()`**, so the tool, the startup auto-connect and every automatic reconnect are covered. |
| F4 | The raw `scpi_command` tool was always registered. | The model could send any command, e.g. `*RST`, recall a setup or switch inputs to 50 Ω. | Off by default (`SIGLENT_ALLOW_RAW_SCPI=true` enables it), and only together with named hosts, because "any private-LAN IP on 5025" also matches signal generators, power supplies and electronic loads. Marked `destructiveHint: true`. |
| F5 | After a reply timed out, its late answer was read as the reply to the next query. Since commands are paced with `*OPC?` (added after 1.0.1 for the SDS1202X-E), the same happened when a slow command such as `*RST` exceeded the timeout, or when a query was sent as a command. | Wrong readings, attributed to the wrong query, with no error. | After any timeout, or if a command's `*OPC?` acknowledgement isn't `1`, the connection is reset; the next call reconnects. A late reply dies with the old socket. |
| F6 | Two overlapping `connect` calls (the startup auto-connect and the `connect` tool) could both install a socket. The scope serves one client at a time, so one of them could hold the scope while the other got no replies. | The server could end up unable to talk to the scope. | A superseded connect attempt closes its own socket and doesn't touch the newer connection. |

`measure` is now annotated as not read-only (it installs the measurement on the scope); `scpi_query` is read-only again, because that is now enforced.

## Design principle

**One choke point, closest to the wire.** All checks that guard the instrument run in `connection.ts`, after a tool has built its command and before it is written. A new tool, or a bug in an existing one, can't skip them. Per-tool schema validation sits on top as an extra layer, not instead.

## Residual risks (accepted or deferred)

| Risk | Status |
|------|--------|
| **50 Ω input coupling.** `configure_channel` can select `A50`/`D50` on models that have it. With a large signal attached, that can exceed the input's rating. Whether a given model protects itself isn't documented here. | Accepted for now: it is a legitimate setting. Planned: human-in-the-loop confirmation for settings with physical consequences. |
| **Changes need no confirmation.** Any configuration tool can change the scope without the user approving it, unless the client asks. | Planned: confirmation (MCP elicitation) for selected changes. |
| **The instrument itself has no authentication.** Anyone who can reach TCP 5025 controls it directly and bypasses this server. | Out of the server's control. Mitigation: network segmentation (instrument VLAN, host firewall). |
| **Undocumented action headers in `?` form** pass the query-shape check if they aren't on the known-actions list. Whether the firmware runs the action is undocumented. | Accepted: the known actions are refused; others are unlikely to have a physical effect on a scope. |
| **Measured data leaves the lab.** Waveforms and screenshots are returned to the model, and so to whoever operates it. | Inherent in the tool's purpose. Don't connect circuits whose signals are confidential. |
| **Prompt injection via instrument responses** (e.g. a label returned by a query). | Low: responses are short and mostly numeric. |
| **No caller identity in stdio mode.** Whoever can start the process has full access. | Planned: HTTP transport with OAuth 2.1, per-tool scopes. |
| **No audit trail** of tool calls. | Planned with the HTTP/OAuth work. |

## How this is tested

`tests/integration/security.test.ts` runs a real MCP client against the real server, over a real TCP socket to a SCPI simulator (`tests/simulator/`). Each rejection is checked by **what did not reach the simulator**, using a `*OPC?` round trip as a sync barrier so "nothing was sent" can't pass just because the bytes hadn't arrived yet. The simulator answers in order, like the scope, so a slow `*OPC?` delays every reply behind it; that is what makes the stale-reply test (F5) meaningful.

`tests/integration/connection-resilience.test.ts` covers F5, F6 and the host policy on reconnects.

`scripts/hardware-check.mjs` (`npm run hardware-check -- <ip>`) repeats the security checks against a real scope and confirms each one by reading the timebase back; it records the settings it touches and restores them at the end. On an SDS1104X-E (firmware 8.1.6.1.37R8): 22 of 22 pass, including F5 on hardware.

Each protection was checked by disabling it and confirming that tests fail (wire check, query shape, action headers, binary allowlist, host policy, `*OPC?` check, reset after timeout, superseded connects, strict formats, raw SCPI opt-in).
