/**
 * OpenPDR Viewer — Lightweight event bus factory
 *
 * Shared by state.ts and compare-state.ts. Snapshots the listener
 * array before firing so unsubscribe-during-iteration is safe.
 */

type Callback = () => void
type Unsubscribe = () => void

export interface EventBus {
  on(fn: Callback): Unsubscribe
  fire(): void
}

export function createBus(): EventBus {
  const fns: Callback[] = []
  return {
    on(fn: Callback): Unsubscribe {
      fns.push(fn)
      return () => {
        const i = fns.indexOf(fn)
        if (i >= 0) fns.splice(i, 1)
      }
    },
    fire(): void {
      const snapshot = fns.slice()
      for (const fn of snapshot) fn()
    },
  }
}
