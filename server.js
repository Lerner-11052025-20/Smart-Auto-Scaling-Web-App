/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  CLOUDPULSE AI v2.0 — AUTO-SCALING ENGINE               ║
 * ║  Node.js + Express + Socket.IO                          ║
 * ║  Smart scaling: cooldown · threshold · AI prediction    ║
 * ╚══════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

// ─────────────────────────────────────────────
// SERVER SETUP
// ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(morgan('dev'));
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://deepsorathiya803_db_user:byzDF7triDEG6mpu@cluster0.reubi88.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => { console.log('✅ MongoDB Atlas Connected'); addLog('MongoDB Atlas connected', 'info', 'DATABASE'); })
  .catch(err => console.warn('⚠️  MongoDB offline:', err.message));

// ─────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ─────────────────────────────────────────────
const MetricSchema = new mongoose.Schema({
  cpuLoad: Number, memoryUsage: Number, requests: Number,
  instances: Number, networkMbps: Number, responseTime: Number,
  diskIO: Number, errorRate: Number, costTotal: Number,
  timestamp: { type: Date, default: Date.now }
});
MetricSchema.index({ timestamp: -1 });
const LogSchema = new mongoose.Schema({
  message: String, level: String, component: { type: String, default: 'SYSTEM' },
  timestamp: { type: Date, default: Date.now }
});
const ScalingEventSchema = new mongoose.Schema({
  action: String, reason: String,
  instancesBefore: Number, instancesAfter: Number,
  cpuAtTrigger: Number, timestamp: { type: Date, default: Date.now }
});

const Metric = mongoose.model('Metric', MetricSchema);
const Log = mongoose.model('Log', LogSchema);
const ScalingEvent = mongoose.model('ScalingEvent', ScalingEventSchema);

// ─────────────────────────────────────────────
// ⚙️  SCALING CONFIG — Tune these values
// ─────────────────────────────────────────────
const SCALING_CONFIG = {
  maxInstances: 5,        // Hard upper limit
  minInstances: 1,        // Hard lower limit
  scaleUpCpu: 70,       // Scale UP  if CPU > 70%
  scaleDownCpu: 30,       // Scale DOWN if CPU < 30%
  cooldownMs: 10000,    // 10s cooldown between scaling events
  checkIntervalMs: 2000,     // Run checkScaling() every 2s
  metricsIntervalMs: 1000,  // Emit systemMetrics every 1s
};

// ─────────────────────────────────────────────
// 📊 STATE VARIABLES
// ─────────────────────────────────────────────
const state = {
  cpuLoad: 15 + Math.random() * 10,
  memoryUsage: 25 + Math.random() * 15,
  networkMbps: 30 + Math.random() * 20,
  diskIO: 10 + Math.random() * 15,
  responseTime: 80 + Math.random() * 40,
  requests: 0,
  instances: 1,                        // Start with 1
  errorRate: 0,
  uptime: 0,
  costTotal: 0,
  lastScaleTime: 0,                        // Timestamp of last scale event
  lastScaleAction: 'none',
  aiEnabled: true,
  realtimeEnabled: true,
};

// Circular history buffers
const HIST = 60;
const history = { cpu: [], pred: [], mem: [], disk: [], net: [] };

// Log buffer (in-memory)
const logBuffer = [];
const scalingEvents = [];
let connectedClients = 0;

// ─────────────────────────────────────────────
// 📜 LOGGING UTILITY
// ─────────────────────────────────────────────
/**
 * addLog — push a structured log entry
 * @param {string} message
 * @param {'info'|'warn'|'warning'|'error'|'success'|'critical'} level
 * @param {string} component
 */
function addLog(message, level = 'info', component = 'SYSTEM') {
  const entry = { message, level, component, timestamp: new Date() };
  logBuffer.unshift(entry);
  if (logBuffer.length > 200) logBuffer.pop();
  console.log(`[${level.toUpperCase()}] [${component}] ${message}`);
  if (mongoose.connection.readyState === 1) {
    new Log(entry).save().catch(() => { });
  }
}

// ─────────────────────────────────────────────
// 🛠️  HELPER UTILITIES
// ─────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const pushHist = (arr, val) => { arr.push(val); if (arr.length > HIST) arr.shift(); };
const cooldownRemaining = () =>
  Math.max(0, Math.ceil((SCALING_CONFIG.cooldownMs - (Date.now() - state.lastScaleTime)) / 1000));

