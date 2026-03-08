/**
 * OpenPDR Viewer — localStorage key constants
 *
 * Single source of truth for all localStorage keys used by the renderer.
 * Import from here instead of declaring local string constants.
 */

export const STORAGE_KEYS = {
  overlayConfig: 'pdr-overlay-config',
  overlayLayout: 'pdr-overlay-layout',
  rpmConfig: 'pdr-rpm-config',
  rpmOverride: 'pdr-rpm-manual-override',
  chartChannels: 'pdr-chart-channels',
  chartHeight: 'pdr-chart-height',
  avSync: 'pdr-sync-offset',
  fontSize: 'pdr-ui-font-size',
  panelState: 'pdr-panel-state',
  lapsPanelWidth: 'pdr-laps-panel-width',
  brakeMode: 'pdr-brake-mode',
} as const
