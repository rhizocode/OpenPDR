/**
 * OpenPDR Viewer — Web entry point
 *
 * Installs the browser PdrApi implementation on window.pdr,
 * then dynamically imports the renderer to ensure pdr is available
 * before any renderer module reads it.
 */

import '../renderer/styles.css'
import { installWebPdr } from './pdr-web'

installWebPdr()

// Dynamic import ensures window.pdr is set before renderer modules execute
import('../renderer/main')
