# Tools Reference

## Connection

### `connect`

Connect to a Siglent oscilloscope over TCP. Returns device identification on success.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `host` | string | No | `SIGLENT_IP` env var | IP address of the oscilloscope |
| `port` | number | No | `5025` | TCP port |

### `disconnect`

Disconnect from the oscilloscope. No parameters.

### `identify`

Query the oscilloscope identification (`*IDN?`). Returns manufacturer, model, serial number, and firmware version. No parameters.

---

## Channel

### `get_channel`

Query the full configuration of an analog channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to query |

Returns: volts/div, offset, coupling, bandwidth limit, trace on/off, probe attenuation, and unit.

### `configure_channel`

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

## Acquisition

### `configure_acquisition`

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

### `get_acquisition_status`

Query the current acquisition state. No parameters.

Returns: acquisition status, sample rate, timebase, trigger delay, trigger mode, trigger select, trigger level, and trigger slope.

---

## Measurement

### `measure`

Install a measurement on a channel and read the result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to measure |
| `parameter` | enum | Yes | Measurement type (see table below) |

### `measure_statistics`

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

## Waveform

### `get_waveform`

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

### `screenshot`

Capture the oscilloscope screen as a PNG image. Returns a base64-encoded image that Claude can display inline. No parameters.

---

## SCPI Escape Hatch

For commands not covered by the built-in tools, send arbitrary SCPI directly.

### `scpi_query`

Send a SCPI query and return the response.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | — | SCPI query (e.g. `*IDN?`, `C1:VDIV?`, `SARA?`) |
| `timeout_ms` | number | No | `2000` | Response timeout in milliseconds |

> Note: `CHDR` is set to `OFF` on connect, so responses contain only values (no command headers).

### `scpi_command`

Send a SCPI command with no response expected.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | SCPI command (e.g. `*RST`, `ARM`, `C1:VDIV 500mV`) |
