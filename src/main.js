import './style.css'
import { attachInteractions, createViewState, renderChart, renderCrosshairOverlay } from './chart/index.js'
import { generateDataset } from './pipeline/generator.js'
import { sanitizeDataset } from './pipeline/sanitizer.js'
import { anomalyCount, filterAndSortRuns, METRICS, summarizeMetric } from './dashboard.js'
import { createRunSelectionController } from './run-loader.js'
import { formatInteger, formatNumber, formatUtcTime } from './formatters.js'

const app = document.querySelector('#app')
let interactions = []
let selectedRun = null
let displayedRun = null
let sanitizedRuns = []
let sort = 'id'
let direction = 'asc'

app.innerHTML = `
  <div class="dashboard-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">TRAINING RUN MONITOR</p>
        <h1>Run dashboard</h1>
      </div>
      <div id="dataset-status" class="status-chip" role="status">Loading runs…</div>
    </header>
    <main>
      <section id="dashboard-loading" class="state-card" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <h2>Loading training runs</h2>
        <p>Generating a deterministic dataset and checking its measurements.</p>
      </section>
      <section id="dashboard-error" class="state-card error-state" hidden role="alert">
        <h2>Runs could not be loaded</h2>
        <p id="dashboard-error-message"></p>
        <button id="retry-button" class="button" type="button">Try again</button>
      </section>
      <section id="dashboard-content" hidden>
        <div class="dashboard-grid">
          <aside class="run-panel panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">DATASET</p>
                <h2>Training runs</h2>
              </div>
              <span id="run-count" class="muted"></span>
            </div>
            <label class="search-label" for="run-filter">Filter by run ID</label>
            <input id="run-filter" class="text-input" type="search" placeholder="e.g. 1" />
            <div class="sort-controls">
              <label for="run-sort">Sort by</label>
              <select id="run-sort" class="select-input">
                <option value="id">Run ID</option>
                <option value="anomalies">Anomalies</option>
                <option value="length">Length</option>
              </select>
              <button id="sort-direction" class="icon-button" type="button" aria-label="Sort ascending">↑</button>
            </div>
            <div id="run-list" class="run-list" role="listbox" aria-label="Training runs"></div>
            <div id="run-empty" class="empty-state" hidden>No runs match this filter.</div>
          </aside>
          <section class="detail-panel">
            <div id="detail-empty" class="state-card" hidden>
              <h2>Select a run</h2>
              <p>Choose a run from the list to inspect its metrics.</p>
            </div>
            <div id="run-detail" hidden>
              <div class="detail-heading">
                <div>
                  <p class="eyebrow">SELECTED RUN</p>
                  <h2 id="selected-run-title"></h2>
                  <p id="selected-run-meta" class="muted"></p>
                </div>
                <div id="run-announcement" class="sr-only" aria-live="polite"></div>
                <div id="run-update-status" class="update-status" role="status" hidden>Updating selected run…</div>
              </div>
              <div id="metric-cards" class="metric-cards"></div>
              <div id="chart-panels" class="chart-panels"></div>
            </div>
          </section>
        </div>
      </section>
    </main>
  </div>
`

const loading = document.querySelector('#dashboard-loading')
const error = document.querySelector('#dashboard-error')
const content = document.querySelector('#dashboard-content')
const status = document.querySelector('#dataset-status')
const list = document.querySelector('#run-list')
const empty = document.querySelector('#run-empty')
const filter = document.querySelector('#run-filter')
const sortSelect = document.querySelector('#run-sort')
const directionButton = document.querySelector('#sort-direction')
const runCount = document.querySelector('#run-count')
const metricCards = document.querySelector('#metric-cards')
const chartPanels = document.querySelector('#chart-panels')
const updateStatus = document.querySelector('#run-update-status')

const selectionController = createRunSelectionController(
  (id) => Promise.resolve(sanitizedRuns.find((run) => run.id === id)),
  {
    onStart: (id) => {
      selectedRun = sanitizedRuns.find((run) => run.id === id) || null
      if (!selectedRun) return
      updateStatus.hidden = false
      updateStatus.textContent = `Updating Run ${id}…`
      document.querySelector('#detail-empty').hidden = true
      document.querySelector('#run-detail').hidden = false
      document.querySelector('#selected-run-title').textContent = `Run ${id}`
      document.querySelector('#selected-run-meta').textContent = 'Loading selected run…'
      renderList()
    },
    onSuccess: (run) => {
      if (!run) throw new Error('Selected run was not found.')
      displayedRun = run
      updateStatus.hidden = true
      document.querySelector('#selected-run-meta').textContent =
        `${formatInteger(run.length)} steps · ${formatInteger(anomalyCount(run))} flagged points`
      document.querySelector('#run-announcement').textContent = `Run ${run.id} selected`
      renderMetrics(run)
      renderCharts(run)
    },
    onError: (exception) => {
      updateStatus.hidden = false
      updateStatus.textContent = exception instanceof Error ? exception.message : 'Run update failed.'
    },
  },
)

