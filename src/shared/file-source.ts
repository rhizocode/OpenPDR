/**
 * OpenPDR — Platform-agnostic file source interface
 *
 * The parser reads data through this interface instead of using Node.js fs
 * directly. Each platform provides its own implementation:
 *   - Electron: NodeFileSource (fs.read via FileHandle)
 *   - PWA/Web:  File.slice().arrayBuffer()
 */

export interface PdrFileSource {
  /** Read `length` bytes starting at `offset` from the file. */
  read(offset: number, length: number): Promise<Uint8Array>

  /** Total file size in bytes. */
  readonly size: number
}
