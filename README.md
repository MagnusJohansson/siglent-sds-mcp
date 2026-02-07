# siglent-sds-mcp

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
    "siglent-sds": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/MagnusJohansson/siglent-sds-mcp:latest"
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
    "siglent-sds": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

### Option C: Clone and build

```bash
git clone https://github.com/MagnusJohansson/siglent-sds-mcp.git
cd siglent-sds-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/siglent-sds-mcp/build/index.js"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

Replace `/path/to/siglent-sds-mcp` with the actual path to your clone.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGLENT_IP` | No | — | Oscilloscope IP address for auto-connect on startup |
| `SIGLENT_PORT` | No | `5025` | TCP port (only change if your setup differs) |

### Auto-Connect Behavior

If `SIGLENT_IP` is set, the server attempts to connect to the scope immediately after starting. This runs in the background and does **not** block the MCP server — Claude can start using other tools right away. If the scope is offline or unreachable, the server logs a warning and you can connect manually later using the `connect` tool.

If `SIGLENT_IP` is not set, the server starts without a scope connection. Use the `connect` tool to connect when ready.

## Tools

12 tools across 6 categories. See [docs/tools-reference.md](docs/tools-reference.md) for full parameter details.

| Category | Tool | Description |
|----------|------|-------------|
| Connection | `connect` | Connect to oscilloscope over TCP |
| | `disconnect` | Close the connection |
| | `identify` | Query device ID (manufacturer, model, serial, firmware) |
| Channel | `get_channel` | Read channel configuration (vdiv, offset, coupling, etc.) |
| | `configure_channel` | Set vdiv, offset, coupling, bandwidth limit, trace, probe |
| Acquisition | `get_acquisition_status` | Read timebase, sample rate, trigger settings |
| | `configure_acquisition` | Set timebase, trigger, run/stop/single |
| Measurement | `measure` | Read a measurement (frequency, Vpp, RMS, etc.) |
| | `measure_statistics` | Enable/read/reset measurement statistics |
| Waveform | `get_waveform` | Download voltage/time data arrays |
| | `screenshot` | Capture scope screen as PNG |
| SCPI | `scpi_query` / `scpi_command` | Send arbitrary SCPI commands |

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
Claude Code <-- stdio/JSON-RPC --> siglent-sds-mcp <-- TCP/SCPI --> Oscilloscope:5025
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
docker build -t siglent-sds-mcp .
```

Then use the local image in your `.mcp.json`:

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "siglent-sds-mcp"
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
  "args": ["run", "--rm", "-i", "--network", "host", "-e", "SIGLENT_IP=192.168.1.126", "ghcr.io/MagnusJohansson/siglent-sds-mcp:latest"]
  ```
  Note: `--network host` does not work on macOS or Windows Docker Desktop.

### Docker: wrong architecture / exec format error

The published image supports `linux/amd64` and `linux/arm64`. Docker should pull the correct one automatically. If you see an exec format error, pull explicitly:

```bash
docker pull --platform linux/amd64 ghcr.io/MagnusJohansson/siglent-sds-mcp:latest
```

### "CHDR" appears in responses

This shouldn't happen — the server sets `CHDR OFF` on connect. If you see command headers in responses, try disconnecting and reconnecting.

## License

MIT — see [LICENSE](LICENSE) for details.