// ─────────────────────────────────────────────
// 🤖 AI PREDICTION ENGINE
// ─────────────────────────────────────────────
function predictLoad(cpuArr) {
  if (cpuArr.length < 5)
    return { nextLoad: state.cpuLoad, confidence: 0.3, action: 'stable' };

  const recent = cpuArr.slice(-12);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const trend = (recent[recent.length - 1] - recent[0]) / recent.length;
  const next = clamp(avg + trend * 3, 0, 100);
  const variance = recent.reduce((s, v) => s + (v - avg) ** 2, 0) / recent.length;
  const conf = Math.max(0.4, 1 - Math.sqrt(variance) / 50);

  let action = 'stable';
  if (next > SCALING_CONFIG.scaleUpCpu) action = 'scale_up';
  else if (next < SCALING_CONFIG.scaleDownCpu && state.instances > 1) action = 'scale_down';
  else if (trend > 3) action = 'prepare_scale_up';

  return { nextLoad: Math.round(next * 10) / 10, confidence: Math.round(conf * 100) / 100, action };
}

// ─────────────────────────────────────────────
// ⬆️  scaleUp() — Add one instance
// ─────────────────────────────────────────────
function scaleUp(reason = 'CPU threshold exceeded') {
  if (state.instances >= SCALING_CONFIG.maxInstances) {
    addLog(`⛔ Scale-up blocked: already at max (${SCALING_CONFIG.maxInstances})`, 'warn', 'AUTOSCALER');
    return false;
  }

  const before = state.instances;
  state.instances += 1;
  state.lastScaleTime = Date.now();
  state.lastScaleAction = 'scale_up';

  // Distribute load across new instance — CPU relief
  state.cpuLoad = clamp(state.cpuLoad * (before / state.instances) - 5, 0, 100);
  state.responseTime = clamp(state.responseTime * 0.8, 10, 3000);

  const msg = `🔺 SCALED UP: ${before} → ${state.instances} instances | ${reason}`;
  addLog(msg, 'warn', 'AUTOSCALER');

  const ev = {
    action: 'scale_up', reason,
    instancesBefore: before, instancesAfter: state.instances,
    cpuAtTrigger: Math.round(state.cpuLoad * 10) / 10,
    timestamp: new Date(),
  };
  scalingEvents.unshift(ev);
  if (scalingEvents.length > 100) scalingEvents.pop();
  if (mongoose.connection.readyState === 1) new ScalingEvent(ev).save().catch(() => { });

  // Emit dedicated scalingUpdate event
  io.emit('scalingUpdate', {
    instancesBefore: before,
    instancesAfter: state.instances,
    instances: state.instances,
    action: 'scale_up',
    cpuLoad: Math.round(state.cpuLoad * 10) / 10,
    reason,
    timestamp: new Date(),
  });

  return true;
}

// ─────────────────────────────────────────────
// ⬇️  scaleDown() — Remove one instance
// ─────────────────────────────────────────────
function scaleDown(reason = 'Low CPU — cost optimization') {
  if (state.instances <= SCALING_CONFIG.minInstances) {
    addLog(`⛔ Scale-down blocked: already at min (${SCALING_CONFIG.minInstances})`, 'info', 'AUTOSCALER');
    return false;
  }

  const before = state.instances;
  state.instances -= 1;
  state.lastScaleTime = Date.now();
  state.lastScaleAction = 'scale_down';

  // Consolidate load — slight CPU increase
  state.cpuLoad = clamp(state.cpuLoad * (before / state.instances) + 4, 0, 100);
  state.responseTime = clamp(state.responseTime * 1.1, 10, 3000);

  const msg = `🔻 SCALED DOWN: ${before} → ${state.instances} instances | ${reason}`;
  addLog(msg, 'info', 'AUTOSCALER');

  const ev = {
    action: 'scale_down', reason,
    instancesBefore: before, instancesAfter: state.instances,
    cpuAtTrigger: Math.round(state.cpuLoad * 10) / 10,
    timestamp: new Date(),
  };
  scalingEvents.unshift(ev);
  if (scalingEvents.length > 100) scalingEvents.pop();
  if (mongoose.connection.readyState === 1) new ScalingEvent(ev).save().catch(() => { });

  // Emit dedicated scalingUpdate event
  io.emit('scalingUpdate', {
    instancesBefore: before,
    instancesAfter: state.instances,
    instances: state.instances,
    action: 'scale_down',
    cpuLoad: Math.round(state.cpuLoad * 10) / 10,
    reason,
    timestamp: new Date(),
  });

  return true;
}

