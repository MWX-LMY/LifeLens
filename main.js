const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'LifeLens_Data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let userConfig = { model: 'qwen3-vl:8b', maxCtx: 4096 };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      userConfig = { ...userConfig, ...loaded };
    }
  } catch {}
}
function saveConfig() {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2));
  } catch {}
}
loadConfig();

const CONFIG = {
  interval: 20_000,             // 20 seconds
  model: userConfig.model,
  ollamaUrl: 'http://localhost:11434/api/generate',
  dataDir: DATA_DIR,
  maxCtx: userConfig.maxCtx,
  prompt: `分析这张截图中用户正在做什么。请用5句简短的话总结用户当前的活动（使用中文）。要求：
1. 描述用户正在使用的软件或网站
2. 描述用户的具体操作
3. 推断用户的工作或任务类型
4. 注意屏幕上可见的细节（代码、文档、设计等）
5. 整体判断用户状态（专注工作、休闲、开会等）

请直接输出5句话，每句话一行，不要编号。`,
};

// ─── State ────────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let timer = null;
let summaryTimer = null;
let running = true;
let processing = false;
let qaInProgress = false;
let lastError = null;
let shotCount = 0;
let analyzedCount = 0;
const recentEntries = []; // last N analysis results
const summaries = []; // completed 10-min summaries
let summarizingBlocks = new Set(); // block timestamps currently being summarized

// ─── Tray Icon (generate a simple colored icon) ──────────────────────────────
function createTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = size / 2, cy = size / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < size / 2 - 1) {
        buf[i] = 0x4a; buf[i + 1] = 0x9e; buf[i + 2] = 0xff; buf[i + 3] = 0xff;
      } else {
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ─── Path Helpers ────────────────────────────────────────────────────────────
function getDateParts(now) {
  const y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return { year: y, month: `${y}-${M}`, day: `${y}-${M}-${d}`, hour: h, min: m, sec: s };
}

function getPaths() {
  const now = new Date();
  const p = getDateParts(now);
  const monthDir = path.join(CONFIG.dataDir, p.month);
  const screenshotsDir = path.join(monthDir, 'screenshots');
  const screenshotFile = `${p.day}_${p.hour}-${p.min}-${p.sec}.png`;
  const hourFile = `${p.day}_${p.hour}.json`;

  return {
    now: now.toISOString(),
    monthDir,
    screenshotsDir,
    screenshotPath: path.join(screenshotsDir, screenshotFile),
    hourFilePath: path.join(monthDir, hourFile),
    relativeScreenshotPath: path.join('data', p.month, 'screenshots', screenshotFile).replace(/\\/g, '/'),
    absoluteScreenshotPath: path.join(CONFIG.dataDir, p.month, 'screenshots', screenshotFile),
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Screenshot via PowerShell ──────────────────────────────────────────────
function takeScreenshot(filePath) {
  return new Promise((resolve, reject) => {
    const winPath = filePath.replace(/\//g, '\\');
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      `$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;`,
      `$b=New-Object System.Drawing.Bitmap $s.Width,$s.Height;`,
      `$g=[System.Drawing.Graphics]::FromImage($b);`,
      `$g.CopyFromScreen($s.X,$s.Y,0,0,$s.Size);`,
      `$b.Save('${winPath}');`,
      `$g.Dispose();$b.Dispose()`,
    ].join('');

    execFile('powershell', [
      '-NoProfile', '-NonInteractive',
      '-Command', psScript,
    ], { timeout: 30000, windowsHide: true }, (err) => {
      if (err) return reject(new Error(`截图失败: ${err.message}`));
      if (!fs.existsSync(filePath)) return reject(new Error('截图文件未生成'));
      resolve(filePath);
    });
  });
}

// ─── Ollama API ──────────────────────────────────────────────────────────────
async function analyzeImage(imagePath) {
  // Resize image before sending to Ollama for speed
  let base64Image;
  try {
    const img = nativeImage.createFromPath(imagePath);
    if (!img.isEmpty()) {
      const resized = img.resize({ width: 800 }); // 800px wide, ~1/6 pixels
      base64Image = resized.toJPEG(75).toString('base64');
    } else {
      throw new Error('empty image');
    }
  } catch {
    // Fallback: use original full-size image
    const imageBuffer = fs.readFileSync(imagePath);
    base64Image = imageBuffer.toString('base64');
  }

  const resp = await fetch(CONFIG.ollamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.model,
      prompt: CONFIG.prompt,
      images: [base64Image],
      stream: false,
      options: {
        num_ctx: CONFIG.maxCtx,
        temperature: 0.3,
      },
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama API ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return (data.response || '').trim();
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function appendToLog(filePath, entry) {
  let entries = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) entries = [];
    } catch { entries = []; }
  }
  entries.push(entry);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

function cleanActivity(text) {
  if (!text) return '（分析失败）';
  // Remove any surrounding markdown or quotes
  return text.replace(/^["']|["']$/g, '').trim();
}

// ─── Screenshot path queue (for analysis) ────────────────────────────────────
let pendingAnalysisPath = null;
let queueLength = 0;  // number of screenshots waiting for analysis

// ─── Screenshot only (runs every 20s) ───────────────────────────────────────
async function takeScreenshotOnly() {
  const paths = getPaths();

  try {
    ensureDir(paths.screenshotsDir);
    await takeScreenshot(paths.screenshotPath);
    shotCount++;

    // Update UI: screenshot taken
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot-taken', {
        timestamp: paths.now,
        imagePath: paths.absoluteScreenshotPath,
        shotCount,
      });
    }

    // Always keep latest screenshot path, queue for analysis
    pendingAnalysisPath = paths;

    if (!processing && !qaInProgress) {
      queueLength = 0;
      processAnalysis();
    } else {
      queueLength++;
      sendState();
    }
  } catch (err) {
    console.error(`[${paths.now}] Screenshot error:`, err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-result', {
        timestamp: paths.now,
        activity: '（截图失败）',
        imagePath: null,
        error: err.message,
        screenshotTaken: false,
      });
    }
  }
}

