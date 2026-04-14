const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const StoreModule = require('electron-store');
const Store = StoreModule.default || StoreModule;
const { AGENTS, RESEARCH_IDS } = require('./shared/agents');
const { getScaffold } = require('./shared/scaffolds');
const { FEEDS } = require('./shared/feeds');

const store = new Store({
  name: 'tev-desk',
  defaults: {
    settings: {
      mode: 'groq',
      groqApiKey: '',
      groqModel: 'llama-3.3-70b-versatile',
      geminiApiKey: '',
      geminiModel: 'gemini-2.0-flash',
      openrouterApiKey: '',
      openrouterModel: 'qwen/qwen3-4b:free',
      ollamaModel: 'qwen3.5:4b',
      ollamaUrl: 'http://localhost:11434',
      tavilyApiKey: ''
    },
    agents: {},
    agentModels: {},
    bounds: {},
    warroom: { messages: [], documents: [] }
  }
});

const DATE_TIME_QUERY_RE = /\b(what(?:'s| is)?\s+(?:the\s+)?(?:date|day|time)(?:\s+(?:today|now))?|today'?s?\s+date|current\s+(?:date|day|time)|what\s+date\s+is\s+(?:it|today)|what\s+day\s+is\s+it|time\s+now|date\s+today)\b/i;
const VERIFY_QUERY_RE = /\b(check|verify|look\s*up|lookup|search|google|internet|online|latest|current|today|recent)\b/i;
const FRESH_EVENT_QUERY_RE = /\b(just|just\s+now|right\s+now|today|this\s+morning|this\s+afternoon|breaking|announced|announcement|conference|event|launch(?:ed)?|unveil(?:ed)?|earnings|call|guidance|keynote)\b/i;
const MODEL_CHANGE_QUERY_RE = /\b(change\s+your\s+model|update\s+(?:your\s+)?model|what\s+does\s+this\s+change|how\s+does\s+this\s+change|revise\s+(?:your\s+)?model|base\s+case|bull\s+case|bear\s+case|targets?)\b/i;

const MAX_DOC_CHARS = 40000;
const NORMAL_DOC_TOTAL_CHARS = 12000;
const RETRY_DOC_TOTAL_CHARS = 5000;
const NORMAL_CHAT_CHARS = 8000;
const RETRY_CHAT_CHARS = 3000;

const ALLOWED_STANCES = new Set(['strong_bull', 'constructive', 'neutral', 'cautious', 'bearish']);
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MASTER_RESPONSE_SCAFFOLD = `GLOBAL RESPONSE RULES:
- Keep answers short and direct.
- Default to 1-3 sentences.
- Lead with the conclusion.
- Do not use sections, tables, headers, or bullet lists unless the user explicitly asks.
- Only give a long answer if the user explicitly asks for details, expand, why, or full brief.
- Stay within the desk's scope: AI, technology, computing, semiconductors, software platforms, startups, venture capital, open source, developer tools, and the future of intelligence. If a topic like geopolitics, regulation, energy policy, or trade policy is raised in the context of its impact on technology or AI, engage with it — do not refuse it as out of scope.
- If the user asks a consumer product, lifestyle, personal preference, or general advice question that is not really a technology, computing, or intelligence question, say briefly that it is outside this desk's scope.
- Do not cite specific metrics, statistics, data points, or technical measurements that are not present in your live data context, uploaded documents, or search results. If you reference data to support your argument, stay directional and qualitative rather than inventing specific numbers. Only cite a number if it appears in the data provided to you in this prompt.
- Do not include transcript speaker labels such as "[CHIEF]:", "[FOUNDERS]:", or "[TENSION]:" in the visible answer.`;

function formatInTimeZone(date, timeZone, options = {}) {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
}

function getCurrentTimeContext(now = new Date()) {
  return {
    localDateTime: formatInTimeZone(now, Intl.DateTimeFormat().resolvedOptions().timeZone, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }),
    easternDate: formatInTimeZone(now, 'America/New_York', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }),
    easternTime: formatInTimeZone(now, 'America/New_York', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }),
    utcDateTime: now.toISOString().replace('T', ' ').replace('Z', ' UTC')
  };
}

function buildCurrentTimeNote() {
  const ctx = getCurrentTimeContext();
  return [
    '',
    'Current Date/Time Grounding (authoritative):',
    `- Local system time: ${ctx.localDateTime}`,
    `- US Eastern date: ${ctx.easternDate}`,
    `- US Eastern time: ${ctx.easternTime}`,
    `- UTC: ${ctx.utcDateTime}`,
    '- If the user asks about "today", "now", "current", or the date, use this grounding and do not invent another date.'
  ].join('\n');
}

function getRecentConversationText(messages = [], count = 6) {
  return messages.slice(-count).map((msg) => String(msg?.content || '')).join('\n');
}

function needsEventGroundingNote(lastUserMessage = '', messages = [], newsItems = []) {
  const text = String(lastUserMessage || '').trim();
  const recentText = getRecentConversationText(messages, 6);
  const combined = `${recentText}\n${text}`;
  const asksToSearch = VERIFY_QUERY_RE.test(text);
  const mentionsFreshEvent = FRESH_EVENT_QUERY_RE.test(combined);
  const asksForModelChange = MODEL_CHANGE_QUERY_RE.test(text) && FRESH_EVENT_QUERY_RE.test(recentText);
  const hasFreshNewsContext = Array.isArray(newsItems) && newsItems.length > 0 && (mentionsFreshEvent || asksToSearch);
  return asksToSearch || mentionsFreshEvent || asksForModelChange || hasFreshNewsContext;
}

