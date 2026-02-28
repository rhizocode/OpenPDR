/**
 * OpenPDR — Video export with baked overlays
 *
 * Orchestrates the video export pipeline:
 * 1. Probe source video for resolution + fps
 * 2. Request overlay frame PNGs from the renderer process
 * 3. Write PNGs to a temp directory
 * 4. Run ffmpeg to composite overlay PNGs onto the source video
 * 5. Clean up temp files
 */

import { spawn, type ChildProcess } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const ffmpegPath: string | null = _require('ffmpeg-static')
import type { TelemetryStore } from '../shared/telemetry-store'
import type {
  OverlayConfig, OverlayLayout, RpmConfig, TrackLayout,
  RenderOverlayRequest, IpcChannels,
} from '../shared/types'
import { probeVideo } from './ffprobe'

type Channel = keyof IpcChannels

/** Active ffmpeg process (for cancellation) */
let activeProcess: ChildProcess | null = null
let activeTempDir: string | null = null

/**
 * Export video with baked telemetry overlays.
 *
 * Flow:
 * - Probes source video for resolution
 * - Sends render request to renderer for overlay PNGs
 * - Collects PNGs via IPC, writes to temp dir
 * - Runs ffmpeg to composite overlays onto source video
 */
export async function exportVideo(
  store: TelemetryStore,
  sourceVideoPath: string,
  outputPath: string,
  startIdx: number,
  endIdx: number,
  overlayConfig: OverlayConfig,
  overlayLayout: OverlayLayout,
  rpmConfig: RpmConfig,
  trackLayout: TrackLayout | null,
  onProgress: (phase: string, pct: number) => void,
  mainWindow: BrowserWindow,
): Promise<void> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found')

  const totalFrames = endIdx - startIdx
  if (totalFrames <= 0) throw new Error('No frames to export')

  // 1. Probe source video
  onProgress('Probing video', 0)
  const meta = await probeVideo(sourceVideoPath)

  // 2. Create temp directory for overlay PNGs
  const tempDir = await mkdtemp(join(tmpdir(), 'openpdr-export-'))
  activeTempDir = tempDir

  try {
    // 3. Request overlay frames from renderer
    onProgress('Rendering overlays', 0)

    const request: RenderOverlayRequest = {
      startIdx, endIdx,
      width: meta.width,
      height: meta.height,
      overlayConfig, overlayLayout, rpmConfig, trackLayout,
    }

    // Wait for all frames to arrive from renderer
    await renderOverlayFrames(request, tempDir, totalFrames, onProgress, mainWindow)

    // 4. Run ffmpeg to composite
    onProgress('Encoding video', 0)

    const startTime = store.time[startIdx]
    const endTime = store.time[Math.min(endIdx - 1, store.length - 1)]
    const isFullExport = startIdx === 0 && endIdx === store.length

    await runFfmpeg(
      sourceVideoPath, outputPath, tempDir,
      startTime, endTime, isFullExport,
      meta.fps, totalFrames,
      onProgress,
    )

    onProgress('Complete', 100)
  } finally {
    // 5. Clean up temp directory
    activeTempDir = null
    try { await rm(tempDir, { recursive: true }) } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Send render request to renderer and collect PNG frames via IPC.
 * Returns when all frames have been written to tempDir.
 */
function renderOverlayFrames(
  request: RenderOverlayRequest,
  tempDir: string,
  totalFrames: number,
  onProgress: (phase: string, pct: number) => void,
  mainWindow: BrowserWindow,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let receivedCount = 0
    const pendingWrites: Promise<void>[] = []

    // Listen for frame data from renderer
    const onFrameData = (
      _event: Electron.IpcMainEvent,
      idx: number,
      buffer: Uint8Array,
    ) => {
      // Count synchronously — async writeFile can still be in-flight when onDone fires
      receivedCount++
      const pct = Math.round((receivedCount / totalFrames) * 100)
      onProgress('Rendering overlays', pct)

      const filename = `${String(idx + 1).padStart(6, '0')}.png`
      const p = writeFile(join(tempDir, filename), Buffer.from(buffer)).catch((err) => {
        cleanup()
        reject(err)
      })
      pendingWrites.push(p as Promise<void>)
    }

    const onDone = async () => {
      cleanup()
      await Promise.all(pendingWrites)
      if (receivedCount >= totalFrames) {
        resolve()
      } else {
        reject(new Error(`Expected ${totalFrames} frames but received ${receivedCount}`))
      }
    }

    function cleanup() {
      ipcMain.removeListener('overlay-frame-data' satisfies Channel, onFrameData)
      ipcMain.removeListener('overlay-frames-done' satisfies Channel, onDone)
    }

    ipcMain.on('overlay-frame-data' satisfies Channel, onFrameData)
    ipcMain.on('overlay-frames-done' satisfies Channel, onDone)

    // Send render request to renderer
    mainWindow.webContents.send('render-overlay-frames' satisfies Channel, request)
  })
}

/**
 * Run ffmpeg to composite overlay PNGs onto the source video.
 */
function runFfmpeg(
  sourceVideoPath: string,
  outputPath: string,
  tempDir: string,
  startTime: number,
  endTime: number,
  isFullExport: boolean,
  _fps: number,
  totalFrames: number,
  onProgress: (phase: string, pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime
    // Overlay PNGs are at 10 Hz (telemetry rate)
    const overlayFps = totalFrames / duration

    const args: string[] = ['-y']  // overwrite output

    if (!isFullExport) {
      // Trim source video to the time range
      args.push('-ss', startTime.toFixed(3))
      args.push('-to', endTime.toFixed(3))
    }

    // Source video input
    args.push('-i', sourceVideoPath)

    // Overlay PNG sequence input at telemetry rate
    args.push('-framerate', overlayFps.toFixed(4))
    args.push('-i', join(tempDir, '%06d.png'))

    // Filter: overlay PNGs on video; shortest=1 stops when overlay ends
    args.push('-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1')

    // Video encoding
    args.push('-c:v', 'libx264', '-crf', '23', '-preset', 'medium')

    // Audio handling
    if (isFullExport) {
      // Full export: copy audio unchanged
      args.push('-c:a', 'copy')
    } else {
      // Lap export: re-encode audio (trim may require it)
      args.push('-c:a', 'aac', '-b:a', '192k')
    }

    args.push(outputPath)

    console.log(`[export-video] ffmpeg args: ${args.join(' ')}`)

    const proc = spawn(ffmpegPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    activeProcess = proc

    let stderr = ''

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()

      // Parse progress from ffmpeg stderr: "frame=  123"
      const frameMatch = stderr.match(/frame=\s*(\d+)/g)
      if (frameMatch) {
        const lastMatch = frameMatch[frameMatch.length - 1]
        const frameNum = parseInt(lastMatch.replace(/frame=\s*/, ''))
        // Estimate total output frames (video fps * duration)
        const estimatedTotal = Math.ceil(duration * 30)  // assume ~30fps output
        const pct = Math.min(99, Math.round((frameNum / estimatedTotal) * 100))
        onProgress('Encoding video', pct)
      }
    })

    proc.on('close', (code) => {
      activeProcess = null
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => {
      activeProcess = null
      reject(new Error(`ffmpeg failed to start: ${err.message}`))
    })
  })
}

/** Cancel an in-progress video export. */
export function cancelVideoExport(): void {
  if (activeProcess) {
    activeProcess.kill('SIGTERM')
    activeProcess = null
  }
  if (activeTempDir) {
    rm(activeTempDir, { recursive: true }).catch(() => {})
    activeTempDir = null
  }
}
