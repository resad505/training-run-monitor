/**
 * Performance measurement harness.
 *
 * Drives a locally installed Chrome (or Edge) in headless mode over the
 * DevTools Protocol, with CPU throttling, and records:
 *
 *   - a Performance trace (loadable in DevTools > Performance > Load profile)
 *   - first render, main-thread blocking, zoom and hover redraw timings
 *   - JS heap and renderer-process memory with the 1M-point run on screen
 *
 * Usage:
 *   npm run build && npm run preview            # in one terminal
 *   node scripts/measure.mjs --label=after      # in another
 *
 * Options:
 *   --url=http://localhost:4173/   page to measure
 *   --label=run                    output name: perf/<label>.json, perf/<label>.trace.json.gz
 *   --throttle=4                   CPU slowdown factor (1 = none)
 *   --no-trace                     skip the trace file
 *   --browser=<path>               browser executable (default: auto-detect)
 *
 * No dependencies: uses Node's built-in fetch and WebSocket (Node 22+).
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.length ? rest.join('=') : true]
  }),
)
const URL_TO_MEASURE = args.url || 'http://localhost:4173/'
const LABEL = args.label || 'run'
const THROTTLE = Number(args.throttle || 4)
const TRACE = !args['no-trace']
const PORT = 9333
const LARGE_RUN_ID = 19
const VIEWPORT = { width: 1280, height: 900 }

const BROWSER_CANDIDATES = [
  args.browser,
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const megabytes = (bytes) => round(bytes / 1048576)

// ---------------------------------------------------------------------------
// DevTools Protocol client
// ---------------------------------------------------------------------------

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    const listeners = new Map()
    let nextId = 1

    socket.onerror = () => reject(new Error(`Cannot connect to ${wsUrl}`))
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const { resolve: done, reject: fail } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) fail(new Error(`${message.error.message} (${message.error.code})`))
        else done(message.result)
      } else {
        for (const listener of listeners.get(message.method) || []) listener(message.params)
      }
    }
    socket.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((done, fail) => {
            pending.set(id, { resolve: done, reject: fail })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        once(method) {
          return new Promise((done) => {
            const listener = (params) => {
              listeners.set(method, (listeners.get(method) || []).filter((l) => l !== listener))
              done(params)
            }
            listeners.set(method, [...(listeners.get(method) || []), listener])
          })
        },
        close: () => socket.close(),
      })
  })
}

async function launchBrowser() {
  const executable = BROWSER_CANDIDATES.find((path) => existsSync(path))
  if (!executable) throw new Error('No Chrome or Edge found. Pass --browser=<path> or set CHROME_PATH.')

  const profile = mkdtempSync(join(tmpdir(), 'trm-measure-'))
  const child = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--enable-precise-memory-info',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let target = null
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    await sleep(100)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = targets.find((t) => t.type === 'page')
    } catch {
      // Browser is still starting.
    }
  }
  if (!target) {
    child.kill()
    throw new Error('Browser did not expose a debugging endpoint.')
  }

  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
  return { child, profile, executable, version: version.Browser, wsUrl: target.webSocketDebuggerUrl }
}

/** Resident memory of the browser's renderer processes (Windows only). */
function rendererMemory(profile) {
  if (process.platform !== 'win32') return null
  try {
    const marker = profile.split(/[\\/]/).pop()
    const script =
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -like '*--type=renderer*' } | ` +
      `ForEach-Object { $_.WorkingSetSize }`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    const sizes = out.split(/\s+/).filter(Boolean).map(Number)
    return sizes.length ? megabytes(Math.max(...sizes)) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function main() {
  const browser = await launchBrowser()
  const cdp = await connect(browser.wsUrl)

  /** Evaluate an expression in the page and return its JSON value. */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    return result.value
  }
  const waitFor = async (expression, what, timeoutMs = 180_000) => {
    const start = Date.now()
    while (!(await evaluate(expression).catch(() => false))) {
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
      await sleep(100)
    }
  }
  const perf = (name) => evaluate(`window.__perf.summary()[${JSON.stringify(name)}] || null`)
  const stats = (s) => s && { count: s.count, median: round(s.median), p95: round(s.p95), max: round(s.max) }
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return megabytes(metrics.find((m) => m.name === 'JSHeapUsedSize').value)
  }

  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Performance.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

    if (TRACE) {
      await cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'gzip',
        traceConfig: {
          includedCategories: [
            'devtools.timeline',
            'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.frame',
            'disabled-by-default-v8.cpu_profiler',
            'v8.execute',
            'blink.user_timing',
            'latencyInfo',
            'loading',
          ],
          excludedCategories: ['*'],
        },
      })
    }

    // --- Start-up -----------------------------------------------------------
    await cdp.send('Page.navigate', { url: URL_TO_MEASURE })
    await waitFor(`!!(window.__perf && window.__perf.summary()['first-render'])`, 'first render')
    const firstRender = await perf('first-render')
    const firstContentfulPaint = await evaluate(
      `performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null`,
    )

    await waitFor(`document.querySelectorAll('#run-list [data-run-id]').length === 20`, 'all 20 runs')
    await waitFor(`!!document.querySelector('#run-list [data-run-id="${LARGE_RUN_ID}"]')`, 'the 1M run')
    const allRunsReady =
      (await perf('all-runs-ready'))?.max ?? (await evaluate(`performance.now()`)) // fallback: observed now
    await sleep(500)
    // Sampled before any forced GC: the closest this script gets to the
    // start-up peak without disturbing the timings it is measuring.
    const rendererAfterStartupMb = rendererMemory(browser.profile)
    const jsHeapAfterStartupMb = await heap()
    const startupLongTasks = await perf('longtask')
    const startup = {
      firstContentfulPaintMs: round(firstContentfulPaint),
      firstRenderMs: round(firstRender.max),
      allRunsReadyMs: round(allRunsReady),
      mainThreadDatasetBuildMs: round((await perf('dataset-build'))?.max),
      longestMainThreadBlockMs: round(startupLongTasks?.max) ?? 0,
      totalLongTaskMs: round(startupLongTasks?.total) ?? 0,
    }

    // --- Open the 1M-point run ----------------------------------------------
    await evaluate(`window.__perf.reset('render-run'); window.__perf.reset('longtask')`)
    const clickedAt = Date.now()
    await evaluate(`document.querySelector('#run-list [data-run-id="${LARGE_RUN_ID}"]').click()`)
    await waitFor(`document.querySelector('#selected-run-title').textContent === 'Run ${LARGE_RUN_ID}'`, 'run 19')
    await sleep(300)
    const openLargeRun = {
      renderThreeChartsMs: round((await perf('render-run'))?.max),
      observedClickToTitleMs: Date.now() - clickedAt,
    }

    const rect = await evaluate(`(() => {
      const canvas = document.querySelector('[data-chart="loss"]')
      canvas.scrollIntoView({ block: 'center' })
      const r = canvas.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    })()`)
    await sleep(200)
    const y = Math.round(rect.top + rect.height / 2)
    const plotLeft = rect.left + 70
    const plotWidth = rect.width - 110

    // --- Zoom: wheel events at full range, one every ~16 ms ------------------
    const interaction = async (events, dispatch) => {
      await evaluate(`window.__perf.reset('redraw'); window.__perf.reset('longtask')`)
      const start = Date.now()
      for (let i = 0; i < events; i++) {
        await dispatch(i)
        await sleep(16)
      }
      await sleep(400)
      const redraw = await perf('redraw')
      const longTasks = await perf('longtask')
      return {
        events,
        redraws: redraw?.count ?? 0,
        redrawMs: stats(redraw),
        totalRedrawMs: round(redraw?.total) ?? 0,
        wallMs: Date.now() - start - 400,
        longTasks: longTasks?.count ?? 0,
        longestBlockMs: round(longTasks?.max) ?? 0,
      }
    }

    const zoom = await interaction(40, (i) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(plotLeft + plotWidth / 2),
        y,
        deltaX: 0,
        deltaY: i % 2 ? 100 : -100, // in, out, in, out: stays near the full 1M range
      }),
    )

    // --- Hover: pointer sweeps across the plot ------------------------------
    await evaluate(`document.querySelector('[data-chart="loss"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await sleep(200)
    const hover = await interaction(80, (i) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(plotLeft + (plotWidth * i) / 80),
        y,
      }),
    )
    const crosshairText = await evaluate(`document.querySelector('[data-a11y="loss"]').textContent`)

    // --- Memory with the 1M run on screen -----------------------------------
    const heapBeforeGc = await heap()
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(500)
    const memory = {
      rendererAfterStartupMb,
      jsHeapAfterStartupMb,
      rendererWith1MRunAfterGcMb: rendererMemory(browser.profile),
      jsHeapWith1MRunAfterGcMb: await heap(),
      jsHeapWith1MRunBeforeGcMb: heapBeforeGc,
    }

    let traceFile = null
    if (TRACE) {
      const complete = cdp.once('Tracing.tracingComplete')
      await cdp.send('Tracing.end')
      const { stream } = await complete
      const chunks = []
      for (;;) {
        const { data, base64Encoded, eof } = await cdp.send('IO.read', { handle: stream, size: 1 << 20 })
        chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'))
        if (eof) break
      }
      await cdp.send('IO.close', { handle: stream })
      mkdirSync('perf', { recursive: true })
      traceFile = `perf/${LABEL}.trace.json.gz`
      writeFileSync(traceFile, Buffer.concat(chunks))
    }

    const result = {
      label: LABEL,
      url: URL_TO_MEASURE,
      measuredAt: new Date().toISOString(),
      browser: browser.version,
      cpuThrottle: `${THROTTLE}x`,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height} @1x, headless`,
      chartCssWidth: Math.round(rect.width),
      startup,
      openLargeRun,
      zoom,
      hover,
      memory,
      crosshairText,
      traceFile,
    }
    mkdirSync('perf', { recursive: true })
    writeFileSync(`perf/${LABEL}.json`, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    cdp.close()
    browser.child.kill()
    await sleep(500)
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