function classifyTurnMode(lastUserMessage = '', messages = [], agentId = '', newsItems = []) {
  const text = String(lastUserMessage || '').trim();
  const recentText = getRecentConversationText(messages, 6);
  const combined = `${recentText}\n${text}`;
  const hasModelState = Boolean(getAgentModelState(agentId));
  const asksModelChange = MODEL_CHANGE_QUERY_RE.test(text) || /\bour model\b/i.test(text);
  const freshEvent = needsEventGroundingNote(lastUserMessage, messages, newsItems);
  const asksThoughts = /\b(thoughts?|take|read|does this matter|what do you think|implication|impact)\b/i.test(combined);

  if (asksModelChange) return hasModelState ? 'model_update' : 'fact_plus_inference';
  if (freshEvent) return asksThoughts ? 'fact_plus_inference' : 'fact_only';
  return 'default';
}

function buildSharedReasoningContract(mode = 'default') {
  if (mode === 'fact_only') {
    return [
      'Turn mode: fact_only',
      '- Give only verified facts from user-provided text, uploaded documents, or retrieved live context.',
      '- If something is uncertain or conflicting across sources, say that directly.',
      '- Do not add fabricated timelines, metrics, or unsupported operational detail.'
    ].join('\n');
  }
  if (mode === 'fact_plus_inference') {
    return [
      'Turn mode: fact_plus_inference',
      '- Start with verified facts.',
      '- Then give a short inference section, clearly labeled in plain language as your interpretation rather than a confirmed fact.',
      '- Keep numeric implications directional unless the supporting assumptions are explicitly stated.',
      '- Do not invent launch plans, market shares, economics, or roadmap detail from thin context.'
    ].join('\n');
  }
  if (mode === 'model_update') {
    return [
      'Turn mode: model_update',
      '- A real stored model with targets exists for this agent (injected above in this prompt).',
      '- Anchor any proposed changes to that baseline.',
      '- Explain the assumption bridge: which specific assumption changed and why.',
      '- If the new evidence is insufficient for a numeric revision, say the model holds and explain what would need to change.',
      '- Do not invent numbers.'
    ].join('\n');
  }
  return [
    'Turn mode: default',
    '- Use normal analyst judgment, but do not present unsupported precision as fact.'
  ].join('\n');
}

function buildEventGroundingNote() {
  return [
    'Fresh-event grounding rules:',
    '- If this turn is about a recent announcement, live event, or something the user asked you to search, separate verified facts from your inference.',
    '- Only state a figure as verified if it appears in the provided live news/search context or user-supplied text.',
    '- If you infer impact, label it explicitly as an inference or assumption rather than a confirmed fact.',
    '- If the evidence is not sufficient for a numeric model revision, give directional impact and name the missing assumptions needed to update the model.'
  ].join('\n');
}

function buildNoModelStateNote(agentId = '') {
  return [
    'Model-state rule:',
    `- There is no stored internal model for ${agentId || 'this agent'} in the app state right now.`,
    '- If the user asks how this changes "your model", answer directionally and explain what assumptions would be needed before making an explicit numeric revision.',
    '- Do not pretend to update a house model baseline that does not actually exist in app state.'
  ].join('\n');
}

function stripTranscriptPrefix(text = '') {
  return String(text).replace(/^\s*(?:\[[A-Z0-9_-]+\]:\s*)+/i, '');
}

function sanitizeVisibleAssistantText(text = '') {
  return stripTranscriptPrefix(String(text));
}

function getAgentState(agentId) {
  return store.get(`agents.${agentId}`, { documents: [], messages: [] });
}

function getAgentModelState(agentId = '') {
  if (!agentId) return null;
  return store.get(`agentModels.${agentId}`, null);
}

function validateAndNormalizeAgentModel(agentId = '', inputModel = {}) {
  const model = inputModel && typeof inputModel === 'object' ? inputModel : null;
  if (!model) return { error: 'Model payload is required.' };

  const currentStance = String(model.currentStance || '').trim();
  if (!ALLOWED_STANCES.has(currentStance)) return { error: 'Current stance is invalid.' };

  const targets = model.targets && typeof model.targets === 'object' ? model.targets : null;
  const targetKeys = ['bull', 'base', 'bear'];
  if (!targets || targetKeys.some((key) => !targets[key] || typeof targets[key] !== 'object')) {
    return { error: 'Bull, base, and bear targets are required.' };
  }

  const normalizedTargets = {};
  for (const key of targetKeys) {
    const price = Number(targets[key].price);
    const label = String(targets[key].label || '').trim();
    if (!Number.isFinite(price)) return { error: `${key} target price must be a finite number.` };
    if (!label) return { error: `${key} target label is required.` };
    normalizedTargets[key] = { price, label };
  }

  const keyAssumptions = Array.isArray(model.keyAssumptions)
    ? model.keyAssumptions.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!keyAssumptions.length) return { error: 'Key assumptions must contain at least one item.' };

  const catalystsInput = Array.isArray(model.catalysts) ? model.catalysts : [];
  const catalysts = [];
  for (const item of catalystsInput) {
    if (!item || typeof item !== 'object') return { error: 'Catalysts must be valid objects.' };
    const event = String(item.event || '').trim();
    const direction = String(item.direction || '').trim();
    const rawDate = item.date == null ? null : String(item.date).trim();
    if (!event || !direction) return { error: 'Each catalyst requires an event and direction.' };
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return { error: 'Catalyst dates must use YYYY-MM-DD format.' };
    catalysts.push({ event, date: rawDate || null, direction });
  }

  const lastReviewNote = String(model.lastReviewNote || '').trim();
  if (!lastReviewNote) return { error: 'Last review note is required.' };

  return {
    model: {
      ticker: agentId,
      updatedAt: new Date().toISOString(),
      currentStance,
      targets: normalizedTargets,
      keyAssumptions,
      catalysts,
      lastReviewNote
    }
  };
}

