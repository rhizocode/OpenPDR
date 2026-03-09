# OpenPDR

**Open-source, cross-platform telemetry viewer for the Cosworth Performance Data Recorder (PDR 2.5) in 2025–2026 GM vehicles**: Cadillac CT5-V Blackwing, Corvette Z06, Corvette Stingray, and others.

PDR records vehicle data directly into the MP4 file alongside the video. OpenPDR reads that data and plays it back as a synchronized HUD overlay.

> OpenPDR currently only supports the **AliveDrive PDR 2.5** format (`adrv`/`adco` codec), which is distinct from the older **Marlin** format (`ctbx`/`mrld`) used in C7/C8 Corvette PDR systems.

The format was reverse-engineered entirely through binary analysis of MP4 files recorded by the vehicles. Keep scrolling for [technical details](#how-the-parser-works), the full [protocol documentation](#protocol-documentation), or the [channel list](#telemetry-channels).

## Get Started

**This project is in beta.** It is mostly functional, but expect rough edges.

- **Web**: Use OpenPDR right now at **[openpdr.org](https://openpdr.org)**. No install or account required. The application runs in your browser and your data remains on your device. The website also has limited mobile support.

- **Desktop**:  Download an installer from the [latest release](https://github.com/rhizocode/OpenPDR/releases/latest) for Windows, macOS, or Linux.

## Build from Source

Both the Web and Desktop apps share the same renderer, parser, and UI. Only the file I/O layer differs.

| | Desktop | Web |
|---|---|---|
| File access | Native file dialogs | Browser file picker or drag-and-drop |
| Video playback | Electron (Chromium) | Browser `<video>` element |
| CSV/GPX export | Save dialog → file system | Browser download |
| Video export (with overlays) | Yes (ffmpeg) | Not available |

### Quick Start (Desktop)

```bash
npm install
npm run dev
```

### Quick Start (Web)

```bash
npm install
npm run dev:web
```

Opens at `http://localhost:5173`. Click **Open File** or drag-and-drop a `.mp4` PDR recording.

### Build

```bash
# Desktop (Electron)
npm run build          # outputs to out/main, out/preload, out/renderer
npm run start          # run the production build

# Web
npm run build:web      # outputs to dist-web/
npm run preview:web    # serve the production build locally

# Desktop installers
npm run dist           # build + package for current platform
npm run dist:win       # Windows .exe
npm run dist:mac       # macOS .dmg
npm run dist:linux     # Linux .AppImage
```

### Architecture

```
src/
  main/
    index.ts            Electron main process — window management, IPC, file dialogs
    export-csv.ts       CSV export (Node.js streaming)
    export-gpx.ts       GPX export (Node.js streaming)
    export-video.ts     Video export with baked overlays (ffmpeg)
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
  parser/
    index.ts            TypeScript MP4 parser (adco track → typed telemetry)
  shared/
    file-source.ts      Platform-agnostic file read interface
    telemetry-store.ts  Columnar telemetry storage
    types.ts            Shared type definitions
  web/
    pdr-web.ts          Browser PdrApi implementation (file picker, object URLs, blob exports)
    index.ts            Web entry point — installs window.pdr, loads renderer
    index.html          Web layout shell
```

The renderer code calls `window.pdr.*` for all platform interactions (file dialogs, parsing, exports). In Electron, this is backed by IPC to the main process. In the web build, it's backed by browser APIs (File API, `URL.createObjectURL`, Blob downloads). Zero renderer files differ between builds.

### Controls

| Input | Action |
|-------|--------|
| Click video | Play / pause |
| Space | Play / pause |
| Left / Right arrow | Seek −/+ 5 seconds |
| `,` / `.` (paused) | Frame step backward / forward |
| Scrub bar | Click or drag to seek |
| Rate dropdown | Change playback speed |
| E | Toggle overlay edit mode |

### Dependencies

| Package | Role |
|---------|------|
| electron | Desktop shell + Chromium video playback |
| electron-vite | Build tooling for Electron (main, preload, renderer) |
| vite | Build tooling for web version |
| typescript | Type-safe source |
| ffmpeg-static | Video export with baked overlays (desktop only) |

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

Both format variants are covered: legacy (3247-byte packets, gen 1 / MMP ≤ 3) and MMP v4+ (4050-byte packets, gen 2 MMP ≥ 4).

A standalone Python reference parser is available at [`protocol/alivedrive_parser.py`](protocol/alivedrive_parser.py).

---

## How the Parser Works

1. **Track discovery**:  locates the `adrv` handler / `adco` codec track in the MP4 container
2. **Sample table parsing**:  reads `stsz`, `stco`, `stsc` to find each telemetry sample's offset and size
3. **Deterministic offset computation**:  pre-computes all byte offsets from the known packet structure (preamble, carry-over, interleaved sub-frame groups)
4. **Frame decoding**:  reads each multi-rate sub-frame at the computed offsets
5. **Playback sync**:  binary search over decoded rows on each animation frame to drive the HUD overlay

---

## Contributing

Contributions welcome, especially:

- Testing with other GM PDR 2.5 vehicles (hybrids, EVs, trucks) to validate e-motor and HV battery channels
- Identifying the remaining numeric fields in the `advi` header (offsets 16–28)
- HUD overlay improvements and new channel visualisations

---

## License

MIT