// ─── Analysis cycle (runs when ready) ───────────────────────────────────────
async function processAnalysis() {
  if (processing || !pendingAnalysisPath || qaInProgress) return;
  processing = true;

  const paths = pendingAnalysisPath;
  pendingAnalysisPath = null;
  let activity = '（分析失败）';

  // Notify renderer that analysis is starting
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('analyzing', { timestamp: paths.now });
  }

  try {
    activity = cleanActivity(await analyzeImage(paths.screenshotPath));
    analyzedCount++;
    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error(`[${paths.now}] Analysis error:`, err.message);
    activity = '（AI分析失败）';
  }

  // Build entry
  const entry = {
    timestamp: paths.now,
    image_path: paths.relativeScreenshotPath,
    activity,
    error: lastError || undefined,
  };

  // Keep in memory
  recentEntries.push(entry);
  if (recentEntries.length > 80) recentEntries.splice(0, 30);

  // Write log file
  try {
    appendToLog(paths.hourFilePath, entry);
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }

  // Trigger 10-min summary check
  checkSummaries();

  // Update UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture-result', {
      timestamp: paths.now,
      activity,
      imagePath: paths.absoluteScreenshotPath,
      error: lastError,
      screenshotTaken: true,
    });
  }

  processing = false;
  sendState();

  // Trigger next pending analysis if available
  if (pendingAnalysisPath) processAnalysis();
}

// ─── 10-Min Summarization ───────────────────────────────────────────────────
const SUMMARY_INTERVAL = 600_000; // 10 minutes

function getBlockKey(ts) {
  return Math.floor(new Date(ts).getTime() / SUMMARY_INTERVAL) * SUMMARY_INTERVAL;
}

function getBlockLabel(blockKey) {
  const d = new Date(blockKey);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m} — ${h}:${m === '0' ? '10' : String(parseInt(m) + 10).padStart(2, '0')}`;
}

async function summarizeBlock(blockKey, entries) {
  if (summarizingBlocks.has(blockKey)) return null;
  summarizingBlocks.add(blockKey);

  // Get previous summary for continuity
  const prev = summaries.filter(s => s.block_key < blockKey).sort((a, b) => b.block_key - a.block_key)[0];

  // Build prompt (truncated for speed)
  const entryTexts = entries.slice(0, 15).map(e =>
    `[${new Date(e.timestamp).toLocaleTimeString('zh-CN')}] ${(e.activity||'').slice(0, 80)}`
  ).join('\n');

  const prevProject = prev ? prev.project_name : '无';

  const prompt = `分析10分钟活动记录。上一项目:${prevProject}。如相同则用同名。