function buildModelStateContext(agentId = '') {
  const model = getAgentModelState(agentId);
  if (!model) return '';

  const lines = [
    `YOUR CURRENT PUBLISHED MODEL for ${model.ticker || agentId} (last updated ${model.updatedAt}):`,
    `Current stance: ${model.currentStance}`,
    `Bull case: ${model.targets.bull.price} - ${model.targets.bull.label}`,
    `Base case: ${model.targets.base.price} - ${model.targets.base.label}`,
    `Bear case: ${model.targets.bear.price} - ${model.targets.bear.label}`,
    '',
    'Key assumptions:',
    ...model.keyAssumptions.map((a, i) => `${i + 1}. ${a}`)
  ];

  if (model.catalysts && model.catalysts.length) {
    lines.push('', 'Upcoming catalysts:');
    model.catalysts.forEach((c) => lines.push(`- ${c.event}${c.date ? ` (${c.date})` : ''}: ${c.direction}`));
  }

  if (model.lastReviewNote) lines.push('', `Last review note: ${model.lastReviewNote}`);
  lines.push(
    '',
    'Model rules:',
    '- This is YOUR model. When asked "what is your view", reference these numbers.',
    '- If new information warrants a change, propose specific revisions and explain the assumption bridge from old to new.',
    '- Do not silently drift from these numbers. Either defend them or explicitly propose a revision.',
    '- Keep your response concise. Do not regurgitate the entire model unless asked.'
  );
  return lines.join('\n');
}

function buildSystemPrompt(agent, documents = [], docTotalCharBudget = NORMAL_DOC_TOTAL_CHARS, model = '', mode = '', newsItems = [], _priceData = {}, isWarRoom = false, extraContext = '') {
  const scaffold = getScaffold(agent.type, agent.id);
  const viaMap = { ollama: 'via Ollama on the user\'s local machine', groq: 'via Groq', openrouter: 'via OpenRouter', gemini: 'via Google Gemini' };
  const modelNote = model ? `\n\nYou are running as ${model} ${viaMap[mode] || ''}.` : '';
  const timeNote = buildCurrentTimeNote();
  const warRoomNote = isWarRoom
    ? `\n\nYou are in a multi-analyst War Room. Other analysts participate in this conversation - their messages are prefixed with their agent ID (e.g. [FOUNDERS]: ...). Read the full conversation, acknowledge relevant points from other analysts where appropriate, and respond strictly from your own coverage perspective.`
    : '';
  const warRoomIdentityNote = isWarRoom
    ? `\n\nIdentity rules for this turn: You are replying as ${agent.id}. Do not adopt another analyst's identity from the transcript. If the transcript refers to ${agent.id} in third person, interpret that as a reference to you rather than a cue to speak about yourself in third person.`
    : '';
  const newsNote = newsItems.length
    ? `\n\nRecent News (fetched live - use as context):\n${newsItems.map((n, i) => `${i + 1}. ${n}`).join('\n')}\nThe above headlines are the ONLY live news available. Do not reference or fabricate news stories not listed above.`
    : '';
  const extraNote = extraContext ? `\n\n${extraContext}` : '';

  const base = MASTER_RESPONSE_SCAFFOLD + '\n\n' + scaffold + modelNote + timeNote + warRoomNote + warRoomIdentityNote + newsNote + extraNote;
  if (!documents.length) return base;

  let remaining = docTotalCharBudget;
  const chunks = [];
  for (let index = 0; index < documents.length; index += 1) {
    if (remaining <= 0) break;
    const doc = documents[index];
    const clipped = String(doc.text || '').slice(0, remaining);
    remaining -= clipped.length;
    const uploaded = new Date(doc.uploadedAt || Date.now()).toISOString().slice(0, 10);
    chunks.push([`### Document ${index + 1}: ${doc.name}`, `Uploaded: ${uploaded}`, '', clipped].join('\n'));
  }

  return [base, '', '---', '', 'Additional Knowledge Base', 'Use this uploaded content as high-priority context when relevant.', '', chunks.join('\n\n---\n\n')].join('\n');
}

