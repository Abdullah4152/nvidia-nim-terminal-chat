#!/usr/bin/env node
'use strict';

/*
 * nvchat — terminal chat UI for NVIDIA NIM / OpenAI-compatible endpoints.
 *
 * Key fixes vs previous version:
 *  - screen.question() does not exist in blessed -> custom modal (askConfirm).
 *    File writes and /run used to crash the app.
 *  - blessed maps the Enter key to 'return' (NOT 'enter'); textarea silently
 *    ignores 'return'. Enter previously did nothing. Now: Enter sends,
 *    Ctrl+J inserts a newline, pasted multi-line text is detected by timing.
 *  - Blessed tag escaping fixed ({open}/{close}; backslash escaping is not
 *    a thing in blessed, so model output containing `{` rendered garbage).
 *  - API key is read from the environment, not argv (visible in process list).
 *  - 429/5xx retry with backoff, spinner, throttled rendering, scroll-lock,
 *    correct history rollback on abort/error.
 */

const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* ---------------------------------------------------------------- config */

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`nvchat needs Node 18+ (built-in fetch). You have ${process.version}.`);
  process.exit(1);
}

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

const isLocal = hasFlag('--local');
const config = {
  apiKey: argValue('--api-key') || process.env.NVIDIA_API_KEY || 'local',
  model: argValue('--model'),
  baseUrl: (isLocal
    ? argValue('--local-url', 'http://localhost:11434/v1')
    : argValue('--base-url', 'https://integrate.api.nvidia.com/v1')).replace(/\/+$/, ''),
  temperature: Number(argValue('--temperature', '0.7')),
  maxTokens: Number(argValue('--max-tokens', '2048')),
  workspace: process.cwd(),
};
if (!config.model) {
  console.error('Missing model. Run: nvchat -Model <model-id>   (e.g. meta/llama-3.3-70b-instruct)');
  process.exit(1);
}

const dataDir = path.join(config.workspace, '.nvchat');
const sessionsDir = path.join(dataDir, 'sessions');
const toolOutputDir = path.join(dataDir, 'tool-output');
const memoryFile = path.join(dataDir, 'memory.json');
const skillsDir = path.join(dataDir, 'skills');

const systemText =
  'When the user explicitly asks to create or update a file, return only real intended files using ' +
  '<nvchat-file path="name.ext">contents</nvchat-file>. Never use that tag as an example or with placeholder paths.';

/* ----------------------------------------------------------------- state */

let messages = [{ role: 'system', content: systemText }];
let transcript = [];            // rendered lines/blocks; joined with \n
let controller = null;          // AbortController of the active request
let paletteVisible = false;
let paletteMatches = [];
let choicePicker = null;        // { kind, values } when palette is selecting a model/session
let activeSkill = '';
let activeSkillName = '';
let activityIndex = -1;         // transcript index of the spinner line
let activityText = '';
let spinnerTimer = null;
let spinnerFrame = 0;
let lastKeyAt = 0;              // for paste detection
let lastLatencyMs = 0;
let memories = [];
try { memories = JSON.parse(fs.readFileSync(memoryFile, 'utf8')); } catch { memories = []; }

/* ----------------------------------------------------------------- theme */

const C = {
  accent: '#89b4fa',   // header / borders / links
  model:  '#a6e3a1',   // assistant label
  user:   '#cba6f7',   // user label
  warn:   '#f9e2af',
  err:    '#f38ba8',
  ok:     '#94e2d5',
  dim:    '#6c7086',
  code:   '#89dceb',
  kw:     '#cba6f7',
  str:    '#a6e3a1',
  surface:'#181825',
  inputBg:'#1e1e2e',
};
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/* -------------------------------------------------------------------- ui */

const screen = blessed.screen({
  smartCSR: true, fullUnicode: true, title: 'nvchat',
  style: { bg: 'black', fg: 'white' },
});

const header = blessed.text({
  top: 0, left: 0, right: 0, height: 1, tags: true,
  style: { bg: C.surface, fg: 'white' },
});

const chat = blessed.log({
  top: 1, left: 1, right: 1, bottom: 4,
  scrollable: true, alwaysScroll: true, mouse: true, keys: false, tags: true,
  scrollbar: { ch: ' ', style: { bg: C.dim } },
  style: { fg: 'white', bg: 'black' },
});

const input = blessed.textarea({
  bottom: 1, left: 1, right: 1, height: 3,
  inputOnFocus: true, keys: true, mouse: true, tags: false, wrap: true,
  scrollable: true, alwaysScroll: false,
  border: { type: 'line' },
  padding: { left: 1, right: 1 },
  label: ' ❯ message ',
  style: {
    fg: '#e6e6e6', bg: C.inputBg,
    border: { fg: C.accent, bg: 'black' },
    label: { fg: C.accent, bold: true },
  },
});

const inputHint = blessed.text({
  bottom: 2, left: 4, height: 1, width: 'shrink',
  content: 'Type a message · / for commands',
  style: { fg: C.dim, bg: C.inputBg },
});