// ─────────────────────────────────────────────
// 🧠 checkScaling() — Core decision engine (every 2s)
// ─────────────────────────────────────────────
function checkScaling() {
  const now = Date.now();
  const cooling = (now - state.lastScaleTime) < SCALING_CONFIG.cooldownMs;
  const cpu = state.cpuLoad;
  const pred = predictLoad(history.cpu);

  if (cooling) {
    // Still in cooldown — skip
    return { action: 'none', reason: `cooldown (${cooldownRemaining()}s left)` };
  }

  // ── Rule 1: SCALE UP ──────────────────────────────────
  // CPU > 70% AND instances < maxInstances
  if (cpu > SCALING_CONFIG.scaleUpCpu && state.instances < SCALING_CONFIG.maxInstances) {
    const reason = `CPU ${cpu.toFixed(1)}% > ${SCALING_CONFIG.scaleUpCpu}% threshold`;
    scaleUp(reason);
    return { action: 'scale_up', reason };
  }

  // ── Rule 2: AI PREDICTIVE SCALE UP ───────────────────
  // AI predicts spike with high confidence
  if (state.aiEnabled &&
    pred.action === 'scale_up' &&
    pred.confidence > 0.75 &&
    state.instances < SCALING_CONFIG.maxInstances) {
    const reason = `AI predicts ${pred.nextLoad}% load (conf: ${(pred.confidence * 100).toFixed(0)}%)`;
    scaleUp(reason);
    return { action: 'scale_up', reason };
  }

  // ── Rule 3: SCALE DOWN ────────────────────────────────
  // CPU < 30% AND instances > minInstances
  if (cpu < SCALING_CONFIG.scaleDownCpu && state.instances > SCALING_CONFIG.minInstances) {
    const reason = `CPU ${cpu.toFixed(1)}% < ${SCALING_CONFIG.scaleDownCpu}% — underutilized`;
    scaleDown(reason);
    return { action: 'scale_down', reason };
  }

  return { action: 'none', reason: 'thresholds not met' };
}

// ─────────────────────────────────────────────
// 📈 METRICS SIMULATION TICK (every 1s)
// ─────────────────────────────────────────────
function tickMetrics() {
  state.uptime++;

  const instFactor = 1 / Math.max(state.instances, 1);
  const noise = (Math.random() - 0.48) * 10;

  state.cpuLoad = clamp(state.cpuLoad + noise * instFactor, 1, 100);
  state.memoryUsage = clamp(state.memoryUsage + (state.cpuLoad - state.memoryUsage) * 0.04 + (Math.random() - 0.5) * 3, 5, 95);
  // Realistic Network Speed based on Load
  const targetMbps = 25 + (state.cpuLoad * 1.6) + (state.requests * 0.5);
  state.networkMbps = clamp(state.networkMbps + (targetMbps - state.networkMbps) * 0.3 + (Math.random() - 0.5) * 15, 5, 2000);
  state.diskIO = clamp(state.diskIO + (Math.random() - 0.5) * 6, 0, 100);

  // Realistic Response Time tied to load per instance
  const rtLoad = state.cpuLoad / state.instances;
  const targetRt = 45 + (rtLoad * 2.8);
  state.responseTime = clamp(state.responseTime + (targetRt - state.responseTime) * 0.35 + (Math.random() - 0.5) * 35, 12, 3000);

  state.errorRate = state.cpuLoad > 90
    ? parseFloat((Math.random() * 5).toFixed(2))
    : parseFloat((Math.random() * 0.4).toFixed(2));
  
  // INR Rate: ₹7.05 per instance compute + dynamic data transfer cost for waviness
  const baseCompute = state.instances * 7.05;
  const dataCost = state.networkMbps * 0.002;
  state.costPerHourFloat = baseCompute + dataCost;
  state.costTotal += state.costPerHourFloat / 3600;

  pushHist(history.cpu, state.cpuLoad);
  pushHist(history.mem, state.memoryUsage);
  pushHist(history.net, state.networkMbps);
  pushHist(history.disk, state.diskIO);

  const prediction = predictLoad(history.cpu);
  pushHist(history.pred, prediction.nextLoad);

  // Persist to MongoDB every 5s for richer history
  if (state.uptime % 5 === 0 && mongoose.connection.readyState === 1) {
    new Metric({
      cpuLoad: state.cpuLoad, memoryUsage: state.memoryUsage,
      requests: state.requests, instances: state.instances,
      networkMbps: state.networkMbps, responseTime: state.responseTime,
      diskIO: state.diskIO, errorRate: state.errorRate,
      costTotal: state.costTotal,
    }).save().catch(() => { });
  }

  // Build and emit full metrics payload every 1s
  if (state.realtimeEnabled && connectedClients > 0) {
    io.emit('systemMetrics', buildPayload(prediction));
  }
}