记录:
${entryTexts}

JSON输出:
{"project_name":"项目名","category":"娱乐|工作|学习|社交","description":"简要描述(100字内)","software":["软件列表"],"todos":"待办"}
只输出JSON。`;

  try {
    const resp = await fetch(CONFIG.ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.model,
        prompt,
        stream: false,
        options: { num_ctx: 4096, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) throw new Error(`Summary API ${resp.status}`);

    const data = await resp.json();
    let result;
    try {
      // Try to extract JSON from response
      const text = data.response || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { project_name: '未知', category: '工作', description: text.slice(0, 60), software: [] };
    } catch {
      result = { project_name: '未知', category: '工作', description: (data.response || '').slice(0, 60), software: [] };
    }

    const summary = {
      block_key: blockKey,
      block_label: getBlockLabel(blockKey),
      project_name: result.project_name || '未知',
      category: result.category || '工作',
      description: (result.description || result.project_name || '').slice(0, 80),
      software: Array.isArray(result.software) ? result.software : [],
      todos: result.todos || '',
      entry_count: entries.length,
      created_at: new Date().toISOString(),
    };

    summaries.push(summary);
    if (summaries.length > 80) summaries.splice(0, 30);

    // Persist
    try {
      const summaryFile = path.join(CONFIG.dataDir, 'summaries.json');
      fs.writeFileSync(summaryFile, JSON.stringify(summaries, null, 2));
    } catch {}

    // Try to generate diaries for any new dates
    autoGenerateMissingDiaries();

    return summary;
  } catch (err) {
    console.error(`Summary error for block ${blockKey}:`, err.message);
    return null;
  } finally {
    summarizingBlocks.delete(blockKey);
    // Notify renderer after removing from summarizing set
    sendSummaries();
  }
}

function checkSummaries() {
  if (!running || recentEntries.length === 0) return;

  const now = Date.now();
  // Find all un-summarized blocks that have at least a few entries
  const summarizedKeys = new Set(summaries.map(s => s.block_key));
  const blockGroups = {};

  for (const entry of recentEntries) {
    const bk = getBlockKey(entry.timestamp);
    if (summarizedKeys.has(bk) || summarizingBlocks.has(bk)) continue;
    if (bk > now) continue;
    if (!blockGroups[bk]) blockGroups[bk] = [];
    const bkTime = new Date(bk).getTime();
    // Only summarize blocks that ended at least 30 seconds ago
    const blockEnd = bkTime + SUMMARY_INTERVAL;
    if (now - blockEnd < 30_000) continue;
    blockGroups[bk].push(entry);
  }

  // Process oldest first
  const keys = Object.keys(blockGroups).map(Number).sort((a, b) => a - b);
  for (const bk of keys.slice(0, 2)) { // max 2 at a time
    const entries = blockGroups[bk];
    if (entries.length >= 2) {
      summarizeBlock(bk, entries);
    }
  }
}

function sendSummaries() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('summaries-update', {
    summaries: summaries.slice(-100),
    summarizing: Array.from(summarizingBlocks),
  });
}

// ─── Send state to renderer ───────────────────────────────────────────────────
function sendState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state-update', {
    running,
    processing,
    qaInProgress,
    shotCount,
    analyzedCount,
    queueLength,
  });
}

// ─── Timer Control ───────────────────────────────────────────────────────────
function startCapture() {
  if (timer) return;
  running = true;
  sendState();
  takeScreenshotOnly();
  timer = setInterval(takeScreenshotOnly, CONFIG.interval);
  // Summary check every 2 minutes
  summaryTimer = setInterval(checkSummaries, 30_000);
  updateTrayMenu();
}

function stopCapture() {
  if (timer) { clearInterval(timer); timer = null; }
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  running = false;
  sendState();
  updateTrayMenu();
}

// ─── Tray Menu ───────────────────────────────────────────────────────────────
function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: `🧠 ${running ? '● 运行中' : '○ 已暂停'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: running ? '⏸ 暂停捕获' : '▶ 开始捕获',
      click: () => (running ? stopCapture() : startCapture()),
    },
    { type: 'separator' },
    {
      label: '📊 显示状态',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '🚪 退出',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
}

