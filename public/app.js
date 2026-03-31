/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  CLOUDPULSE AI v2.0 — FRONTEND AUTO-SCALING ENGINE      ║
 * ║  Socket.IO · D3.js · Three.js · Real-time scaling UI    ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

// ─────────────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────────────
const S = {
  cpu: [], pred: [], mem: [], disk: [], net: [], req: [],
  rt: [], inst: [], cost: [],
  logs: [], scalingEvents: [],
  latest: null,
  view: 'dashboard',
  logFilter: 'all',
  prevCpu: 0,
  prevInst: 0,
  realtimeOn: true,
  connected: false,
  socket: null,
  scalingConfig: { maxInstances: 5, minInstances: 1, scaleUpCpu: 70, scaleDownCpu: 30 },
};

const MAX = 60;
const Charts = {};
const C = {
  indigo: '#6366f1', indigoL: '#818cf8',
  cyan: '#22d3ee', success: '#22c55e',
  warning: '#facc15', danger: '#ef4444',
  info: '#38bdf8', grid: 'rgba(99,102,241,0.07)',
};
const numAnimState = {};

// ─────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupTheme();
  setupSettings();
  setupLogTabs();
  setupRipple();
  setupRealtimeToggle();
  setupHistTabs();
  connectSocket();
  boot();
});

async function boot() {
  await sleep(1200);
  el('skeletonGrid').style.display = 'none';
  show('kpiRow'); show('chartsRow'); show('bottomRow');

  // Wait for browser layout to repaint so clientWidth metrics are non-zero!
  await sleep(150);

  try { initCpuChart(); } catch (e) { console.error(e); }
  try { initReqChart(); } catch (e) { console.error(e); }
  try { initGauge(); } catch (e) { console.error(e); }
  try { initInstanceChart(); } catch (e) { console.error(e); }
  try { initSparklines(); } catch (e) { console.error(e); }

  setupResizeObserver();
  // seed the log summary counts on boot
  if (typeof updateLogSummary === 'function') updateLogSummary();
}

function setupResizeObserver() {
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Re-initialize 2D dynamic charts on global window resize
      if (S.view === 'dashboard') {
        initCpuChart(); updateCpuChart();
        initReqChart(); updateReqChart();
        initGauge(); updateGauge(S.latest?.cpu?.load || 0);
        initSparklines(); updateSparklines();
      } else if (S.view === 'analytics') {
        renderAnalytics();
      } else if (S.view === 'scaling') {
        initInstanceChart(); updateInstanceChart(S.latest?.scaling?.instances || 1);
      }
    }, 280);
  });
}

// ─────────────────────────────────────────────────────────
// 🔌 SOCKET.IO — REAL-TIME CONNECTION
// ─────────────────────────────────────────────────────────
function connectSocket() {
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 1000 });
  S.socket = socket;

  socket.on('connect', () => {
    S.connected = true;
    setConnStatus(true);
    toast('📡 WebSocket Connected', 'Live data stream active', 'success');
  });

  socket.on('disconnect', reason => {
    S.connected = false;
    setConnStatus(false);
    toast('⚠️ Disconnected', `Reconnecting… (${reason})`, 'warn');
  });

  socket.on('connect_error', () => setConnStatus(false));

  // ── PRIMARY 1s STREAM ──
  socket.on('systemMetrics', data => {
    if (!S.realtimeOn) return;
    S.latest = data;
    push(S.cpu, data.cpu.load, MAX);
    push(S.pred, data.ai.prediction.nextLoad, MAX);
    push(S.mem, data.memory.usage, MAX);
    push(S.disk, data.disk.io, MAX);
    push(S.net, data.network.mbps, MAX);
    push(S.req, data.performance.requests, 30);
    push(S.rt, data.performance.responseTime, MAX);
    push(S.inst, data.scaling.instances, MAX);
    push(S.cost, data.cost.perHour, MAX);

    updateKPIs(data);
    updateCpuChart();
    updateReqChart();
    updateGauge(data.cpu.load);
    updateAIPanel(data);
    updateHealthBadge(data.system.status);
    updateUptime(data.system.uptime);
    updateClientCount(data.system.clients);
    updateInstanceChart(data.scaling.instances);
    updateSparklines();
    updateThresholdMarkers(data);

    if (S.view === 'analytics') renderAnalytics();
    if (S.view === 'scaling') renderScaling();
  });

  // ── SCALING CONFIG ──
  socket.on('scalingConfig', cfg => {
    S.scalingConfig = cfg;
    syncConfigUI(cfg);
  });

  // ── 🔥 SCALING UPDATE (fires on every scale event) ──
  socket.on('scalingUpdate', ev => {
    S.scalingEvents.unshift(ev);
    if (S.scalingEvents.length > 50) S.scalingEvents.pop();

    handleScalingEvent(ev);
    if (S.view === 'scaling') renderScaling();
  });

  // ── SCALING HISTORY (on connect) ──
  socket.on('scalingHistory', ({ events }) => {
    S.scalingEvents = events;
    if (S.view === 'scaling') renderScaling();
  });

  // ── LOG HISTORY ──
  socket.on('logHistory', ({ logs }) => {
    S.logs = logs;
    if (S.view === 'logs') renderLogs();
    // update summary counts whenever history arrives
    updateLogSummary();
  });
  // Shared handler for incoming single log entries (real-time)
  function handleIncomingLog(l) {
    const entry = Object.assign({ level: 'info', message: '', component: 'SYS', timestamp: Date.now() }, l);
    S.logs.unshift(entry);
    if (S.logs.length > 500) S.logs.pop();
    // update UI
    updateLogSummary();
    if (S.view === 'logs') renderLogs();
  }

  socket.on('log', handleIncomingLog);
  socket.on('logEntry', handleIncomingLog);
  socket.on('logEvent', handleIncomingLog);

  // ── MANUAL SCALE RESULT ──
  socket.on('scaleResult', ({ success, action, instancesAfter }) => {
    if (success) {
      const dir = action === 'up' ? '▲' : '▼';
      toast(`${dir} Manual Scale ${action === 'up' ? 'Up' : 'Down'}`,
        `Now ${instancesAfter} active instance(s)`, 'success');
    }
    enableScaleBtns();
  });

  socket.on('realtimeStatus', ({ enabled }) => {
    S.realtimeOn = enabled;
    updateRealtimeUI(enabled);
  });
}

// ─────────────────────────────────────────────────────────
// 🔥 HANDLE SCALING EVENT — UI reaction
// ─────────────────────────────────────────────────────────
function handleScalingEvent(ev) {
  const isUp = ev.action === 'scale_up';

  // Toast notification
  if (isUp) {
    toast(`🔺 AUTO SCALE UP`, `${ev.instancesBefore} → ${ev.instancesAfter} instances | ${ev.reason}`, 'warn');
  } else {
    toast(`🔻 AUTO SCALE DOWN`, `${ev.instancesBefore} → ${ev.instancesAfter} instances | ${ev.reason}`, 'info');
  }

  // Flash the instance KPI card
  flashCard('kpiInst', isUp ? 'flash-up' : 'flash-down');

  // Flash topbar health badge
  const badge = el('healthBadge');
  if (badge) {
    badge.style.transition = 'all 0.3s';
    badge.style.boxShadow = isUp
      ? '0 0 20px rgba(239,68,68,0.5)'
      : '0 0 20px rgba(34,197,94,0.5)';
    setTimeout(() => { badge.style.boxShadow = ''; }, 1500);
  }

  // Log into scaling view
  const logEl = el('scalingLog');
  if (logEl) {
    const entry = document.createElement('div');
    entry.className = `scale-ev ${isUp ? 'up' : 'down'} new-event`;
    entry.innerHTML = `
      <div class="ev-msg">
        <div class="ev-comp">${isUp ? '🔺' : '🔻'} ${ev.instancesAfter} instance${ev.instancesAfter !== 1 ? 's' : ''}</div>
        ${ev.reason}
      </div>
      <div class="ev-time">${fmtTime(ev.timestamp)}</div>`;
    logEl.prepend(entry);
    setTimeout(() => entry.classList.remove('new-event'), 600);
    // Prune old entries
    while (logEl.children.length > 15) logEl.removeChild(logEl.lastChild);
  }
}