function renderList() {
  const runs = filterAndSortRuns(sanitizedRuns, filter.value, sort, direction)
  list.innerHTML = runs
    .map(
      (run) => `
        <button class="run-row ${selectedRun?.id === run.id ? 'selected' : ''}" type="button" role="option"
          aria-selected="${selectedRun?.id === run.id}" data-run-id="${run.id}">
          <span><strong>Run ${formatInteger(run.id)}</strong><small>${formatInteger(run.length)} steps</small></span>
          <span class="anomaly-badge ${anomalyCount(run) ? '' : 'clean'}">${formatInteger(anomalyCount(run))} anomalies</span>
        </button>
      `,
    )
    .join('')
  runCount.textContent = `${formatInteger(runs.length)} of ${formatInteger(sanitizedRuns.length)}`
  empty.hidden = runs.length !== 0
  list.querySelectorAll('[data-run-id]').forEach((button) => {
    button.addEventListener('click', () => selectionController.select(Number(button.dataset.runId)))
  })
}

function renderMetrics(run) {
  metricCards.innerHTML = METRICS.map((metric) => {
    const summary = summarizeMetric(run, metric)
    return `
      <article class="metric-card">
        <div class="metric-card-heading"><h3>${metric}</h3><span>${formatInteger(summary.anomalyCount)} flagged</span></div>
        <strong>${formatNumber(summary.last)}</strong>
        <dl><div><dt>Min</dt><dd>${formatNumber(summary.min)}</dd></div><div><dt>Max</dt><dd>${formatNumber(summary.max)}</dd></div></dl>
      </article>
    `
  }).join('')
}

function renderCharts(run) {
  interactions.forEach(({ destroy }) => destroy())
  interactions = []
  chartPanels.innerHTML = METRICS.map(
    (metric) => `
      <article class="chart-card">
        <div class="chart-heading"><h3>${metric}</h3><span>Raw + smoothed</span></div>
        <canvas data-chart="${metric}" width="800" height="300"></canvas>
        <p class="chart-help" data-a11y="${metric}">Use arrow keys to pan and Shift+Arrow to inspect points.</p>
      </article>
    `,
  ).join('')

  METRICS.forEach((metric) => {
    const canvas = chartPanels.querySelector(`[data-chart="${metric}"]`)
    const a11yTarget = chartPanels.querySelector(`[data-a11y="${metric}"]`)
    const series = { steps: run.steps, values: run[metric], anomaly: run.anomaly }
    const viewState = createViewState([run.steps[0], run.steps[run.steps.length - 1]])
    let scales = null
    const redraw = () => {
      const width = Math.max(320, canvas.parentElement.clientWidth)
      const height = 300
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      scales = renderChart(ctx, series, { width, height, xRange: viewState.getRange(), theme: 'light' })
      renderCrosshairOverlay(ctx, interactions.find((item) => item.canvas === canvas)?.getCrosshair(), scales.xScale, scales.yScale, scales.margins, scales.plotW, scales.plotH)
    }
    redraw()
    const control = attachInteractions(canvas, {
      rawSeries: series,
      viewState,
      getScales: () => scales || {},
      onRender: redraw,
      a11yTarget,
      accessibleName: `${metric} chart for run ${run.id}`,
    })
    interactions.push({ ...control, canvas })
  })
}

function showError(exception) {
  loading.hidden = true
  content.hidden = true
  error.hidden = false
  document.querySelector('#dashboard-error-message').textContent =
    exception instanceof Error ? exception.message : 'An unexpected error occurred.'
  status.textContent = 'Load failed'
}

function loadDashboard() {
  loading.hidden = false
  error.hidden = true
  content.hidden = true
  status.textContent = 'Loading runs…'
  requestAnimationFrame(() => {
    try {
      sanitizedRuns = sanitizeDataset(generateDataset())
      loading.hidden = true
      content.hidden = false
      status.textContent = `${formatInteger(sanitizedRuns.length)} runs ready · ${formatUtcTime(new Date())}`
      renderList()
      selectionController.select(sanitizedRuns[0].id)
    } catch (exception) {
      showError(exception)
    }
  })
}

filter.addEventListener('input', renderList)
sortSelect.addEventListener('change', () => {
  sort = sortSelect.value
  renderList()
})
directionButton.addEventListener('click', () => {
  direction = direction === 'asc' ? 'desc' : 'asc'
  directionButton.textContent = direction === 'asc' ? '↑' : '↓'
  directionButton.setAttribute('aria-label', `Sort ${direction === 'asc' ? 'ascending' : 'descending'}`)
  renderList()
})
document.querySelector('#retry-button').addEventListener('click', loadDashboard)
window.addEventListener('resize', () => {
  if (displayedRun && !content.hidden) renderCharts(displayedRun)
})

loadDashboard()
