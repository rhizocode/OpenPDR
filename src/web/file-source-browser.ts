/**
 * OpenPDR — Browser file source implementation
 *
 * Wraps a browser File object to implement the platform-agnostic
 * PdrFileSource interface used by the parser.
 */

import type { PdrFileSource } from '../shared/file-source'

export class BrowserFileSource implements PdrFileSource {
  readonly size: number

  constructor(private file: File) {
    this.size = file.size
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const blob = this.file.slice(offset, offset + length)
    return new Uint8Array(await blob.arrayBuffer())
  }
}