function clipMessagesForBudget(messages = [], charBudget = NORMAL_CHAT_CHARS) {
  const kept = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const content = String(msg.content || '');
    if (used + content.length > charBudget) break;
    kept.push({ role: msg.role, content });
    used += content.length;
  }
  return kept.reverse();
}

async function extractDocumentText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.csv') return fs.readFileSync(filePath, 'utf8');
  if (ext === '.pdf') {
    const pdfParseModule = require('pdf-parse');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const parsed = await pdfParse(fs.readFileSync(filePath));
    return parsed.text || '';
  }
  if (ext === '.docx') {
    const mammothModule = require('mammoth');
    const mammoth = mammothModule.default || mammothModule;
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

function getAgentWithState(agentId) {
  const agent = AGENTS.find((item) => item.id === agentId);
  if (!agent) return null;
  const state = getAgentState(agentId);
  return { ...agent, documents: state.documents || [], model: getAgentModelState(agentId) };
}

async function fetchRssHeadlines(url, max = 5) {
  const items = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const xml = await response.text();
    const itemBlocks = xml.split('<item>').slice(1);
    for (const block of itemBlocks) {
      const cdataMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
      const plainMatch = block.match(/<title>([\s\S]*?)<\/title>/);
      const title = ((cdataMatch && cdataMatch[1]) || (plainMatch && plainMatch[1]) || '').trim();
      if (title && !title.includes('<') && title.length > 10) items.push(title);
      if (items.length >= max) break;
    }
  } catch (_) {}
  return items;
}

async function fetchNewsForAgent(agentId) {
  const urls = FEEDS[agentId] || [];
  if (!urls.length) return [];
  const results = await Promise.all(urls.map((url) => fetchRssHeadlines(url, 5)));
  return results.flat().slice(0, 5);
}

async function fetchNewsForQuery(query) {
  if (!query || !query.trim()) return [];
  const encoded = encodeURIComponent(query.trim().slice(0, 120));
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
  return fetchRssHeadlines(url, 5);
}

const windows = new Map();

function createWindow(key, opts) {
  const saved = store.get(`bounds.${key}`, {});
  const win = new BrowserWindow({
    ...opts,
    ...saved,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.on('close', () => store.set(`bounds.${key}`, win.getBounds()));
  return win;
}

function createHubWindow() {
  const win = createWindow('hub', {
    width: 420,
    height: 760,
    minWidth: 360,
    minHeight: 620,
    title: 'TEV Desk',
    backgroundColor: '#f4f7fb',
    titleBarStyle: 'hiddenInset'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'hub.html'));
  windows.set('hub', win);
  win.on('closed', () => {
    windows.delete('hub');
    app.quit();
  });
}

function createSettingsWindow() {
  const existing = windows.get('settings');
  if (existing && !existing.isDestroyed()) return existing.focus();
  const win = createWindow('settings', {
    width: 560,
    height: 420,
    minWidth: 520,
    minHeight: 400,
    title: 'TEV Desk - Settings',
    backgroundColor: '#f4f7fb',
    titleBarStyle: 'hiddenInset'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  windows.set('settings', win);
  win.on('closed', () => windows.delete('settings'));
}

function createWarRoomWindow() {
  const existing = windows.get('warroom');
  if (existing && !existing.isDestroyed()) return existing.focus();
  const win = createWindow('warroom', {
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'TEV Desk - War Room',
    backgroundColor: '#f4f7fb',
    titleBarStyle: 'hiddenInset'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'warroom.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  windows.set('warroom', win);
  win.on('closed', () => windows.delete('warroom'));
}

function createAgentWindow(agentId) {
  const key = `agent:${agentId}`;
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) return existing.focus();
  const agent = AGENTS.find((item) => item.id === agentId);
  if (!agent) return;
  const win = createWindow(key, {
    width: 1240,
    height: 860,
    minWidth: 900,
    minHeight: 660,
    title: `TEV Desk - ${agent.name}`,
    backgroundColor: '#f4f7fb',
    titleBarStyle: 'hiddenInset'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'agent.html'), { query: { agentId } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  windows.set(key, win);
  win.on('closed', () => windows.delete(key));
}

app.whenReady().then(() => {
  createHubWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createHubWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function searchWeb(query, tavilyApiKey) {
  if (!tavilyApiKey) return 'Web search unavailable: add a Tavily API key in Settings.';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: tavilyApiKey, query, search_depth: 'basic', max_results: 5, include_answer: true }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await response.json();
    const parts = [];
    if (data.answer) parts.push(`Answer: ${data.answer}`);
    const results = (data.results || []).slice(0, 5);
    if (results.length) parts.push('Sources:\n' + results.map((r) => `- ${r.title}: ${(r.content || '').slice(0, 250)}`).join('\n'));
    return parts.length ? parts.join('\n\n') : 'No results found.';
  } catch (err) {
    return `Search failed: ${err.message}`;
  }
}

function parseFakeSearchWebCall(text = '') {
  const match = String(text).match(/<function=search_web>(\{[\s\S]*?\})<\/function>/i);
  if (!match) return null;
  try {
    const args = JSON.parse(match[1]);
    if (!args || typeof args.query !== 'string' || !args.query.trim()) return null;
    return {
      id: `fake_search_${Date.now()}`,
      name: 'search_web',
      arguments: JSON.stringify({ query: args.query.trim() })
    };
  } catch (_) {
    return null;
  }
}

function getProviderConfig(settings) {
  const mode = settings.mode || 'groq';
  if (mode === 'groq') return { mode, endpoint: GROQ_URL, apiKey: settings.groqApiKey, model: settings.groqModel, extraHeaders: {} };
  if (mode === 'gemini') return { mode, endpoint: GEMINI_URL, apiKey: settings.geminiApiKey, model: settings.geminiModel, extraHeaders: {} };
  if (mode === 'openrouter') {
    return {
      mode,
      endpoint: OPENROUTER_URL,
      apiKey: settings.openrouterApiKey,
      model: settings.openrouterModel,
      extraHeaders: { 'HTTP-Referer': 'https://tevdesk.local', 'X-Title': 'TEV Desk' }
    };
  }
  return { mode: 'ollama', endpoint: settings.ollamaUrl || 'http://localhost:11434', model: settings.ollamaModel };
}

function makeToolDef(tavilyApiKey) {
  if (!tavilyApiKey) return null;
  return [{
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for real-time information: current events, recent announcements, regulations, research updates, company metrics, or any data that changes over time. Use this whenever the user asks about something that requires up-to-date information.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] }
    }
  }];
}

async function pipeSSEStream(body, sender, events = { chunk: 'agent:stream-chunk', done: 'agent:stream-done', error: 'agent:stream-error' }, meta = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          if (!sender.isDestroyed()) sender.send(events.done, { ...meta, text: fullText });
          return { ok: true, text: fullText };
        }
        try {
          const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (chunk) {
            fullText += chunk;
            if (!sender.isDestroyed()) sender.send(events.chunk, { ...meta, chunk });
          }
        } catch (_) {}
      }
    }
    if (!sender.isDestroyed()) sender.send(events.done, { ...meta, text: fullText });
    return { ok: true, text: fullText };
  } catch (err) {
    if (!sender.isDestroyed()) sender.send(events.error, { ...meta, error: err.message });
    return { ok: false, error: err.message, text: fullText };
  }
}

