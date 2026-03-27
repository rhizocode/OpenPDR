# Protocol

Reverse-engineered specifications and reference parsers for telemetry formats embedded in MP4 video recordings.

## Formats

### AliveDrive PDR 2.5 (`adrv` / `adco`)

Cosworth Performance Data Recorder in 2025–2026 GM vehicles (Cadillac CT5-V Blackwing, Corvette Z06, Corvette Stingray, and others). 59 channels across 6 rate groups (1–100 Hz), fixed-rate multi-rate frame packing.

| File | Description |
|------|-------------|
| [`ALIVEDRIVE_FORMAT.md`](ALIVEDRIVE_FORMAT.md) | Complete format specification — MP4 container layout, all 59 channel definitions, rate table structure, packet/frame byte layouts, scale factors, and encoding details for both legacy and MMP v4+ variants |
| [`alivedrive_parser.py`](alivedrive_parser.py) | Reference Python parser — extracts all channels to CSV directly from an MP4 file or pre-extracted binary; no external dependencies |

```bash
# Extract telemetry to CSV from an MP4
python protocol/alivedrive_parser.py recording.mp4 --csv output.csv
```

### Marlin PDR 2.0 (`ctbx` / `marl`)

Original Cosworth Performance Data Recorder in C7/C8 Corvette and Camaro. Up to 85 self-describing channels with event-driven full/diff record encoding and per-channel sample intervals from 1–100 Hz.

| File | Description |
|------|-------------|
| [`MARLIN_FORMAT.md`](MARLIN_FORMAT.md) | Complete format specification — MP4 container layout, `mrlh`/`mrlv`/`mrld` box structures, 448-byte channel dictionary records, full/diff telemetry record encoding, two-stage unit conversion, and all known channel definitions |

See [`ALIVEDRIVE_FORMAT.md`](ALIVEDRIVE_FORMAT.md) §18 for AliveDrive parser usage and the TypeScript implementation in `src/parser/`.

### GoPro GPMF (`meta` / `gpmd`)

GoPro Metadata Format embedded in GoPro HERO5+ cameras. Contains GPS at ~9 Hz, accelerometer and gyroscope at ~198 Hz, plus camera metadata. The format uses nested KLV (Key-Length-Value) binary structures within an MP4 `gpmd`-coded metadata track.

| File | Description |
|------|-------------|
| [`GOPRO_GPMF_FORMAT.md`](GOPRO_GPMF_FORMAT.md) | Format overview — MP4 track detection, KLV structure, GPS5/ACCL/GYRO stream decoding, axis remapping, and resampling strategy |

TypeScript implementation: `src/parser/gopro/`
