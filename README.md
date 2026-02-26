# alivedrive-decode

Open-source parser for the **AliveDrive PDR 2.5** telemetry format found in modern GM vehicles equipped with the Cosworth Performance Data Recorder (PDR 2.5), such as the 2025–2026 Cadillac CT5-V Blackwing.

The PDR records high-rate vehicle telemetry (GPS, accelerometer, engine, steering, wheel speeds, etc.) into an MP4 file alongside video. This data is normally only accessible through proprietary software (Cosworth Toolbox / AliveDrive app). 

In this project, we reverse-engineered the binary telemetry format and provide tools to extract the data to CSV.

> **Note:** This covers the **AliveDrive PDR 2.5** format (`adrv`/`adco` codec), which is distinct from the older **Marlin** format (`ctbx`/`mrld`) used in Corvette C7/C8 PDR systems.

## Decoded Channels

| Rate | Channels |
|------|----------|
| 100 Hz | Engine RPM, torque, steering angle, 4× wheel speeds, gyro yaw |
| 50 Hz | 3-axis accelerometer (lateral, longitudinal, vertical) |
| 10 Hz | GPS (lat/lon/alt/heading/satellites), vehicle speed, coolant temp, boost, tire pressure |
| 5 Hz | Brake, ESC status, TCS status |
| 2 Hz | Oil pressure |
| 1 Hz | Tire temps, VIN, odometer, battery voltage, ambient temp (partial decode) |

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
- Rate table structure and channel definitions
- Packet framing and multi-rate interleaving pattern
- Scale factors and unit conversions
- Sub-frame byte layouts for all rate groups

## How It Works

1. **Track discovery** — Locates the `adrv` handler / `adco` codec track in the MP4 container
2. **Sample table parsing** — Reads the MP4 sample table (`stsz`, `stco`, `stsc`) to find each telemetry sample's offset and size
3. **GPS anchor detection** — Finds valid GPS coordinate patterns in the data to establish frame boundaries (positions vary per packet due to a variable-length preamble)
4. **Frame decoding** — Walks the interleaved multi-rate structure (100/50/10/5/2/1 Hz) relative to each GPS anchor
5. **CSV export** — Writes all decoded channels with timestamps

## Known Limitations

- The **1 Hz frame** (31 bytes, 27 channels) is not fully mapped — tire temps, VIN, odometer, etc. are present but individual byte assignments are unconfirmed
- **Wheel speed scale factor** is close to but not confirmed identical to the engine speed scale
- **Engine torque** scale factor and unit (N·m vs lb·ft) are undetermined
- **Accelerometer data** shows a ~0.64 g lateral offset at rest that may need calibration
- Some packets at recording boundaries have non-standard sizes

See section 15 of [ALIVEDRIVE_FORMAT.md](ALIVEDRIVE_FORMAT.md) for the full list.

## Contributing

Contributions are welcome, especially for:

- Completing the 1 Hz frame mapping
- Confirming scale factors for torque and wheel speed
- Testing with other GM/PDR 2.5 vehicles
- Adding export formats (GPX, MoTeC, etc.)

## License

MIT