// ─── Main Window ─────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 620,
    resizable: true,
    minWidth: 780,
    minHeight: 480,
    frame: false,
    title: 'LifeLens',
    show: true, // show window on startup
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  ipcMain.on('show-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // IPC: window controls
  ipcMain.on('win-minimize', () => mainWindow?.minimize());
  ipcMain.on('win-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('win-close', () => mainWindow?.close());

  // IPC: toggle capture
  ipcMain.on('toggle-capture', () => {
    running ? stopCapture() : startCapture();
  });

  // IPC: get available models from Ollama
  ipcMain.on('get-models', async () => {
    try {
      const resp = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json();
      const models = (data.models || []).map(m => m.name);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('models-list', models);
      }
    } catch (err) {
      console.error('Failed to get models:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('models-list', []);
      }
    }
  });

  // IPC: save config
  ipcMain.on('save-config', (_e, newConfig) => {
    userConfig = { ...userConfig, ...newConfig };
    CONFIG.model = userConfig.model;
    CONFIG.maxCtx = userConfig.maxCtx;
    saveConfig();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-updated', { ...userConfig });
    }
  });

  // IPC: get current config
  ipcMain.on('get-config', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-updated', { ...userConfig });
    }
  });

  // IPC: request initial state
  ipcMain.on('request-state', () => {
    sendState();
  });

  // IPC: request summaries
  ipcMain.on('request-summaries', () => {
    sendSummaries();
    checkSummaries();
  });

  // IPC: diary (always goes through generateDiary for regeneration check)
  ipcMain.on('request-diary', (_e, dateStr) => {
    generateDiary(dateStr);
  });

  // IPC: push all diaries to renderer
  ipcMain.on('request-all-diaries', () => {
    loadDiaries();
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const [date, diary] of Object.entries(diariesCache)) {
        mainWindow.webContents.send('diary-result', { date, diary });
      }
    }
  });

  // IPC: stats
  ipcMain.on('request-stats', (_e, range) => {
    const stats = computeStats(range);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stats-result', stats);
    }
  });

  // IPC: question
  ipcMain.on('ask-question', async (_e, question) => {
    await handleQuestion(question);
  });
}

// ─── Diary Generation ───────────────────────────────────────────────────────
const DIARIES_FILE = path.join(CONFIG.dataDir, 'diaries.json');
let diariesCache = {};

function loadDiaries() {
  try {
    if (fs.existsSync(DIARIES_FILE)) {
      diariesCache = JSON.parse(fs.readFileSync(DIARIES_FILE, 'utf-8'));
    }
  } catch {}
}

function saveDiaries() {
  try {
    fs.writeFileSync(DIARIES_FILE, JSON.stringify(diariesCache, null, 2));
  } catch {}
}