function flashCard(id, cls) {
  const card = el(id);
  if (!card) return;
  card.classList.add(cls);
  setTimeout(() => card.classList.remove(cls), 900);
}

function enableScaleBtns() {
  ['btnScaleUp', 'btnScaleDown', 'btnForceUp', 'btnForceDown'].forEach(id => {
    const b = el(id); if (b) b.disabled = false;
  });
}

// ─────────────────────────────────────────────────────────
// KPI UPDATES
// ─────────────────────────────────────────────────────────
const prevVals = {};
function updateKPIs(d) {
  const cpu = d.cpu.load;
  const mem = d.memory.usage;
  const inst = d.scaling.instances;

  // CPU
  animNum('kCpu', cpu.toFixed(1));
  setBar('kCpuBar', cpu, cpu > 70 ? 'crit' : cpu > 50 ? 'warn' : '');
  setText('kCpuFooter', cpu > 70 ? '⚠ Auto-scaling UP' : cpu < 30 ? '↓ Auto-scaling DOWN' : '✓ Optimal');
  setDelta('kCpuDelta', cpu, prevVals.cpu);
  prevVals.cpu = cpu;

  // Memory
  animNum('kMem', mem.toFixed(1));
  setBar('kMemBar', mem, mem > 85 ? 'crit' : mem > 65 ? 'warn' : '');
  setText('kMemFooter', `${Math.round(d.memory.used)} MB / ${d.memory.total} MB`);
  setDelta('kMemDelta', mem, prevVals.mem);
  prevVals.mem = mem;

  // Instances — animate + flash on change
  if (inst !== prevVals.inst) {
    animNum('kInst', inst);
    renderInstDots(inst, d.scaling.maxInstances);
    prevVals.inst = inst;
  }
  setText('kInstFooter', `Time: ${d.scaling.cooldownRemaining}s | Max: ${d.scaling.maxInstances}`);

  // Network
  animNum('kNet', d.network.mbps.toFixed(1));

  // Response time
  const rt = d.performance.responseTime;
  animNum('kRt', rt);
  setText('kRtFooter', rt < 200 ? '✓ Excellent' : rt < 600 ? '↗ Moderate' : '⚠ Slow');

  // Cost
  setText('kCost', d.cost.perHour.toFixed(3));
  setText('kCostFooter', `Total: ₹${d.cost.total.toFixed(3)}`);

  // ── PERFORMANCE METRICS (Settings page) ──
  // WebSocket Connections
  setText('metricWsConn', d.system.clients || 0);
  
  // Active Instances
  setText('metricInstances', d.scaling.instances || 0);
  
  // Total Requests
  setText('metricReqs', d.performance.requests || 0);
  
  // System Uptime (format as HH:MM:SS)
  const uptimeSecs = d.system.uptime || 0;
  const h = Math.floor(uptimeSecs / 3600);
  const m = Math.floor((uptimeSecs % 3600) / 60);
  const s = uptimeSecs % 60;
  const uptimeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  setText('metricUptime', uptimeStr);
  
  // Avg Response Time (in ms)
  setText('metricRt', `${Math.round(d.performance.responseTime)}ms`);
  
  // Database Latency (simulated from network latency + some offset)
  const dbLatency = Math.round(d.network.mbps * 0.15 + 5 + Math.random() * 10);
  setText('metricDbLat', `${dbLatency}ms`);

  // Threshold alerts (using scaling config values)
  const UP = S.scalingConfig.scaleUpCpu || 70;
  const DN = S.scalingConfig.scaleDownCpu || 30;
  if (cpu > 90 && S.prevCpu <= 90)
    toast('🔴 CRITICAL LOAD', `CPU at ${cpu.toFixed(1)}% — Emergency scaling!`, 'error');
  else if (cpu > UP && S.prevCpu <= UP)
    toast('🔥 Scale-Up Triggered', `CPU ${cpu.toFixed(1)}% > ${UP}% threshold`, 'warn');
  else if (cpu < DN && S.prevCpu >= DN && S.latest?.scaling.instances > 1)
    toast('✅ Scale-Down Triggered', `CPU ${cpu.toFixed(1)}% < ${DN}% — saving costs`, 'info');
  S.prevCpu = cpu;
}

// Smooth number animation
function animNum(id, target) {
  const e = el(id);
  if (!e) return;
  const t = parseFloat(target);
  const c = parseFloat(e.textContent) || 0;
  if (isNaN(t) || Math.abs(t - c) < 0.05) { e.textContent = target; return; }
  const start = performance.now(), dur = 280;
  if (numAnimState[id]) cancelAnimationFrame(numAnimState[id]);
  function step(now) {
    const p = Math.min((now - start) / dur, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    e.textContent = Number.isInteger(t)
      ? Math.round(c + (t - c) * ease)
      : (c + (t - c) * ease).toFixed(1);
    if (p < 1) numAnimState[id] = requestAnimationFrame(step);
    else e.textContent = target;
  }
  numAnimState[id] = requestAnimationFrame(step);
}

function setBar(id, pct, cls) {
  const b = el(id); if (!b) return;
  b.style.width = Math.min(pct, 100) + '%';
  b.className = 'kpi-bar' + (cls ? ' ' + cls : '');
}

function setDelta(id, cur, prv) {
  const e = el(id); if (!e || prv == null) return;
  const d = cur - prv;
  if (Math.abs(d) < 0.3) { e.textContent = ''; return; }
  e.textContent = (d > 0 ? '▲' : '▼') + Math.abs(d).toFixed(1) + '%';
  e.className = 'kpi-delta ' + (d > 0 ? 'up' : 'down');
}

function renderInstDots(active, max = 5) {
  const c = el('instDots'); if (!c) return;
  c.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const d = document.createElement('div');
    d.className = 'inst-dot' + (i < active ? ' on' : '');
    d.title = i < active ? `EC2-${String(i + 1).padStart(2, '0')} RUNNING` : 'Idle';
    c.appendChild(d);
  }
}

// Threshold marker lines on CPU chart
function updateThresholdMarkers(d) {
  setText('threshUp', `↑ ${d.scaling.scaleUpThreshold}%`);
  setText('threshDown', `↓ ${d.scaling.scaleDownThreshold}%`);
}

// ─────────────────────────────────────────────────────────
// SPARKLINES
// ─────────────────────────────────────────────────────────
function initSparklines() {
  ['sparkCpu'].forEach(id => {
    const w = el(id); if (!w) return;
    w.innerHTML = '';
    d3.select(`#${id}`).append('svg').attr('width', '100%').attr('height', 32).attr('id', id + 'Svg');
  });
}
function updateSparklines() { drawSpark('sparkCpu', S.cpu.slice(-20), C.cyan); }
function drawSpark(id, data, color) {
  const svg = d3.select(`#${id}Svg`); if (!svg.node()) return;
  const W = svg.node().parentElement?.clientWidth || 120, H = 32;
  svg.attr('width', W);
  const x = d3.scaleLinear().domain([0, data.length - 1]).range([0, W]);
  const y = d3.scaleLinear().domain([0, 100]).range([H - 2, 2]);
  const line = d3.line().x((_, i) => x(i)).y(d => y(d)).curve(d3.curveCatmullRom);
  const area = d3.area().x((_, i) => x(i)).y0(H).y1(d => y(d)).curve(d3.curveCatmullRom);
  const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');
  const gId = `sg-${id}`;
  if (defs.select(`#${gId}`).empty()) {
    const g = defs.append('linearGradient').attr('id', gId).attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
    g.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', '0.35');
    g.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', '0');
  }
  svg.selectAll('.sp-area').data([data]).join('path').attr('class', 'sp-area').attr('d', area).attr('fill', `url(#${gId})`);
  svg.selectAll('.sp-line').data([data]).join('path').attr('class', 'sp-line').attr('d', line).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.5);
}

