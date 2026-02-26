# OpenPDR Viewer

Desktop application for playing back PDR MP4 recordings with synchronized telemetry overlays. Built with Electron, TypeScript, and Vite.

## Running

```bash
cd viewer
npm install
npm run dev        # launches with hot-reload (renderer at localhost:5173)
```

Then click **Open File** and select a `.mp4` PDR recording. The app looks for a `_telemetry.json` sidecar file next to the video (e.g. `ADV_0600_telemetry.json` alongside `ADV_0600.mp4`).

### Generating the telemetry sidecar

Use the conversion script in `dev/` to convert parser CSV output to the JSON format the viewer expects:

```bash
python dev/csv_to_telemetry_json.py ADV_0600.csv
# writes ADV_0600_telemetry.json (same directory as the CSV)
```

### Building

```bash
npm run build      # outputs to out/main, out/preload, out/renderer
npm run start      # runs the production build
```

## Architecture

```
viewer/
  src/
    main/index.ts       Electron main process
    preload/index.ts     Secure bridge (contextIsolation: true)
    renderer/
      index.html         Layout shell
      main.ts            Video player, telemetry sync, HUD updates
      styles.css         Dark motorsport theme
  electron-vite.config.ts
  package.json
```

**Main process** (`src/main/index.ts`)
- Window management (1280x800, dark background)
- Native file-open dialog filtered to `.mp4`
- IPC handler to read `_telemetry.json` sidecar files from disk

**Preload** (`src/preload/index.ts`)
- Exposes `window.pdr` API to the renderer via `contextBridge`
- `openFileDialog()` — triggers the native file picker
- `loadTelemetry(path)` — reads and parses the JSON sidecar
- `getVideoUrl(path)` — converts a local file path to a `file:///` URL

**Renderer** (`src/renderer/main.ts`)
- `<video>` element plays the MP4 via `file://` URLs (`webSecurity: false` for the PoC)
- `requestAnimationFrame` loop reads `video.currentTime` on every frame
- Binary search (O(log n)) over the telemetry array to find the closest row
- HUD overlay updates: speed (mph), RPM, gear, g-force ball, throttle/brake bars
- Custom scrub bar with click-to-seek and drag scrubbing
- Click-on-video toggles play/pause
- Keyboard shortcuts: Space (play/pause), Left/Right arrows (seek +/-5s), comma/period (frame step when paused)
- Playback rate selector (0.25x, 0.5x, 1x, 2x)

## Telemetry sync

The JSON sidecar is an array of objects with a `time` field (seconds from recording start, 10 Hz). On each animation frame the renderer binary-searches for the row closest to `video.currentTime` and pushes values to the HUD elements. Sparse channels (gear at 5 Hz, oil pressure at 2 Hz) hold their last known value to avoid flickering.

## Controls

| Input | Action |
|-------|--------|
| Click video | Play / pause |
| Space | Play / pause |
| Left / Right arrow | Seek -/+ 5 seconds |
| `,` / `.` (paused) | Frame step backward / forward |
| Scrub bar | Click or drag to seek |
| Rate dropdown | Change playback speed |

## Dependencies

| Package | Role |
|---------|------|
| electron | Desktop shell + Chromium video playback |
| electron-vite | Build tooling (Vite for main, preload, and renderer) |
| vite | Bundler + HMR dev server |
| typescript | Type-safe source |
