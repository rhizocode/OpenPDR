/**
 * OpenPDR Viewer — Unified gear menu
 *
 * Single dropdown panel behind the toolbar gear button, containing
 * four accordion sections: Overlay Edit, Export, RPM Zones, A/V Sync.
 */

import { onTelemetryLoad } from './state'
import { buildEditPanel } from './edit-mode'
import { buildRpmPanel, buildAvSyncPanel, buildFontSizePanel } from './overlay-settings'
import { buildExportPanel } from './export-menu'

interface Section {
  id: string
  label: string
  build: (container: HTMLDivElement) => void
}

export function initGearMenu(): void {
  const btn = document.getElementById('btn-gear') as HTMLButtonElement
  const panel = document.getElementById('gear-panel') as HTMLDivElement

  const sections: Section[] = [
    { id: 'overlays',     label: 'Overlays',     build: buildEditPanel },
    { id: 'export',       label: 'Export',        build: buildExportPanel },
    { id: 'rpm-zones',    label: 'RPM Zones',     build: buildRpmPanel },
    { id: 'av-sync',      label: 'A/V Sync',      build: buildAvSyncPanel },
    { id: 'font-size',    label: 'Font Size',      build: buildFontSizePanel },
  ]

  for (const sec of sections) {
    const header = document.createElement('div')
    header.className = 'gear-section-header'
    header.dataset.section = sec.id

    const chevron = document.createElement('span')
    chevron.className = 'gear-chevron'
    chevron.textContent = '\u25B8'

    const labelSpan = document.createElement('span')
    labelSpan.textContent = sec.label

    header.appendChild(chevron)
    header.appendChild(labelSpan)

    const content = document.createElement('div')
    content.className = 'gear-section-content'
    content.id = `gear-content-${sec.id}`
    content.style.display = 'none'

    header.addEventListener('click', () => {
      const isOpen = content.style.display !== 'none'
      content.style.display = isOpen ? 'none' : ''
      chevron.textContent = isOpen ? '\u25B8' : '\u25BE'
    })

    sec.build(content)
    panel.appendChild(header)
    panel.appendChild(content)
  }

  // Toggle panel visibility on gear button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const isVisible = panel.classList.toggle('visible')
    btn.classList.toggle('active', isVisible)
  })

  // Close panel on outside click
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node
    if (!panel.contains(target) && target !== btn && !btn.contains(target)) {
      panel.classList.remove('visible')
      btn.classList.remove('active')
    }
  })

  // Rebuild export section when telemetry loads
  onTelemetryLoad(() => {
    const exportContent = document.getElementById('gear-content-export') as HTMLDivElement
    buildExportPanel(exportContent)
  })
}