// ─────────────────────────────────────────────────────────
// D3 — CPU LINE CHART (with threshold lines)
// ─────────────────────────────────────────────────────────
function initCpuChart() {
  const wrap = el('cpuChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 16, r: 18, b: 32, l: 40 };
  const W = Math.max(wrap.clientWidth, 400), H = 210;
  const w = W - m.l - m.r, h = H - m.t - m.b;

  const svg = d3.select('#cpuChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const lg = defs.append('linearGradient').attr('id', 'cpuLG').attr('x1', '0').attr('x2', '1').attr('y1', '0').attr('y2', '0');
  lg.append('stop').attr('offset', '0%').attr('stop-color', C.indigo);
  lg.append('stop').attr('offset', '100%').attr('stop-color', C.cyan);
  const ag = defs.append('linearGradient').attr('id', 'cpuAG').attr('x1', '0').attr('x2', '0').attr('y1', '0').attr('y2', '1');
  ag.append('stop').attr('offset', '0%').attr('stop-color', C.cyan).attr('stop-opacity', '0.4');
  ag.append('stop').attr('offset', '100%').attr('stop-color', C.indigo).attr('stop-opacity', '0.0');

  const glow = defs.append('filter').attr('id', 'cpuGlow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
  glow.append('feGaussianBlur').attr('stdDeviation', '5').attr('result', 'blur');
  glow.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'blur').attr('operator', 'over');

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  g.append('g').attr('id', 'cpuGridY').attr('class', 'd3-grid');

  // Threshold lines (70% up, 30% down)
  const y = d3.scaleLinear().domain([0, 100]).range([h, 0]);
  g.append('line').attr('id', 'lineUp')
    .attr('x1', 0).attr('x2', w).attr('y1', y(70)).attr('y2', y(70))
    .attr('stroke', C.danger).attr('stroke-dasharray', '4 3').attr('opacity', 0.5).attr('stroke-width', 1);
  g.append('line').attr('id', 'lineDown')
    .attr('x1', 0).attr('x2', w).attr('y1', y(30)).attr('y2', y(30))
    .attr('stroke', C.success).attr('stroke-dasharray', '4 3').attr('opacity', 0.5).attr('stroke-width', 1);
  g.append('text').attr('x', w - 2).attr('y', y(70) - 4).attr('text-anchor', 'end')
    .attr('fill', C.danger).attr('font-size', '9').attr('id', 'threshUpLabel').text('Scale Up 70%');
  g.append('text').attr('x', w - 2).attr('y', y(30) + 11).attr('text-anchor', 'end')
    .attr('fill', C.success).attr('font-size', '9').attr('id', 'threshDownLabel').text('Scale Down 30%');

  g.append('path').attr('id', 'cpuArea').attr('fill', 'url(#cpuAG)');
  g.append('path').attr('id', 'predLine').attr('fill', 'none')
    .attr('stroke', C.warning).attr('stroke-width', '1.5').attr('stroke-dasharray', '5 4').attr('opacity', '0.7');

  g.append('path').attr('id', 'cpuLine').attr('fill', 'none')
    .attr('stroke', 'url(#cpuLG)').attr('stroke-width', '3').attr('stroke-linecap', 'round')
    .attr('filter', 'url(#cpuGlow)');

  g.append('circle').attr('id', 'cpuDot').attr('r', '6')
    .attr('fill', '#fff').attr('stroke', C.cyan).attr('stroke-width', '2.5')
    .attr('filter', 'url(#cpuGlow)');

  g.append('g').attr('class', 'd3-axis').attr('id', 'cpuAxisX').attr('transform', `translate(0,${h})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'cpuAxisY');

  // Tooltip
  const tip = el('cpuTooltip');
  g.append('rect').attr('width', w).attr('height', h).attr('fill', 'none').attr('pointer-events', 'all')
    .on('mousemove', function (evt) {
      const PTS = 30, cs = S.cpu.slice(-PTS); if (!cs.length) return;
      const [mx] = d3.pointer(evt);
      const xSc = d3.scaleLinear().domain([0, PTS - 1]).range([0, w]);
      const idx = Math.max(0, Math.min(Math.round(xSc.invert(mx)), cs.length - 1));
      if (tip) { tip.textContent = `CPU: ${cs[idx]?.toFixed(1)}% | t-${PTS - 1 - idx}s`; tip.classList.add('show'); }
    })
    .on('mouseleave', () => tip?.classList.remove('show'));

  Charts.cpu = { g, w, h };
}

function updateCpuChart() {
  if (!Charts.cpu) return;
  const { g, w, h } = Charts.cpu;
  const PTS = 30;
  const cs = S.cpu.slice(-PTS);
  const ps = S.pred.slice(-PTS);
  const n = cs.length;
  const x = d3.scaleLinear().domain([0, PTS - 1]).range([0, w]);
  const y = d3.scaleLinear().domain([0, 100]).range([h, 0]);

  g.select('#cpuGridY').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat('')).select('.domain').remove();
  g.selectAll('#cpuGridY line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');

  const lineG = d3.line().x((_, i) => x(i + PTS - n)).y(d => y(d)).curve(d3.curveCatmullRom.alpha(0.5));
  const areaG = d3.area().x((_, i) => x(i + PTS - n)).y0(h).y1(d => y(d)).curve(d3.curveCatmullRom.alpha(0.5));

  g.select('#cpuLine').datum(cs).transition().duration(380).attr('d', lineG);
  g.select('#cpuArea').datum(cs).transition().duration(380).attr('d', areaG);
  g.select('#predLine').datum(ps).transition().duration(380).attr('d', lineG);
  if (n > 0) g.select('#cpuDot').transition().duration(380).attr('cx', x(PTS - 1)).attr('cy', y(cs[n - 1]));

  g.select('#cpuAxisX').call(d3.axisBottom(x).ticks(6).tickFormat(d => `-${PTS - 1 - d}s`));
  g.select('#cpuAxisY').call(d3.axisLeft(y).ticks(5).tickFormat(d => d + '%'));
}

// ─────────────────────────────────────────────────────────
// D3 — INSTANCE COUNT MINI CHART
// ─────────────────────────────────────────────────────────
const instHistory = [];
function initInstanceChart() {
  const wrap = el('instChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 15, r: 20, b: 35, l: 40 };
  const W = Math.max(wrap.clientWidth, 400), H = 220;
  const w = W - m.l - m.r, h = H - m.t - m.b;

  const svg = d3.select('#instChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');

  // Local gradient to avoid dependency issues
  const lg = defs.append('linearGradient').attr('id', 'instLG').attr('x1', '0').attr('x2', '0').attr('y1', '0').attr('y2', '1');
  lg.append('stop').attr('offset', '0%').attr('stop-color', C.cyan).attr('stop-opacity', 0.25);
  lg.append('stop').attr('offset', '100%').attr('stop-color', C.indigo).attr('stop-opacity', 0);

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);

  // Grid
  g.append('g').attr('id', 'instGridY').attr('class', 'd3-grid');

  g.append('path').attr('id', 'instArea').attr('fill', 'url(#instLG)');
  g.append('path').attr('id', 'instLine').attr('fill', 'none')
    .attr('stroke', C.cyan).attr('stroke-width', '3').attr('stroke-linecap', 'round');

  g.append('g').attr('class', 'd3-axis').attr('id', 'instAxisX').attr('transform', `translate(0,${h})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'instAxisY');

  Charts.instChart = { g, w, h };
}

function updateInstanceChart(inst) {
  push(instHistory, inst, 30);
  if (!Charts.instChart) return;
  const { g, w, h } = Charts.instChart;
  const data = instHistory;
  const n = data.length;
  const max = S.scalingConfig.maxInstances || 5;

  const x = d3.scaleLinear().domain([0, 29]).range([0, w]);
  const y = d3.scaleLinear().domain([0, max]).range([h, 0]);

  // Horizontal Grid Lines
  g.select('#instGridY').call(d3.axisLeft(y).ticks(max).tickSize(-w).tickFormat(''))
    .selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('#instGridY .domain').remove();

  const lineG = d3.line().x((_, i) => x(i + 30 - n)).y(d => y(d)).curve(d3.curveStepAfter);
  const areaG = d3.area().x((_, i) => x(i + 30 - n)).y0(h).y1(d => y(d)).curve(d3.curveStepAfter);

  g.select('#instLine').datum(data).transition().duration(250).attr('d', lineG);
  g.select('#instArea').datum(data).transition().duration(250).attr('d', areaG);

  g.select('#instAxisX').call(d3.axisBottom(x).ticks(5).tickFormat(d => `-${29 - d}s`)).select('.domain').remove();
  g.select('#instAxisY').call(d3.axisLeft(y).ticks(max).tickFormat(d => Math.round(d))).select('.domain').remove();
}

// ─────────────────────────────────────────────────────────
// D3 — REQUEST BAR CHART
// ─────────────────────────────────────────────────────────
function initReqChart() {
  const wrap = el('reqChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 15, r: 10, b: 25, l: 38 };
  const W = Math.max(wrap.clientWidth, 260), H = 180;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const svg = d3.select('#reqChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');

  const areaGrad = defs.append('linearGradient').attr('id', 'reqAreaGrad').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  areaGrad.append('stop').attr('offset', '0%').attr('stop-color', C.cyan).attr('stop-opacity', 0.5);
  areaGrad.append('stop').attr('offset', '100%').attr('stop-color', C.cyan).attr('stop-opacity', 0.0);

  const glow = defs.append('filter').attr('id', 'reqGlow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
  glow.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
  glow.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'blur').attr('operator', 'over');

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  g.append('g').attr('class', 'req-grid-y');

  g.append('path').attr('id', 'reqArea').attr('fill', 'url(#reqAreaGrad)');
  g.append('path').attr('id', 'reqLine').attr('fill', 'none').attr('stroke', C.cyan).attr('stroke-width', 3).attr('filter', 'url(#reqGlow)');

  g.append('g').attr('class', 'd3-axis').attr('id', 'reqAxisX').attr('transform', `translate(0,${h})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'reqAxisY');
  g.append('g').attr('id', 'reqDots');

  Charts.req = { g, w, h };
}

function updateReqChart() {
  if (!Charts.req) return;
  const { g, w, h } = Charts.req;
  const data = S.req.slice(-30).map((v, i) => ({ i, v }));

  const x = d3.scaleLinear().domain([0, Math.max(1, data.length - 1)]).range([0, w]);
  const maxV = Math.max(d3.max(data, d => d.v) || 10);
  const y = d3.scaleLinear().domain([0, maxV * 1.15]).range([h, 0]);

  const lineFunc = d3.line().x(d => x(d.i)).y(d => y(d.v)).curve(d3.curveMonotoneX);
  const areaFunc = d3.area().x(d => x(d.i)).y0(h).y1(d => y(d.v)).curve(d3.curveMonotoneX);

  g.select('#reqLine').datum(data).transition().duration(400).ease(d3.easeLinear).attr('d', lineFunc);
  g.select('#reqArea').datum(data).transition().duration(400).ease(d3.easeLinear).attr('d', areaFunc);

  const dots = g.select('#reqDots').selectAll('circle').data(data.slice(-1));
  dots.enter().append('circle').attr('r', 5).attr('fill', '#fff').attr('stroke', C.cyan).attr('stroke-width', 2).attr('filter', 'url(#reqGlow)')
    .merge(dots).transition().duration(400).ease(d3.easeLinear)
    .attr('cx', d => x(d.i)).attr('cy', d => y(d.v));

  g.select('.req-grid-y').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat('')).selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.req-grid-y').select('.domain').remove();

  g.select('#reqAxisX').call(d3.axisBottom(x).ticks(6).tickFormat(d => `-${data.length - 1 - d}s`)).select('.domain').remove();
  g.select('#reqAxisY').call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('d'))).select('.domain').remove();

  if (S.latest) setText('totalReqBadge', `${S.latest.performance.requests} total`);
}

// ─────────────────────────────────────────────────────────
// D3 — CIRCULAR GAUGE
// ─────────────────────────────────────────────────────────
function initGauge() {
  const svg = d3.select('#gaugeRing');
  svg.html('');
  const R = 80, cx = 95, cy = 95, tau = 2 * Math.PI, sAng = -tau * 0.375;
  const defs = svg.append('defs');

  const glow = defs.append('filter').attr('id', 'gaugeGlow').attr('x', '-30%').attr('y', '-30%').attr('width', '160%').attr('height', '160%');
  glow.append('feGaussianBlur').attr('stdDeviation', '6').attr('result', 'blur');
  glow.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'blur').attr('operator', 'over');

  const ticksBg = svg.append('g').attr('transform', `translate(${cx},${cy})`);
  const tickCount = 42;
  const step = (tau * 0.75) / tickCount;
  for (let i = 0; i < tickCount; i++) {
    const a1 = sAng + i * step;
    const a2 = sAng + (i + 0.6) * step;
    ticksBg.append('path')
      .datum({ s: a1, e: a2 })
      .attr('d', d3.arc().innerRadius(R - 10).outerRadius(R).startAngle(d => d.s).endAngle(d => d.e))
      .attr('fill', 'rgba(255,255,255,0.06)');
  }

  svg.append('path')
    .datum({ s: sAng, e: sAng + tau * 0.75 })
    .attr('d', d3.arc().innerRadius(R - 20).outerRadius(R - 16).startAngle(d => d.s).endAngle(d => d.e).cornerRadius(2))
    .attr('fill', 'rgba(255,255,255,0.04)')
    .attr('transform', `translate(${cx},${cy})`);

  svg.append('path').attr('id', 'gaugeFg').attr('transform', `translate(${cx},${cy})`);
  svg.append('circle').attr('id', 'gaugeDot').attr('r', 6).attr('cx', cx).attr('cy', cy).attr('fill', '#fff').attr('filter', 'url(#gaugeGlow)');

  Charts.gauge = { svg, cx, cy, R, tau, sAng };
}

function updateGauge(load) {
  if (!Charts.gauge) return;
  const { tau, sAng, cx, cy, R } = Charts.gauge;
  const col = load > 75 ? C.danger : load > 50 ? C.warning : C.cyan;
  const pct = Math.min(Math.max(load / 100, 0), 1);
  const endA = sAng + tau * 0.75 * pct;

  d3.select('#gaugeFg').datum({ s: sAng, e: endA })
    .transition().duration(500).ease(d3.easeBounceOut)
    .attr('d', d3.arc().innerRadius(R - 20).outerRadius(R - 16).startAngle(d => d.s).endAngle(d => d.e).cornerRadius(4))
    .attr('fill', col).attr('filter', `drop-shadow(0 0 12px ${col}A0)`);

  d3.select('#gaugeDot').transition().duration(500).ease(d3.easeBounceOut)
    .attr('cx', cx + Math.sin(endA) * (R - 18))
    .attr('cy', cy - Math.cos(endA) * (R - 18))
    .attr('fill', col);

  setText('gaugeNum', Math.round(load));
  const gs = el('gaugeState');
  if (gs) { gs.textContent = load > 75 ? 'CRITICAL' : load > 50 ? 'WARNING' : 'NORMAL'; gs.style.color = col; }
}



// ─────────────────────────────────────────────────────────
// AI PANEL
// ─────────────────────────────────────────────────────────
function updateAIPanel(d) {
  const ai = d.ai.prediction;
  const conf = Math.round(ai.confidence * 100);
  animNum('aiPredLoad', ai.nextLoad);
  setText('aiConf', conf);
  setText('aiCooldown', d.scaling.cooldownRemaining + 's');
  setText('aiErr', d.performance.errorRate.toFixed(2) + '%');
  const aMap = {
    stable: { label: '✓ Stable', color: 'var(--success)' },
    scale_up: { label: '▲ Scale Up', color: 'var(--danger)' },
    scale_down: { label: '▼ Scale Down', color: 'var(--info)' },
    prepare_scale_up: { label: '⚡ Pre-Scale', color: 'var(--warning)' },
  };
  const ai_info = aMap[ai.action] || aMap.stable;
  const aEl = el('aiAction');
  if (aEl) { aEl.textContent = ai_info.label; aEl.style.color = ai_info.color; }
  const fill = el('confFill');
  if (fill) fill.style.width = conf + '%';
}

// Config sync from server
function syncConfigUI(cfg) {
  const up = el('cfgUp'), upV = el('cfgUpVal');
  const dn = el('cfgDown'), dnV = el('cfgDownVal');
  const mx = el('cfgMax'), mxV = el('cfgMaxVal');
  if (up && cfg.scaleUpCpu) { up.value = cfg.scaleUpCpu; if (upV) upV.textContent = cfg.scaleUpCpu + '%'; }
  if (dn && cfg.scaleDownCpu) { dn.value = cfg.scaleDownCpu; if (dnV) dnV.textContent = cfg.scaleDownCpu + '%'; }
  if (mx && cfg.maxInstances) { mx.value = cfg.maxInstances; if (mxV) mxV.textContent = cfg.maxInstances; }
}

// ─────────────────────────────────────────────────────────
// HEALTH + UPTIME + CONN
// ─────────────────────────────────────────────────────────
function updateHealthBadge(status) {
  const b = el('healthBadge'), t = el('healthLabel');
  if (!b || !t) return;
  b.className = 'health-badge';
  if (status === 'critical') { b.classList.add('crit'); t.textContent = 'Critical Load'; }
  else if (status === 'warning') { b.classList.add('warn'); t.textContent = 'High Load'; }
  else t.textContent = 'System Healthy';
}
function updateUptime(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  setText('uptimeBadge', h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`);
}
function updateClientCount(count) { setText('clientCount', count + ' online'); }
function setConnStatus(ok) {
  const dot = el('connDot'), txt = el('connText'), dbDot = el('dbDot'), dbLbl = el('dbLabel');
  if (dot) dot.className = 'conn-dot ' + (ok ? 'on' : 'off');
  if (txt) txt.textContent = ok ? 'Connected' : 'Disconnected';
  if (ok) { dbDot?.classList.add('ok'); if (dbLbl) dbLbl.textContent = 'MongoDB Connected'; }
  else { dbDot?.classList.remove('ok'); if (dbLbl) dbLbl.textContent = 'Reconnecting…'; }
}

// ─────────────────────────────────────────────────────────
// REALTIME TOGGLE
// ─────────────────────────────────────────────────────────
function setupRealtimeToggle() {
  el('realtimeToggle')?.addEventListener('click', () => {
    S.realtimeOn = !S.realtimeOn;
    S.socket?.emit('toggleRealtime', { enabled: S.realtimeOn });
    updateRealtimeUI(S.realtimeOn);
    toast(S.realtimeOn ? '▶ Real-time ON' : '⏸ Real-time PAUSED',
      S.realtimeOn ? 'Live data resumed' : 'Stream frozen', 'info');
  });
}
function updateRealtimeUI(on) {
  const btn = el('realtimeToggle'), led = el('realtimeLed');
  if (btn) { btn.textContent = on ? '⏸ Pause' : '▶ Resume'; btn.className = 'rt-toggle-btn ' + (on ? 'active' : 'paused'); }
  if (led) led.className = 'rt-led ' + (on ? 'on' : 'off');
}

// ─────────────────────────────────────────────────────────
// LOAD GENERATOR
// ─────────────────────────────────────────────────────────
async function generateLoad(intensity) {
  const ids = { 0.3: 'btnLight', 0.7: 'btnMedium', 1.5: 'btnHeavy' };
  const btn = el(ids[intensity]); if (btn) btn.disabled = true;
  const label = intensity < 0.5 ? 'Light' : intensity < 1 ? 'Medium' : 'Heavy';
  setText('ctrlStatus', `⚡ Firing ${label} load…`);
  toast(`⚡ ${label} Load`, `Simulating ${intensity}x spike`, 'warn');
  try {
    const res = await fetch(`/api/load?intensity=${intensity}`);
    const d = await res.json();
    toast('🔥 Spike Applied', `CPU +${d.cpuIncrease?.toFixed(1)}% in ${d.computationMs}ms`, 'warn');
    setText('ctrlStatus', `Done — +${d.cpuIncrease?.toFixed(1)}% CPU | ${d.computationMs}ms`);
  } catch {
    toast('❌ Load Failed', 'Server unreachable', 'error');
    setText('ctrlStatus', 'Load generation failed');
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; setText('ctrlStatus', 'Ready to generate load…'); }, 2500);
  }
}

// ─────────────────────────────────────────────────────────
// MANUAL SCALING
// ─────────────────────────────────────────────────────────
function manualScale(action) {
  const btnId = action === 'up' ? 'btnScaleUp' : 'btnScaleDown';
  const btn = el(btnId); if (btn) btn.disabled = true;
  if (S.socket?.connected) {
    S.socket.emit('manualScale', { action, count: 1 });
  } else {
    fetch('/api/scale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      .then(r => r.json()).then(d => {
        if (d.success) toast(action === 'up' ? '▲ Scaled Up' : '▼ Scaled Down', `${d.instances} instances`, 'success');
        else toast('⚠ Limit', d.message, 'warn');
      }).catch(() => toast('❌ Scale Failed', 'Server error', 'error'))
      .finally(() => setTimeout(() => { if (btn) btn.disabled = false; }, 1500));
  }
}

