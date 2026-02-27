# Protocol

Reverse-engineered specification and reference parser for the **AliveDrive PDR 2.5** telemetry format embedded in MP4 recordings from the Cosworth Performance Data Recorder found in 2025–2026 GM vehicles (Cadillac CT5-V Blackwing, Corvette Z06, Corvette Stingray, and others).

## Contents

| File | Description |
|------|-------------|
| [`ALIVEDRIVE_FORMAT.md`](ALIVEDRIVE_FORMAT.md) | Complete format specification — MP4 container layout, all 59 channel definitions, rate table structure, packet/frame byte layouts, scale factors, and encoding details for both legacy and MMP v4+ variants |
| [`alivedrive_parser.py`](alivedrive_parser.py) | Reference Python parser — extracts all channels to CSV directly from an MP4 file or pre-extracted binary; no external dependencies |

## Quick Reference

```bash
# Extract telemetry to CSV from an MP4
python protocol/alivedrive_parser.py recording.mp4 --csv output.csv
```

See [`ALIVEDRIVE_FORMAT.md`](ALIVEDRIVE_FORMAT.md) §18 for full usage and the TypeScript implementation in `src/main/parser/`.