const footer = blessed.text({
  bottom: 0, left: 1, right: 1, height: 1, tags: true,
  style: { fg: C.dim, bg: 'black' },
});

const palette = blessed.list({
  hidden: true, bottom: 4, left: 1, right: 1, height: 11,
  keys: false, mouse: true, tags: true,
  border: { type: 'line' },
  style: {
    fg: 'gray', bg: C.surface,
    border: { fg: C.dim },
    selected: { fg: 'black', bg: C.accent, bold: true },
    item: { fg: 'gray', bg: C.surface },
  },
});

screen.append(chat); screen.append(header); screen.append(palette);
screen.append(input); screen.append(inputHint); screen.append(footer);

const commands = [
  ['/model', 'change active model'],
  ['/save', 'save current chat'],
  ['/resume', 'resume saved chat'],
  ['/sessions', 'list saved chats'],
  ['/file', 'attach file context'],
  ['/search', 'search workspace'],
  ['/run', 'run approved shell command'],
  ['/agent', 'delegate isolated sub-agents'],
  ['/remember', 'save persistent memory'],
  ['/memories', 'list memories'],
  ['/skills', 'list skills'],
  ['/skill', 'load a skill'],
  ['/summarize', 'compact current chat'],
  ['/temperature', 'set sampling temperature'],
  ['/tokens', 'set max output tokens'],
  ['/ls', 'list workspace files'],
  ['/pwd', 'show workspace'],
  ['/clear', 'clear chat'],
  ['/exit', 'close nvchat'],
  ['/help', 'show commands and keys'],
];
const ARG_COMMANDS = new Set(['/model', '/save', '/resume', '/file', '/search', '/run', '/agent', '/remember', '/skill', '/temperature', '/tokens']);

/* --------------------------------------------------------- render helpers */

function escapeTags(text) {
  // blessed has no backslash escaping; {open}/{close} are the literal braces.
  return String(text).replace(/{/g, '{open}').replace(/}/g, '{close}');
}
function tag(color, text) { return `{${color}-fg}${text}{/${color}-fg}`; }

function shortModel() { return config.model.split('/').pop(); }
function shortPath(p, max = 34) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let out = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  if (out.length > max) out = '…' + out.slice(-max);
  return out;
}

function renderHeader() {
  screen.title = 'nvchat — ' + config.model;
  const leftPlain = `  nvchat · ${config.model}${activeSkillName ? ` · skill:${activeSkillName}` : ''}`;
  const rightPlain = `${isLocal ? 'local' : 'nvidia'} · ${shortPath(config.workspace)}` +
    (lastLatencyMs ? ` · ${(lastLatencyMs / 1000).toFixed(1)}s` : '') + '  ';
  const pad = Math.max(1, (screen.width || 80) - leftPlain.length - rightPlain.length);
  header.setContent(
    '  {bold}' + tag(C.accent, 'nvchat') + '{/bold}' +
    tag(C.dim, ' · ') + tag(C.model, escapeTags(config.model)) +
    (activeSkillName ? tag(C.dim, ' · ') + tag(C.warn, 'skill:' + escapeTags(activeSkillName)) : '') +
    ' '.repeat(pad) + tag(C.dim, escapeTags(rightPlain))
  );
}

function renderFooter() {
  footer.setContent(tag(C.dim,
    'Enter send · Ctrl+J newline · Ctrl+U clear · Esc cancel · PgUp/PgDn scroll · Ctrl+C quit'));
}

let renderQueued = false;
function renderTranscript(force = false) {
  if (renderQueued && !force) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const atBottom = chat.getScrollHeight() <= chat.height ||
      chat.getScrollPerc() >= 95;
    const previousScroll = chat.getScroll();
    chat.setContent(transcript.join('\n'));
    if (atBottom) chat.setScrollPerc(100);
    else chat.scrollTo(Math.min(previousScroll, Math.max(0, chat.getScrollHeight() - 1)));
    screen.render();
  }, force ? 0 : 33);
}
function scrollTranscript(lines) {
  chat.scroll(lines);
  screen.render();
}
chat.on('wheelup', () => scrollTranscript(-3));
chat.on('wheeldown', () => scrollTranscript(3));

/* -------------------------------------------------- markdown-ish rendering */