// Force scale (bypasses cooldown via REST)
async function forceScale(direction) {
  const btnId = direction === 'up' ? 'btnForceUp' : 'btnForceDown';
  const btn = el(btnId); if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/scale-${direction}`, { method: 'POST' });
    const d = await res.json();
    if (d.success) toast(`🔺 Force Scale ${direction === 'up' ? 'Up' : 'Down'}`, d.message, 'warn');
    else toast('⚠ Blocked', d.message, 'info');
  } catch {
    toast('❌ Failed', 'Server error', 'error');
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 2000);
  }
}

// ─────────────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// HISTORICAL ANALYTICS ENGINE
// ─────────────────────────────────────────────────────────
let histRange = 'live';
let histData = null;
let histFetchTimer = null;

function setupHistTabs() {
  document.querySelectorAll('.hist-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.hist-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      histRange = tab.dataset.range;
      const liveTag = el('histLiveTag');
      const srcLabel = el('histSourceLabel');
      if (histRange === 'live') {
        if (liveTag) liveTag.style.display = '';
        if (srcLabel) srcLabel.textContent = 'WebSocket · Live';
        setText('histChartSub', 'CPU · Memory · Network — last 30s via WebSocket');
        setText('sDataSource', 'WebSocket');
        clearInterval(histFetchTimer);
        renderAnalytics();
      } else {
        if (liveTag) liveTag.style.display = 'none';
        const labels = { '1h': '1 Hour', '6h': '6 Hours', '24h': '24 Hours', '7d': '7 Days' };
        if (srcLabel) srcLabel.textContent = `MongoDB · ${labels[histRange]}`;
        setText('histChartSub', `CPU · Memory · Network — last ${labels[histRange]} from database`);
        setText('sDataSource', 'MongoDB');
        fetchHistoricalData();
        // Auto-refresh historical data every 15s
        clearInterval(histFetchTimer);
        histFetchTimer = setInterval(fetchHistoricalData, 15000);
      }
    });
  });
}

async function fetchHistoricalData() {
  try {
    const [metricsRes, eventsRes, summaryRes] = await Promise.all([
      fetch(`/api/metrics/history/detailed?range=${histRange}&limit=300`),
      fetch(`/api/scaling/events/history?limit=50`),
      fetch(`/api/analytics/summary`),
    ]);
    const metrics = await metricsRes.json();
    const events = await eventsRes.json();
    const summary = await summaryRes.json();
    histData = { metrics: metrics.metrics || [], events: events.events || [], summary };
    renderHistoricalAnalytics();
  } catch (e) {
    console.error('Historical fetch error:', e);
    toast('⚠️ History Fetch Failed', 'Using cached data', 'warn');
  }
}

function renderAnalytics() {
  if (!S.latest) return;
  const d = S.latest, hist = S.cpu.slice(-30);

  // Stats table
  setText('sAvgCpu', hist.length ? (hist.reduce((a, b) => a + b, 0) / hist.length).toFixed(1) + '%' : '--');
  setText('sPeakCpu', hist.length ? Math.max(...hist).toFixed(1) + '%' : '--');
  setText('sMinCpu', hist.length ? Math.min(...hist).toFixed(1) + '%' : '--');
  setText('sTotalReq', d.performance.requests);
  setText('sReqPerMin', Math.round((d.performance.requests / Math.max(d.system.uptime, 1)) * 60));
  setText('sTotalCost', '₹' + d.cost.total.toFixed(4));
  setText('sInstances', d.scaling.instances);

  if (histRange === 'live') {
    renderLiveHistCharts();
    updateHistKPIsLive(d, hist);
    renderHistScaleLog(S.scalingEvents);
  }
}

function updateHistKPIsLive(d, hist) {
  setText('hkAvgCpu', hist.length ? (hist.reduce((a, b) => a + b, 0) / hist.length).toFixed(1) + '%' : '--');
  setText('hkPeakCpu', hist.length ? Math.max(...hist).toFixed(1) + '%' : '--');
  const memHist = S.mem.slice(-30);
  setText('hkAvgMem', memHist.length ? (memHist.reduce((a, b) => a + b, 0) / memHist.length).toFixed(1) + '%' : '--');
  setText('hkAvgRt', d.performance.responseTime + 'ms');
  setText('hkTotalCost', '₹' + d.cost.total.toFixed(3));
  const upEvents = S.scalingEvents.filter(e => e.action === 'scale_up').length;
  const downEvents = S.scalingEvents.filter(e => e.action === 'scale_down').length;
  setText('hkScaleEvents', upEvents + downEvents);
  setText('histScaleUp', '▲ ' + upEvents);
  setText('histScaleDown', '▼ ' + downEvents);
  const maxCost = (S.scalingConfig.maxInstances || 5) * 7.05;
  const actualCost = d.scaling.instances * 7.05;
  const savings = maxCost > 0 ? ((1 - actualCost / maxCost) * 100).toFixed(0) : 0;
  setText('hkSavings', savings + '%');
  setText('hkErrorRate', d.performance.errorRate.toFixed(2) + '%');
  setText('histCostBadge', '₹' + d.cost.perHour.toFixed(3) + '/hr');
}

function renderHistoricalAnalytics() {
  if (!histData) return;
  const { metrics, events, summary } = histData;

  // Update KPIs from summary
  setText('hkAvgCpu', summary.avgCpu + '%');
  setText('hkPeakCpu', summary.peakCpu + '%');
  setText('hkAvgMem', summary.avgMemory + '%');
  setText('hkAvgRt', summary.avgResponseTime + 'ms');
  setText('hkTotalCost', '₹' + summary.totalCost.toFixed(3));
  setText('hkScaleEvents', summary.scaleUpEvents + summary.scaleDownEvents);
  setText('histScaleUp', '▲ ' + summary.scaleUpEvents);
  setText('histScaleDown', '▼ ' + summary.scaleDownEvents);
  setText('hkSavings', summary.costSavingsPercent + '%');
  setText('hkErrorRate', summary.errorRate.toFixed(2) + '%');
  setText('histCostBadge', '₹' + summary.costPerHour.toFixed(3) + '/hr');

  // Stats table
  setText('sAvgCpu', summary.avgCpu + '%');
  setText('sPeakCpu', summary.peakCpu + '%');
  setText('sMinCpu', '--');
  setText('sTotalReq', summary.totalRequests);
  setText('sReqPerMin', Math.round((summary.totalRequests / Math.max(summary.uptime, 1)) * 60));
  setText('sTotalCost', '₹' + summary.totalCost.toFixed(4));
  setText('sInstances', summary.activeInstances);

  // Render historical charts
  if (metrics.length > 0) {
    renderHistResourceChart(metrics);
    renderHistCostChart(metrics);
    renderHistScaleChart(metrics);
    renderHistRtChart(metrics);
  }

  renderHistScaleLog(events);
}

// ─────────────────────────────────────────────────────────
// LIVE MODE CHARTS (WebSocket data)
// ─────────────────────────────────────────────────────────
function renderLiveHistCharts() {
  const n = Math.min(S.cpu.length, S.mem.length, S.net.length, S.rt.length || 1, 30);
  if (n < 2) return;
  const cpuD = S.cpu.slice(-n), memD = S.mem.slice(-n), netD = S.net.slice(-n);
  const rtD = S.rt.slice(-n), instD = S.inst.slice(-n), costD = S.cost.slice(-n);

  // Build metric objects from ACTUAL per-tick history
  const liveMetrics = cpuD.map((cpu, i) => ({
    cpuLoad: cpu,
    memoryUsage: memD[i],
    networkMbps: netD[i],
    responseTime: rtD[i] || 100,
    instances: instD[i] || 1,
    costPerHour: costD[i] || 7.05,
    timestamp: new Date(Date.now() - (n - i) * 1000),
  }));

  renderHistResourceChart(liveMetrics);
  renderHistCostChart(liveMetrics);
  renderHistScaleChart(liveMetrics);
  renderHistRtChart(liveMetrics);
}

// ─────────────────────────────────────────────────────────
// D3 — HISTORICAL RESOURCE CHART (CPU + Memory + Network)
// ─────────────────────────────────────────────────────────
function renderHistResourceChart(metrics) {
  const wrap = el('histResourceChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 18, r: 50, b: 36, l: 44 };
  const W = Math.max(wrap.clientWidth, 500), H = 260;
  const w = W - m.l - m.r, h = H - m.t - m.b;

  const svg = d3.select('#histResourceChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');

  // CPU gradient
  const cpuGrad = defs.append('linearGradient').attr('id', 'hrcCpuG').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  cpuGrad.append('stop').attr('offset', '0%').attr('stop-color', C.indigo).attr('stop-opacity', 0.4);
  cpuGrad.append('stop').attr('offset', '100%').attr('stop-color', C.indigo).attr('stop-opacity', 0.0);

  // Glow filter
  const glow = defs.append('filter').attr('id', 'hrcGlow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
  glow.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'b');
  glow.append('feComposite').attr('in', 'SourceGraphic').attr('in2', 'b').attr('operator', 'over');

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  const n = metrics.length;

  const x = d3.scaleLinear().domain([0, n - 1]).range([0, w]);
  const y = d3.scaleLinear().domain([0, 100]).range([h, 0]);
  const yNet = d3.scaleLinear().domain([0, d3.max(metrics, d => d.networkMbps || 100) * 1.2 || 200]).range([h, 0]);

  // Grid
  g.append('g').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(''))
    .selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.domain').remove();

  // CPU Area
  const cpuArea = d3.area().x((_, i) => x(i)).y0(h).y1(d => y(d.cpuLoad || 0)).curve(d3.curveCatmullRom);
  g.append('path').datum(metrics).attr('d', cpuArea).attr('fill', 'url(#hrcCpuG)');

  // CPU Line
  const cpuLine = d3.line().x((_, i) => x(i)).y(d => y(d.cpuLoad || 0)).curve(d3.curveCatmullRom);
  g.append('path').datum(metrics).attr('d', cpuLine).attr('fill', 'none')
    .attr('stroke', C.indigo).attr('stroke-width', 2.5).attr('stroke-linecap', 'round').attr('filter', 'url(#hrcGlow)');

  // Memory Line
  const memLine = d3.line().x((_, i) => x(i)).y(d => y(d.memoryUsage || 0)).curve(d3.curveCatmullRom);
  g.append('path').datum(metrics).attr('d', memLine).attr('fill', 'none')
    .attr('stroke', C.danger).attr('stroke-width', 2).attr('opacity', 0.8);

  // Network Line (secondary Y axis)
  const netLine = d3.line().x((_, i) => x(i)).y(d => yNet(d.networkMbps || 0)).curve(d3.curveCatmullRom);
  g.append('path').datum(metrics).attr('d', netLine).attr('fill', 'none')
    .attr('stroke', C.cyan).attr('stroke-width', 1.8).attr('opacity', 0.7).attr('stroke-dasharray', '4 2');

  // End dots
  if (n > 0) {
    const last = metrics[n - 1];
    g.append('circle').attr('cx', x(n - 1)).attr('cy', y(last.cpuLoad || 0)).attr('r', 5)
      .attr('fill', '#fff').attr('stroke', C.indigo).attr('stroke-width', 2).attr('filter', 'url(#hrcGlow)');
    g.append('circle').attr('cx', x(n - 1)).attr('cy', y(last.memoryUsage || 0)).attr('r', 4)
      .attr('fill', '#fff').attr('stroke', C.danger).attr('stroke-width', 2);
  }

  // Axes
  const isLive = histRange === 'live';
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d => {
      if (isLive) return `-${n - 1 - Math.round(d)}s`;
      const ts = metrics[Math.min(Math.round(d), n - 1)]?.timestamp;
      return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    }));
  g.append('g').attr('class', 'd3-axis').call(d3.axisLeft(y).ticks(5).tickFormat(d => d + '%'));
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(${w},0)`)
    .call(d3.axisRight(yNet).ticks(4).tickFormat(d => Math.round(d) + 'Mbps'))
    .selectAll('text').attr('fill', C.cyan).attr('font-size', '9px');

  // Interactive hover
  const tip = el('histResourceTooltip');
  g.append('rect').attr('width', w).attr('height', h).attr('fill', 'none').attr('pointer-events', 'all')
    .on('mousemove', function (evt) {
      const [mx] = d3.pointer(evt);
      const idx = Math.max(0, Math.min(Math.round(x.invert(mx)), n - 1));
      const pt = metrics[idx];
      if (tip && pt) {
        tip.textContent = `CPU: ${(pt.cpuLoad || 0).toFixed(1)}% | Mem: ${(pt.memoryUsage || 0).toFixed(1)}% | Net: ${(pt.networkMbps || 0).toFixed(1)} Mbps`;
        tip.classList.add('show');
      }
    })
    .on('mouseleave', () => tip?.classList.remove('show'));
}