// ─────────────────────────────────────────────
// 📦 BUILD METRICS PAYLOAD
// ─────────────────────────────────────────────
function buildPayload(prediction) {
  return {
    cpu: { load: Math.round(state.cpuLoad * 10) / 10, history: history.cpu.slice(-30) },
    memory: { usage: Math.round(state.memoryUsage * 10) / 10, total: 16384, used: Math.round(state.memoryUsage * 163.84) },
    network: { mbps: Math.round(state.networkMbps * 10) / 10 },
    disk: { io: Math.round(state.diskIO * 10) / 10 },
    performance: {
      requests: state.requests,
      responseTime: Math.round(state.responseTime),
      errorRate: state.errorRate,
    },
    scaling: {
      instances: state.instances,
      maxInstances: SCALING_CONFIG.maxInstances,
      minInstances: SCALING_CONFIG.minInstances,
      cooldownRemaining: cooldownRemaining(),
      lastAction: state.lastScaleAction,
      scaleUpThreshold: SCALING_CONFIG.scaleUpCpu,
      scaleDownThreshold: SCALING_CONFIG.scaleDownCpu,
    },
    ai: { prediction, enabled: state.aiEnabled, historySize: history.cpu.length },
    cost: { perHour: Math.round((state.costPerHourFloat || (state.instances * 7.05)) * 1000) / 1000, total: Math.round(state.costTotal * 1000) / 1000 },
    system: {
      uptime: state.uptime,
      status: state.cpuLoad > SCALING_CONFIG.scaleUpCpu ? 'critical'
        : state.cpuLoad > 60 ? 'warning' : 'healthy',
      clients: connectedClients,
      realtimeEnabled: state.realtimeEnabled,
    },
    predHistory: history.pred.slice(-30),
    timestamp: new Date(),
  };
}

// ─────────────────────────────────────────────
// ⏲️  START LOOPS
// ─────────────────────────────────────────────
setInterval(tickMetrics, SCALING_CONFIG.metricsIntervalMs);     // 1s — metrics
setInterval(checkScaling, SCALING_CONFIG.checkIntervalMs);       // 2s — auto-scale decisions

// ─────────────────────────────────────────────
// 🔌 SOCKET.IO EVENTS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  connectedClients++;
  addLog(`Dashboard client connected [${socket.id.slice(0, 8)}]`, 'info', 'WEBSOCKET');

  // Send immediate snapshot
  socket.emit('systemMetrics', buildPayload(predictLoad(history.cpu)));
  socket.emit('logHistory', { logs: logBuffer.slice(0, 40) });
  socket.emit('scalingHistory', { events: scalingEvents.slice(0, 20) });
  socket.emit('scalingConfig', SCALING_CONFIG);

  // Manual scale via WebSocket
  socket.on('manualScale', ({ action, count = 1 }) => {
    for (let i = 0; i < count; i++) {
      if (action === 'up') scaleUp('Manual override by operator');
      if (action === 'down') scaleDown('Manual override by operator');
    }
    socket.emit('scaleResult', {
      success: true, action,
      instancesAfter: state.instances,
    });
  });

  // Toggle real-time
  socket.on('toggleRealtime', ({ enabled }) => {
    state.realtimeEnabled = enabled;
    addLog(`Real-time streaming ${enabled ? 'ENABLED' : 'PAUSED'}`, 'info', 'WEBSOCKET');
    io.emit('realtimeStatus', { enabled });
  });

  // Toggle AI
  socket.on('toggleAI', ({ enabled }) => {
    state.aiEnabled = enabled;
    addLog(`AI Engine ${enabled ? 'ENABLED' : 'DISABLED'}`, 'info', 'AI-ENGINE');
  });

  socket.on('disconnect', () => {
    connectedClients = Math.max(0, connectedClients - 1);
  });
});