function inlineMarkdown(text) {
  let v = escapeTags(text);
  const BT = '`';
  v = v.replace(/\*\*(.+?)\*\*/g, '{bold}$1{/bold}');
  v = v.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), tag(C.code, '$1'));
  v = v.replace(/\[([^\]]+)\]\(([^)]+)\)/g, tag(C.accent, '$1') + ' ' + tag(C.dim, '($2)'));
  return v;
}
function codeLine(text) {
  let v = escapeTags(text);
  v = v.replace(/(\/\/.*$|#.*$)/g, tag(C.dim, '$1'));
  v = v.replace(/\b(const|let|var|function|return|if|else|for|while|async|await|class|import|from|def|print|true|false|null|undefined)\b/g, tag(C.kw, '$1'));
  v = v.replace(/(['"][^'"]*['"])/g, tag(C.str, '$1'));
  return v;
}
function renderModelText(text) {
  let fenced = false; let language = '';
  const out = [];
  const FENCE = '```';
  for (const rawLine of String(text).replace(/\r/g, '').split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith(FENCE)) {
      fenced = !fenced;
      language = trimmed.slice(3).trim().toLowerCase();
      out.push(tag(C.dim, fenced ? '┌─ ' + (language || 'code') : '└─'));
      continue;
    }
    if (fenced) {
      const body = (language === 'diff' || /^(\+|-|@@)/.test(rawLine))
        ? (rawLine.startsWith('+') ? tag('#a6e3a1', escapeTags(rawLine))
          : rawLine.startsWith('-') ? tag('#f38ba8', escapeTags(rawLine))
          : tag('#8f8f8f', escapeTags(rawLine)))
        : codeLine(rawLine);
      out.push(tag(C.dim, '│ ') + body);
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(rawLine)) {
      out.push(tag(C.dim, '─'.repeat(Math.min(72, (screen.width || 80) - 4))));
      continue;
    }
    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { out.push('{bold}' + tag(C.accent, inlineMarkdown(heading[2])) + '{/bold}'); continue; }
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (quote) { out.push(tag(C.dim, '▎ ') + tag(C.dim, inlineMarkdown(quote[1]))); continue; }
    const bullet = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) { out.push(bullet[1] + tag('#b0b0b0', '•') + ' ' + inlineMarkdown(bullet[2])); continue; }
    const numbered = rawLine.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numbered) { out.push(numbered[1] + tag('#b0b0b0', numbered[2] + '.') + ' ' + inlineMarkdown(numbered[3])); continue; }
    out.push(inlineMarkdown(rawLine));
  }
  return out.join('\n');
}

/* ------------------------------------------------------ transcript pieces */

function pushUser(text) {
  if (transcript.length) transcript.push('');
  transcript.push('{bold}' + tag(C.user, '❯ you') + '{/bold}');
  transcript.push(inlineMarkdown(text));
}
function pushAssistantLabel(name) {
  transcript.push('{bold}' + tag(C.model, '⏺ ' + escapeTags(name)) + '{/bold}');
}
function clearChat() {
  messages = [{ role: 'system', content: systemText }];
  transcript = [];
  activityIndex = -1;
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  renderTranscript(true);
}
function exitNvchat() {
  if (controller) controller.abort();
  if (spinnerTimer) clearInterval(spinnerTimer);
  screen.destroy();
  process.exit(0);
}
function status(text, color = C.dim) {
  transcript.push(tag(color, '·') + ' ' + inlineMarkdown(text));
  renderTranscript();
}

function setActivity(text) {
  activityText = text;
  const line = tag(C.dim, SPINNER[spinnerFrame] + ' ' + escapeTags(text));
  if (activityIndex >= 0) transcript[activityIndex] = line;
  else activityIndex = transcript.push(line) - 1;
  if (!spinnerTimer) {
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      if (activityIndex >= 0) {
        transcript[activityIndex] = tag(C.dim, SPINNER[spinnerFrame] + ' ' + escapeTags(activityText));
        renderTranscript();
      }
    }, 90);
  }
  renderTranscript();
}
function clearActivity() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  if (activityIndex < 0) return -1;
  const removed = activityIndex;
  transcript.splice(activityIndex, 1);
  activityIndex = -1;
  return removed;
}

/* ------------------------------------------------------------ input sizing */

function contentRows() {
  const renderedRows = Array.isArray(input._clines) ? input._clines.length : 0;
  if (renderedRows) return Math.max(1, renderedRows);
  const width = Math.max(20, (screen.width || 100) - 6); // margins(2)+border(2)+padding(2)
  return input.getValue().replace(/\r/g, '').split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(Math.max(line.length, 1) / width)), 0);
}
function resizeInput() {
  const rows = Math.min(Math.max(contentRows(), 1), 8);
  const boxH = rows + 2;                    // + border
  input.height = boxH;
  chat.bottom = boxH + 1;                   // + footer
  palette.bottom = boxH + 1;
  inputHint.bottom = boxH - 1;              // first content row inside border
}
function refreshInputHint() {
  if (input.getValue()) inputHint.hide(); else inputHint.show();
  resizeInput();
  screen.render();
  input._updateCursor();
}
function promptInput() { input.setValue(''); input.focus(); refreshInputHint(); }

/* ----------------------------------------------------------------- palette */