// ─────────────────────────────────────────────────────────
// D3 — COST ANALYTICS CHART
// ─────────────────────────────────────────────────────────
function renderHistCostChart(metrics) {
  const wrap = el('histCostChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 14, r: 14, b: 30, l: 44 };
  const W = Math.max(wrap.clientWidth, 260), H = 200;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const n = metrics.length;

  const svg = d3.select('#histCostChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const costGrad = defs.append('linearGradient').attr('id', 'costG').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  costGrad.append('stop').attr('offset', '0%').attr('stop-color', C.success).attr('stop-opacity', 0.35);
  costGrad.append('stop').attr('offset', '100%').attr('stop-color', C.success).attr('stop-opacity', 0.0);

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  const costData = metrics.map(m => (m.instances || 1) * 7.05);
  const x = d3.scaleLinear().domain([0, n - 1]).range([0, w]);
  const maxC = Math.max(d3.max(costData) || 10, 10);
  const y = d3.scaleLinear().domain([0, maxC * 1.15]).range([h, 0]);

  // Grid
  g.append('g').call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat('')).selectAll('line')
    .attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.domain').remove();

  // Area
  const area = d3.area().x((_, i) => x(i)).y0(h).y1(d => y(d)).curve(d3.curveMonotoneX);
  g.append('path').datum(costData).attr('d', area).attr('fill', 'url(#costG)');

  // Line
  const line = d3.line().x((_, i) => x(i)).y(d => y(d)).curve(d3.curveMonotoneX);
  g.append('path').datum(costData).attr('d', line).attr('fill', 'none')
    .attr('stroke', C.success).attr('stroke-width', 2.5).attr('stroke-linecap', 'round');

  // End dot
  if (n > 0) {
    g.append('circle').attr('cx', x(n - 1)).attr('cy', y(costData[n - 1])).attr('r', 4)
      .attr('fill', '#fff').attr('stroke', C.success).attr('stroke-width', 2);
  }

  // Axes
  const isLive = histRange === 'live';
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d => {
      if (isLive) return `-${n - 1 - Math.round(d)}s`;
      const ts = metrics[Math.min(Math.round(d), n - 1)]?.timestamp;
      return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    }));
  g.append('g').attr('class', 'd3-axis').call(d3.axisLeft(y).ticks(4).tickFormat(d => '₹' + d.toFixed(1)));
}