async function pipeOllamaStream(body, sender, events = { chunk: 'agent:stream-chunk', done: 'agent:stream-done', error: 'agent:stream-error' }, meta = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const chunk = parsed?.message?.content;
          if (chunk) {
            fullText += chunk;
            if (!sender.isDestroyed()) sender.send(events.chunk, { ...meta, chunk });
          }
          if (parsed?.done) {
            if (!sender.isDestroyed()) sender.send(events.done, { ...meta, text: fullText });
            return { ok: true, text: fullText };
          }
        } catch (_) {}
      }
    }
    if (!sender.isDestroyed()) sender.send(events.done, { ...meta, text: fullText });
    return { ok: true, text: fullText };
  } catch (err) {
    if (!sender.isDestroyed()) sender.send(events.error, { ...meta, error: err.message });
    return { ok: false, error: err.message, text: fullText };
  }
}

async function pipeGroqStreamWithTools(payload, apiKey, tavilyApiKey, sender, endpoint = GROQ_URL, extraHeaders = {}) {
  const toolsDef = makeToolDef(tavilyApiKey);
  const requestBody = { ...payload, stream: true };
  if (toolsDef) {
    requestBody.tools = toolsDef;
    requestBody.tool_choice = 'auto';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = String(errData?.error?.message || errData?.error || JSON.stringify(errData));
    return { ok: false, tooLarge: /request too large|tokens per minute|reduce your message size/i.test(errMsg), error: errMsg };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallsMap = {};
  let finishedWithToolCall = false;
  let fullText = '';

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta;
          const finishReason = parsed?.choices?.[0]?.finish_reason;
          if (delta?.content) {
            fullText += delta.content;
            if (!sender.isDestroyed()) sender.send('agent:stream-chunk', { chunk: delta.content });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            }
          }
          if (finishReason === 'tool_calls') finishedWithToolCall = true;
        } catch (_) {}
      }
    }
  } catch (err) {
    if (!sender.isDestroyed()) sender.send('agent:stream-error', { error: err.message });
    return { ok: false, error: err.message };
  }

  if (!finishedWithToolCall) {
    const fakeToolCall = parseFakeSearchWebCall(fullText);
    if (!fakeToolCall) {
      if (!sender.isDestroyed()) sender.send('agent:stream-done', {});
      return { ok: true, text: fullText };
    }
    toolCallsMap[0] = fakeToolCall;
  }

  const tc = toolCallsMap[0];
  if (!tc || tc.name !== 'search_web') {
    if (!sender.isDestroyed()) sender.send('agent:stream-done', {});
    return { ok: true, text: fullText };
  }

  let args = {};
  try { args = JSON.parse(tc.arguments); } catch (_) {}
  if (!sender.isDestroyed()) sender.send('agent:stream-searching', { query: args.query || '' });
  const searchResult = await searchWeb(args.query || '', tavilyApiKey);
  const secondMessages = [
    ...payload.messages,
    { role: 'assistant', tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] },
    { role: 'tool', tool_call_id: tc.id, content: searchResult }
  ];
  const response2 = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({ ...payload, messages: secondMessages, stream: true })
  });
  if (!response2.ok) {
    const errData = await response2.json().catch(() => ({}));
    if (!sender.isDestroyed()) sender.send('agent:stream-error', { error: errData?.error?.message || 'Search follow-up failed.' });
    return { ok: false };
  }
  return pipeSSEStream(response2.body, sender);
}

