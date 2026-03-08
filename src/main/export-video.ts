/**
 * OpenPDR — Video export with baked overlays
 *
 * Streaming pipeline:
 * 1. Probe source video for resolution + fps
 * 2. Start ffmpeg with raw RGBA pipe input
 * 3. Renderer sends raw overlay frames via IPC → piped to ffmpeg stdin
 * 4. ffmpeg composites overlays onto source video and encodes
 */

import { spawn, type ChildProcess } from 'child_process'
import { BrowserWindow, ipcMain } from 'electron'
import { ffmpegPath } from './ffmpeg-path'
import type { TelemetryStore } from '../shared/telemetry-store'
import type {
  OverlayConfig, OverlayLayout, RpmConfig, TrackLayout,
  RenderOverlayRequest, IpcChannels, SessionInfo, TrackMapExportConfig,
} from '../shared/types'
import { probeVideo } from './ffprobe'

type Channel = keyof IpcChannels

/** Active ffmpeg process (for cancellation) */
let activeProcess: ChildProcess | null = null
let exportGeneration = 0
let exportCancelled = false

/**
 * Export video with baked telemetry overlays.
 *
 * Streaming pipeline: overlay frames are rendered in the renderer process,
 * sent as raw RGBA pixels via IPC, and piped directly to ffmpeg's stdin
 * for compositing onto the source video. No temp files needed.
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
  sessionInfo: SessionInfo | undefined,
  trackMapConfig: TrackMapExportConfig | undefined,
  onProgress: (phase: string, pct: number) => void,
  mainWindow: BrowserWindow,
): Promise<void> {
  if (exportGeneration > 0) throw new Error('Export already in progress')
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found')
  const ffmpeg = ffmpegPath // narrowed to string — no assertion needed below
  if (endIdx <= startIdx) throw new Error('No frames to export')

  const gen = ++exportGeneration
  exportCancelled = false
  try {
    // 1. Probe source video
    onProgress('Analyze video', 0)
    const meta = await probeVideo(sourceVideoPath)

    const overlayFps = Math.min(meta.fps, 30)
    const startTime = store.time[startIdx]
    const endTime = store.time[Math.min(endIdx - 1, store.length - 1)]
    const duration = endTime - startTime
    const totalFrames = Math.max(1, Math.ceil(duration * overlayFps))
    const isFullExport = startIdx === 0 && endIdx === store.length

    // 2. Start ffmpeg with raw RGBA pipe input for overlay stream
    onProgress('Encoding video', 0)

    const args: string[] = ['-y']  // overwrite output

    // Source video (input 0) — with optional input-level seek for partial exports.
    // Input-level -ss (before -i) seeks to the exact frame and resets PTS to 0,
    // so the overlay stream (also starting at PTS 0) stays aligned.
    if (!isFullExport) {
      args.push('-ss', startTime.toFixed(3))
    }
    args.push('-i', sourceVideoPath)

    // Overlay: raw RGBA from stdin (input 1)
    args.push(
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-video_size', `${meta.width}x${meta.height}`,
      '-framerate', overlayFps.toFixed(4),
      '-i', 'pipe:0',
    )

    // Filter: composite overlay on source video
    args.push('-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1')

    // Video encoding
    args.push('-c:v', 'libx264', '-crf', '23', '-preset', 'medium')

    // Audio handling + duration limit for partial exports
    if (isFullExport) {
      args.push('-c:a', 'copy')
    } else {
      args.push('-t', duration.toFixed(3))
      args.push('-c:a', 'aac', '-b:a', '192k')
    }

    args.push(outputPath)

    console.log(`[export-video] ffmpeg args: ${args.join(' ')}`)

    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    activeProcess = proc

    // 3. Stream overlay frames from renderer → ffmpeg stdin
    let receivedCount = 0
    let stdinBroken = false

    // Handle stdin errors (e.g. broken pipe on cancel) — suppress so
    // the IPC handler can return cleanly instead of throwing
    proc.stdin?.on('error', () => { stdinBroken = true })

    // Attach close/error listeners immediately after spawn so that a
    // cancel before the IPC loop starts still settles the promise.
    let stderr = ''
    const procDone = new Promise<void>((resolve, reject) => {
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderr.length > 10000) stderr = stderr.slice(-5000)
      })

      proc.on('close', (code) => {
        activeProcess = null
        if (exportCancelled || code === 0) {
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

    // If the process was already killed before listeners attached, reject now
    if (proc.killed || proc.exitCode !== null) {
      activeProcess = null
      throw new Error('ffmpeg process exited before export could start')
    }

    // Handle frame data: write raw RGBA to ffmpeg stdin with backpressure
    ipcMain.handle('overlay-frame-data' satisfies Channel, async (
      _event: Electron.IpcMainInvokeEvent,
      _idx: number,
      buffer: Uint8Array,
    ) => {
      if (stdinBroken || exportCancelled || !proc.stdin || proc.stdin.destroyed) return

      const expected = meta.width * meta.height * 4
      if (buffer.length !== expected) return

      receivedCount++
      const pct = Math.min(99, Math.round((receivedCount / totalFrames) * 100))
      onProgress('Encoding video', pct)

      // Write raw RGBA to ffmpeg stdin; wait for drain if buffer is full
      return new Promise<void>((resolve) => {
        if (proc.stdin!.write(buffer)) {
          resolve()
        } else {
          proc.stdin!.once('drain', resolve)
        }
      })
    })

    // When renderer signals all frames sent, close ffmpeg stdin
    const onDone = (): void => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end()
      }
      onProgress('Finalizing', 99)
    }
    ipcMain.on('overlay-frames-done' satisfies Channel, onDone)

    try {
      // Send render request to renderer — starts the frame stream
      const request: RenderOverlayRequest = {
        startIdx, endIdx,
        width: meta.width,
        height: meta.height,
        fps: overlayFps,
        totalFrames,
        overlayConfig, overlayLayout, rpmConfig, trackLayout, sessionInfo,
        trackMapConfig,
      }
      mainWindow.webContents.send('render-overlay-frames' satisfies Channel, request)

      await procDone
      if (!exportCancelled) onProgress('Complete', 100)
    } finally {
      ipcMain.removeHandler('overlay-frame-data' satisfies Channel)
      ipcMain.removeListener('overlay-frames-done' satisfies Channel, onDone)
    }
  } finally {
    if (exportGeneration === gen) {
      exportGeneration = 0
      exportCancelled = false
    }
  }
}

/** Cancel an in-progress video export. */
export function cancelVideoExport(): void {
  exportCancelled = true
  if (activeProcess) {
    // On Windows, all signals result in TerminateProcess() (hard kill).
    // On Unix, SIGKILL is more reliable for ffmpeg since it ignores SIGTERM in some states.
    activeProcess.kill()
    activeProcess = null
  }
}
