/**
 * OpenPDR — Node.js / Electron file source implementation
 *
 * Wraps a Node.js FileHandle to implement the platform-agnostic
 * PdrFileSource interface used by the parser.
 */

import { open, stat } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import type { PdrFileSource } from '../shared/file-source'

export class NodeFileSource implements PdrFileSource {
  private constructor(
    private fh: FileHandle,
    readonly size: number,
  ) {}

  static async open(filePath: string): Promise<NodeFileSource> {
    const info = await stat(filePath)
    const fh = await open(filePath, 'r')
    return new NodeFileSource(fh, info.size)
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length)
    await this.fh.read(buf, 0, length, offset)
    return buf
  }

  async close(): Promise<void> {
    await this.fh.close()
  }
}