async function generateDiary(dateStr) {
  // Reload cache from disk to ensure we have latest data
  loadDiaries();

  // Collect all 10-min summaries for that day
  const daySummaries = summaries.filter(s => {
    const d = new Date(s.block_key).toISOString().slice(0, 10);
    return d === dateStr;
  });

  // If diary exists but summaries increased, regenerate
  if (diariesCache[dateStr]) {
    const old = diariesCache[dateStr];
    if (daySummaries.length > (old.summary_count || 0)) {
      // Regenerate - continue below
    } else {
      sendDiary(dateStr, old);
      return;
    }
  } else if (daySummaries.length === 0) {
    sendDiary(dateStr, null);
    return;
  }

  // Build prompt (shortened for speed)
  const summaryTexts = daySummaries.slice(0, 20).map(s =>
    `${s.block_label}|${s.category}|${s.project_name}:${(s.description||'').slice(0, 60)}`
  ).join('\n');

  const prompt = `基于以下每日汇总生成结构化日记。日期:${dateStr} 共${daySummaries.length}条。

汇总:
${summaryTexts}

JSON输出:
{"brief_summary":"50字总结","top_3":["事项1","事项2","事项3"],"highlights":["高光1","高光2"],"todos":["待办"],"optimizations":["建议"],"tips":"一句话提示"}
只输出JSON。`;

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('diary-generating', { date: dateStr });
    }

    const resp = await fetch(CONFIG.ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.model,
        prompt,
        stream: false,
        options: { num_ctx: 4096, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) throw new Error(`Diary API ${resp.status}`);

    const data = await resp.json();
    const text = data.response || '';
    let result;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch { result = null; }

    if (!result) throw new Error('Failed to parse diary JSON');

    const diary = {
      date: dateStr,
      ...result,
      summary_count: daySummaries.length,
      category_stats: daySummaries.reduce((acc, s) => { acc[s.category] = (acc[s.category]||0)+1; return acc; }, {}),
      software_stats: daySummaries.reduce((acc, s) => { s.software?.forEach(sw => { acc[sw] = (acc[sw]||0)+1; }); return acc; }, {}),
      project_stats: daySummaries.reduce((acc, s) => { acc[s.project_name] = (acc[s.project_name]||0)+1; return acc; }, {}),
      generated_at: new Date().toISOString(),
    };

    diariesCache[dateStr] = diary;
    saveDiaries();
    sendDiary(dateStr, diary);

  } catch (err) {
    console.error(`Diary error for ${dateStr}:`, err.message);
    // Fallback: send old diary if available
    if (diariesCache[dateStr]) sendDiary(dateStr, diariesCache[dateStr]);
    else sendDiary(dateStr, null, err.message);
  }
}

function sendDiary(date, diary, error) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('diary-result', { date, diary, error });
}

