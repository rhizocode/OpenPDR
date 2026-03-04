/**
 * OpenPDR Viewer — Update UI
 *
 * Toolbar button (download icon) appears when an update is available.
 * Clicking opens a modal with the multi-version changelog and
 * "Not Now" / "Update & Restart" action buttons.
 */

import type { UpdateStatus, ReleaseNote } from './types'

// Module state
let pendingVersion = ''
let pendingNotes: ReleaseNote[] = []

export function initUpdateUI(): void {
  // Guard: in web build, update API won't exist
  if (!window.pdr?.onUpdateStatus) return

  const btn = document.getElementById('btn-update') as HTMLButtonElement
  const modal = document.getElementById('update-modal') as HTMLDivElement
  const title = document.getElementById('update-modal-title') as HTMLHeadingElement
  const changelog = document.getElementById('update-modal-changelog') as HTMLDivElement
  const actions = document.getElementById('update-modal-actions') as HTMLDivElement

  // Listen for update status from main process
  window.pdr.onUpdateStatus((status: UpdateStatus) => {
    switch (status.state) {
      case 'available':
        pendingVersion = status.version ?? ''
        pendingNotes = status.releaseNotes ?? []
        btn.style.display = ''
        break

      case 'downloading':
        updateDownloadProgress(changelog, actions, status.progress ?? 0)
        break

      case 'downloaded':
        showDownloaded(changelog, actions, status.version ?? pendingVersion)
        break

      case 'error':
        // If modal is open and we were downloading, show error
        if (modal.style.display !== 'none') {
          showError(changelog, actions, status.error ?? 'Download failed')
        }
        break

      case 'checking':
      case 'not-available':
        // Nothing to show
        break
    }
  })

  // Toolbar button click → open modal
  btn.addEventListener('click', () => {
    openModal(modal, title, changelog, actions)
  })

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal(modal)
    }
  })
}

function openModal(
  modal: HTMLDivElement,
  title: HTMLHeadingElement,
  changelog: HTMLDivElement,
  actions: HTMLDivElement,
): void {
  title.textContent = `Update to v${pendingVersion}`

  // Render changelog
  if (pendingNotes.length > 0) {
    changelog.innerHTML = pendingNotes
      .map((note) => {
        const heading = document.createElement('h4')
        heading.textContent = `v${note.version}`
        return heading.outerHTML + note.note
      })
      .join('')
  } else {
    changelog.textContent = 'A new version is available.'
  }

  // Render action buttons
  actions.innerHTML = ''

  const dismissBtn = document.createElement('button')
  dismissBtn.className = 'update-btn-dismiss'
  dismissBtn.textContent = 'Not Now'
  dismissBtn.addEventListener('click', () => closeModal(modal))

  const updateBtn = document.createElement('button')
  updateBtn.className = 'update-btn-action'
  updateBtn.textContent = 'Update & Restart'
  updateBtn.addEventListener('click', () => {
    startDownload(changelog, actions)
  })

  actions.appendChild(dismissBtn)
  actions.appendChild(updateBtn)

  modal.style.display = ''
}

function closeModal(modal: HTMLDivElement): void {
  modal.style.display = 'none'
}

function startDownload(changelog: HTMLDivElement, actions: HTMLDivElement): void {
  // Replace actions with progress
  actions.innerHTML = ''

  const progressContainer = document.createElement('div')
  progressContainer.style.width = '100%'

  const bar = document.createElement('div')
  bar.className = 'update-progress-bar'
  const fill = document.createElement('div')
  fill.className = 'update-progress-fill'
  fill.style.width = '0%'
  bar.appendChild(fill)

  const text = document.createElement('div')
  text.className = 'update-progress-text'
  text.textContent = 'Downloading... 0%'

  progressContainer.appendChild(bar)
  progressContainer.appendChild(text)
  actions.appendChild(progressContainer)

  window.pdr.downloadUpdate()
}

function updateDownloadProgress(
  _changelog: HTMLDivElement,
  actions: HTMLDivElement,
  progress: number,
): void {
  const fill = actions.querySelector('.update-progress-fill') as HTMLDivElement | null
  const text = actions.querySelector('.update-progress-text') as HTMLDivElement | null
  if (fill) fill.style.width = `${progress}%`
  if (text) text.textContent = `Downloading... ${progress}%`
}

function showDownloaded(
  _changelog: HTMLDivElement,
  actions: HTMLDivElement,
  version: string,
): void {
  actions.innerHTML = ''

  const text = document.createElement('div')
  text.className = 'update-progress-text'
  text.textContent = `v${version} downloaded successfully`
  text.style.marginBottom = '8px'

  const restartBtn = document.createElement('button')
  restartBtn.className = 'update-btn-action'
  restartBtn.textContent = 'Restart Now'
  restartBtn.addEventListener('click', () => {
    window.pdr.installUpdate()
  })

  actions.appendChild(text)
  actions.appendChild(restartBtn)
}

function showError(
  _changelog: HTMLDivElement,
  actions: HTMLDivElement,
  error: string,
): void {
  actions.innerHTML = ''

  const text = document.createElement('div')
  text.className = 'update-progress-text'
  text.style.color = '#ff6b6b'
  text.textContent = `Error: ${error}`

  const retryBtn = document.createElement('button')
  retryBtn.className = 'update-btn-action'
  retryBtn.textContent = 'Retry'
  retryBtn.addEventListener('click', () => {
    startDownload(_changelog, actions)
  })

  actions.appendChild(text)
  actions.appendChild(retryBtn)
}

/** Trigger a manual update check (used by gear menu) */
export function triggerUpdateCheck(): void {
  if (window.pdr?.checkForUpdates) {
    window.pdr.checkForUpdates()
  }
}
