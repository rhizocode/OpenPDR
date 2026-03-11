/**
 * OpenPDR Viewer — Unified gear menu
 *
 * Single dropdown panel behind the toolbar gear button, containing
 * four accordion sections: Overlay Edit, Export, RPM Zones, A/V Sync.
 */

import { onTelemetryLoad } from './state'
import { buildEditPanel } from './edit-mode'
import { buildRpmPanel, buildAvSyncPanel, buildFontSizePanel, buildBrakeDisplayPanel } from './overlay-settings'
import { buildExportPanel } from './export-menu'
import { triggerUpdateCheck } from './update-ui'

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
    { id: 'brake-display',label: 'Brake Display',  build: buildBrakeDisplayPanel },
    { id: 'av-sync',      label: 'Sync Offset',   build: buildAvSyncPanel },
    { id: 'font-size',    label: 'Font Scale',      build: buildFontSizePanel },
    { id: 'about',        label: 'About',           build: buildAboutPanel },
  ]

  const accordionItems: { content: HTMLDivElement; chevron: HTMLSpanElement }[] = []

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

    const idx = accordionItems.length
    accordionItems.push({ content, chevron })

    header.addEventListener('click', () => {
      const isOpen = content.style.display !== 'none'
      // Collapse all sections
      for (let i = 0; i < accordionItems.length; i++) {
        if (i !== idx) {
          accordionItems[i].content.style.display = 'none'
          accordionItems[i].chevron.textContent = '\u25B8'
        }
      }
      // Toggle the clicked section
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

  // Close panel on outside click (skip when mobile menu manages visibility)
  document.addEventListener('pointerdown', (e) => {
    const toolbar = document.getElementById('toolbar')
    if (toolbar?.classList.contains('mobile-open')) return
    const target = e.target as Node
    if (!panel.contains(target) && target !== btn && !btn.contains(target)) {
      panel.classList.remove('visible')
      btn.classList.remove('active')
    }
  })

  // Rebuild export and RPM sections when telemetry loads
  onTelemetryLoad(() => {
    const exportContent = document.getElementById('gear-content-export') as HTMLDivElement
    buildExportPanel(exportContent)
    const rpmContent = document.getElementById('gear-content-rpm-zones') as HTMLDivElement
    buildRpmPanel(rpmContent)
  })
}

function buildAboutPanel(container: HTMLDivElement): void {
  container.innerHTML = ''

  // Version row
  const versionRow = document.createElement('div')
  versionRow.className = 'settings-row'
  const versionLabel = document.createElement('label')
  versionLabel.textContent = 'Version'
  const versionValue = document.createElement('span')
  versionValue.style.fontFamily = 'Consolas, monospace'
  versionValue.style.fontSize = '0.75em'

  if (window.pdr?.getAppVersion) {
    versionValue.textContent = '...'
    window.pdr.getAppVersion().then((v) => {
      versionValue.textContent = `v${v}`
    }).catch(() => {
      versionValue.textContent = 'unknown'
    })
  } else {
    versionValue.textContent = 'web build'
  }

  versionRow.appendChild(versionLabel)
  versionRow.appendChild(versionValue)
  container.appendChild(versionRow)

  // Description + link
  const desc = document.createElement('div')
  desc.className = 'about-description'
  desc.innerHTML =
    'OpenPDR is an open source viewer for Performance Data Recorder files. ' +
    'For more information, visit ' +
    '<a href="https://github.com/rhizocode/OpenPDR" target="_blank" rel="noopener">github.com/rhizocode/OpenPDR</a>' +
    '<br><br>Comments, Questions, or Feedback? Email <a href="mailto:contact@openpdr.org">contact@openpdr.org</a>'
  container.appendChild(desc)

  // Check for updates button (Electron only)
  if (window.pdr.platform !== 'web' && window.pdr?.checkForUpdates) {
    const checkRow = document.createElement('div')
    checkRow.className = 'edit-actions'
    const checkBtn = document.createElement('button')
    checkBtn.textContent = 'Check for Updates'
    checkBtn.addEventListener('click', () => {
      // Close gear panel
      const panel = document.getElementById('gear-panel')
      const gearBtn = document.getElementById('btn-gear')
      panel?.classList.remove('visible')
      gearBtn?.classList.remove('active')
      triggerUpdateCheck()
    })
    checkRow.appendChild(checkBtn)
    container.appendChild(checkRow)
  }
}