// ─────────────────────────────────────────────────────────
// D3 — SCALING TIMELINE (Instance Count Step Chart)
// ─────────────────────────────────────────────────────────
function renderHistScaleChart(metrics) {
  const wrap = el('histScaleChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 12, r: 12, b: 30, l: 38 };
  const W = Math.max(wrap.clientWidth, 260), H = 200;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const n = metrics.length;

  const svg = d3.select('#histScaleChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const scaleGrad = defs.append('linearGradient').attr('id', 'scaleG').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  scaleGrad.append('stop').attr('offset', '0%').attr('stop-color', C.indigo).attr('stop-opacity', 0.25);
  scaleGrad.append('stop').attr('offset', '100%').attr('stop-color', C.indigo).attr('stop-opacity', 0.0);

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  const instData = metrics.map(m => m.instances || 1);
  const maxI = Math.max(d3.max(instData) || 5, 5);
  const x = d3.scaleLinear().domain([0, n - 1]).range([0, w]);
  const y = d3.scaleLinear().domain([0, maxI]).range([h, 0]);

  // Grid
  g.append('g').call(d3.axisLeft(y).ticks(maxI).tickSize(-w).tickFormat(''))
    .selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.domain').remove();

  // Step Area
  const area = d3.area().x((_, i) => x(i)).y0(h).y1(d => y(d)).curve(d3.curveStepAfter);
  g.append('path').datum(instData).attr('d', area).attr('fill', 'url(#scaleG)');

  // Step Line
  const line = d3.line().x((_, i) => x(i)).y(d => y(d)).curve(d3.curveStepAfter);
  g.append('path').datum(instData).attr('d', line).attr('fill', 'none')
    .attr('stroke', C.indigo).attr('stroke-width', 2.5).attr('stroke-linecap', 'round');

  // Change dots — highlight scale events
  for (let i = 1; i < n; i++) {
    if (instData[i] !== instData[i - 1]) {
      const isUp = instData[i] > instData[i - 1];
      g.append('circle').attr('cx', x(i)).attr('cy', y(instData[i])).attr('r', 5)
        .attr('fill', isUp ? C.danger : C.success)
        .attr('stroke', '#fff').attr('stroke-width', 1.5)
        .attr('opacity', 0.9);
    }
  }

  // Axes
  const isLive = histRange === 'live';
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d => {
      if (isLive) return `-${n - 1 - Math.round(d)}s`;
      const ts = metrics[Math.min(Math.round(d), n - 1)]?.timestamp;
      return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    }));
  g.append('g').attr('class', 'd3-axis').call(d3.axisLeft(y).ticks(maxI).tickFormat(d => Math.round(d)));
}