async function pipeGroqStreamTagged(payload, apiKey, tavilyApiKey, sender, endpoint = GROQ_URL, meta = {}, extraHeaders = {}) {
  const toolsDef = makeToolDef(tavilyApiKey);
  const requestBody = { ...payload, stream: true };
  if (toolsDef) {
    requestBody.tools = toolsDef;
    requestBody.tool_choice = 'auto';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = String(errData?.error?.message || errData?.error || JSON.stringify(errData));
    if (!sender.isDestroyed()) sender.send('askall:agent-error', { ...meta, error: errMsg });
    return { ok: false, error: errMsg };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallsMap = {};
  let finishedWithToolCall = false;
  let fullText = '';

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta;
          const finishReason = parsed?.choices?.[0]?.finish_reason;
          if (delta?.content) {
            fullText += delta.content;
            if (!sender.isDestroyed()) sender.send('askall:agent-chunk', { ...meta, chunk: delta.content });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            }
          }
          if (finishReason === 'tool_calls') finishedWithToolCall = true;
        } catch (_) {}
      }
    }
  } catch (err) {
    if (!sender.isDestroyed()) sender.send('askall:agent-error', { ...meta, error: err.message });
    return { ok: false, error: err.message };
  }

  if (!finishedWithToolCall) {
    const fakeToolCall = parseFakeSearchWebCall(fullText);
    if (!fakeToolCall) {
      if (!sender.isDestroyed()) sender.send('askall:agent-done', { ...meta, text: fullText });
      return { ok: true, text: fullText };
    }
    toolCallsMap[0] = fakeToolCall;
  }

  const tc = toolCallsMap[0];
  if (!tc || tc.name !== 'search_web') {
    if (!sender.isDestroyed()) sender.send('askall:agent-done', { ...meta, text: fullText });
    return { ok: true, text: fullText };
  }

  let args = {};
  try { args = JSON.parse(tc.arguments); } catch (_) {}
  if (!sender.isDestroyed()) sender.send('askall:agent-searching', { ...meta, query: args.query || '' });
  const searchResult = await searchWeb(args.query || '', tavilyApiKey);
  const secondMessages = [
    ...payload.messages,
    { role: 'assistant', tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] },
    { role: 'tool', tool_call_id: tc.id, content: searchResult }
  ];
  const response2 = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({ ...payload, messages: secondMessages, stream: true })
  });
  if (!response2.ok) {
    const errData = await response2.json().catch(() => ({}));
    if (!sender.isDestroyed()) sender.send('askall:agent-error', { ...meta, error: errData?.error?.message || 'Search follow-up failed.' });
    return { ok: false };
  }
  return pipeSSEStream(response2.body, sender, { chunk: 'askall:agent-chunk', done: 'askall:agent-done', error: 'askall:agent-error' }, meta);
}

async function completeChat(messages, settings) {
  const provider = getProviderConfig(settings);
  if (provider.mode === 'ollama') {
    const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, messages, stream: false })
    });
    const data = await response.json();
    return data?.message?.content || '';
  }

  const payload = { model: provider.model, messages, stream: false };
  const tools = makeToolDef(settings.tavilyApiKey);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }
  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, ...provider.extraHeaders },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  if (message?.tool_calls?.length) {
    const tc = message.tool_calls[0];
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
    const result = await searchWeb(args.query || '', settings.tavilyApiKey);
    const followUp = [
      ...messages,
      { role: 'assistant', tool_calls: message.tool_calls },
      { role: 'tool', tool_call_id: tc.id, content: result }
    ];
    return completeChat(followUp, { ...settings, tavilyApiKey: '' });
  }
  return message?.content || '';
}

async function buildPromptMessages(agentId, messages = [], newsItems = [], isWarRoom = false, docBudget = NORMAL_DOC_TOTAL_CHARS, chatBudget = NORMAL_CHAT_CHARS, extraContext = '') {
  const agent = getAgentWithState(agentId);
  if (!agent) throw new Error('Unknown agent.');
  const settings = store.get('settings', {});
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const mode = classifyTurnMode(lastUserMessage, messages, agentId, newsItems);
  const reasoningBits = [buildSharedReasoningContract(mode)];
  if (needsEventGroundingNote(lastUserMessage, messages, newsItems)) reasoningBits.push(buildEventGroundingNote());
  const modelState = buildModelStateContext(agentId);
  if (modelState) reasoningBits.push(modelState);
  else reasoningBits.push(buildNoModelStateNote(agentId));
  if (DATE_TIME_QUERY_RE.test(lastUserMessage)) reasoningBits.push('If the user asks only for the date or time, answer directly using the current time note above.');
  if (extraContext) reasoningBits.push(extraContext);

  return {
    settings,
    agent,
    systemPrompt: buildSystemPrompt(agent, agent.documents || [], docBudget, getProviderConfig(settings).model, settings.mode, newsItems, {}, isWarRoom, reasoningBits.join('\n\n')),
    chatMessages: clipMessagesForBudget(messages, chatBudget)
  };
}

