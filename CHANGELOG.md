# Changelog

## 2.1.0

### Added

- **Audit log.** The server records what it refused, what it connected to and, optionally, every line it wrote to the scope, as JSON lines. Configured with `SIGLENT_AUDIT_LOG`; see the README's "Audit log" section and `docs/audit-log-design.md`.
  - By default, security events go to stderr: every refusal (`guard.refused`) with a stable rule id, `instrument.connect` and `instrument.disconnect`, every state-changing tool call (`readOnlyHint: false`) with its arguments and result, `server.start`/`server.stop` and `audit.loss`.
  - `SIGLENT_AUDIT_LOG=stderr` gives the full trail on stderr: also every MCP message, read-only calls and every instrument write with its reply. An absolute path gives the full trail in that file (mode `0600`); `off` disables it. A relative path, or a file that can't be opened, stops the server at startup.
  - Refusals the SDK makes before a tool runs are recorded too: arguments that fail the tool's schema (`schema.invalid`, e.g. a newline in `vdiv`) and calls to `scpi_command` while it's disabled (`raw.disabled`). Lines that aren't valid JSON-RPC are recorded as `mcp.malformed`.
  - Every event carries the JSON-RPC request id of the call that caused it, including instrument writes made later from the query queue. Connection events say what caused them: an idle close (`cause: idle-close`), the resets after a timeout or an out-of-step reply (`cause: reset`, with the id of the call whose query caused it), and a reconnect, which carries the id of the call that needed it (`cause: reconnect`). A setter paced by `*OPC?` is two writes, the setter (`scpi.kind: command`) and its `*OPC?` (`opc`); if the connection resets in the gap between them, the `*OPC?` is recorded as `not_written`. Waveform and screenshot data are logged by size only. A cancelled call is closed with `outcome: cancelled`.
  - Each sink numbers its records without gaps; lost records are counted and reported with `audit.loss` (and a warning on stderr) once the sink accepts records again.
