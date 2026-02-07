# Manual Testing Guide

Step-by-step verification of all 12 MCP tools against a real Siglent oscilloscope.

## Prerequisites

- Oscilloscope powered on and connected to your network
- Scope IP address known (check Utility > Interface on the scope)
- MCP server built: `npm run build`
- A signal connected to at least one channel (e.g., probe the cal output for a 1 kHz square wave)

## How to Run the Tests

### MCP Inspector (recommended)

The MCP Inspector is a web UI purpose-built for testing MCP tools interactively. Launch it with:

```bash
npm run inspector
```

This opens a browser where you can select each tool from a list, fill in parameters, and see the raw JSON response. Work through the tests below one by one.

### Claude Code

If you have the server configured in your `.mcp.json`, you can ask Claude to call the tools directly in conversation. For example:

- "Call the `connect` tool with host 192.168.1.126"
- "Call `get_channel` on C1"
- "Take a screenshot"

Claude will execute the tool against your real scope and show you the results.

## 1. Connection Tools

### 1.1 connect

**Action:** Call `connect` with your scope's IP address.

```
Tool: connect
Parameters: { "host": "192.168.1.126" }
```

**Expected:** Text response confirming connection and showing the `*IDN?` string (manufacturer, model, serial, firmware).

- [ ] Pass

### 1.2 identify

**Action:** Call `identify` (no parameters).

```
Tool: identify
```

**Expected:** JSON object with `manufacturer`, `model`, `serial`, and `firmware` fields. Example:

```json
{
  "manufacturer": "Siglent Technologies",
  "model": "SDS1104X-E",
  "serial": "...",
  "firmware": "..."
}
```

- [ ] Pass

### 1.3 disconnect and reconnect

**Action:** Call `disconnect`, then `connect` again.

```
Tool: disconnect
```

```
Tool: connect
Parameters: { "host": "192.168.1.126" }
```

**Expected:** Disconnect confirms closure. Second connect succeeds with IDN string. Verify the server recovers cleanly from a disconnect/reconnect cycle.

- [ ] Pass

---

## 2. Channel Tools

### 2.1 get_channel

**Action:** Query each active channel.

```
Tool: get_channel
Parameters: { "channel": "C1" }
```

**Expected:** JSON object with `channel`, `volts_per_div`, `offset`, `coupling`, `bandwidth_limit`, `trace`, `probe_attenuation`, and `unit`. Verify the values match what the scope's front panel shows.

- [ ] Pass — values match scope display

### 2.2 configure_channel — change volts/div

**Action:** Change C1 to 1V/div.

```
Tool: configure_channel
Parameters: { "channel": "C1", "vdiv": "1V" }
```

**Expected:** Text listing the command sent (`C1:VDIV 1V`). Verify the scope display updates to 1V/div on C1.

- [ ] Pass — scope shows 1V/div

### 2.3 configure_channel — multiple parameters

**Action:** Set C1 to 500mV/div, DC 1MOhm coupling, offset 0V.

```
Tool: configure_channel
Parameters: { "channel": "C1", "vdiv": "500mV", "coupling": "D1M", "offset": "0V" }
```

**Expected:** Text listing all commands sent. Scope shows 500mV/div, DC coupling, 0V offset on C1.

- [ ] Pass

### 2.4 configure_channel — trace on/off

**Action:** Turn C1 off, then back on.

```
Tool: configure_channel
Parameters: { "channel": "C1", "trace": false }
```

```
Tool: configure_channel
Parameters: { "channel": "C1", "trace": true }
```

**Expected:** C1 trace disappears from scope display, then reappears.

- [ ] Pass

### 2.5 configure_channel — bandwidth limit

**Action:** Enable, then disable bandwidth limit on C1.

```
Tool: configure_channel
Parameters: { "channel": "C1", "bandwidth_limit": true }
```

**Expected:** Scope shows "B" or bandwidth limit indicator on C1. Disable with `false` and verify it clears.

- [ ] Pass

---

## 3. Acquisition Tools

### 3.1 get_acquisition_status

**Action:** Query acquisition status.

```
Tool: get_acquisition_status
```

**Expected:** JSON object with `acquisition_status`, `sample_rate`, `timebase`, `trigger_delay`, `trigger_mode`, `trigger_select`, `trigger_level_c1`, and `trigger_slope_c1`. Verify timebase and trigger mode match scope display.

- [ ] Pass

### 3.2 configure_acquisition — timebase

**Action:** Set timebase to 1ms/div.

```
Tool: configure_acquisition
Parameters: { "timebase": "1MS" }
```

**Expected:** Scope timebase changes to 1ms/div. Note: use SCPI time units — `NS`, `US`, `MS`, `S`.

- [ ] Pass

### 3.3 configure_acquisition — trigger settings

**Action:** Configure trigger: C1, rising edge, 1.5V level.

```
Tool: configure_acquisition
Parameters: {
  "trigger_source": "C1",
  "trigger_slope": "POS",
  "trigger_level": "1.5V"
}
```

**Expected:** Scope trigger indicator shows C1, rising edge, level at 1.5V.

- [ ] Pass

### 3.4 configure_acquisition — run/stop

**Action:** Stop acquisition, then restart it.

```
Tool: configure_acquisition
Parameters: { "command": "stop" }
```

```
Tool: configure_acquisition
Parameters: { "command": "run" }
```

**Expected:** Scope stops updating (shows "Stop" indicator), then resumes (shows "Trig'd" or "Auto").

- [ ] Pass

### 3.5 configure_acquisition — single trigger

**Action:** Set single trigger mode.

```
Tool: configure_acquisition
Parameters: { "command": "single" }
```

**Expected:** Scope shows "Ready" and waits for one trigger event. Once triggered, it stops.

- [ ] Pass

---