ipcMain.handle('agents:get-all', () => AGENTS.map((agent) => getAgentWithState(agent.id)));
ipcMain.handle('agent:get', (_, agentId) => getAgentWithState(agentId));
ipcMain.handle('agent:open', (_, agentId) => {
  if (agentId === '__settings__') { createSettingsWindow(); return true; }
  if (agentId === '__warroom__') { createWarRoomWindow(); return true; }
  createAgentWindow(agentId);
  return true;
});

ipcMain.handle('agent:get-messages', (_, agentId) => store.get(`agents.${agentId}.messages`, []));
ipcMain.handle('agent:save-messages', (_, { agentId, messages }) => {
  store.set(`agents.${agentId}.messages`, messages.slice(-50));
  return true;
});
ipcMain.handle('agent:clear-messages', (_, agentId) => {
  store.set(`agents.${agentId}.messages`, []);
  return true;
});

ipcMain.handle('agent:get-model', (_, agentId) => getAgentModelState(agentId));
ipcMain.handle('agent:save-model', (_, { agentId, model }) => {
  const agent = AGENTS.find((item) => item.id === agentId);
  if (!agent) return { error: 'Unknown agent.' };
  if (!RESEARCH_IDS.includes(agentId)) return { error: 'Model state is only supported for research agents.' };
  const result = validateAndNormalizeAgentModel(agentId, model);
  if (result.error) return { error: result.error };
  store.set(`agentModels.${agentId}`, result.model);
  return { model: result.model };
});
ipcMain.handle('agent:clear-model', (_, agentId) => {
  const agent = AGENTS.find((item) => item.id === agentId);
  if (!agent) return { error: 'Unknown agent.' };
  if (!RESEARCH_IDS.includes(agentId)) return { error: 'Model state is only supported for research agents.' };
  store.delete(`agentModels.${agentId}`);
  return { cleared: true };
});

async function importDocuments(filePaths) {
  const docs = [];
  for (const filePath of filePaths) {
    const text = String(await extractDocumentText(filePath)).slice(0, MAX_DOC_CHARS);
    docs.push({
      name: path.basename(filePath),
      path: filePath,
      text,
      uploadedAt: new Date().toISOString()
    });
  }
  return docs;
}

ipcMain.handle('agent:upload-documents', async (_, agentId) => {
  const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'csv'] }] });
  if (result.canceled || !result.filePaths.length) return getAgentWithState(agentId);
  const existing = getAgentState(agentId);
  const docs = await importDocuments(result.filePaths);
  store.set(`agents.${agentId}.documents`, [...(existing.documents || []), ...docs]);
  return getAgentWithState(agentId);
});

ipcMain.handle('agent:remove-document', (_, { agentId, docIndex }) => {
  const state = getAgentState(agentId);
  const docs = [...(state.documents || [])];
  docs.splice(docIndex, 1);
  store.set(`agents.${agentId}.documents`, docs);
  return getAgentWithState(agentId);
});

ipcMain.handle('warroom:get-messages', () => store.get('warroom.messages', []));
ipcMain.handle('warroom:save-messages', (_, { messages }) => {
  store.set('warroom.messages', messages.slice(-320));
  return true;
});
ipcMain.handle('warroom:clear-messages', () => {
  store.set('warroom.messages', []);
  return true;
});
ipcMain.handle('warroom:get-documents', () => store.get('warroom.documents', []));
ipcMain.handle('warroom:upload-documents', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'csv'] }] });
  if (result.canceled || !result.filePaths.length) return store.get('warroom.documents', []);
  const docs = await importDocuments(result.filePaths);
  store.set('warroom.documents', [...store.get('warroom.documents', []), ...docs]);
  return store.get('warroom.documents', []);
});
ipcMain.handle('warroom:remove-document', (_, { docIndex }) => {
  const docs = [...store.get('warroom.documents', [])];
  docs.splice(docIndex, 1);
  store.set('warroom.documents', docs);
  return docs;
});

ipcMain.handle('agent:fetch-news', async (_, agentId) => fetchNewsForAgent(agentId));

ipcMain.handle('settings:get', () => store.get('settings', {}));
ipcMain.handle('settings:save', (_, settings) => {
  const current = store.get('settings', {});
  store.set('settings', { ...current, ...settings });
  return store.get('settings', {});
});

ipcMain.handle('ollama:get-models', async () => {
  const settings = store.get('settings', {});
  const baseUrl = String(settings.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    const data = await response.json();
    return (data.models || []).map((m) => m.name).filter(Boolean);
  } catch (_) {
    return [];
  }
});

