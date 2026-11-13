/**
 * Chart Engine — Issues #12, #13, #14, #15.
 *
 * Truthful canvas chart engine for training run visualization.
 */

export { createLinearScale, createLogScale, formatTickNumber } from './scale.js'
export { downsample, binarySearchFirstGe, binarySearchLastLe } from './downsample.js'
export { renderChart, setupCanvas, computeEMA } from './renderer.js'
export { downsampleInWorker } from './worker-downsample.js'
export {
  createViewState,
  inspectRawPoint,
  attachInteractions,
  renderCrosshairOverlay,
  binarySearchNearest,
  formatMetricValue,
} from './interaction.js'
