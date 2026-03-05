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
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const ffmpegPath: string | null = _require('ffmpeg-static')
import type { TelemetryStore } from '../shared/telemetry-store'
import type {
  OverlayConfig, OverlayLayout, RpmConfig, TrackLayout,
  RenderOverlayRequest, IpcChannels, SessionInfo,
} from '../shared/types'
import { probeVideo } from './ffprobe'

type Channel = keyof IpcChannels

/** Active ffmpeg process (for cancellation) */
let activeProcess: ChildProcess | null = null
let exportInProgress = false

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
  onProgress: (phase: string, pct: number) => void,
  mainWindow: BrowserWindow,
): Promise<void> {
  if (exportInProgress) throw new Error('Export already in progress')
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found')
  if (endIdx <= startIdx) throw new Error('No frames to export')

  exportInProgress = true
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

    if (!isFullExport) {
      args.push('-ss', startTime.toFixed(3))
      args.push('-to', endTime.toFixed(3))
    }

    // Source video (input 0)
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

    // Audio handling
    if (isFullExport) {
      args.push('-c:a', 'copy')
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k')
    }

    args.push(outputPath)

    console.log(`[export-video] ffmpeg args: ${args.join(' ')}`)

    const proc = spawn(ffmpegPath!, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    activeProcess = proc

    // 3. Stream overlay frames from renderer → ffmpeg stdin
    let receivedCount = 0
    let cancelled = false

    // Handle stdin errors (e.g. broken pipe on cancel) — suppress so
    // the IPC handler can return cleanly instead of throwing
    proc.stdin?.on('error', () => { cancelled = true })

    // Handle frame data: write raw RGBA to ffmpeg stdin with backpressure
    ipcMain.handle('overlay-frame-data' satisfies Channel, async (
      _event: Electron.IpcMainInvokeEvent,
      _idx: number,
      buffer: Uint8Array,
    ) => {
      if (cancelled || !proc.stdin || proc.stdin.destroyed) return

      receivedCount++
      const pct = Math.min(99, Math.round((receivedCount / totalFrames) * 100))
      onProgress('Encoding video', pct)

      // Write raw RGBA to ffmpeg stdin; wait for drain if buffer is full
      const buf = Buffer.from(buffer)
      return new Promise<void>((resolve) => {
        if (proc.stdin!.write(buf)) {
          resolve()
        } else {
          proc.stdin!.once('drain', resolve)
        }
      })
    })

    let onDone: (() => void) | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = ''

        // When renderer signals all frames sent, close ffmpeg stdin
        onDone = () => {
          if (proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.end()
          }
        }
        ipcMain.on('overlay-frames-done' satisfies Channel, onDone)

        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
          // Cap stderr to avoid unbounded growth
          if (stderr.length > 10000) stderr = stderr.slice(-5000)
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

        // Send render request to renderer — starts the frame stream
        const request: RenderOverlayRequest = {
          startIdx, endIdx,
          width: meta.width,
          height: meta.height,
          fps: overlayFps,
          totalFrames,
          overlayConfig, overlayLayout, rpmConfig, trackLayout, sessionInfo,
        }
        mainWindow.webContents.send('render-overlay-frames' satisfies Channel, request)
      })

      onProgress('Complete', 100)
    } finally {
      ipcMain.removeHandler('overlay-frame-data' satisfies Channel)
      if (onDone) ipcMain.removeListener('overlay-frames-done' satisfies Channel, onDone)
    }
  } finally {
    exportInProgress = false
  }
}

/** Cancel an in-progress video export. */
export function cancelVideoExport(): void {
  if (activeProcess) {
    activeProcess.kill('SIGTERM')
    activeProcess = null
  }
}
