/**
 * OpenPDR — Video metadata probe via ffmpeg
 *
 * Uses `ffmpeg -i` to extract video resolution, frame rate, and duration.
 * ffmpeg-static does not bundle ffprobe, so we parse ffmpeg's stderr output.
 */

import { execFile } from 'child_process'
import { ffmpegPath } from './ffmpeg-path'

export interface VideoMeta {
  width: number
  height: number
  fps: number
  duration: number
}

/**
 * Probe a video file for metadata using ffmpeg -i.
 * Parses the "Stream #0:0" video line and "Duration:" line from stderr.
 */
export function probeVideo(filePath: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not found'))
      return
    }

    // ffmpeg -i exits with code 1 when no output is specified, but still prints info
    execFile(ffmpegPath, ['-i', filePath], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      // System errors (ENOENT, timeout, etc.) — not just the expected exit code 1
      if (error && !stderr) {
        reject(new Error(`ffmpeg failed to run: ${error.message}`))
        return
      }
      const output = stderr || ''

      // Parse duration: "Duration: HH:MM:SS.ss"
      const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      let duration = 0
      if (durMatch) {
        duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
      }

      // Parse video stream: "Stream #0:0... Video: ... WxH ... fps"
      // Example: "Stream #0:0(und): Video: h264 (avc1 / ...), yuv420p, 1920x1080, 5985 kb/s, 29.97 fps"
      const streamMatch = output.match(/Stream\s+#\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/)
      if (!streamMatch) {
        reject(new Error(`Could not parse video dimensions from ffmpeg output:\n${output.slice(0, 500)}`))
        return
      }

      const width = parseInt(streamMatch[1])
      const height = parseInt(streamMatch[2])

      // Parse fps: search only within the matched video stream line to avoid
      // picking up encoding stats or other "fps" values from ffmpeg output
      const streamLine = streamMatch[0]
      const fpsMatch = streamLine.match(/(\d+(?:\.\d+)?)\s+fps/)
      const fps = Math.max(1, fpsMatch ? parseFloat(fpsMatch[1]) : 30)

      resolve({ width, height, fps, duration })
    })
  })
}
