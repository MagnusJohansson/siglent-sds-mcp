# siglent-sdx-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets AI assistants control Siglent oscilloscopes over your local network. Connect Claude to your bench and measure, capture, and configure your scope through natural language.

## Overview

This MCP server communicates with Siglent SDS oscilloscopes via SCPI commands over TCP sockets (port 5025). No VISA drivers or NI-MAX installation required — just a network connection to your scope.

**Key features:**

- 12 tools covering channels, timebase, triggers, measurements, waveform capture, and screenshots
- Auto-connect on startup via environment variable
- Query queue serializes commands automatically — tools can safely run in parallel
- Waveform data returned as voltage/time arrays ready for analysis
- Screenshots captured and converted to PNG for inline display in Claude
- Raw SCPI escape hatch for any command not covered by the built-in tools

## Compatibility

| Status | Model |
|--------|-------|
| Tested | SDS1104X-E |
| Expected to work | SDS1000X-E series (SDS1202X-E, SDS1204X-E, etc.) |
| May work | Other Siglent SDS models with SCPI over TCP support |

The server uses standard SCPI commands from the [SDS1000X-E Programming Guide](https://siglentna.com/wp-content/uploads/dlm_uploads/2017/10/ProgrammingGuide_forSDS-1702.pdf). Other Siglent models that support the same command set over port 5025 should work with little or no modification.

## Quick Start

You need a Siglent oscilloscope accessible on your network (TCP port 5025). Pick one of the three options below and add the config to your `.mcp.json` (in your project directory, or `~/.claude/.mcp.json` for global access).

Replace `192.168.1.126` with your scope's IP address.

### Option A: Docker (recommended)

No Node.js installation required. Works on Linux, macOS, and Windows (via WSL2 or Docker Desktop).

```json
{
  "mcpServers": {
    "siglent-sdx": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/OWNER/siglent-sdx-mcp:latest"
      ]
    }
  }
}
```

### Option B: npx

Requires Node.js 20+. Downloads and runs the package automatically.

```json
{
  "mcpServers": {
    "siglent-sdx": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "siglent-sdx-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

### Option C: Clone and build

```bash
git clone https://github.com/OWNER/siglent-sdx-mcp.git
cd siglent-sdx-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "siglent-sdx": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/siglent-sdx-mcp/build/index.js"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

Replace `/path/to/siglent-sdx-mcp` with the actual path to your clone.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGLENT_IP` | No | — | Oscilloscope IP address for auto-connect on startup |
| `SIGLENT_PORT` | No | `5025` | TCP port (only change if your setup differs) |

### Auto-Connect Behavior

If `SIGLENT_IP` is set, the server attempts to connect to the scope immediately after starting. This runs in the background and does **not** block the MCP server — Claude can start using other tools right away. If the scope is offline or unreachable, the server logs a warning and you can connect manually later using the `connect` tool.

If `SIGLENT_IP` is not set, the server starts without a scope connection. Use the `connect` tool to connect when ready.

## Tools Reference

### Connection

#### `connect`

Connect to a Siglent oscilloscope over TCP. Returns device identification on success.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `host` | string | No | `SIGLENT_IP` env var | IP address of the oscilloscope |
| `port` | number | No | `5025` | TCP port |

#### `disconnect`

Disconnect from the oscilloscope. No parameters.

#### `identify`

Query the oscilloscope identification (`*IDN?`). Returns manufacturer, model, serial number, and firmware version. No parameters.

---

### Channel

#### `get_channel`

Query the full configuration of an analog channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to query |

Returns: volts/div, offset, coupling, bandwidth limit, trace on/off, probe attenuation, and unit.

#### `configure_channel`

Configure an analog channel. Only specified parameters are changed — omitted parameters are left untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to configure |
| `vdiv` | string | No | Volts per division with unit (e.g. `500mV`, `1V`, `2V`). Range: 500uV–10V |
| `offset` | string | No | Vertical offset with unit (e.g. `0V`, `-500mV`, `1.5V`) |
| `coupling` | enum | No | Coupling mode (see table below) |
| `bandwidth_limit` | boolean | No | Enable (`true`) or disable (`false`) 20 MHz bandwidth limit |
| `trace` | boolean | No | Turn channel display on (`true`) or off (`false`) |
| `probe` | number | No | Probe attenuation factor (1, 10, 100, 1000) |

**Coupling modes:**

| Value | Description |
|-------|-------------|
| `A1M` | AC, 1 MOhm |
| `A50` | AC, 50 Ohm |
| `D1M` | DC, 1 MOhm |
| `D50` | DC, 50 Ohm |
| `GND` | Ground |

---

### Acquisition

#### `configure_acquisition`

Control the acquisition state and configure timebase/trigger settings. All parameters are optional — combine as needed in a single call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | enum | No | `run` (ARM), `stop`, `single`, `auto` |
| `timebase` | string | No | Time per division with unit (e.g. `1US`, `500NS`, `10MS`). Range: 1NS–100S |
| `trigger_mode` | enum | No | `AUTO`, `NORM`, `SINGLE`, `STOP` |
| `trigger_source` | enum | No | `C1`, `C2`, `C3`, `C4`, `EX`, `EX5` |
| `trigger_level` | string | No | Trigger level voltage (e.g. `1.5V`, `500mV`) |
| `trigger_slope` | enum | No | `POS` (rising), `NEG` (falling), `WINDOW` |
| `trigger_delay` | string | No | Horizontal position (e.g. `0S`, `-4.8US`) |

#### `get_acquisition_status`

Query the current acquisition state. No parameters.

Returns: acquisition status, sample rate, timebase, trigger delay, trigger mode, trigger select, trigger level, and trigger slope.

---

### Measurement

#### `measure`

Install a measurement on a channel and read the result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to measure |
| `parameter` | enum | Yes | Measurement type (see table below) |

#### `measure_statistics`

Control measurement statistics — enable, disable, reset, or read statistical values (current, mean, min, max, std-dev, count).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to measure |
| `parameter` | enum | Yes | Measurement type |
| `action` | enum | Yes | `on`, `off`, `reset`, `read` |

**Measurement types:**

| Value | Description |
|-------|-------------|
| `PKPK` | Peak-to-peak voltage |
| `MAX` | Maximum voltage |
| `MIN` | Minimum voltage |
| `AMPL` | Amplitude |
| `TOP` | Top voltage |
| `BASE` | Base voltage |
| `MEAN` | Mean voltage |
| `CMEAN` | Cycle mean |
| `RMS` | RMS voltage |
| `CRMS` | Cycle RMS |
| `OVSN` | Negative overshoot |
| `OVSP` | Positive overshoot |
| `FPRE` | Fall preshoot |
| `RPRE` | Rise preshoot |
| `FREQ` | Frequency |
| `PER` | Period |
| `PWID` | Positive pulse width |
| `NWID` | Negative pulse width |
| `RISE` | Rise time |
| `FALL` | Fall time |
| `WID` | Width |
| `DUTY` | Positive duty cycle |
| `NDUTY` | Negative duty cycle |
| `ALL` | All measurements |

---

### Waveform

#### `get_waveform`

Download waveform data from a channel. Returns reconstructed voltage and time arrays.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | — | Channel to download from |
| `max_points` | number | No | `1000` | Maximum data points to return. Higher values give more detail but use more context. |

Returns a JSON object with:
- `total_points` / `returned_points` — raw count vs. downsampled count
- `sample_rate`, `timebase`, `volts_per_div`, `offset` — acquisition parameters
- `time_range` — start/end times
- `voltage_range` — min/max voltages
- `data` — array of `{time, voltage}` objects

#### `screenshot`

Capture the oscilloscope screen as a PNG image. Returns a base64-encoded image that Claude can display inline. No parameters.

---

### SCPI Escape Hatch

For commands not covered by the built-in tools, send arbitrary SCPI directly.

#### `scpi_query`

Send a SCPI query and return the response.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | — | SCPI query (e.g. `*IDN?`, `C1:VDIV?`, `SARA?`) |
| `timeout_ms` | number | No | `2000` | Response timeout in milliseconds |

> Note: `CHDR` is set to `OFF` on connect, so responses contain only values (no command headers).

#### `scpi_command`

Send a SCPI command with no response expected.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | SCPI command (e.g. `*RST`, `ARM`, `C1:VDIV 500mV`) |

## Example Conversations

### Read a channel configuration

> **You:** What's the current setup on channel 1?
>
> Claude calls `get_channel` with `channel: "C1"` and returns the volts/div, offset, coupling, and other settings.

### Measure a signal

> **You:** Measure the frequency and peak-to-peak voltage on channel 2.
>
> Claude calls `measure` twice — once with `parameter: "FREQ"` and once with `parameter: "PKPK"` on channel C2 — and reports both values.

### Capture and analyze a waveform

> **You:** Download the waveform from channel 1 and tell me what you see.
>
> Claude calls `get_waveform` on C1, receives voltage/time data, and analyzes the signal shape, frequency, amplitude, and any anomalies.

### Take a screenshot

> **You:** Show me what the scope screen looks like right now.
>
> Claude calls `screenshot`, receives a base64 BMP image, and displays it inline.

### Configure the scope for a specific measurement

> **You:** Set up channel 1 for a 3.3V logic signal — DC coupling, 1V/div, trigger on the rising edge at 1.6V.
>
> Claude calls `configure_channel` (setting vdiv, coupling) and `configure_acquisition` (setting trigger source, level, slope) in sequence.

## Architecture

```
Claude Code <-- stdio/JSON-RPC --> siglent-sdx-mcp <-- TCP/SCPI --> Oscilloscope:5025
```

- **Transport:** MCP over stdio (JSON-RPC 2.0)
- **Protocol:** SCPI commands over raw TCP sockets, newline-terminated
- **Query Queue:** All SCPI queries are serialized through an internal queue. The oscilloscope processes one command at a time, so even when tools issue parallel requests (via `Promise.all`), the queue ensures they're sent sequentially.
- **Binary Block Parsing:** Waveform and screenshot data use IEEE 488.2 definite-length block format (`#9XXXXXXXXX` + data bytes + `\n\n`). The connection layer detects and parses these automatically.
- **Voltage Reconstruction:** Raw ADC codes are converted to voltages: `code * (vdiv / 25) - offset`, with two's complement handling for signed values.

## Development

```bash
npm run build       # Compile TypeScript
npm run watch       # Watch mode — recompile on changes
npm run dev         # Build and run
npm run inspector   # Launch with MCP Inspector for debugging
```

### Docker (local build)

Build the image locally:

```bash
docker build -t siglent-sdx-mcp .
```

Then use the local image in your `.mcp.json`:

```json
{
  "mcpServers": {
    "siglent-sdx": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "siglent-sdx-mcp"
      ]
    }
  }
}
```

### Project Structure

```
src/
  index.ts              # Entry point, MCP server setup
  connection.ts         # TCP socket manager with query queue
  tools/
    connection.ts       # connect, disconnect, identify
    channel.ts          # get_channel, configure_channel
    acquisition.ts      # configure_acquisition, get_acquisition_status
    measure.ts          # measure, measure_statistics
    waveform.ts         # get_waveform, screenshot
    scpi.ts             # scpi_query, scpi_command
```

## Troubleshooting

### "Not connected to oscilloscope"

The scope isn't connected yet. Either set `SIGLENT_IP` in your `.mcp.json` env for auto-connect, or use the `connect` tool manually.

### Connection timeout

- Verify the scope's IP address (check the scope's Utility > Interface menu)
- Ensure port 5025 is accessible (try `telnet <scope-ip> 5025` from your machine)
- Check that no firewall is blocking the connection
- The scope only accepts one TCP connection at a time — close any other SCPI clients

### Query timeout

Some SCPI queries can take a few seconds, especially on slower scope models. The default timeout is 5 seconds. For `scpi_query`, you can increase the timeout with the `timeout_ms` parameter.

### Docker: can't reach the oscilloscope

By default, Docker containers can reach LAN devices via the bridge network (NAT). If the container can't connect to your scope:

- Verify the scope is reachable from your host: `telnet 192.168.1.126 5025`
- On Linux, try adding `--network host` to the Docker args:
  ```json
  "args": ["run", "--rm", "-i", "--network", "host", "-e", "SIGLENT_IP=192.168.1.126", "ghcr.io/OWNER/siglent-sdx-mcp:latest"]
  ```
  Note: `--network host` does not work on macOS or Windows Docker Desktop.

### Docker: wrong architecture / exec format error

The published image supports `linux/amd64` and `linux/arm64`. Docker should pull the correct one automatically. If you see an exec format error, pull explicitly:

```bash
docker pull --platform linux/amd64 ghcr.io/OWNER/siglent-sdx-mcp:latest
```

### "CHDR" appears in responses

This shouldn't happen — the server sets `CHDR OFF` on connect. If you see command headers in responses, try disconnecting and reconnecting.

## License

MIT — see [LICENSE](LICENSE) for details.
