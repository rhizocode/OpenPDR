# OpenPDR

**Open-source, cross-platform telemetry viewer for video files with embedded vehicle telemetry.** Currently supports GM's Cosworth Performance Data Recorder across multiple generations of hardware and firmware.

Many dashcams, action cameras, and data loggers embed telemetry (GPS, accelerometers, vehicle data) directly into video files. OpenPDR reads that data and plays it back as a synchronized HUD overlay.

We have reverse-engineered several telemetry formats through binary analysis of MP4 files from the vehicle. See the [protocol documentation](#protocol-documentation) for full details.

## Get Started

**This project is in beta.** It is mostly functional, but expect rough edges.

- **Web**: Use OpenPDR right now at **[openpdr.org](https://openpdr.org)**. No install or account required. The application runs in your browser and your data remains on your device. The website also has limited mobile support.

- **Desktop**:  Download an installer from the [latest release](https://github.com/rhizocode/OpenPDR/releases/latest) for Windows, macOS, or Linux.

## Features

- Synchronized telemetry overlays on video: RPM gauge, G-force ball, steering angle, track map, and more
- Lap comparison mode to analyze differences between two laps side-by-side
- Fully customizable overlays
- Real-time strip charts for each telemetry channel
- Track map shows real-time vechicle location and supports color shading based on speed, throttle, braking zones
- Export telemetry to CSV
- Export video with baked overlays (desktop only)
- Automatic lap detection from firmware events or GPS data
- Runs on desktop, web, and mobile
- Fully offline. Your data never leaves your device

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

OpenPDR extracts telemetry embedded in video files and decodes it into usable channels — GPS, accelerometers, wheel speeds, engine/drivetrain data, tire pressures and temperatures, and more at rates up to 100 Hz. Enum channels (gear, drive mode, traction control, etc.) are decoded with human-readable labels.

See [`protocol/`](protocol/) for the complete channel lists and encoding details for each supported format.

---

## Protocol Documentation

Format specifications and reference parsers live in [`protocol/`](protocol/). Formats documented so far:

| Format | Handler / Codec | Vehicles | Channels |
|--------|----------------|----------|----------|
| **AliveDrive PDR 2.5** | `adrv` / `adco` | 2025–2026 GM (CT5-V Blackwing, Corvette Z06/Stingray, etc.) | 59 channels, 6 rate groups (1–100 Hz) |
| **Marlin PDR 2.0** | `ctbx` / `marl` | C7/C8 Corvette, Camaro (original Cosworth PDR) | Up to 85 self-describing channels |

See the [`protocol/README.md`](protocol/README.md) for details and standalone reference parsers.

---

## Contributing

Contributions welcome, especially:

- Testing with other GM PDR 2.5 vehicles (hybrids, EVs, trucks) to validate e-motor and HV battery channels
- Identifying the remaining numeric fields in the `advi` header (offsets 16–28)
- HUD overlay improvements and new channel visualisations
- **Marlin sample files**: we need recordings from older vehicles running the original Marlin/Cougar PDR 2.0 firmware — different firmware versions are needed to answer the [open questions](protocol/MARLIN_FORMAT.md#9-open-questions) about diff encoding, version history, and gear mapping on 7+ speed transmissions
- **Other telemetry formats**: sample files from GoPro (GPMF), AIM, Garmin Catalyst, RaceLogic VBOX, and other race/dash telemetry systems would help expand format support

---

## License

MIT
