# Changelog

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