// ─────────────────────────────────────────────────────────
// D3 — RESPONSE TIME TREND WITH P95 BAND
// ─────────────────────────────────────────────────────────
function renderHistRtChart(metrics) {
  const wrap = el('histRtChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 14, r: 18, b: 36, l: 48 };
  const W = Math.max(wrap.clientWidth, 500), H = 200;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const n = metrics.length;

  const svg = d3.select('#histRtChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const rtGrad = defs.append('linearGradient').attr('id', 'rtG').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  rtGrad.append('stop').attr('offset', '0%').attr('stop-color', C.warning).attr('stop-opacity', 0.25);
  rtGrad.append('stop').attr('offset', '100%').attr('stop-color', C.warning).attr('stop-opacity', 0.0);

  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  const rtData = metrics.map(m => m.responseTime || 100);
  const maxRt = Math.max(d3.max(rtData) || 200, 200);
  const x = d3.scaleLinear().domain([0, n - 1]).range([0, w]);
  const y = d3.scaleLinear().domain([0, maxRt * 1.2]).range([h, 0]);

  // Grid
  g.append('g').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(''))
    .selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.domain').remove();

  // P95 band (approximate: 1.3x average)
  const windowSize = Math.max(5, Math.floor(n / 10));
  const p95Data = rtData.map((v, i) => {
    const start = Math.max(0, i - windowSize);
    const window = rtData.slice(start, i + 1);
    const sorted = [...window].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || v * 1.3;
  });
  const p5Data = rtData.map((v, i) => {
    const start = Math.max(0, i - windowSize);
    const window = rtData.slice(start, i + 1);
    const sorted = [...window].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.05)] || v * 0.7;
  });

  // P95 band area
  const bandArea = d3.area()
    .x((_, i) => x(i)).y0((_, i) => y(p5Data[i])).y1((_, i) => y(p95Data[i]))
    .curve(d3.curveCatmullRom);
  g.append('path').datum(rtData).attr('d', bandArea)
    .attr('fill', 'rgba(250, 204, 21, 0.08)').attr('stroke', 'none');

  // RT Area
  const area = d3.area().x((_, i) => x(i)).y0(h).y1(d => y(d)).curve(d3.curveCatmullRom);
  g.append('path').datum(rtData).attr('d', area).attr('fill', 'url(#rtG)');

  // RT Line
  const line = d3.line().x((_, i) => x(i)).y(d => y(d)).curve(d3.curveCatmullRom);
  g.append('path').datum(rtData).attr('d', line).attr('fill', 'none')
    .attr('stroke', C.warning).attr('stroke-width', 2.5).attr('stroke-linecap', 'round');

  // Threshold line at 500ms (SLA)
  if (maxRt > 400) {
    g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(500)).attr('y2', y(500))
      .attr('stroke', C.danger).attr('stroke-dasharray', '4 3').attr('opacity', 0.5).attr('stroke-width', 1);
    g.append('text').attr('x', w - 2).attr('y', y(500) - 4).attr('text-anchor', 'end')
      .attr('fill', C.danger).attr('font-size', '9').text('SLA 500ms');
  }

  // End dot
  if (n > 0) {
    g.append('circle').attr('cx', x(n - 1)).attr('cy', y(rtData[n - 1])).attr('r', 4)
      .attr('fill', '#fff').attr('stroke', C.warning).attr('stroke-width', 2);
  }

  // Axes
  const isLive = histRange === 'live';
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d => {
      if (isLive) return `-${n - 1 - Math.round(d)}s`;
      const ts = metrics[Math.min(Math.round(d), n - 1)]?.timestamp;
      return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    }));
  g.append('g').attr('class', 'd3-axis').call(d3.axisLeft(y).ticks(5).tickFormat(d => d + 'ms'));
}