// ─────────────────────────────────────────────
// 🌐 REST API ENDPOINTS
// ─────────────────────────────────────────────

// Status snapshot
app.get('/api/', (req, res) => res.json({
  status: 'operational', version: '2.0.0',
  uptime: state.uptime, instances: state.instances,
  realtimeClients: connectedClients, timestamp: new Date(),
}));

// Current metrics
app.get('/api/status', (req, res) => {
  state.requests++;
  res.json(buildPayload(predictLoad(history.cpu)));
});

// ── POST /api/scale-up ─────────────────────
app.post('/api/scale-up', (req, res) => {
  state.requests++;
  const ok = scaleUp('Manual REST — Force Scale Up');
  res.json({
    success: ok,
    instances: state.instances,
    message: ok ? `Scaled up to ${state.instances} instances` : 'Already at max instances',
  });
});

// ── POST /api/scale-down ───────────────────
app.post('/api/scale-down', (req, res) => {
  state.requests++;
  const ok = scaleDown('Manual REST — Force Scale Down');
  res.json({
    success: ok,
    instances: state.instances,
    message: ok ? `Scaled down to ${state.instances} instances` : 'Already at min instances',
  });
});

// ── GET /api/scale (REST compat) ──────────
app.post('/api/scale', (req, res) => {
  const { action } = req.body;
  state.requests++;
  let ok = false;
  if (action === 'up') ok = scaleUp('Manual REST override');
  if (action === 'down') ok = scaleDown('Manual REST override');
  res.json({ success: ok, instances: state.instances, action });
});

// Load generator
app.get('/api/load', (req, res) => {
  const intensity = parseFloat(req.query.intensity) || 1.0;
  const start = Date.now();
  let x = 0;
  const iters = Math.floor(40_000_000 * intensity);
  for (let i = 0; i < iters; i++) x += Math.sqrt(i) * Math.sin(i * 0.001);
  const ms = Date.now() - start;
  const spike = clamp(18 + intensity * 35, 10, 65);
  state.cpuLoad = clamp(state.cpuLoad + spike, 0, 100);
  state.networkMbps += 15 + Math.random() * 10;
  state.requests++;
  const label = intensity < 0.5 ? 'Light' : intensity < 1 ? 'Medium' : 'Heavy';
  addLog(`⚡ ${label} load spike +${spike.toFixed(1)}% CPU (${ms}ms)`, 'warn', 'LOAD-GEN');
  io.emit('systemMetrics', buildPayload(predictLoad(history.cpu)));
  res.json({ cpuIncrease: Math.round(spike * 10) / 10, currentCpu: Math.round(state.cpuLoad * 10) / 10, computationMs: ms, intensity });
});

// Logs
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 40, 200);
  res.json({ logs: logBuffer.slice(0, limit), total: logBuffer.length });
});

// Scaling events
app.get('/api/scaling/events', (req, res) => res.json({ events: scalingEvents.slice(0, 30) }));

// Scaling config
app.get('/api/scaling/config', (req, res) => res.json(SCALING_CONFIG));

// Force scaling check immediately (bypass interval)
app.post('/api/scaling/check', (req, res) => {
  const result = checkScaling();
  res.json({ ...result, instances: state.instances, cpuLoad: state.cpuLoad });
});