ipcMain.handle('agent:send-message', async (_, { agentId, messages = [], newsItems = [] }) => {
  try {
    const primary = await buildPromptMessages(agentId, messages, newsItems, false, NORMAL_DOC_TOTAL_CHARS, NORMAL_CHAT_CHARS);
    const responseText = await completeChat([{ role: 'system', content: primary.systemPrompt }, ...primary.chatMessages], primary.settings);
    return { text: sanitizeVisibleAssistantText(responseText) };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.on('agent:start-stream', async (event, { agentId, messages = [], newsItems = [], isWarRoom = false }) => {
  const sender = event.sender;
  try {
    let promptBundle = await buildPromptMessages(agentId, messages, newsItems, isWarRoom);
    const settings = promptBundle.settings;
    const provider = getProviderConfig(settings);

    if (provider.mode === 'ollama') {
      const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          stream: true,
          messages: [{ role: 'system', content: promptBundle.systemPrompt }, ...promptBundle.chatMessages]
        })
      });
      if (!response.ok) throw new Error(`Ollama request failed (${response.status}).`);
      await pipeOllamaStream(response.body, sender);
      return;
    }

    const payload = { model: provider.model, messages: [{ role: 'system', content: promptBundle.systemPrompt }, ...promptBundle.chatMessages] };
    const result = await pipeGroqStreamWithTools(payload, provider.apiKey, settings.tavilyApiKey, sender, provider.endpoint, provider.extraHeaders);
    if (result.ok) return;

    if (result.tooLarge) {
      promptBundle = await buildPromptMessages(agentId, messages, newsItems, isWarRoom, RETRY_DOC_TOTAL_CHARS, RETRY_CHAT_CHARS);
      const retryPayload = { model: provider.model, messages: [{ role: 'system', content: promptBundle.systemPrompt }, ...promptBundle.chatMessages] };
      const retry = await pipeGroqStreamWithTools(retryPayload, provider.apiKey, settings.tavilyApiKey, sender, provider.endpoint, provider.extraHeaders);
      if (retry.ok) return;
      throw new Error(retry.error || 'Retry failed.');
    }

    throw new Error(result.error || 'Streaming failed.');
  } catch (error) {
    if (!sender.isDestroyed()) sender.send('agent:stream-error', { error: error.message });
  }
});

function buildAskAllMessages(question, transcript) {
  const messages = [];
  if (transcript) messages.push({ role: 'user', content: transcript });
  messages.push({ role: 'user', content: question });
  return messages;
}

ipcMain.on('warroom:ask-all', async (event, { question }) => {
  const sender = event.sender;
  try {
    const settings = store.get('settings', {});
    const provider = getProviderConfig(settings);
    const warRoomDocs = store.get('warroom.documents', []);
    const researchOutputs = [];

    for (const agentId of RESEARCH_IDS) {
      const agent = getAgentWithState(agentId);
      const newsItems = await fetchNewsForAgent(agentId);
      const transcript = researchOutputs.map((item) => `[${item.agentId}]: ${item.text}`).join('\n');
      const lastMsgs = buildAskAllMessages(question, transcript);
      const mode = classifyTurnMode(question, lastMsgs, agentId, newsItems);
      const context = [buildSharedReasoningContract(mode)];
      if (needsEventGroundingNote(question, lastMsgs, newsItems)) context.push(buildEventGroundingNote());
      const modelState = buildModelStateContext(agentId);
      context.push(modelState || buildNoModelStateNote(agentId));
      const systemPrompt = buildSystemPrompt(agent, [...warRoomDocs, ...(agent.documents || [])], NORMAL_DOC_TOTAL_CHARS, provider.model, provider.mode, newsItems, {}, true, context.join('\n\n'));
      const payload = { model: provider.model, messages: [{ role: 'system', content: systemPrompt }, ...clipMessagesForBudget(lastMsgs, NORMAL_CHAT_CHARS)] };

      if (provider.mode === 'ollama') {
        const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: provider.model, stream: true, messages: payload.messages })
        });
        const result = await pipeOllamaStream(response.body, sender, { chunk: 'askall:agent-chunk', done: 'askall:agent-done', error: 'askall:agent-error' }, { agentId });
        researchOutputs.push({ agentId, text: sanitizeVisibleAssistantText(result.text || '') });
      } else {
        const result = await pipeGroqStreamTagged(payload, provider.apiKey, settings.tavilyApiKey, sender, provider.endpoint, { agentId }, provider.extraHeaders);
        researchOutputs.push({ agentId, text: sanitizeVisibleAssistantText(result.text || '') });
      }
    }

    if (!sender.isDestroyed()) sender.send('askall:research-done', { researchOutputs });

    const synthesisPrompt = researchOutputs.map((item) => `[${item.agentId}]: ${item.text}`).join('\n\n');
    for (const agentId of ['CHIEF', 'TENSION']) {
      const agent = getAgentWithState(agentId);
      const systemPrompt = buildSystemPrompt(
        agent,
        warRoomDocs,
        NORMAL_DOC_TOTAL_CHARS,
        provider.model,
        provider.mode,
        [],
        {},
        true,
        `Research transcript:\n${synthesisPrompt}\n\nMake the call from your own role.`
      );
      const payload = {
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ]
      };

      if (provider.mode === 'ollama') {
        const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: provider.model, stream: true, messages: payload.messages })
        });
        await pipeOllamaStream(response.body, sender, { chunk: 'askall:agent-chunk', done: 'askall:agent-done', error: 'askall:agent-error' }, { agentId });
      } else {
        await pipeGroqStreamTagged(payload, provider.apiKey, settings.tavilyApiKey, sender, provider.endpoint, { agentId }, provider.extraHeaders);
      }
    }

    if (!sender.isDestroyed()) sender.send('askall:complete', {});
  } catch (error) {
    if (!event.sender.isDestroyed()) event.sender.send('askall:error', { error: error.message });
  }
});