// ─────────────────────────────────────────────────────────
// SCALING EVENT LOG RENDERER
// ─────────────────────────────────────────────────────────
function renderHistScaleLog(events) {
  const logEl = el('histScaleLog'); if (!logEl) return;
  if (!events || events.length === 0) {
    logEl.innerHTML = '<div style="color:var(--t3);padding:20px;text-align:center;font-size:13px;">No scaling events yet</div>';
    setText('histEventsSub', '0 events recorded');
    return;
  }
  setText('histEventsSub', events.length + ' events recorded');
  logEl.innerHTML = events.slice(0, 20).map(ev => {
    const isUp = ev.action === 'scale_up';
    return `<div class="scale-ev ${isUp ? 'up' : 'down'}">
      <div class="ev-msg">
        <div class="ev-comp">${isUp ? '🔺' : '🔻'} ${ev.instancesAfter || '?'} instance${(ev.instancesAfter || 0) !== 1 ? 's' : ''}</div>
        ${ev.reason || 'Auto-scaling event'}
      </div>
      <div class="ev-time">${fmtTime(ev.timestamp)}</div>
    </div>`;
  }).join('');
}

function renderScaling() {
  if (!S.latest) return;
  const d = S.latest, inst = d.scaling.instances;
  setText('ssActive', inst);
  setText('ssCooldown', d.scaling.cooldownRemaining + 's');
  setText('ssLastAction', d.scaling.lastAction || 'none');
  const grid = el('instanceGrid');
  if (grid) {
    grid.innerHTML = '';
    for (let i = 0; i < (S.scalingConfig.maxInstances || 5); i++) {
      const box = document.createElement('div');
      box.className = 'inst-box' + (i < inst ? ' on' : '');
      box.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span>EC2-${String(i + 1).padStart(2, '0')}</span>`;
      grid.appendChild(box);
    }
  }

  // Populate Scaling Log
  const logEl = el('scalingLog');
  if (logEl) {
    if (!S.scalingEvents.length) {
      logEl.innerHTML = '<div style="color:var(--t3);padding:20px;text-align:center;font-size:13px;">No events recorded</div>';
    } else {
      logEl.innerHTML = S.scalingEvents.slice(0, 15).map(ev => {
        const isUp = ev.action === 'scale_up';
        return `<div class="scale-ev ${isUp ? 'up' : 'down'}">
          <div class="ev-msg">
            <div class="ev-comp">${isUp ? '🔺' : '🔻'} ${ev.instancesAfter} instance${ev.instancesAfter !== 1 ? 's' : ''}</div>
            ${ev.reason || 'Auto-scaling event'}
          </div>
          <div class="ev-time">${fmtTime(ev.timestamp)}</div>
        </div>`;
      }).join('');
    }
  }
}

function renderLogs() {
  const body = el('logsBody'); if (!body) return;
  const all = S.logFilter === 'all' ? S.logs : S.logs.filter(l => l.level === S.logFilter);
  setText('logCount', all.length);
  body.innerHTML = all.length
    ? all.map(l => `<div class="log-row ${l.level}">
        <span class="ltime">${fmtTime(l.timestamp)}</span>
        <span class="llvl">${l.level}</span>
        <span class="lcomp">${l.component || 'SYS'}</span>
        <span class="lmsg">${l.message}</span>
      </div>`).join('')
    : `<div style="color:var(--t3);padding:20px;text-align:center;font-size:13px;">No ${S.logFilter} logs.</div>`;
}

// Update the small Log Summary counts shown in the sidebar
function updateLogSummary() {
  const totals = { info: 0, warn: 0, error: 0, success: 0 };
  for (const l of S.logs) {
    const lvl = (l.level || 'info').toLowerCase();
    if (totals.hasOwnProperty(lvl)) totals[lvl]++;
  }
  setText('logStatInfo', totals.info);
  setText('logStatWarn', totals.warn);
  setText('logStatError', totals.error);
  setText('logStatSuccess', totals.success);
  setText('statTotal', S.logs.length || 0);
}

// ─────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────
function toast(title, msg, type = 'info') {
  const stack = el('toastStack'); if (!stack) return;
  const icons = { info: '💡', success: '✅', warn: '⚠️', error: '❌' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="t-icon">${icons[type] || '•'}</span>
    <div class="t-body"><div class="t-title">${title}</div>${msg ? `<div class="t-msg">${msg}</div>` : ''}</div>`;
  stack.appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); t.addEventListener('animationend', () => t.remove()); }, 4200);
}

// ─────────────────────────────────────────────────────────
// NAV + THEME + SETTINGS
// ─────────────────────────────────────────────────────────
const PAGE_META = {
  dashboard: ['Dashboard', 'Real-time WebSocket cloud monitoring'],
  analytics: ['Analytics Center', 'Multi-metric performance trends'],
  scaling: ['Auto-Scaling Engine', 'AI-driven instance management'],
  logs: ['System Logs', 'Live event stream'],
  settings: ['Settings', 'Configure thresholds & preferences'],
};
function setupNav() {
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const view = a.dataset.view; if (view === S.view) return;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      el(`view-${view}`)?.classList.add('active');
      document.querySelectorAll('.nav-link').forEach(x => x.classList.remove('active'));
      a.classList.add('active'); S.view = view;
      // Hide topbar right controls for logs and settings views only
      const hideTopControls = view === 'logs' || view === 'settings';
      document.body.classList.toggle('hide-topbar-right', hideTopControls);
      const [h, s] = PAGE_META[view] || [];
      setText('pageHeading', h); setText('pageSub', s);
      setTimeout(() => {
        if (view === 'analytics') renderAnalytics();
        if (view === 'scaling') { initInstanceChart(); renderScaling(); }
        if (view === 'dashboard') {
          initCpuChart(); updateCpuChart();
          initReqChart(); updateReqChart();
        }
      }, 50);
      if (view === 'logs') renderLogs();
    });
  });
  el('hamburger')?.addEventListener('click', () => {
    el('sidebar')?.classList.toggle('hidden');
    el('mainWrapper')?.classList.toggle('full');
  });
}
function setupTheme() {
  el('themeBtn')?.addEventListener('click', () => {
    const html = document.documentElement;
    const dark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', dark ? 'light' : 'dark');
    toast(dark ? '☀️ Light Mode' : '🌙 Dark Mode', '', 'info');
  });
}
function setupSettings() {
  [['cfgUp', 'cfgUpVal', '%'], ['cfgDown', 'cfgDownVal', '%'], ['cfgMax', 'cfgMaxVal', '']].forEach(([id, dId, sfx]) => {
    const s = el(id), d = el(dId);
    if (s && d) s.addEventListener('input', () => d.textContent = s.value + sfx);
  });
}
function setupLogTabs() {
  document.querySelectorAll('.log-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); S.logFilter = btn.dataset.filter; renderLogs();
    });
  });
}
function setupRipple() {
  document.querySelectorAll('.ctrl-btn').forEach(btn => {
    btn.addEventListener('click', function () { this.classList.remove('ripple'); void this.offsetWidth; this.classList.add('ripple'); setTimeout(() => this.classList.remove('ripple'), 500); });
  });
}

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
const show = id => { const e = el(id); if (e) e.style.display = ''; };
const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.shift(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