- **OpenTelemetry export.** With `SIGLENT_AUDIT_OTLP=1` and the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, or with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` alone, the full audit trail is also exported as OTLP log records over HTTP with JSON payloads, independent of `SIGLENT_AUDIT_LOG`. Event names are `siglent.audit.<event>`; refusals and failures are `WARN`. It's opt-in because the generic endpoint is often inherited from another application's environment: that endpoint alone gets a startup note, not an export. `OTEL_LOGS_EXPORTER=none` keeps it off in any case. An invalid endpoint stops the server at startup; a failing collector doesn't, but the server warns on stderr (rate-limited) and counts the records that didn't arrive, including those a collector rejects in a partial-success answer, reporting them with `audit.loss` once the export works. At shutdown the local sinks' `server.stop` carries the OTLP totals after the final export (`otlp.lost`, `otlp.unexported`), and stderr says how many records were lost. The key in `OTEL_EXPORTER_OTLP_HEADERS` isn't logged: the logged endpoint has no userinfo or query string, the exporter's errors are logged as message and status only (no response body, no stack), and configured header values, and their parts, are redacted. Adds 11 dependencies, all from the OpenTelemetry project (`@opentelemetry/api`, `api-logs`, `core`, `sdk-logs`, `exporter-logs-otlp-http`, `resources` and what they pull in), loaded only when an endpoint is set.
- `ScpiPolicyError` carries a stable `rule` id (`query.not_a_query`, `wire.compound`, `host.not_allowed`, ...).

### Changed

- **Requires Node.js 22.15 or later** (was 20.9). The OpenTelemetry 3.x packages require it, and Node 20 reached end of life in April 2026. The Docker image (Node 26) is unaffected; with `npx`, upgrade Node first.
- **All stderr output goes through one non-blocking writer**, the human-readable lines and Node's process warnings included. A client that pipes the server's stderr and never reads it can no longer stall tool calls once the pipe is full; lines are dropped and counted instead.
- **The server exits when stdin closes.** Until now an open instrument connection kept the process alive after the client had gone. On stdin end, SIGTERM or SIGINT, the server closes the instrument connection, flushes the audit log (up to 1 s), writes `server.stop`, flushes again (up to 1 s) and exits. If a write is still stuck in the kernel then (a file on a hung network filesystem, say), the server kills itself with SIGKILL instead of waiting for it, since an ordinary exit would wait without a time limit; it then ends with status 137 (killed by SIGKILL) and no `server.stop`, which is expected, not a crash. A second signal during shutdown does the same.
- **Docker:** the server still writes no files by default, so `--read-only` works unchanged. A file audit log needs a mounted directory writable by UID 1000; `scripts/check-image.sh` checks that.

### Tests

- OTLP tests run the server process against a local HTTP server standing in for a collector: the exported records, their names, severities, attributes and resource, the flush on shutdown, the export-only mode, losses while the collector rejects exports and their report once it accepts them, an invalid endpoint, and that the key appears in no record and no stderr line.
- Audit tests run the MCP server against the simulator and check attribution with parallel calls, after a timeout and when a disconnect cuts queued queries off, the per-sink numbering, bounded strings, and that every rule id is produced. A contract test pins the SDK behaviours the transport hooks rely on. Process tests check that stdout stays JSON-RPC, shutdown on stdin end and SIGTERM, the file mode, fail-closed startup, and that 2,000 tool calls complete with stderr unread.
- The hardware check drains the server's stderr and uses the audit log as a second oracle: every security probe must be recorded as `guard.refused` with its expected rule, and no probe's payload may appear in any instrument write.

## 2.0.3

### Security

- The Docker image no longer runs the server as root. It runs as the base image's `node` user (UID 1000); the app files stay owned by root, so the server can read them but not change them. The setuid and setgid bits are removed from every file in the image. This is defence in depth: no known flaw lets a caller run code in the server, and with the documented `--rm` the container is discarded after each session. It limits a compromised process inside the container; it doesn't limit what that process could send to the instrument.
- The README's `docker run` examples add `--read-only --cap-drop=ALL --security-opt=no-new-privileges`. The server writes no files and needs no Linux capabilities. These flags are optional; existing configurations keep working.

### Release process

- `scripts/check-image.sh` checks a built image: it fails if the image's user is root or the image contains setuid or setgid files, and checks that the server answers an MCP `initialize` request when started with the hardening flags. CI runs it on every pull request, and the release workflow runs it before publishing to npm, so a release can't ship an image that runs as root.
- `scripts/hardware-check.mjs` takes `--docker <image>`, to run the checks against the server in a Docker image with the hardening flags. Hardware check: 24/24 with `--docker` on the new image.

## 2.0.2

### Fixed

- `scpi_query` no longer accepts commands that the programming guide documents without a query form. Only a short list of known actions (`ASET`, `ARM`, `STOP`, `FRTR`, `PACL`) was refused; others passed with a `?` appended, for example `SET50?` (set the trigger level to 50 %), `MEACL?` (clear measurements), `REFSA?` / `REFCL?` (save or close a reference waveform), `PFCM?` (create a pass/fail mask), `RCPN?` / `STPN?` (recall or store a setup) and the decode and gate setters. Whether the firmware ignores the `?` or runs the command isn't documented. All of them are now refused, in long and short form, with one or more source prefixes such as `C1:` or a numeric suffix. Unit tests read the guide and check both directions: every command it documents without a query form is refused, and every query header it documents without parameters is still accepted.
- The read-and-clear queries (`INR?`, ...) are also refused with a source prefix or a numeric suffix.
- `scpi_query` rejects headers with an empty node (`C1::VDIV?`, `C1:VDIV:?`).

## 2.0.1

### Fixed

- `get_waveform` decoded negative samples one ADC code (`vdiv/25`) too high, and read `0xFF` as 0 instead of -1. The scope sends each sample as a signed byte; the code subtracted 255 from values above 127, as the programming guide says, instead of 256. The error was at most 4 % of a division per sample and shifted the mean of a signal centred on zero by about half a code. The end-to-end loopback check found it: the mean of the downloaded samples differed from the scope's own `MEAN` measurement by half a code at two different V/div settings. After the fix they agree within 1 mV.
- `get_waveform` failed with "Maximum call stack size exceeded" when asked for a few hundred thousand points or more (`max_points` allows up to 1,000,000): the voltage range was computed by spreading every point into `Math.min`/`Math.max`.

### Added

- `npm run e2e-loopback -- <generator-ip> <scope-ip>`: an end-to-end check against real hardware. A Siglent SDG generator's CH1 output is connected to the scope's CH1 with a coax cable. The check generates signals through siglent-sdg-mcp, measures them through this server, and compares the scope's measurements and the downloaded samples with what was generated. At the end, also after a failure or a first Ctrl-C, it switches the generator output off in a fresh session, reads it back and warns if it can't confirm it, and restores and verifies the settings it changed on both instruments. It refuses to start if a generator output is already on, or if C1 has modulation, sweep or burst on. The generator server is a pinned siglent-sdg-mcp release (`--sdg-version` or `--sdg-entry` to change it).

### Dependencies

- `@types/node` 22.19.9 → 22.20.5 (development only).

## 2.0.0

Security release. Tool arguments come from a language model and are now treated as untrusted input. See [docs/threat-model.md](docs/threat-model.md) for the full analysis.

### Breaking changes

- **`scpi_command` is no longer registered by default.** Set `SIGLENT_ALLOW_RAW_SCPI=true` to enable it. This also requires `SIGLENT_IP` or `SIGLENT_ALLOWED_HOSTS` naming specific hosts (`*` is not accepted); otherwise the server exits with a configuration error.
- **`scpi_query` only accepts queries:** a single SCPI header immediately followed by `?` (e.g. `C1:VDIV?`). Parameters after `?` only for `PAVA?`. Previously it would send any string, including commands that change state.
- **`connect` is restricted.** Allowed hosts are `SIGLENT_IP` plus `SIGLENT_ALLOWED_HOSTS`. If neither is set, only private-LAN IP addresses are accepted. Ports are limited to 5025 and the configured `SIGLENT_PORT`. The same applies to automatic reconnects.
- **Stricter parameter formats:** `vdiv`, `offset`, `trigger_level` must be voltages (e.g. `500mV`, `-1.5V`); `timebase` and `trigger_delay` must be times (e.g. `1US`, `-4.8US`). `probe` must be positive, `max_points` and `timeout_ms` integers within limits.
- **`get_acquisition_status`** reports the active trigger source's level and slope as `trigger_level` and `trigger_slope`, plus a new `trigger_source` field (previously always C1's, as `trigger_level_c1` and `trigger_slope_c1`).
- **Setting `trigger_source`** selects an edge trigger on that source (`TRSE EDGE,SR,<source>`), replacing other trigger types.
- Invalid values for numeric environment variables now stop the server at startup instead of being ignored.
- **Node.js 20.9 or later** is required (was 20), because of sharp 0.35. The Docker image runs on Node 26.

### Security fixes

- Command injection: newlines, other control characters and `;` are rejected in every command and query before it reaches the socket.
- `scpi_query` was annotated read-only but could change instrument state.
- `connect` could open TCP connections to arbitrary hosts and ports.
- After a timeout, a late reply could be read as the answer to the next query. The connection is now reset after any timeout, and when a command's `*OPC?` acknowledgement isn't `1`, before anything queued behind it is sent. Commands containing `?` (and `SCDP`) are rejected before they are written.

### Fixed

Contributed by [@TangoEcho](https://github.com/TangoEcho) in [#3](https://github.com/MagnusJohansson/siglent-sds-mcp/pull/3), tested on an SDS1202X-E:

- Commands sent back to back were silently dropped by the scope. Each command is now paced by `*OPC?`, as a separate write.
- Trigger level and slope always went to C1. They now go to the active trigger source.
- `measure_statistics` read always returned slot 1 instead of the requested measurement.
- `get_waveform`'s time axis ignored the trigger delay.
- Channels the model doesn't have (C3/C4 on a 2-channel scope) are rejected instead of returning placeholder values.
- The scope serves one client at a time: new `SIGLENT_IDLE_TIMEOUT` releases the connection when idle, reconnecting on the next call, and a clearer error when the scope is busy.

Also fixed:

- Overlapping connects (auto-connect still initializing when `connect` is called) could leave two sockets open.
- A short idle timeout could close the connection during the connect handshake.

### Dependencies

- `@modelcontextprotocol/sdk` 1.27 → 1.32.2, `zod` 3.25 → 4.6.7, `sharp` 0.34 → 0.35.5, `vitest` 3 → 4.1.12 (development). `@types/sharp` removed (sharp ships its own types). `npm audit`: 0 vulnerabilities (1.0.1's lock file had advisories in the MCP SDK, zod and the SDK's HTTP stack, which stdio mode doesn't load).

### Release process

- Publishing to npm and GHCR is triggered by publishing a GitHub Release, not by pushing a tag. One `Release` workflow runs verify, npm and docker jobs in order: nothing is published unless the release tag matches `package.json` and `SERVER_VERSION`, `repository.url` matches the repository, the pre-release flag matches the version, the tagged commit is on `master`, and the tests pass. npm publishes with provenance on Node 26 (pre-releases to the `next` dist-tag); the Docker image is pushed only after npm succeeds. Dependency install scripts are disabled in the release jobs and the Docker build.
- All GitHub Actions are pinned to commit SHAs and the Docker base image to a digest. Dependabot (with a 7-day cooldown), CodeQL and OpenSSF Scorecard workflows added.

### Added

- `SIGLENT_ALLOWED_HOSTS` and `SIGLENT_ALLOW_RAW_SCPI` environment variables.
- `destructiveHint` on `scpi_command`; `measure` is no longer marked read-only (it installs the measurement).
- SCPI simulator and end-to-end security tests (`npm test`), plus a CI workflow.
- Threat model: [`docs/threat-model.md`](docs/threat-model.md).