// Historical from MongoDB
app.get('/api/metrics/history', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.json({ metrics: [], source: 'unavailable' });
    const m = await Metric.find().sort({ timestamp: -1 }).limit(60);
    res.json({ metrics: m, source: 'mongodb' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HISTORICAL ANALYTICS ENDPOINTS ──────────────────
// Detailed metrics history with time range + limit
app.get('/api/metrics/history/detailed', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      // Fallback: return in-memory history as fake MongoDB data
      const fakeMetrics = history.cpu.slice(-60).map((cpu, i) => ({
        cpuLoad: cpu, memoryUsage: history.mem[i] || 0,
        networkMbps: history.net[i] || 0, diskIO: history.disk[i] || 0,
        instances: state.instances, responseTime: state.responseTime,
        requests: state.requests, errorRate: state.errorRate,
        costTotal: state.costTotal,
        timestamp: new Date(Date.now() - (history.cpu.length - i) * 1000)
      }));
      return res.json({ metrics: fakeMetrics, source: 'memory', count: fakeMetrics.length });
    }
    const range = req.query.range || '1h'; // 1h, 6h, 24h, 7d
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rangeMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
    const since = new Date(Date.now() - (rangeMs[range] || 3600000));
    const metrics = await Metric.find({ timestamp: { $gte: since } })
      .sort({ timestamp: 1 }).limit(limit).lean();
    res.json({ metrics, source: 'mongodb', count: metrics.length, range });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scaling events history from MongoDB
app.get('/api/scaling/events/history', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ events: scalingEvents.slice(0, 50), source: 'memory' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const events = await ScalingEvent.find().sort({ timestamp: -1 }).limit(limit).lean();
    res.json({ events, source: 'mongodb', count: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics summary — computed aggregates
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const cpuHist = history.cpu;
    const memHist = history.mem;
    const avgCpu = cpuHist.length ? cpuHist.reduce((a, b) => a + b, 0) / cpuHist.length : 0;
    const peakCpu = cpuHist.length ? Math.max(...cpuHist) : 0;
    const avgMem = memHist.length ? memHist.reduce((a, b) => a + b, 0) / memHist.length : 0;
    const totalEventsUp = scalingEvents.filter(e => e.action === 'scale_up').length;
    const totalEventsDown = scalingEvents.filter(e => e.action === 'scale_down').length;
    // Cost savings estimate: cost if always max vs actual
    const maxCostPerHour = SCALING_CONFIG.maxInstances * 7.05;
    const actualCostPerHour = state.instances * 7.05;
    const savingsPercent = maxCostPerHour > 0 ? ((1 - actualCostPerHour / maxCostPerHour) * 100).toFixed(1) : 0;
    res.json({
      avgCpu: Math.round(avgCpu * 10) / 10,
      peakCpu: Math.round(peakCpu * 10) / 10,
      avgMemory: Math.round(avgMem * 10) / 10,
      totalRequests: state.requests,
      totalCost: Math.round(state.costTotal * 1000) / 1000,
      costPerHour: actualCostPerHour,
      costSavingsPercent: parseFloat(savingsPercent),
      activeInstances: state.instances,
      maxInstances: SCALING_CONFIG.maxInstances,
      scaleUpEvents: totalEventsUp,
      scaleDownEvents: totalEventsDown,
      uptime: state.uptime,
      avgResponseTime: Math.round(state.responseTime),
      errorRate: state.errorRate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────
// 🚀 START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   🚀 CLOUDPULSE AI  v2.0  ENTERPRISE             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   🌐  HTTP  → http://localhost:${PORT}             ║`);
  console.log(`║   📡  WS   → ws://localhost:${PORT}               ║`);
  console.log('║   🧠  AI Engine     : ACTIVE                     ║');
  console.log(`║   ⚙️   Scale Up CPU : >${SCALING_CONFIG.scaleUpCpu}%                    ║`);
  console.log(`║   ⚙️   Scale Down CPU: <${SCALING_CONFIG.scaleDownCpu}%                    ║`);
  console.log(`║   ⏱️   Cooldown     : ${SCALING_CONFIG.cooldownMs / 1000}s                     ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  setTimeout(() => {
    addLog('🚀 CloudPulse AI v2.0 server started', 'success', 'SYSTEM');
    addLog('📡 Socket.IO WebSocket server active', 'info', 'WEBSOCKET');
    addLog('🧠 AI Prediction Engine initialized', 'info', 'AI-ENGINE');
    addLog(`⚙️  Auto-scaling: UP>${SCALING_CONFIG.scaleUpCpu}% DOWN<${SCALING_CONFIG.scaleDownCpu}% cooldown=${SCALING_CONFIG.cooldownMs / 1000}s`, 'info', 'AUTOSCALER');
    addLog('☁️  AWS EC2 cluster simulation ready', 'info', 'CLOUD');
  }, 600);
});