## 4. Measurement Tools

### 4.1 measure — frequency

**Action:** Measure frequency on the channel with a signal.

```
Tool: measure
Parameters: { "channel": "C1", "parameter": "FREQ" }
```

**Expected:** Text with frequency value (e.g., ~1 kHz if using cal output). Should match the scope's built-in measurement.

- [ ] Pass

### 4.2 measure — peak-to-peak voltage

**Action:** Measure Vpp.

```
Tool: measure
Parameters: { "channel": "C1", "parameter": "PKPK" }
```

**Expected:** Text with peak-to-peak voltage (e.g., ~3.3V for cal output).

- [ ] Pass

### 4.3 measure — ALL measurements

**Action:** Request all measurements at once.

```
Tool: measure
Parameters: { "channel": "C1", "parameter": "ALL" }
```

**Expected:** Text with all measurement values for C1. Some may show as unavailable if the signal doesn't support them.

- [ ] Pass

### 4.4 measure_statistics — enable and read

**Action:** Enable statistics for frequency, wait a few seconds, then read.

```
Tool: measure_statistics
Parameters: { "channel": "C1", "parameter": "FREQ", "action": "on" }
```

Wait 3-5 seconds for statistics to accumulate.

```
Tool: measure_statistics
Parameters: { "channel": "C1", "parameter": "FREQ", "action": "read" }
```

**Expected:** Statistics including current value, mean, min, max, std-dev, and count. Count should be > 1.

- [ ] Pass

### 4.5 measure_statistics — reset and disable

**Action:** Reset statistics, then disable.

```
Tool: measure_statistics
Parameters: { "channel": "C1", "parameter": "FREQ", "action": "reset" }
```

```
Tool: measure_statistics
Parameters: { "channel": "C1", "parameter": "FREQ", "action": "off" }
```

**Expected:** Reset clears accumulated data. Off disables the statistics display.

- [ ] Pass

---

## 5. Waveform Tools

### 5.1 get_waveform — default points

**Action:** Download waveform from C1 with default settings.

```
Tool: get_waveform
Parameters: { "channel": "C1" }
```

**Expected:** JSON object with:
- `total_points` — full memory depth (may be large)
- `returned_points` — up to 1000 (default max_points)
- `sample_rate`, `timebase`, `volts_per_div`, `offset` — match scope settings
- `time_range` and `voltage_range` — reasonable values
- `data` — array of `{time, voltage}` objects

Verify the voltage values are consistent with the signal (e.g., square wave between 0V and ~3.3V).

- [ ] Pass

### 5.2 get_waveform — custom max_points

**Action:** Download with fewer points.

```
Tool: get_waveform
Parameters: { "channel": "C1", "max_points": 100 }
```

**Expected:** `returned_points` is at most 100. Data array has at most 100 entries.

- [ ] Pass

### 5.3 screenshot

**Action:** Capture the scope screen.

```
Tool: screenshot
```

**Expected:** A PNG image is returned and displayed inline. The image should match what the scope screen shows (800x480, correct colors, all UI elements visible).

- [ ] Pass

---

## 6. SCPI Escape Hatch

### 6.1 scpi_query

**Action:** Send a raw SCPI query.

```
Tool: scpi_query
Parameters: { "command": "*IDN?" }
```

**Expected:** Raw IDN response string. No command headers (CHDR is OFF).

- [ ] Pass

### 6.2 scpi_query — with custom timeout

**Action:** Query with explicit timeout.

```
Tool: scpi_query
Parameters: { "command": "TDIV?", "timeout_ms": 3000 }
```

**Expected:** Returns the current timebase value (e.g., `1.00E-03` for 1ms/div).

- [ ] Pass

### 6.3 scpi_command

**Action:** Send a command with no response.

```
Tool: scpi_command
Parameters: { "command": "ARM" }
```

**Expected:** Text confirming `Command sent: ARM`. Scope starts acquisition if it was stopped.

- [ ] Pass

### 6.4 scpi_command — change a setting

**Action:** Change timebase via raw SCPI.

```
Tool: scpi_command
Parameters: { "command": "TDIV 500US" }
```

**Expected:** Text confirming command sent. Scope timebase changes to 500us/div.

- [ ] Pass

---

## 7. Error Handling

### 7.1 Query while disconnected

**Action:** Disconnect, then try to use a tool.

```
Tool: disconnect
```

```
Tool: get_channel
Parameters: { "channel": "C1" }
```

**Expected:** Clear error message indicating the scope is not connected.

- [ ] Pass

### 7.2 Connect with wrong IP

**Action:** Try connecting to an unreachable address.

```
Tool: connect
Parameters: { "host": "192.168.1.254" }
```

**Expected:** Connection timeout or error after a few seconds. Server should not crash.

- [ ] Pass

### 7.3 Reconnect after error

**Action:** After the failed connect above, connect to the correct IP.

```
Tool: connect
Parameters: { "host": "192.168.1.126" }
```

**Expected:** Connects successfully. All tools work normally again.

- [ ] Pass

---

## Summary

| # | Tool | Tests | Status |
|---|------|-------|--------|
| 1 | connect | 1.1, 1.3 | |
| 2 | disconnect | 1.3 | |
| 3 | identify | 1.2 | |
| 4 | get_channel | 2.1 | |
| 5 | configure_channel | 2.2–2.5 | |
| 6 | configure_acquisition | 3.2–3.5 | |
| 7 | get_acquisition_status | 3.1 | |
| 8 | measure | 4.1–4.3 | |
| 9 | measure_statistics | 4.4–4.5 | |
| 10 | get_waveform | 5.1–5.2 | |
| 11 | screenshot | 5.3 | |
| 12 | scpi_query | 6.1–6.2 | |
| 13 | scpi_command | 6.3–6.4 | |