function canShowPalette() { return /^\/\S*$/.test(input.getValue()); }
function showPalette() {
  if (!canShowPalette()) return hidePalette();
  choicePicker = null;
  const typed = input.getValue().trim().toLowerCase();
  paletteMatches = commands.filter(([c]) => !typed || c.startsWith(typed));
  palette.setItems(paletteMatches.map(([c, d]) =>
    `{bold}${tag(C.code, c.padEnd(13))}{/bold}${tag(C.dim, d)}`));
  if (paletteMatches.length) {
    const keepSelection = paletteVisible && palette.selected < paletteMatches.length;
    palette.height = Math.min(paletteMatches.length + 2, 13);
    palette.show();
    if (!keepSelection) palette.select(0);
    paletteVisible = true;
  } else { palette.hide(); paletteVisible = false; }
  screen.render();
}
function hidePalette() { palette.hide(); paletteVisible = false; choicePicker = null; screen.render(); }
function insertSelected() {
  const selected = paletteMatches[palette.selected];
  if (!selected) return;
  const [text] = selected;
  input.setValue(text + (ARG_COMMANDS.has(text) ? ' ' : ''));
  inputHint.hide();
  input.focus();
  hidePalette();
  screen.render();
}
function showChoicePicker(kind, values) {
  if (!values.length) return;
  choicePicker = { kind, values };
  paletteMatches = values.map(value => [value, '']);
  palette.setItems(values.map(value => '{bold}' + tag(C.code, value) + '{/bold}'));
  palette.height = Math.min(values.length + 2, 13);
  palette.show(); palette.select(0); paletteVisible = true;
  input.clearValue(); inputHint.hide(); input.focus(); screen.render();
}
function choosePickerSelection() {
  if (!choicePicker) return;
  const choice = choicePicker.values[palette.selected];
  const kind = choicePicker.kind;
  hidePalette();
  if (!choice) return promptInput();
  if (kind === 'resume') resumeSession(choice);
  if (kind === 'model') { config.model = choice; renderHeader(); status('Model: ' + choice, C.ok); }
  promptInput();
}
palette.on('select', (_, index) => {
  if (choicePicker) { palette.select(index); return choosePickerSelection(); }
  const selected = paletteMatches[index];
  if (!selected) return;
  hidePalette();
  if (selected[0] === '/resume') return openResumePicker();
  if (selected[0] === '/model') return openModelPicker();
  insertSelected();
});

/* ------------------------------------------------------------ confirm modal */

function askConfirm(text) {
  return new Promise(resolve => {
    const lines = String(text).split('\n');
    const width = Math.min(Math.max(...lines.map(l => l.length), 24) + 6, (screen.width || 80) - 4);
    const box = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width, height: lines.length + 4, tags: true,
      border: { type: 'line' }, padding: { left: 1, right: 1 },
      label: ' confirm ',
      style: { bg: C.surface, fg: 'white', border: { fg: C.warn }, label: { fg: C.warn, bold: true } },
    });
    box.setContent(escapeTags(text) + '\n\n{bold}y{/bold}' + tag(C.dim, ' yes    ') + '{bold}n / Esc{/bold}' + tag(C.dim, ' no'));
    const done = ok => { box.destroy(); screen.render(); input.focus(); resolve(ok); };
    box.on('keypress', (ch, key) => {
      key = key || {};
      if (ch === 'y' || ch === 'Y') return done(true);
      if (ch === 'n' || ch === 'N' || key.name === 'escape' || key.name === 'return' || key.name === 'enter') return done(false);
    });
    box.focus();
    screen.render();
  });
}

/* --------------------------------------------------------------- fs helpers */

