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
  connectSocket();
  boot();
});

async function boot() {
  await sleep(1200);
  el('skeletonGrid').style.display = 'none';
  show('kpiRow'); show('chartsRow'); show('bottomRow');
  
  // Wait for browser layout to repaint so clientWidth metrics are non-zero!
  await sleep(150);

  try { initThreeJS(); } catch(e) { console.error(e); }
  try { initCpuChart(); } catch(e) { console.error(e); }
  try { initReqChart(); } catch(e) { console.error(e); }
  try { initGauge(); } catch(e) { console.error(e); }
  try { initInstanceChart(); } catch(e) { console.error(e); }
  try { initSparklines(); } catch(e) { console.error(e); }

  setupResizeObserver();
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
         renderMultiChart();
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

    updateKPIs(data);
    updateCpuChart();
    updateReqChart();
    updateGauge(data.cpu.load);
    updateSphere(data.cpu.load, data.scaling.instances);
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
  });

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
  setText('kInstFooter', `Cooldown: ${d.scaling.cooldownRemaining}s | Max: ${d.scaling.maxInstances}`);

  // Network
  animNum('kNet', d.network.mbps.toFixed(1));

  // Response time
  const rt = d.performance.responseTime;
  animNum('kRt', rt);
  setText('kRtFooter', rt < 200 ? '✓ Excellent' : rt < 600 ? '↗ Moderate' : '⚠ Slow');

  // Cost
  setText('kCost', d.cost.perHour.toFixed(3));
  setText('kCostFooter', `Total: $${d.cost.total.toFixed(3)}`);

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
  ag.append('stop').attr('offset', '0%').attr('stop-color', C.indigo).attr('stop-opacity', '0.3');
  ag.append('stop').attr('offset', '100%').attr('stop-color', C.cyan).attr('stop-opacity', '0.01');

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
    .attr('stroke', 'url(#cpuLG)').attr('stroke-width', '2.5').attr('stroke-linecap', 'round');
  g.append('circle').attr('id', 'cpuDot').attr('r', '5')
    .attr('fill', C.cyan).attr('stroke', '#0b1220').attr('stroke-width', '2.5')
    .style('filter', 'drop-shadow(0 0 6px #22d3ee)');
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
  const m = { t: 8, r: 8, b: 24, l: 30 };
  const W = Math.max(wrap.clientWidth, 280), H = 120;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const svg = d3.select('#instChart').append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'instAxisX').attr('transform', `translate(0,${h})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'instAxisY');
  g.append('path').attr('id', 'instLine').attr('fill', 'none')
    .attr('stroke', 'url(#cpuLG)').attr('stroke-width', '2').attr('stroke-linecap', 'round');
  // step coloured area
  g.append('path').attr('id', 'instArea').attr('fill', 'rgba(99,102,241,0.12)');
  Charts.instChart = { g, w, h };
}

function updateInstanceChart(inst) {
  push(instHistory, inst, 30);
  if (!Charts.instChart) return;
  const { g, w, h } = Charts.instChart;
  const data = instHistory;
  const n = data.length;
  const x = d3.scaleLinear().domain([0, 29]).range([0, w]);
  const max = S.scalingConfig.maxInstances || 5;
  const y = d3.scaleLinear().domain([0, max]).range([h, 0]);
  const lineG = d3.line().x((_, i) => x(i + 30 - n)).y(d => y(d)).curve(d3.curveStepAfter);
  const areaG = d3.area().x((_, i) => x(i + 30 - n)).y0(h).y1(d => y(d)).curve(d3.curveStepAfter);
  g.select('#instLine').datum(data).transition().duration(320).attr('d', lineG);
  g.select('#instArea').datum(data).transition().duration(320).attr('d', areaG);
  g.select('#instAxisX').call(d3.axisBottom(x).ticks(4).tickFormat(d => `-${29 - d}s`));
  g.select('#instAxisY').call(d3.axisLeft(y).ticks(max).tickFormat(d => Math.round(d)));
}

// ─────────────────────────────────────────────────────────
// D3 — REQUEST BAR CHART
// ─────────────────────────────────────────────────────────
function initReqChart() {
  const wrap = el('reqChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 10, r: 10, b: 28, l: 38 };
  const W = Math.max(wrap.clientWidth, 260), H = 180;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const svg = d3.select('#reqChart').append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const bg = defs.append('linearGradient').attr('id', 'barGrad').attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
  bg.append('stop').attr('offset', '0%').attr('stop-color', C.indigo);
  bg.append('stop').attr('offset', '100%').attr('stop-color', C.cyan);
  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'barAxisX').attr('transform', `translate(0,${h})`);
  g.append('g').attr('class', 'd3-axis').attr('id', 'barAxisY');
  g.append('g').attr('id', 'barGroup');
  Charts.req = { g, w, h };
}

function updateReqChart() {
  if (!Charts.req) return;
  const { g, w, h } = Charts.req;
  const data = S.req.slice(-20).map((v, i) => ({ i, v }));
  const x = d3.scaleBand().domain(data.map(d => d.i)).range([0, w]).padding(0.3);
  const maxV = Math.max(d3.max(data, d => d.v) || 10, 10);
  const y = d3.scaleLinear().domain([0, maxV]).range([h, 0]);
  const bars = g.select('#barGroup').selectAll('rect').data(data, d => d.i);
  bars.enter().append('rect').attr('x', d => x(d.i)).attr('y', h).attr('height', 0)
    .attr('width', x.bandwidth()).attr('rx', 3).attr('fill', 'url(#barGrad)').attr('opacity', .72)
    .merge(bars).transition().duration(320)
    .attr('x', d => x(d.i)).attr('width', x.bandwidth())
    .attr('y', d => y(d.v)).attr('height', d => h - y(d.v))
    .attr('opacity', (_, i, ns) => i === ns.length - 1 ? 1 : 0.65);
  bars.exit().remove();
  g.select('#barAxisX').call(d3.axisBottom(x).tickFormat(() => ''));
  g.select('#barAxisY').call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('d')));
  if (S.latest) setText('totalReqBadge', `${S.latest.performance.requests} total`);
}

// ─────────────────────────────────────────────────────────
// D3 — CIRCULAR GAUGE
// ─────────────────────────────────────────────────────────
function initGauge() {
  const svg = d3.select('#gaugeRing');
  svg.html('');
  const R = 76, cx = 95, cy = 95, tau = 2 * Math.PI, sAng = -tau * 0.375;
  const defs = svg.append('defs');
  const gg = defs.append('linearGradient').attr('id', 'gaugeGrad').attr('x1', '0').attr('y1', '0').attr('x2', '1').attr('y2', '1');
  gg.append('stop').attr('offset', '0%').attr('stop-color', C.indigo);
  gg.append('stop').attr('offset', '100%').attr('stop-color', C.cyan);
  svg.append('path')
    .datum({ s: sAng, e: sAng + tau * 0.75 })
    .attr('d', d3.arc().innerRadius(R - 13).outerRadius(R).startAngle(d => d.s).endAngle(d => d.e))
    .attr('fill', 'rgba(255,255,255,0.05)')
    .attr('transform', `translate(${cx},${cy})`);
  svg.append('path').attr('id', 'gaugeFg').attr('transform', `translate(${cx},${cy})`);
  Charts.gauge = { svg, cx, cy, R, tau, sAng };
}

function updateGauge(load) {
  if (!Charts.gauge) return;
  const { tau, sAng } = Charts.gauge;
  const col = load > 70 ? C.danger : load > 50 ? C.warning : C.success;
  d3.select('#gaugeFg').datum({ s: sAng, e: sAng + tau * 0.75 * Math.min(load / 100, 1) })
    .transition().duration(500).ease(d3.easeQuadOut)
    .attr('d', d3.arc().innerRadius(73).outerRadius(76).startAngle(d => d.s).endAngle(d => d.e).cornerRadius(3))
    .attr('fill', col).attr('filter', `drop-shadow(0 0 8px ${col}88)`);
  setText('gaugeNum', Math.round(load));
  const gs = el('gaugeState');
  if (gs) { gs.textContent = load > 70 ? 'CRITICAL' : load > 50 ? 'WARNING' : 'NORMAL'; gs.style.color = col; }
}

// ─────────────────────────────────────────────────────────
// THREE.JS — 3D SPHERE (reacts to CPU + instances)
// ─────────────────────────────────────────────────────────
function initThreeJS() {
  const canvas = el('threeCanvas'), wrap = canvas?.parentElement;
  if (!canvas || !wrap) return;
  const W = wrap.clientWidth || 300, H = Math.max(wrap.clientHeight - 60, 180);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
  camera.position.set(0, 0, 3.8);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const dLight = new THREE.DirectionalLight(0xffffff, 0.9); dLight.position.set(4, 4, 4); scene.add(dLight);
  const pL1 = new THREE.PointLight(0x6366f1, 3.5, 12); pL1.position.set(-2, 2, 2); scene.add(pL1);
  const pL2 = new THREE.PointLight(0x22d3ee, 2.0, 10); pL2.position.set(2, -2, 1); scene.add(pL2);
  const mat = new THREE.MeshPhongMaterial({ color: 0x22c55e, emissive: 0x053d1a, shininess: 100, transparent: true, opacity: 0.93 });
  const sph = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 5), mat); scene.add(sph);
  const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(1.03, 4), new THREE.MeshBasicMaterial({ color: 0x22c55e, wireframe: true, transparent: true, opacity: 0.10 })); scene.add(wire);
  const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.012, 8, 72), new THREE.MeshBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.18 }));
  const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.80, 0.008, 8, 60), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.12 }));
  r1.rotation.x = Math.PI / 2; r2.rotation.x = 0.4; r2.rotation.y = 0.8; scene.add(r1); scene.add(r2);
  const pGeo = new THREE.BufferGeometry(), pos = new Float32Array(450);
  for (let i = 0; i < 450; i++) pos[i] = (Math.random() - 0.5) * 10;
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const ptcl = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0x6366f1, size: 0.025, transparent: true, opacity: 0.4 })); scene.add(ptcl);
  window._three = { scene, camera, renderer, sphere: sph, wireShell: wire, ring1: r1, ring2: r2, particles: ptcl, pLight: pL1, pLight2: pL2 };
  (function animate(ts) {
    requestAnimationFrame(animate);
    const t = ts * 0.001;
    sph.rotation.y = t * 0.38; sph.rotation.x = Math.sin(t * 0.28) * 0.18;
    wire.rotation.copy(sph.rotation);
    r1.rotation.z = t * 0.75; r2.rotation.z = -t * 0.45; r2.rotation.x = 0.4 + Math.sin(t * 0.35) * 0.08;
    ptcl.rotation.y = t * 0.04;
    pL1.position.x = Math.sin(t * 0.7) * 3; pL1.position.y = Math.cos(t * 0.5) * 3;
    pL2.position.x = -Math.sin(t * 0.6) * 2.5; pL2.position.y = -Math.cos(t * 0.4) * 2;
    renderer.render(scene, camera);
  })(0);
  window.addEventListener('resize', () => {
    const nW = wrap.clientWidth, nH = Math.max(wrap.clientHeight - 60, 160);
    renderer.setSize(nW, nH); camera.aspect = nW / nH; camera.updateProjectionMatrix();
  });
}

// Color: < 30 green · 30-70 yellow · > 70 red
// Size: scales with instance count
function updateSphere(load, instances = 1) {
  const t = window._three; if (!t?.sphere) return;
  let sc, se, pc, p2c;
  if (load > 70) { sc = 0xef4444; se = 0x5a0000; pc = 0xef4444; p2c = 0xf97316; }
  else if (load > 30) { sc = 0xf59e0b; se = 0x4d2d00; pc = 0xf59e0b; p2c = 0xfbbf24; }
  else { sc = 0x22c55e; se = 0x053d1a; pc = 0x6366f1; p2c = 0x22d3ee; }
  t.sphere.material.color.setHex(sc);
  t.sphere.material.emissive.setHex(se);
  t.wireShell.material.color.setHex(sc);
  t.pLight.color.setHex(pc); t.pLight2.color.setHex(p2c);
  t.pLight.intensity = 2 + (load / 100) * 5;
  // Size reflects number of instances
  const maxInst = S.scalingConfig.maxInstances || 5;
  const instScale = 0.85 + (instances / maxInst) * 0.4;
  const loadScale = 1 + (load / 100) * 0.15;
  const total = instScale * loadScale;
  t.sphere.scale.setScalar(total);
  t.wireShell.scale.setScalar(total + 0.03);
  // Ring speed reacts to instances
  t.ring1.material.opacity = 0.10 + (instances / maxInst) * 0.25;
  // Badge
  const badge = el('loadBadge');
  if (badge) {
    badge.className = 'load-badge';
    if (load > 70) { badge.textContent = 'HIGH'; badge.classList.add('hi'); }
    else if (load > 30) { badge.textContent = 'MEDIUM'; badge.classList.add('med'); }
    else { badge.textContent = 'LOW'; }
  }
  setText('threeCpuText', `${Math.round(load)}%`);
  setText('threeInstText', `${instances} inst`);
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
function renderAnalytics() {
  if (!S.latest) return;
  const d = S.latest, hist = S.cpu.slice(-30);
  setText('sAvgCpu', hist.length ? (hist.reduce((a, b) => a + b, 0) / hist.length).toFixed(1) + '%' : '--');
  setText('sPeakCpu', hist.length ? Math.max(...hist).toFixed(1) + '%' : '--');
  setText('sMinCpu', hist.length ? Math.min(...hist).toFixed(1) + '%' : '--');
  setText('sTotalReq', d.performance.requests);
  setText('sReqPerMin', Math.round((d.performance.requests / Math.max(d.system.uptime, 1)) * 60));
  setText('sTotalCost', '$' + d.cost.total.toFixed(4));
  setText('sInstances', d.scaling.instances);
  renderMultiChart();
}

function renderMultiChart() {
  const wrap = el('analyticsChart'); if (!wrap) return;
  wrap.innerHTML = '';
  const m = { t: 12, r: 18, b: 30, l: 40 };
  const W = Math.max(wrap.clientWidth, 500), H = 240;
  const w = W - m.l - m.r, h = H - m.t - m.b;
  const n = Math.min(S.cpu.length, S.mem.length, S.disk.length, 30);
  const cS = S.cpu.slice(-n), mS = S.mem.slice(-n), dS = S.disk.slice(-n);
  const svg = d3.select('#analyticsChart').append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  const x = d3.scaleLinear().domain([0, n - 1]).range([0, w]);
  const y = d3.scaleLinear().domain([0, 100]).range([h, 0]);
  g.append('g').call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat('')).selectAll('line').attr('stroke', C.grid).attr('stroke-dasharray', '3 3');
  g.select('.domain').remove();
  const line = arr => d3.line().x((_, i) => x(i)).y(d => y(d)).curve(d3.curveCatmullRom)(arr);
  g.append('path').attr('d', line(cS)).attr('fill', 'none').attr('stroke', C.indigo).attr('stroke-width', 2.5).attr('stroke-linecap', 'round');
  g.append('path').attr('d', line(mS)).attr('fill', 'none').attr('stroke', C.danger).attr('stroke-width', 2).attr('opacity', 0.8);
  g.append('path').attr('d', line(dS)).attr('fill', 'none').attr('stroke', C.cyan).attr('stroke-width', 1.8).attr('opacity', 0.7);
  g.append('g').attr('class', 'd3-axis').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(6).tickFormat(d => `-${n - 1 - d}s`));
  g.append('g').attr('class', 'd3-axis').call(d3.axisLeft(y).ticks(5).tickFormat(d => d + '%'));
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
      const [h, s] = PAGE_META[view] || [];
      setText('pageHeading', h); setText('pageSub', s);
      setTimeout(() => {
        if (view === 'analytics') renderAnalytics();
        if (view === 'scaling') renderScaling();
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
