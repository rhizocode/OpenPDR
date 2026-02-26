# alivedrive-decode

Open-source parser for the **AliveDrive PDR 2.5** telemetry format found in modern GM vehicles equipped with the Cosworth Performance Data Recorder (PDR 2.5), such as the 2025–2026 Cadillac CT5-V Blackwing.

The PDR records high-rate vehicle telemetry (GPS, accelerometer, engine, steering, wheel speeds, etc.) into an MP4 file alongside video. This data is normally only accessible through proprietary software (Cosworth Toolbox / AliveDrive app).

In this project, we reverse-engineered the binary telemetry format and provide tools to extract the data to CSV.

> **Note:** This covers the **AliveDrive PDR 2.5** format (`adrv`/`adco` codec), which is distinct from the older **Marlin** format (`ctbx`/`mrld`) used in Corvette C7/C8 PDR systems.

## Decoded Channels

All 59 channels defined in the `adcp` box have been identified with their
authoritative Cosworth namespace names, scale factors, and offsets. Every rate
group's byte layout is fully mapped.

| Rate | Channels |
|------|----------|
| 100 Hz | Brake position, engine RPM, torque (N·m), steering angle, 4× wheel speeds, gyro yaw rate |
| 50 Hz | Dual 3-axis accelerometer (raw device frame + gravity-compensated vehicle frame) |
| 10 Hz | GPS (lat/lon/alt/heading/satellites/fix), vehicle speed, ABS status, throttle position, boost pressure, e-motor power, engine power |
| 5 Hz | Gear, engine start/stop, ESC status, TCS status |
| 2 Hz | Oil pressure |
| 1 Hz | Engine temps (coolant, oil, air intake), transmission temp, outside air temp, fuel level, odometer, tire pressures (4×), tire temps (4×), drive mode, PTM mode, VSE status, HV battery/e-motor channels |

## Quick Start

### Requirements

- Python 3.7+
- No external dependencies (stdlib only)

### From an MP4 file

```bash
python alivedrive_parser.py ADV_0600.mp4 --csv output.csv
```

### From a pre-extracted binary

If you've already extracted the data track with ffmpeg:

```bash
ffmpeg -v quiet -i input.mp4 -map 0:1 -c copy -f data telemetry_raw.bin
python alivedrive_parser.py telemetry_raw.bin --raw --csv output.csv
```

### Options

```
positional arguments:
  input                 Input MP4 file or raw telemetry file (.bin)

options:
  --csv, -o PATH        Output CSV file path (default: input with .csv extension)
  --raw                 Input is a raw telemetry binary (from ffmpeg extraction)
  --lat FLOAT           Reference latitude for GPS search
  --lon FLOAT           Reference longitude for GPS search
  --verbose, -v         Verbose output
```

## Format Documentation

See [ALIVEDRIVE_FORMAT.md](ALIVEDRIVE_FORMAT.md) for the full reverse-engineered format specification, including:

- MP4 container layout and track identification
- Complete channel definitions with Cosworth namespace names (all 59 channels)
- `adcp` box structure (channel parameters: scale, offset, min/max, type)
- `adud` box structure (unit definitions: angle, velocity, temperature, etc.)
- Rate table structure (`adcr`) and rate-table width overhead analysis
- Packet framing and multi-rate interleaving pattern
- Scale factors and unit conversions for all channel types
- Complete sub-frame byte layouts for all 6 rate groups (100/50/10/5/2/1 Hz)
- Temperature encoding (Kelvin offset model), torque formula, pressure/proportion scales

## How It Works

1. **Track discovery** — Locates the `adrv` handler / `adco` codec track in the MP4 container
2. **Sample table parsing** — Reads the MP4 sample table (`stsz`, `stco`, `stsc`) to find each telemetry sample's offset and size
3. **GPS anchor detection** — Finds valid GPS coordinate patterns in the data to establish frame boundaries (positions vary per packet due to a variable-length preamble)
4. **Frame decoding** — Walks the interleaved multi-rate structure (100/50/10/5/2/1 Hz) relative to each GPS anchor
5. **CSV export** — Writes all decoded channels with timestamps

## Known Limitations

- **Enum channels** (gear, drive mode, ABS, ESC, TCS, VSE, PTM) have label strings in `adcp` but the full value-to-label mapping is not yet decoded
- The **`advi` and `adeg`** sub-box structures are not yet documented

## Contributing

Contributions are welcome, especially for:

- Decoding enum value mappings from `adcp` descriptors (gear, drive mode, etc.)
- Testing with other GM/PDR 2.5 vehicles (especially hybrids to validate e-motor/HV battery channels)
- Adding export formats (GPX, MoTeC, etc.)

## License

MIT
