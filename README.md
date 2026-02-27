# OpenPDR

OpenPDR is an open-source desktop viewer for **AliveDrive PDR 2.5** recordings — the Cosworth Performance Data Recorder found in 2025–2026 GM vehicles including the Cadillac CT5-V Blackwing, Corvette Z06, and Corvette Stingray.

The PDR records high-rate vehicle telemetry (GPS, accelerometer, engine, steering, wheel speeds, and more) into an MP4 file alongside the video. OpenPDR parses the binary telemetry and plays it back as a synchronized HUD overlay over the original video, without requiring Cosworth Toolbox or the AliveDrive app.

> **Format note:** This covers the **AliveDrive PDR 2.5** format (`adrv`/`adco` codec), which is distinct from the older **Marlin** format (`ctbx`/`mrld`) used in Corvette C7/C8 PDR systems.

> **Reverse engineering method:** The format was decoded entirely through binary analysis of MP4 files recorded directly by the vehicles. No proprietary software was decompiled, disassembled, or otherwise reverse-engineered. See [Protocol Documentation](#protocol-documentation) section for details.

---

## Viewer

Built with **Electron + TypeScript + Vite**.

### Quick Start

```bash
npm install
npm run dev
```

Click **Open File** and select a `.mp4` PDR recording. The viewer parses the telemetry directly from the MP4 — no pre-processing or sidecar files required.

### Build

```bash
npm run build    # outputs to out/main, out/preload, out/renderer
npm run start    # run the production build
```

### Architecture

```
src/
  main/
    index.ts            Electron main process — window management, IPC, file dialogs
    parser/             TypeScript MP4 parser (adco track → typed telemetry)
  preload/
    index.ts            Secure contextBridge — exposes window.pdr API
  renderer/
    index.html          Layout shell
    main.ts             Video playback, telemetry sync, HUD updates
    styles.css          Dark motorsport theme
    hud.ts              Master HUD overlay
    rpm-gauge.ts        RPM gauge
    gforce-ball.ts      G-force visualisation
    strip-chart.ts      Telemetry strip charts
    controls.ts         Playback controls and scrub bar
```

### Controls

| Input | Action |
|-------|--------|
| Click video | Play / pause |
| Space | Play / pause |
| Left / Right arrow | Seek −/+ 5 seconds |
| `,` / `.` (paused) | Frame step backward / forward |
| Scrub bar | Click or drag to seek |
| Rate dropdown | Change playback speed |

### Dependencies

| Package | Role |
|---------|------|
| electron | Desktop shell + Chromium video playback |
| electron-vite | Build tooling (Vite for main, preload, and renderer) |
| typescript | Type-safe source |

---

## Telemetry Channels

All 59 channels defined in the PDR 2.5 `adcp` descriptor have been identified with their authoritative Cosworth namespace names, scale factors, and offsets. All 9 enum channels (gear, drive mode, ABS, ESC, TCS, VSE, PTM, engine start/stop, e-motor axle) are fully decoded with human-readable labels.

| Rate | Channels |
|------|----------|
| 100 Hz | Brake position, engine RPM, torque (N·m), steering angle, 4× wheel speeds, gyro yaw rate |
| 50 Hz | Dual 3-axis accelerometer (raw device frame + gravity-compensated vehicle frame) |
| 10 Hz | GPS (lat/lon/alt/heading/satellites/fix), vehicle speed, ABS status, throttle position, boost pressure, e-motor power, engine power |
| 5 Hz | Gear, engine start/stop, ESC status, TCS status |
| 2 Hz | Oil pressure |
| 1 Hz | Engine temps (coolant, oil, air intake), transmission temp, outside air temp, fuel level, odometer, tire pressures (4×), tire temps (4×), drive mode, PTM mode, VSE status, HV battery/e-motor channels |

---

## Protocol Documentation

See [`protocol/ALIVEDRIVE_FORMAT.md`](protocol/ALIVEDRIVE_FORMAT.md) for the full reverse-engineered format specification, including:

- MP4 container layout and track identification (`adrv` handler, `adco` codec)
- Complete channel definitions with Cosworth namespace names (all 59 channels)
- `adcp` box structure (channel parameters: scale, offset, min/max, type)
- `adud` box structure (unit definitions)
- `advi` box structure (format version, hardware generation, MMP firmware version)
- `adeg` box structure (20 performance timing event definitions)
- Rate table structure (`adcr`) and multi-rate interleaving pattern
- Complete sub-frame byte layouts for all 6 rate groups (100/50/10/5/2/1 Hz)
- Encoding details: temperature (Kelvin offset model), torque, pressure, GPS coordinates

Both format variants are covered — legacy (3247-byte packets, gen 1 / MMP ≤ 3) and MMP v4+ (4050-byte packets, gen 2 MMP ≥ 4).

A standalone Python reference parser is available at [`protocol/alivedrive_parser.py`](protocol/alivedrive_parser.py).

---

## How the Parser Works

1. **Track discovery** — locates the `adrv` handler / `adco` codec track in the MP4 container
2. **Sample table parsing** — reads `stsz`, `stco`, `stsc` to find each telemetry sample's offset and size
3. **GPS anchor detection** — finds valid GPS coordinate patterns to establish frame boundaries
4. **Frame decoding** — walks the interleaved multi-rate structure relative to each GPS anchor
5. **Playback sync** — binary search over decoded rows on each animation frame to drive the HUD overlay

---

## Contributing

Contributions welcome, especially:

- Testing with other GM PDR 2.5 vehicles (hybrids, EVs, trucks) to validate e-motor and HV battery channels
- Identifying the remaining numeric fields in the `advi` header (offsets 16–28)
- Additional export formats (GPX, MoTeC i2, etc.)
- HUD overlay improvements and new channel visualisations

---

## License

MIT