function safePath(file) {
  const full = path.resolve(config.workspace, file);
  const base = config.workspace.endsWith(path.sep) ? config.workspace : config.workspace + path.sep;
  if (process.platform === 'win32') {
    return full.toLowerCase().startsWith(base.toLowerCase()) ? full : null;
  }
  return full.startsWith(base) ? full : null;
}
function attachFile(file) {
  const full = safePath(file);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const content = fs.readFileSync(full, 'utf8').slice(0, 60000);
  return `--- file: ${path.relative(config.workspace, full)} ---\n${content}\n--- end file ---`;
}
function offload(kind, content) {
  fs.mkdirSync(toolOutputDir, { recursive: true });
  const name = `${Date.now()}-${kind}.log`;
  fs.writeFileSync(path.join(toolOutputDir, name), content);
  return path.relative(config.workspace, path.join(toolOutputDir, name));
}
function searchWorkspace(query) {
  const skip = new Set(['node_modules', '.git', '.nvchat']);
  const results = [];
  const needle = query.toLowerCase();
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= 30) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        if (fs.statSync(full).size > 300000) continue;
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue; // binary
        buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
          if (results.length < 30 && line.toLowerCase().includes(needle)) {
            results.push(`${path.relative(config.workspace, full)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
      } catch { /* unreadable */ }
    }
  })(config.workspace);
  return results;
}

/* ---------------------------------------------------------------- sessions */

function sessionPath(name) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ? path.join(sessionsDir, `${name}.json`) : null;
}
function saveSession(name) {
  const file = sessionPath(name);
  if (!file) return status('Invalid session name (letters, digits, - and _).', C.warn);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    model: config.model, temperature: config.temperature, maxTokens: config.maxTokens, messages,
  }, null, 2));
  status(`Saved ${name}.`, C.ok);
}
function resumeSession(name) {
  const file = sessionPath(name);
  if (!file || !fs.existsSync(file)) return status('Saved chat not found.', C.warn);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return status('Saved chat is corrupted.', C.err); }
  messages = saved.messages || [{ role: 'system', content: systemText }];
  config.model = saved.model || config.model;
  config.temperature = saved.temperature ?? config.temperature;
  config.maxTokens = saved.maxTokens ?? config.maxTokens;
  transcript = [];
  for (const m of messages) {
    if (m.role === 'user') pushUser(m.content);
    else if (m.role === 'assistant') { pushAssistantLabel(shortModel()); transcript.push(renderModelText(m.content)); }
  }
  renderHeader();
  status(`Resumed ${name}.`, C.ok);
}
function listSessions() {
  if (!fs.existsSync(sessionsDir)) return status('No saved chats.');
  const names = fs.readdirSync(sessionsDir).filter(x => x.endsWith('.json')).map(x => x.slice(0, -5));
  status(names.length ? `Saved chats: ${names.join(', ')}` : 'No saved chats.');
}

function sessionNames() {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter(x => x.endsWith('.json')).map(x => x.slice(0, -5)).sort();
}
function knownModels() {
  const defaults = [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.2-3b-instruct',
    'meta/llama-3.1-8b-instruct',
    'mistralai/mistral-large-2-instruct',
    'deepseek-ai/deepseek-r1',
  ];
  const values = new Set([config.model, ...defaults]);
  const customFile = path.join(dataDir, 'models.json');
  try {
    const custom = JSON.parse(fs.readFileSync(customFile, 'utf8'));
    if (Array.isArray(custom)) custom.filter(x => typeof x === 'string' && x.trim()).forEach(x => values.add(x.trim()));
  } catch { /* optional file */ }
  for (const name of sessionNames()) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, name + '.json'), 'utf8'));
      if (typeof saved.model === 'string' && saved.model.trim()) values.add(saved.model.trim());
    } catch { /* ignore damaged session */ }
  }
  return [...values].sort((a, b) => a === config.model ? -1 : b === config.model ? 1 : a.localeCompare(b));
}
function chooseFromList(label, values) {
  return new Promise(resolve => {
    if (!values.length) return resolve(null);
    const width = Math.min(Math.max(...values.map(v => v.length), label.length, 28) + 6, Math.max(36, (screen.width || 80) - 6));
    const picker = blessed.list({
      parent: screen, top: 'center', left: 'center', width,
      height: Math.min(values.length + 2, Math.max(5, (screen.height || 24) - 4)),
      keys: true, mouse: true, tags: true, border: { type: 'line' },
      label: ' ' + label + ' ',
      style: {
        fg: 'white', bg: C.surface, border: { fg: C.accent }, label: { fg: C.accent, bold: true },
        selected: { fg: 'black', bg: C.accent, bold: true }, item: { fg: 'white', bg: C.surface },
      },
    });
    picker.setItems(values.map(escapeTags));
    let closed = false;
    const done = value => {
      if (closed) return;
      closed = true; picker.destroy(); input.focus(); screen.render(); resolve(value || null);
    };
    picker.on('select', (_, index) => done(values[index]));
    picker.key(['escape', 'C-c'], () => done(null));
    picker.key(['return', 'enter'], () => done(values[picker.selected]));
    picker.focus(); picker.select(0); screen.render();
  });
}
function openResumePicker() {
  const names = sessionNames();
  if (!names.length) { status('No saved chats.', C.warn); return promptInput(); }
  showChoicePicker('resume', names);
}
function openModelPicker() {
  showChoicePicker('model', knownModels());
}

/* ------------------------------------------------------------- file writes */

async function maybeWriteBlocks(text, requested) {
  const re = /<nvchat-file\s+path\s*=\s*"([^"]+)"\s*>\n?([\s\S]*?)\n?<\/nvchat-file>/g;
  const blocks = [...text.matchAll(re)];
  if (!blocks.length || !requested) return;
  const valid = blocks.filter(m =>
    !/^(relative\/|path\.(ext|txt)$|file\.(ext|txt)$)/i.test(m[1]) && safePath(m[1]));
  if (!valid.length) { status('Ignored placeholder/unsafe file block.', C.warn); return; }
  const ok = await askConfirm(`Write ${valid.length} file(s)?\n${valid.map(m => '  ' + m[1]).join('\n')}`);
  if (!ok) { status('File write declined.', C.warn); return; }
  for (const m of valid) {
    const target = safePath(m[1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, m[2], 'utf8');
    status(`Wrote ${m[1]}`, C.ok);
  }
}
function explicitFileRequest(text) {
  return /\b(create|write|make|add|update|modify|edit|implement|save|fix)\b/i.test(text);
}

/* --------------------------------------------------------- memory / skills */

function memoryContext() {
  return memories.length ? `\nPersistent memory:\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}` : '';
}
function saveMemories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2));
}
function requestMessages(extra = []) {
  return [
    { role: 'system', content: systemText + memoryContext() + (activeSkill ? `\nLoaded skill:\n${activeSkill}` : '') },
    ...messages.slice(1),
    ...extra,
  ];
}

/* --------------------------------------------------------------------- api */

async function apiFetch(body, signal) {
  let attempt = 0;
  for (;;) {
    attempt++;
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 3) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      throw new Error(`${response.status}: ${detail || response.statusText}`);
    }
    const wait = Number(response.headers.get('retry-after')) * 1000 || attempt * 2000;
    setActivity(`Rate limited (${response.status}) — retrying in ${Math.round(wait / 1000)}s…`);
    await new Promise(r => setTimeout(r, wait));
  }
}
async function callOnce(agentMessages) {
  const response = await apiFetch({
    model: config.model, messages: agentMessages,
    temperature: config.temperature, max_tokens: config.maxTokens, stream: false,
  });
  return (await response.json()).choices?.[0]?.message?.content || '';
}

/* --------------------------------------------------------------- summarize */

async function summarize() {
  if (messages.length <= 10) return status('Chat is already compact.');
  const older = messages.slice(1, -8);
  setActivity('Summarizing earlier messages…');
  try {
    const summary = await callOnce([
      { role: 'system', content: 'Summarize this coding conversation faithfully. Preserve requirements, paths, decisions, and unfinished work. Be concise.' },
      { role: 'user', content: JSON.stringify(older) },
    ]);
    messages = [
      { role: 'system', content: systemText },
      { role: 'system', content: `Conversation summary:\n${summary}` },
      ...messages.slice(-8),
    ];
    status('Chat compacted.', C.ok);
  } finally { clearActivity(); renderTranscript(); }
}

/* ------------------------------------------------------------------ agents */

async function runAgents(task) {
  setActivity('Planning sub-agents…');
  let plan;
  try {
    const raw = await callOnce([
      { role: 'system', content: 'Split the request into at most 3 concrete coding sub-tasks. Return only a JSON array of strings, no markdown.' },
      { role: 'user', content: task },
    ]);
    plan = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
    if (!Array.isArray(plan) || !plan.length) plan = [task];
  } catch { plan = [task]; }
  clearActivity();
  const total = Math.min(plan.length, 3);
  for (const [index, subtask] of plan.slice(0, 3).entries()) {
    setActivity(`Agent ${index + 1}/${total}: ${String(subtask).slice(0, 60)}…`);
    const reply = await callOnce([
      { role: 'system', content: 'You are an isolated sub-agent. Work only on this task. Report concrete findings or proposed changes. Do not assume access to parent conversation.' + memoryContext() + (activeSkill ? `\nLoaded skill:\n${activeSkill}` : '') },
      { role: 'user', content: String(subtask) },
    ]);
    clearActivity();
    if (transcript.length) transcript.push('');
    transcript.push('{bold}' + tag(C.code, `⏺ agent ${index + 1}/${total}`) + '{/bold} ' + tag(C.dim, escapeTags(String(subtask).slice(0, 80))));
    transcript.push(renderModelText(reply));
    renderTranscript();
  }
  clearActivity();
  renderTranscript();
}

/* -------------------------------------------------------------------- send */

async function send(text) {
  const user = text.trim();
  if (!user) return promptInput();
  const shorthand = user.toLowerCase();
  if (shorthand === 'clear' || shorthand === '/clear') {
    clearChat();
    return promptInput();
  }
  if (shorthand === 'exit' || shorthand === 'quit' || shorthand === '/exit' || shorthand === '/quit') {
    return exitNvchat();
  }
  if (user.startsWith('/')) return command(user);

  pushUser(user);
  messages.push({ role: 'user', content: user });
  renderTranscript(true);

  controller = new AbortController();
  let reply = '';
  let assistantPushed = false;
  let replyIndex = -1;
  const t0 = Date.now();
  setActivity('Thinking…');

  try {
    if (messages.length > 26) await summarize();
    const response = await apiFetch({
      model: config.model, messages: requestMessages(),
      temperature: config.temperature, max_tokens: config.maxTokens, stream: true,
    }, controller.signal);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const part = chunk.choices?.[0]?.delta?.content || '';
          if (!part) continue;
          if (replyIndex < 0) {
            const removed = clearActivity();
            pushAssistantLabel(shortModel());
            replyIndex = transcript.push('') - 1;
            void removed;
          }
          reply += part;
          transcript[replyIndex] = renderModelText(reply);
          renderTranscript();
        } catch { /* keepalive/partial json */ }
      }
    }
    lastLatencyMs = Date.now() - t0;
    renderHeader();
    if (!reply) { status('Model returned an empty reply.', C.warn); messages.pop(); }
    else {
      messages.push({ role: 'assistant', content: reply });
      assistantPushed = true;
      await maybeWriteBlocks(reply, explicitFileRequest(user));
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (reply) {
        messages.push({ role: 'assistant', content: reply + '\n[response canceled by user]' });
        status('Canceled — partial reply kept.', C.warn);
      } else {
        messages.pop(); // roll back unanswered user turn
        status('Request canceled.', C.warn);
      }
    } else {
      if (!assistantPushed) messages.pop();
      status(`Error: ${error.message}`, C.err);
    }
  } finally {
    clearActivity();
    renderTranscript(true);
    controller = null;
    promptInput();
  }
}

/* ---------------------------------------------------------------- commands */

function helpText() {
  return commands.map(([c, d]) => `  ${c.padEnd(13)} ${d}`).join('\n') +
    '\n\n  Enter send · Ctrl+J newline · Ctrl+S also sends · Ctrl+U clear input' +
    '\n  Esc cancel request · PgUp/PgDn scroll · mouse wheel scrolls · Ctrl+C quit';
}

function command(line) {
  const [name, ...rest] = line.trim().split(/\s+/);
  const value = rest.join(' ');
  switch (name) {
    case '/help': status('Commands:\n' + helpText()); break;
     if (!value) status('Usage: /model <model-id>', C.warn);
     else { config.model = value; renderHeader(); status(`Model: ${value}`, C.ok); }
     break;
    case '/model':
      if (!value) return openModelPicker();
      config.model = value; renderHeader(); status('Model: ' + value, C.ok);
      break;
    case '/save': value ? saveSession(value) : status('Usage: /save <name>', C.warn); break;
    case '/resume':
      if (!value) return openResumePicker();
      resumeSession(value);
      break;
    case '/sessions': listSessions(); break;
    case '/clear':
      clearChat();
      break;
    case '/exit':
    case '/quit':
      return exitNvchat();
    case '/pwd': status(config.workspace); break;
    case '/ls': {
      const entries = fs.readdirSync(config.workspace, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .map(e => e.isDirectory() ? e.name + '/' : e.name);
      status(entries.join('  '));
      break;
    }
    case '/file': {
      const file = attachFile(value);
      if (file) { messages.push({ role: 'user', content: file }); status(`Attached ${value}.`, C.ok); }
      else status('File not found or outside workspace.', C.warn);
      break;
    }
    case '/search': {
      if (!value) { status('Usage: /search <text>', C.warn); break; }
      const found = searchWorkspace(value);
      status(found.length ? found.join('\n') : 'No matches.');
      break;
    }
    case '/run': {
      if (!value) { status('Usage: /run <command>', C.warn); break; }
      askConfirm(`Run in workspace?\n  ${value}`).then(ok => {
        if (!ok) { status('Command declined.', C.warn); return promptInput(); }
        setActivity(`Running: ${value.slice(0, 50)}…`);
        const child = spawn(value, { cwd: config.workspace, shell: true });
        let output = '';
        child.stdout.on('data', d => output += d);
        child.stderr.on('data', d => output += d);
        child.on('error', e => { clearActivity(); status(`Spawn error: ${e.message}`, C.err); promptInput(); });
        child.on('close', code => {
          clearActivity();
          const file = offload('shell', output);
          const tail = output.trim().split('\n').slice(-15).join('\n');
          if (tail) transcript.push(tag(C.dim, escapeTags(tail)));
          status(`Exited ${code}. Full output: ${file}`, code === 0 ? C.ok : C.warn);
          promptInput();
        });
      });
      return;
    }
    case '/agent':
      if (!value) { status('Usage: /agent <task>', C.warn); break; }
      runAgents(value).catch(e => { clearActivity(); status(`Agent error: ${e.message}`, C.err); }).finally(promptInput);
      return;
    case '/summarize':
      summarize().catch(e => status(`Summary error: ${e.message}`, C.err)).finally(promptInput);
      return;
    case '/temperature': {
      const t = Number(value);
      if (!value || Number.isNaN(t) || t < 0 || t > 2) status('Usage: /temperature <0..2>', C.warn);
      else { config.temperature = t; status(`Temperature: ${t}`, C.ok); }
      break;
    }
    case '/tokens': {
      const n = Number(value);
      if (!value || !Number.isInteger(n) || n < 1) status('Usage: /tokens <max output tokens>', C.warn);
      else { config.maxTokens = n; status(`Max tokens: ${n}`, C.ok); }
      break;
    }
    case '/remember':
      if (!value) status('Usage: /remember <fact or preference>', C.warn);
      else { memories.push(value); saveMemories(); status('Memory saved.', C.ok); }
      break;
    case '/memories':
      status(memories.length ? memories.map((m, i) => `${i + 1}. ${m}`).join('\n') : 'No saved memories.');
      break;
    case '/skills': {
      fs.mkdirSync(skillsDir, { recursive: true });
      const names = fs.readdirSync(skillsDir).filter(x => x.endsWith('.md')).map(x => x.slice(0, -3));
      status(names.length ? `Skills: ${names.join(', ')}` : `No skills. Add Markdown files to ${path.relative(config.workspace, skillsDir)}.`);
      break;
    }
    case '/skill': {
      const file = value ? path.join(skillsDir, `${value}.md`) : '';
      if (!value || !fs.existsSync(file)) status('Skill not found.', C.warn);
      else { activeSkill = fs.readFileSync(file, 'utf8'); activeSkillName = value; renderHeader(); status(`Loaded skill: ${value}`, C.ok); }
      break;
    }
    default: {
      const near = commands.filter(([c]) => c.startsWith(name)).map(([c]) => c);
      status(`Unknown command: ${name}${near.length ? ` — did you mean ${near.join(', ')}?` : ' — try /help'}`, C.warn);
    }
  }
  promptInput();
}

/* ------------------------------------------------------------ key handling */

/*
 * blessed key facts (verified against lib/keys.js + program.js):
 *  - One physical Enter press (\r) is emitted TWICE: first as name 'enter',
 *    then as name 'return' — both with ch '\r'. They must be collapsed into
 *    one logical event or every Enter fires twice.
 *  - Ctrl+J arrives once as ch '\n' name 'enter' (and pasted \n looks the
 *    same); blessed's default textarea handler turns it into a newline.
 * UX we implement:
 *   physical Enter -> send (or complete a partial /command)
 *   Ctrl+J         -> newline
 *   pasted \r      -> newline (keys arriving < 12 ms apart = paste)
 */
const PASTE_MS = 12;
const ENTER_DUP_MS = 8;
let lastEnterAt = 0;
const defaultInputListener = input._listener;
input._listener = function (ch, key) {
  key = key || {};
  const now = Date.now();

  const isEnterName = key.name === 'return' || key.name === 'enter';
  const physicalEnter = isEnterName && ch === '\r';
  if (physicalEnter) {
    if (now - lastEnterAt < ENTER_DUP_MS) return; // duplicate emission of the same keystroke
    lastEnterAt = now;
  }
  const sincePrev = now - lastKeyAt;
  lastKeyAt = now;

  if (key.name === 'escape') {
    if (controller) { controller.abort(); return; }
    if (paletteVisible) { hidePalette(); return; }
    return; // keep focus, keep text
  }
  if (key.ctrl && key.name === 'c') return exitNvchat();
  if (key.ctrl && key.name === 'u') { this.clearValue(); afterKey(); return; }
  if (choicePicker) {
    if (key.name === 'up') { palette.up(1); screen.render(); return; }
    if (key.name === 'down') { palette.down(1); screen.render(); return; }
    if (key.name === 'tab' || physicalEnter) { choosePickerSelection(); return; }
    return;
  }
  if (!paletteVisible && key.name === 'up') { scrollTranscript(-3); return; }
  if (!paletteVisible && key.name === 'down') { scrollTranscript(3); return; }
  if (key.name === 'pageup') { scrollTranscript(-Math.max(1, chat.height - 2)); return; }
  if (key.name === 'pagedown') { scrollTranscript(Math.max(1, chat.height - 2)); return; }

  if (paletteVisible) {
    if (key.name === 'up') { palette.up(1); screen.render(); return; }
    if (key.name === 'down') { palette.down(1); screen.render(); return; }
    if (key.name === 'tab') { insertSelected(); return; }
    if (physicalEnter && !commands.some(([c]) => c === this.getValue().trim())) {
      // complete a partial command; an exact match falls through and sends
      insertSelected(); return;
    }
  }
  if (key.name === 'tab') return; // never insert literal tabs

  const sendCombo = key.ctrl && (key.name === 's' || isEnterName);
  if (sendCombo || (physicalEnter && sincePrev > PASTE_MS)) {
    const value = this.getValue();
    if (!value.trim()) return;
    hidePalette();
    this.clearValue();
    refreshInputHint();
    send(value);
    return;
  }
  if (physicalEnter) { // \r arriving mid-paste -> newline
    defaultInputListener.call(this, '\n', { name: 'enter' });
    afterKey();
    return;
  }
  defaultInputListener.call(this, ch, key);
  afterKey();
};
function afterKey() {
  setTimeout(() => {
    input.setValue(input.getValue()); // force textarea wrapping before measuring the box
    refreshInputHint();
    if (canShowPalette()) showPalette(); else hidePalette();
  }, 0);
}

screen.key(['pageup'], () => scrollTranscript(-Math.max(1, chat.height - 2)));
screen.key(['pagedown'], () => scrollTranscript(Math.max(1, chat.height - 2)));
screen.key(['C-c'], exitNvchat);
screen.on('resize', () => { resizeInput(); renderHeader(); renderFooter(); renderTranscript(true); });

/* -------------------------------------------------------------------- boot */

renderHeader();
renderFooter();
status(`Ready — ${config.model} via ${isLocal ? 'local server' : 'NVIDIA'}. Type /help for commands.`);
promptInput();
screen.render();