// Auto-generate missing diaries
async function autoGenerateMissingDiaries() {
  loadDiaries();
  const dateSet = new Set(Object.keys(diariesCache));

  // Find all dates that have summaries
  const datesWithData = new Set();
  for (const s of summaries) {
    const d = new Date(s.block_key).toISOString().slice(0, 10);
    datesWithData.add(d);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Generate or regenerate diaries for dates with data
  for (const d of datesWithData) {
    if (d > today) continue;
    const sCount = summaries.filter(s => new Date(s.block_key).toISOString().slice(0, 10) === d).length;
    const existing = diariesCache[d];
    if (!existing || sCount > (existing.summary_count || 0)) {
      await generateDiary(d);
    }
  }
}

// ─── Stats Computation ──────────────────────────────────────────────────────
function computeStats(range) {
  const { mode, start, end } = range;
  let filtered = [...summaries];

  if (start) {
    const s = new Date(start).getTime();
    filtered = filtered.filter(sm => sm.block_key >= s);
  }
  if (end) {
    const e = new Date(end).getTime();
    filtered = filtered.filter(sm => sm.block_key <= e);
  }

  // Category distribution
  const categoryDist = {};
  filtered.forEach(s => { categoryDist[s.category] = (categoryDist[s.category]||0) + s.entry_count; });

  // Software ranking
  const softwareRank = {};
  filtered.forEach(s => {
    s.software?.forEach(sw => { softwareRank[sw] = (softwareRank[sw]||0) + s.entry_count; });
  });

  // Project time
  const projectTime = {};
  filtered.forEach(s => { projectTime[s.project_name] = (projectTime[s.project_name]||0) + s.entry_count; });

  // Sort
  const sortedSoftware = Object.entries(softwareRank).sort((a,b) => b[1]-a[1]).slice(0, 15);
  const sortedProjects = Object.entries(projectTime).sort((a,b) => b[1]-a[1]).slice(0, 15);

  return {
    mode,
    start: start || undefined,
    end: end || undefined,
    total_blocks: filtered.length,
    category_distribution: categoryDist,
    software_ranking: sortedSoftware,
    project_ranking: sortedProjects,
  };
}

// Load diaries on startup
loadDiaries();

// ─── Q&A Agent ──────────────────────────────────────────────────────────────
const QA_MAX = 3;

function parseTimeRange(str) {
  if (!str || str === '7d') return Date.now() - 7*86400000;
  if (str === 'today') return new Date().setHours(0,0,0,0);
  if (str === 'yesterday') return Date.now() - 86400000;
  if (str === 'week') return Date.now() - 7*86400000;
  if (str === 'month') return Date.now() - 30*86400000;
  const m = str.match(/^(\d+)([dh])$/);
  if (m) return Date.now() - parseInt(m[1])*(m[2]==='d'?86400000:3600000);
  const d = new Date(str);
  if (!isNaN(d)) return d.getTime();
  return Date.now() - 7*86400000;
}

function searchQA(plan) {
  const results = new Set();
  const since = parseTimeRange(plan.time_range);
  const kws = (plan.keywords||[]).map(k => k.toLowerCase());
  const sources = plan.sources || ['summaries'];

  // Test function: check if text matches any keyword
  const matches = (text) => !kws.length || kws.some(k => text.includes(k));

  if (sources.includes('summaries')) {
    for (const s of summaries) {
      if (s.block_key < since) continue;
      const txt = `${s.project_name} ${s.description} ${(s.software||[]).join(' ')} ${s.category}`.toLowerCase();
      if (matches(txt))
        results.add(`[10min]${s.block_label} ${s.category}|${s.project_name}:${s.description.slice(0,80)}`);
    }
  }

  if (sources.includes('entries')) {
    let count = 0;
    for (const e of recentEntries) {
      if (count >= 30) break;
      const t = new Date(e.timestamp).getTime();
      if (t < since) continue;
      if (matches((e.activity||'').toLowerCase())) {
        results.add(`[快照]${e.timestamp.slice(5,19)}:${(e.activity||'').slice(0,150)}`);
        count++;
      }
    }
  }

  if (sources.includes('diaries')) {
    for (const [date, d] of Object.entries(diariesCache)) {
      const txt = `${d.brief_summary||''} ${(d.top_3||[]).join(' ')} ${(d.highlights||[]).join(' ')} ${d.tips||''}`.toLowerCase();
      if (matches(txt))
        results.add(`[日记]${date}:${(d.brief_summary||'')}`);
    }
  }

  // Fallback: if keywords matched nothing, return most recent summaries anyway
  if (results.size === 0 && summaries.length > 0) {
    const recent = summaries.filter(s => s.block_key >= since).slice(-5);
    for (const s of recent) {
      results.add(`[10min]${s.block_label} ${s.category}|${s.project_name}:${s.description.slice(0,80)}`);
    }
  }

  return Array.from(results);
}

async function handleQuestion(question) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = (type, text) => mainWindow.webContents.send('qa-token', { type, text });

  // Pause image analysis during Q&A
  qaInProgress = true;
  sendState();
  send('thinking', '🤔 分析问题中（已暂停截图分析）...\n');

  let allCtx = [];
  let iter = 0;

  while (iter < QA_MAX) {
    iter++;
    const ctxHint = allCtx.length > 0 ? `\n已搜到${allCtx.length}条,决定是否继续搜索` : '';

    const prompt = `你是个搜索规划助手。用户问:${question}${ctxHint}
数据源:summaries(10分钟汇总),entries(20秒快照),diaries(每日日记)
输出JSON:
{"keywords":["k1","k2"],"time_range":"7d","sources":["summaries","diaries"],"stop":false,"reason":"原因"}
只输出JSON。`;

    let plan;
    try {
      const resp = await fetch(CONFIG.ollamaUrl, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:CONFIG.model,prompt,stream:false,options:{num_ctx:4096,temperature:0.2}}),
        signal:AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const txt = await resp.json();
      const m = (txt.response||'').match(/\{[\s\S]*\}/);
      plan = m ? JSON.parse(m[0]) : {keywords:[question],time_range:'7d',sources:['summaries','diaries'],stop:false};

      // Always search at least once, even if model says stop
      if (plan.stop && iter === 1) {
        plan = {keywords:[question],time_range:'7d',sources:['summaries','diaries'],stop:false};
      }
    } catch(err) {
      console.error('QA plan error:', err.message);
      plan = {keywords:[question],time_range:'7d',sources:['summaries','diaries'],stop:false};
    }

    send('search', `🔍第${iter}次: [${(plan.keywords||[]).join(',')}] ${plan.time_range||'7d'}\n`);
    const res = searchQA(plan);
    allCtx.push(...res);

    if (plan.stop || iter >= QA_MAX) break;
  }

  send('answer', `📝基于${allCtx.length}条记录回答中...\n`);

  const ctx = allCtx.slice(0,40).join('\n').slice(0,6000);

  try {
    const resp = await fetch(CONFIG.ollamaUrl, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:CONFIG.model,
        prompt:`你是LifeLens助手。基于用户活动记录回答问题。\n问:${question}\n\n记录:\n${ctx||'无相关记录'}\n\n用中文回答，简洁有条理。信息不足则如实说明。`,
        stream:true,
        options:{num_ctx:8192,temperature:0.3},
      }),
      signal:AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      buf += dec.decode(value,{stream:true});
      for (const line of buf.split('\n').slice(0,-1)) {
        try { const c=JSON.parse(line); if(c.response) send('token', c.response); } catch{}
      }
      buf = buf.split('\n').pop() || '';
    }
  } catch(err) {
    send('error', `回答失败:${err.message}`);
  }
  // Resume image analysis - process latest pending screenshot
  qaInProgress = false;
  if (pendingAnalysisPath && !processing) {
    setTimeout(() => processAnalysis(), 500);
  }
  sendState();
  send('done', '');
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Ensure data directory
  ensureDir(CONFIG.dataDir);

  // Load persisted summaries
  try {
    const sf = path.join(CONFIG.dataDir, 'summaries.json');
    if (fs.existsSync(sf)) {
      const loaded = JSON.parse(fs.readFileSync(sf, 'utf-8'));
      summaries.push(...loaded);
    }
  } catch {}

  // Load recent entries from hourly files into memory for summarization
  try {
    const monthDirs = fs.readdirSync(CONFIG.dataDir).filter(d => d.match(/^\d{4}-\d{2}$/));
    const today = new Date().toISOString().slice(0, 7); // YYYY-MM
    const recentDirs = monthDirs.filter(d => d >= today).sort().slice(-1);
    for (const dir of recentDirs) {
      const dirPath = path.join(CONFIG.dataDir, dir);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
      for (const file of files.slice(-1)) { // only last hour file
        const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf-8'));
        if (Array.isArray(data)) recentEntries.push(...data.slice(-50)); // max 50 entries
      }
    }
  } catch {}

  // Start periodic cleanup (every 6 hours)
  function cleanupOldFiles() {
    const cutOff = Date.now() - 3 * 86400000; // 3 days ago
    try {
      const dirs = fs.readdirSync(CONFIG.dataDir).filter(d => d.match(/^\d{4}-\d{2}$/));
      let deleted = 0;
      for (const dir of dirs) {
        const shotDir = path.join(CONFIG.dataDir, dir, 'screenshots');
        if (!fs.existsSync(shotDir)) continue;
        for (const file of fs.readdirSync(shotDir)) {
          const fp = path.join(shotDir, file);
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutOff) {
            fs.unlinkSync(fp);
            deleted++;
          }
        }
        // Remove empty screenshot dir
        if (fs.existsSync(shotDir) && fs.readdirSync(shotDir).length === 0) {
          fs.rmdirSync(shotDir);
        }
      }
      if (deleted > 0) console.log(`Cleaned up ${deleted} old screenshots`);
    } catch (err) { console.error('Cleanup error:', err.message); }
  }
  // Run cleanup every 6 hours, and once on startup
  setInterval(cleanupOldFiles, 6 * 3600000);
  setTimeout(cleanupOldFiles, 10000);

  // Tray
  tray = new Tray(createTrayIcon());
  tray.setToolTip('LifeLens — 活动记录中');
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTrayMenu();

  // Window
  createMainWindow();

  // Start capturing
  startCapture();

  // Catch up on summaries and diaries
  setTimeout(() => { checkSummaries(); autoGenerateMissingDiaries(); }, 8000);
});

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopCapture();
});
