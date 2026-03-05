/**
 * Shared ffmpeg binary path resolution.
 * Both export-video.ts and ffprobe.ts need the ffmpeg-static binary path.
 */

import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
export const ffmpegPath: string | null = _require('ffmpeg-static')
