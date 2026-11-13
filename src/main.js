import './style.css'
import {
  attachInteractions,
  createViewState,
  renderChart,
  renderCrosshairOverlay,
  setupCanvas,
} from './chart/index.js'
import { generateDataset } from './pipeline/generator.js'
import { sanitizeDataset } from './pipeline/sanitizer.js'
import {
  ANOMALY_KINDS,
  anomalyCount,
  countAnomaliesByKind,
  filterAndSortRuns,
  METRICS,
  nextOptionIndex,
  summarizeMetric,
} from './dashboard.js'
import { createRunSelectionController } from './run-loader.js'
import { formatInteger, formatNumber, formatUtcTime } from './formatters.js'

const app = document.querySelector('#app')
let interactions = []
let selectedRun = null
let displayedRun = null
let sanitizedRuns = []
let activeOptionId = null
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
              <ul id="anomaly-summary" class="anomaly-summary" aria-label="Flagged points by kind"></ul>
              <div id="run-body">
                <div id="metric-cards" class="metric-cards"></div>
                <div id="chart-panels" class="chart-panels"></div>
              </div>
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
const runBody = document.querySelector('#run-body')
const anomalySummary = document.querySelector('#anomaly-summary')

/** Mark the detail body as lagging behind (or caught up with) the selection. */
function setStale(stale, message = '') {
  runBody.classList.toggle('is-stale', stale)
  runBody.setAttribute('aria-busy', String(stale))
  updateStatus.hidden = !stale
  updateStatus.textContent = message
}

const selectionController = createRunSelectionController(
  (id) => Promise.resolve(sanitizedRuns.find((run) => run.id === id)),
  {
    onStart: (id) => {
      selectedRun = sanitizedRuns.find((run) => run.id === id) || null
      if (!selectedRun) return
      document.querySelector('#detail-empty').hidden = true
      document.querySelector('#run-detail').hidden = false
      // The title, metrics and charts only ever change together in onSuccess,
      // so one run's data can never sit under another run's title. Until then
      // the body is marked stale and the indicator names both runs.
      if (displayedRun && displayedRun.id !== id) {
        setStale(true, `Loading Run ${formatInteger(id)}… still showing Run ${formatInteger(displayedRun.id)}`)
      } else if (!displayedRun) {
        document.querySelector('#selected-run-title').textContent = `Run ${formatInteger(id)}`
        document.querySelector('#selected-run-meta').textContent = 'Loading selected run…'
        setStale(true, `Loading Run ${formatInteger(id)}…`)
      }
      renderList()
    },
    onSuccess: (run) => {
      if (!run) throw new Error('Selected run was not found.')
      displayedRun = run
      document.querySelector('#selected-run-title').textContent = `Run ${formatInteger(run.id)}`
      document.querySelector('#selected-run-meta').textContent =
        `${formatInteger(run.length)} steps · ${formatInteger(anomalyCount(run))} flagged points`
      renderAnomalySummary(run)
      renderMetrics(run)
      renderCharts(run)
      setStale(false)
      document.querySelector('#run-announcement').textContent =
        `Run ${formatInteger(run.id)} selected, ${formatInteger(anomalyCount(run))} flagged points`
    },
    onError: (exception) => {
      const reason = exception instanceof Error ? exception.message : 'Run update failed.'
      setStale(true, displayedRun ? `${reason} Still showing Run ${formatInteger(displayedRun.id)}.` : reason)
    },
  },
)

function renderList() {
  const runs = filterAndSortRuns(sanitizedRuns, filter.value, sort, direction)
  const hadFocus = list.contains(document.activeElement)
  // Roving tabindex: exactly one row is in the tab order. Prefer the row the
  // user was on, then the selected run, then the first visible row.
  const ids = runs.map((run) => run.id)
  activeOptionId = [activeOptionId, selectedRun?.id, ids[0]].find((id) => ids.includes(id)) ?? null

  list.innerHTML = runs
    .map(
      (run) => `
        <button class="run-row ${selectedRun?.id === run.id ? 'selected' : ''}" type="button" role="option"
          aria-selected="${selectedRun?.id === run.id}" tabindex="${run.id === activeOptionId ? 0 : -1}" data-run-id="${run.id}">
          <span><strong>Run ${formatInteger(run.id)}</strong><small>${formatInteger(run.length)} steps</small></span>
          <span class="anomaly-badge ${anomalyCount(run) ? '' : 'clean'}">${formatInteger(anomalyCount(run))} anomalies</span>
        </button>
      `,
    )
    .join('')
  runCount.textContent = `${formatInteger(runs.length)} of ${formatInteger(sanitizedRuns.length)}`
  empty.hidden = runs.length !== 0
  // Re-rendering replaces the rows; put focus back so keyboard users are not
  // thrown out of the list after every selection.
  if (hadFocus) list.querySelector('[tabindex="0"]')?.focus()
}

function focusOption(row) {
  list.querySelectorAll('[data-run-id]').forEach((other) => other.setAttribute('tabindex', other === row ? '0' : '-1'))
  activeOptionId = Number(row.dataset.runId)
  row.focus()
}

function renderAnomalySummary(run) {
  const counts = countAnomaliesByKind(run)
  anomalySummary.innerHTML =
    ANOMALY_KINDS.map(
      ({ key, label }) =>
        `<li class="anomaly-chip ${counts[key] ? '' : 'clean'}"><strong>${formatInteger(counts[key])}</strong> ${label}</li>`,
    ).join('') + '<li class="anomaly-note">Flags are computed from loss.</li>'
}

function renderMetrics(run) {
  metricCards.innerHTML = METRICS.map((metric) => {
    const summary = summarizeMetric(run, metric)
    return `
      <article class="metric-card">
        <div class="metric-card-heading"><h3>${metric}</h3><span class="${summary.nonFiniteCount ? 'non-finite-count' : ''}">${formatInteger(summary.nonFiniteCount)} non-finite</span></div>
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
      // Draw in the canvas's own CSS box. Pointer positions are measured in
      // CSS pixels, so any other width would make the crosshair report a
      // different point from the one under the cursor. setupCanvas scales the
      // backing store for high-DPI screens.
      const width = Math.floor(canvas.clientWidth) || 320
      const height = 300
      const ctx = setupCanvas(canvas, width, height)
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
      accessibleName: `${metric} chart for run ${formatInteger(run.id)}`,
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
  // rAF callbacks run before the frame is painted, so the heavy synchronous
  // generation waits one more task to let the loading state reach the screen.
  const start = () => {
    try {
      sanitizedRuns = sanitizeDataset(generateDataset())
      loading.hidden = true
      content.hidden = false
      status.textContent = `${formatInteger(sanitizedRuns.length)} runs ready · loaded ${formatUtcTime(new Date())}`
      renderList()
      selectionController.select(sanitizedRuns[0].id)
    } catch (exception) {
      showError(exception)
    }
  }
  requestAnimationFrame(() => setTimeout(start, 0))
}

list.addEventListener('click', (event) => {
  const row = event.target.closest('[data-run-id]')
  if (!row) return
  activeOptionId = Number(row.dataset.runId)
  selectionController.select(activeOptionId)
})
list.addEventListener('keydown', (event) => {
  const rows = [...list.querySelectorAll('[data-run-id]')]
  const next = nextOptionIndex(event.key, rows.indexOf(event.target.closest('[data-run-id]')), rows.length)
  if (next === null) return
  event.preventDefault()
  focusOption(rows[next])
})
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
