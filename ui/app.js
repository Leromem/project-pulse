// Project Pulse window. Vanilla ES module, no build step.
// Everything that comes from the API (AI-written text) is inserted as text nodes, never as HTML.
const qs = new URLSearchParams(location.search);
const DEMO = qs.get('demo') === '1';
const demo = DEMO ? await import('./demo.js') : null;
const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- token, storage ---------- */
let token = qs.get('t') || '';
try { if (token) sessionStorage.setItem('pulse.token', token); else token = sessionStorage.getItem('pulse.token') || ''; } catch {}
if (qs.has('t')) {
  qs.delete('t');
  try { history.replaceState(history.state, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash); } catch {}
}
const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let startProject = qs.get('project');

/* ---------- vocabulary ---------- */
const STATUS = { completed: 'Completed', partial: 'Partially Completed', 'needs-testing': 'Needs Testing', blocked: 'Blocked', 'no-changes': 'No Meaningful Changes', failed: "Didn't finish" };
const TRIGGER = { 'task-complete': 'after task finished', 'session-end': 'when session ended', manual: 'you asked', retry: 'on retry' };
const SOURCE = { 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', 'pulse-window': 'Pulse window' };
const PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };
const EFFORT = { small: 'Small effort', medium: 'Medium effort', large: 'Large effort' };
const PR = { high: 3, medium: 2, low: 1 };
const ER = { small: 1, medium: 2, large: 3 };
const REC_STATUS = { suggested: 'Suggested', planned: 'In your plan', dismissed: 'Dismissed', completed: 'Completed' };
const HOW = { tested: 'You tried it yourself', 'tests-pass': 'Tests pass', reviewed: 'Claude reviewed it', detected: 'Spotted in later work' };
const PLAIN = {
  completed: "It's built and something proved it works.",
  partial: 'Some parts are done; some are still missing.',
  'needs-testing': "It's built, but nobody has checked that it works yet.",
  blocked: 'Work stopped because something is missing or broken.',
  'no-changes': 'Nothing important changed in this session.',
};
const DB_STATE = { open: 'Open', resolved: 'Fixed', accepted: 'Accepted as is' };
const RUN_STATE = { queued: 'Waiting', running: 'Writing', done: 'Finished', failed: "Didn't finish" };
const DETAIL = { brief: 'Brief', standard: 'Standard', detailed: 'Detailed' };
const NEXT = { plan: 'planned', unplan: 'suggested', dismiss: 'dismissed', restore: 'suggested', complete: 'completed' };
const OVR = [
  ['autoReviews', 'Automatic session reviews', 'bool'],
  ['autoOpenWindow', 'Open the window automatically', 'bool'],
  ['maxRecommendations', 'Next steps per review', 'max'],
  ['detail', 'Explanation detail', 'detail'],
  ['notifications', 'Notifications', 'bool'],
];

/* ---------- icons (constant markup only) ---------- */
const ICONS = {
  chev: '<path d="m6 9 6 6 6-6"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>',
  planAdd: '<path d="M4 6h11M4 12h11M4 18h7M18 14v7M14.5 17.5h7"/>',
  planOk: '<path d="M4 6h11M4 12h11M4 18h6"/><path class="tick" pathLength="1" d="M14 18l2.5 2.5L21 16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17h.01"/>',
  completed: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.5"/>',
  partial: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  'needs-testing': '<path d="M9 3h6M10 3v6.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.5V3M7.2 15h9.6"/>',
  blocked: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  'no-changes': '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  failed: '<path d="M12 3 2 20h20zM12 10v4M12 17h.01"/>',
};
function svgEl(cls, viewBox, markup) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', viewBox); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = markup; // constants from this file only
  return s;
}
const icon = (name) => svgEl('i', '0 0 24 24', ICONS[name] || '');
const art = () => svgEl('art', '0 0 160 36', '<path d="M0 26H70q3-4 6 0h4l2 2.5L86 6l4.5 23 2-3H100q4-7 8 0h52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');

/* ---------- DOM helpers ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k.startsWith('aria-')) el.setAttribute(k, String(v));
    else if (v === false) continue;
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(9)) if (c != null && c !== false && c !== '') el.append(c); // strings become text nodes
  return el;
}
const lbl = (t) => h('span', { class: 'lbl' }, t);
function btn(label, fn, o = {}) {
  return h('button', { type: 'button', class: 'btn ' + (o.cls || ''), 'data-k': o.k, title: o.title, onclick: fn }, o.icon ? icon(o.icon) : null, h('span', null, label));
}
// A short confirmation ("Copied") temporarily replaces the label, and shows as text even on icon-only buttons.
function act(label, ic, fn, o = {}) {
  const said = o.k ? S.say.get(o.k) : null, text = said || label, iconOnly = o.iconOnly && !said;
  return h('button', {
    type: 'button', class: 'act' + (iconOnly ? ' ic' : '') + (o.cls ? ' ' + o.cls : ''), 'data-k': o.k,
    title: o.title || (o.iconOnly ? label : null), 'aria-label': iconOnly ? text : null, 'aria-expanded': o.expanded, onclick: fn,
  }, icon(said ? 'check' : ic), iconOnly ? null : fx(h('span', null, text), 'say:' + o.k, 'fx-fade', 120));
}
function focusEl(el) { if (el && document.hasFocus()) el.focus({ preventScroll: true }); }
// Replace a container's content while keeping scroll, focus and caret (re-renders happen on live updates).
function swap(box, node, keepScroll = true) {
  const a = document.activeElement, k = box.contains(a) ? a.dataset.k : null;
  let sel = null; try { if (k && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch {}
  const top = box.scrollTop;
  const inner = [...box.querySelectorAll('pre[data-k]')].map((e) => [e.dataset.k, e.scrollTop]);
  box.replaceChildren(node);
  box.scrollTop = keepScroll ? top : 0;
  for (const [pk, t] of inner) { const e = box.querySelector(`pre[data-k="${CSS.escape(pk)}"]`); if (e) e.scrollTop = t; }
  if (k) {
    const el = box.querySelector(`[data-k="${CSS.escape(k)}"]`);
    focusEl(el);
    if (el && sel) try { el.setSelectionRange(...sel); } catch {}
  }
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const animOn = () => S.settings?.animations !== false;
const motionOn = () => animOn() && !matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- one-shot motion that survives re-renders ---------- */
// render() rebuilds the DOM, so a plain CSS animation would replay on every render.
// Instead an event starts a key; anything rendered while that key is running gets the class
// plus a negative delay (--fxd), so a re-render continues the animation instead of restarting it.
const FX = new Map();
function startFx(key, force) {
  const now = performance.now();
  for (const [k, t] of FX) if (now - t > 4000) FX.delete(k);
  if (force || animOn()) FX.set(key, now);
}
function fx(el, key, cls, life, delay = 0) {
  const t0 = FX.get(key); if (t0 == null) return el;
  const dt = performance.now() - t0; if (dt > life + delay) return el;
  el.classList.add(cls); el.style.setProperty('--fxd', `${Math.round(delay - dt)}ms`);
  return el;
}
function ago(iso) {
  if (!iso) return 'no activity yet';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.round(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const fullDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
function shortPath(p) {
  p = String(p || ''); const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? '…' + sep + parts.slice(-2).join(sep) : p;
}

/* ---------- state ---------- */
const S = {
  projects: [], pid: null, detail: null, loaded: false, settings: null, defaults: null, diag: null,
  view: 'pulse', prevView: 'pulse', recs: new Map(), dbs: new Map(), reviews: new Map(), prompts: new Map(),
  open: new Set(), explore: new Set(), why: new Set(), evidence: new Set(), hist: new Set(),
  confirm: null, compare: null, forget: false, menu: false, flash: null, allConns: false,
  drafts: new Map(), conn: 'ok', auth: false, lastKey: '', dlgKey: '',
  say: new Map(), full: new Map(), promptOpen: new Set(), seen: new Set(), closing: new Set(), legend: false, stOut: false,
};
const curProject = () => (S.detail?.project?.id === S.pid ? S.detail.project : S.projects.find((p) => p.id === S.pid)) || null;
const drawbackFor = (r) => (r?.addressesDrawbackId && S.dbs.get(r.addressesDrawbackId)) || null;
const reviewTitle = (id) => S.detail?.reviews?.find((x) => x.id === id)?.title || S.reviews.get(id)?.title || null;
const fixesOpen = (r) => drawbackFor(r)?.status === 'open';

/* ---------- API ---------- */
async function api(method, path, body) {
  if (DEMO) return demo.request(method, path, body);
  let res;
  try {
    res = await fetch(path, {
      method, cache: 'no-store',
      headers: { 'X-Pulse-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const e = new Error("Can't reach Pulse right now."); e.network = true; throw e;
  }
  if (res.status === 401 || res.status === 403) { S.auth = true; renderHeader(); throw new Error('This window needs a fresh link.'); }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Pulse answered with an error (${res.status}).`);
  return data ?? {};
}

async function loadAll() {
  try {
    const [projects, st] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/settings')]);
    S.projects = Array.isArray(projects) ? projects : [];
    S.settings = st.global; S.defaults = st.defaults; S.loaded = true;
    applyPrefs();
    let pid = S.pid;
    if (!S.projects.some((p) => p.id === pid)) {
      pid = [startProject, local.get('pulse.project')].find((id) => id && S.projects.some((p) => p.id === id)) || S.projects[0]?.id || null;
    }
    startProject = null;
    await selectProject(pid, pid === S.pid);
  } catch (e) {
    if (e.network) setConn('offline');
    render();
  }
}
async function selectProject(id, keep) {
  if (!keep || id !== S.pid) {
    S.detail = null;
    for (const set of [S.open, S.explore, S.why, S.hist, S.evidence, S.promptOpen]) set.clear();
    Object.assign(S, { confirm: null, compare: null, forget: false, allConns: false, stOut: false });
  }
  S.pid = id; S.menu = false;
  if (id) local.set('pulse.project', id);
  render();
  sendWindowState();
  if (id) await loadDetail();
}
// gate: a promise to wait for before showing the new data (the old status fading out).
// ready: runs right before the render that shows it.
async function loadDetail(gate, ready) {
  const id = S.pid; if (!id) return;
  try {
    const d = await api('GET', `/api/projects/${enc(id)}`);
    if (gate) await gate;
    if (id !== S.pid) return;
    const lr = d.latestReview;
    S.recs = new Map(); S.dbs = new Map();
    for (const r of [...(lr?.recommendations || []), ...(d.recommendations || [])]) S.recs.set(r.id, r);
    for (const x of [...(lr?.drawbacks || []), ...(d.drawbacks || [])]) S.dbs.set(x.id, x);
    if (lr) S.reviews.set(lr.id, lr);
    S.detail = d;
    const i = S.projects.findIndex((p) => p.id === id);
    if (i >= 0) S.projects[i] = d.project;
  } catch (e) {
    if (id === S.pid) toast(e.message);
  }
  if (typeof ready === 'function') ready();
  render();
}
async function refreshProjects() {
  try {
    S.projects = await api('GET', '/api/projects');
    if (S.pid && !S.projects.some((p) => p.id === S.pid)) return selectProject(S.projects[0]?.id || null);
    if (S.detail) { const p = S.projects.find((x) => x.id === S.pid); if (p) S.detail.project = { ...S.detail.project, ...p }; }
    renderHeader(); renderMenu();
  } catch {}
}
async function loadSettings() {
  try {
    const st = await api('GET', '/api/settings');
    S.settings = st.global; S.defaults = st.defaults; applyPrefs();
    if (S.pid) reloadDetail();
    render();
  } catch {}
}
async function loadDiag() {
  try { S.diag = await api('GET', '/api/diagnostics'); } catch (e) { S.diag = { error: e.message }; }
  render();
}
const reloadDetail = debounce(loadDetail, 120);
const reloadProjects = debounce(refreshProjects, 250);

function applyPrefs() {
  const s = S.settings || {}, root = document.documentElement;
  if (!s.theme || s.theme === 'system') delete root.dataset.theme; else root.dataset.theme = s.theme;
  root.dataset.motion = s.animations === false ? 'off' : 'on';
}

/* ---------- live updates (SSE) ---------- */
let es = null, retries = 0, retryTimer = 0, stale = false;
const HANDLERS = {
  project: (d) => { reloadProjects(); if (d.projectId === S.pid) reloadDetail(); },
  review: (d) => {
    reloadProjects();
    if (d.projectId === S.pid) {
      markJob(d.projectId, 'done');
      // Focal moment: the old status fades out (120ms), then the new one rises in (see .st-in).
      const old = animOn() && S.view === 'pulse' ? document.querySelectorAll('#main .st-fx') : [];
      if (old.length) { S.stOut = true; for (const el of old) el.classList.add('st-out'); }
      loadDetail(old.length ? wait(120) : null, () => {
        S.stOut = false;
        startFx('st:' + d.reviewId); startFx('flash:' + d.reviewId);
      }).then(beat);
      if (S.view !== 'pulse') toast('A new review is ready.', { label: 'View', fn: () => go('pulse') }, 8000);
    } else {
      const p = S.projects.find((x) => x.id === d.projectId);
      toast(`New review for ${p ? p.name : 'another project'}`, { label: 'View', fn: () => { S.view = 'pulse'; selectProject(d.projectId); } }, 8000);
    }
  },
  job: (d) => { markJob(d.projectId, d.state, d.error); if (d.projectId === S.pid && (d.state === 'done' || d.state === 'failed')) reloadDetail(); },
  settings: () => loadSettings(),
  focus: (d) => { if (!d.projectId) return; S.view = 'pulse'; if (d.projectId === S.pid) render(); else selectProject(d.projectId); },
};
function connect() {
  clearTimeout(retryTimer);
  try { es = DEMO ? demo.events() : new EventSource('/api/events?t=' + enc(token)); } catch { scheduleReconnect(); return; }
  es.onopen = onOpen;
  es.addEventListener('hello', onOpen);
  es.onerror = () => { es?.close(); es = null; scheduleReconnect(); };
  for (const [type, fn] of Object.entries(HANDLERS)) {
    es.addEventListener(type, (e) => { let d; try { d = JSON.parse(e.data || '{}'); } catch { return; } fn(d || {}); });
  }
}
function onOpen() {
  const resync = S.conn !== 'ok' || stale;
  retries = 0; stale = false; setConn('ok');
  if (resync) loadAll();
}
function scheduleReconnect() {
  retries++; stale = true;
  if (S.conn === 'ok') setConn('reconnecting');
  retryTimer = setTimeout(async () => {
    if (!DEMO) {
      try { const r = await fetch('/api/health', { cache: 'no-store' }); if (!r.ok) throw new Error(); }
      catch { if (retries >= 2) setConn('offline'); scheduleReconnect(); return; }
      if (S.conn === 'offline') setConn('reconnecting');
      if (retries >= 2) api('GET', '/api/settings').catch(() => {}); // a refused token shows the "fresh link" banner
    }
    connect();
  }, Math.min(30000, 1000 * 2 ** Math.min(retries - 1, 5)));
}
function setConn(c) { if (S.conn !== c) { S.conn = c; renderHeader(); if (!S.loaded) render(); } }
function markJob(pid, state, error) {
  const job = (p) => (state === 'done' ? null : { id: '', trigger: 'manual', startedAt: null, ...(p.job || {}), state, error: error || null });
  for (const p of [S.projects.find((x) => x.id === pid), S.detail?.project?.id === pid ? S.detail.project : null]) if (p) p.job = job(p);
  render();
}
function beat() {
  const t = $('#top'); t.classList.remove('beat'); void t.offsetWidth; t.classList.add('beat');
  setTimeout(() => t.classList.remove('beat'), 1800);
}

/* ---------- window state ---------- */
let lastWin = '';
const winState = (visible = document.visibilityState === 'visible') => ({
  visible, focused: document.hasFocus(), bounds: { x: screenX, y: screenY, w: outerWidth, h: outerHeight }, projectId: S.pid,
});
function sendWindowState(force) {
  const body = JSON.stringify(winState());
  if (!force && body === lastWin) return;
  lastWin = body;
  if (DEMO) return;
  fetch('/api/window/state', { method: 'POST', headers: { 'X-Pulse-Token': token, 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
addEventListener('pagehide', () => {
  if (DEMO) return;
  navigator.sendBeacon('/api/window/state?t=' + enc(token), new Blob([JSON.stringify(winState(false))], { type: 'application/json' }));
});

/* ---------- actions ---------- */
function go(view) { if (view === 'settings' && S.view !== 'settings') { S.prevView = S.view; loadDiag(); } S.view = view; S.compare = null; S.menu = false; render(); }
function toggle(set, id, fxKey) { if (set.has(id)) set.delete(id); else { set.add(id); if (fxKey) startFx(fxKey); } render(); }
// Expand/collapse a card: grid-template-rows 0fr <-> 1fr (.more.opening / .more.closing).
function toggleRec(id) {
  if (S.closing.has(id)) return;
  if (!S.open.has(id)) { FX.delete('close:' + id); S.open.add(id); if (motionOn()) startFx('open:' + id); render(); return; }
  FX.delete('open:' + id);
  if (!motionOn()) { S.open.delete(id); render(); return; }
  S.closing.add(id); startFx('close:' + id); render();
  setTimeout(() => { S.closing.delete(id); FX.delete('close:' + id); S.open.delete(id); render(); }, 160);
}
// "Step N fixes this": scroll the card into view, then ring it briefly.
function jumpTo(id) {
  const el = document.querySelector(`#main [data-rec="${CSS.escape(id)}"]`); if (!el) return;
  const main = $('#main'), r = el.getBoundingClientRect(), m = main.getBoundingClientRect();
  let done = false;
  const ring = () => {
    if (done) return; done = true; main.removeEventListener('scrollend', ring);
    startFx('hl:' + id, true);
    const card = document.querySelector(`#main [data-rec="${CSS.escape(id)}"]`);
    if (card) fx(card, 'hl:' + id, 'hl', 900);
    setTimeout(() => document.querySelector(`#main [data-rec="${CSS.escape(id)}"]`)?.classList.remove('hl'), 900);
  };
  if (r.top >= m.top && r.bottom <= m.bottom) return ring();
  main.addEventListener('scrollend', ring);
  setTimeout(ring, 900);
  el.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'center' });
}
// Temporary label on a card action, e.g. "Copied".
const sayTimers = new Map();
function say(k, text, ms, announce = true) {
  S.say.set(k, text); startFx('say:' + k);
  if (announce) { const sr = $('#sr'); if (sr) { sr.textContent = ''; setTimeout(() => { sr.textContent = text; }, 30); } }
  render();
  clearTimeout(sayTimers.get(k));
  sayTimers.set(k, setTimeout(() => { S.say.delete(k); startFx('say:' + k); render(); }, ms));
}

async function reviewNow() {
  const id = S.pid; if (!id) return;
  try {
    const res = await api('POST', `/api/projects/${enc(id)}/review`, {});
    if (res.mode && res.mode !== 'none') markJob(id, 'queued');
    toast(res.message || (res.mode === 'none' ? 'Nothing new to review yet.' : 'Review started.'));
  } catch (e) { toast(e.message); }
}
async function retry(review) {
  try {
    const res = await api('POST', `/api/reviews/${enc(review.id)}/retry`, {});
    if (res.mode && res.mode !== 'none') markJob(S.pid, 'queued');
    toast(res.message || 'Trying the review again.');
  } catch (e) { toast(e.message); }
}
async function recAction(r, action, extra = {}) {
  const prev = S.recs.get(r.id) || r;
  S.recs.set(r.id, { ...prev, status: NEXT[action], completedHow: extra.how || prev.completedHow });
  if (S.confirm === r.id) S.confirm = null;
  render();
  try {
    const res = await api('POST', `/api/recommendations/${enc(r.id)}/action`, { action, ...extra });
    if (res?.recommendation) S.recs.set(r.id, res.recommendation);
    render(); reloadProjects();
    return true;
  } catch (e) {
    S.recs.set(r.id, prev); render(); toast(e.message);
    return false;
  }
}
function leave(id) {
  const el = document.querySelector(`#main [data-rec="${CSS.escape(id)}"]`);
  if (!el || !motionOn()) return Promise.resolve();
  el.classList.add('leaving');
  return new Promise((ok) => setTimeout(ok, 230));
}
async function dismiss(r) {
  await leave(r.id);
  if (await recAction(r, 'dismiss')) toast('Suggestion dismissed.', { label: 'Undo', fn: () => recAction(r, 'restore') }, 7000);
}
async function complete(r, how) {
  if (S.view === 'pulse' || S.view === 'plan') await leave(r.id);
  if (await recAction(r, 'complete', { how })) toast('Marked as completed.');
}
async function unplan(r) {
  if (S.view === 'plan') await leave(r.id);
  if (await recAction(r, 'unplan')) toast('Removed from your plan.', { label: 'Undo', fn: () => recAction(r, 'plan') });
}
async function drawbackAction(x, action) {
  S.dbs.set(x.id, { ...x, status: action === 'accept' ? 'accepted' : action === 'resolve' ? 'resolved' : 'open' }); render();
  try {
    const res = await api('POST', `/api/drawbacks/${enc(x.id)}/action`, { action });
    if (res?.drawback) S.dbs.set(x.id, res.drawback);
    render();
  } catch (e) { S.dbs.set(x.id, x); render(); toast(e.message); }
}
function localPrompt(r) {
  const p = curProject(), d = drawbackFor(r);
  return [
    `I'd like to talk through a suggestion from Project Pulse${p ? ` for "${p.name}"` : ''} before changing anything.`, '',
    `Suggestion: ${r.title}`, `Why: ${r.why}`, r.benefit && `Benefit: ${r.benefit}`, r.drawback && `Drawback: ${r.drawback}`,
    d && `It addresses this concern: ${d.text}`, '',
    'Please explain the options and trade-offs first. Do not change any code until I say so.',
  ].filter((x) => x !== null && x !== undefined && x !== false).join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const prev = document.activeElement;
  const ta = h('textarea', { readonly: true, style: 'position:fixed;top:-200px;left:0;opacity:0' });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); focusEl(prev);
  return ok;
}
// The prompt Discuss in Claude would send. Falls back to the local version if the service can't build it.
async function fetchPrompt(r) {
  try {
    const res = await api('GET', `/api/recommendations/${enc(r.id)}/prompt`);
    if (typeof res?.prompt === 'string' && res.prompt.trim()) { S.full.set(r.id, res.prompt); return res.prompt; }
  } catch {}
  const text = S.full.get(r.id) || S.prompts.get(r.id) || localPrompt(r);
  S.full.set(r.id, text);
  return text;
}
async function togglePrompt(r) {
  if (S.promptOpen.has(r.id)) { S.promptOpen.delete(r.id); render(); return; }
  S.promptOpen.add(r.id); render();
  await fetchPrompt(r); render();
}
async function copyPrompt(r) {
  const ok = await copyText(await fetchPrompt(r));
  if (ok) say('copy:' + r.id, 'Copied', 1500);
  else toast("Couldn't reach the clipboard. Try Copy Prompt again.");
}
async function discuss(r) {
  const k = 'disc:' + r.id;
  try {
    const res = await api('POST', `/api/recommendations/${enc(r.id)}/discuss`, {});
    if (res.prompt) S.prompts.set(r.id, res.prompt);
    if (res.mode === 'sent-to-claude-code') {
      say(k, 'Added to Claude Code', 2000, false);
      toast('Added to your Claude Code prompt box. Read it, then press Enter to send.', { label: 'Copy Prompt', fn: () => copyPrompt(r) }, 8000);
    } else {
      const ok = await copyText(res.prompt || localPrompt(r));
      if (ok) { say(k, 'Prompt copied', 2000, false); toast('Prompt copied. Paste it into Claude.'); }
      else toast("Couldn't reach the clipboard. Try Copy Prompt again.");
    }
  } catch (e) { toast(e.message); }
}
async function setGlobal(patch) {
  const prev = { ...S.settings };
  if (Object.entries(patch).every(([k, v]) => JSON.stringify(prev[k]) === JSON.stringify(v))) return;
  Object.assign(S.settings, patch); applyPrefs(); render();
  try {
    const res = await api('PUT', '/api/settings', patch);
    if (res?.global) S.settings = res.global;
    applyPrefs(); render();
  } catch (e) { S.settings = prev; applyPrefs(); render(); toast(e.message); }
}
async function setOverride(key, val) {
  const pid = S.pid, st = S.detail?.settings; if (!st) return;
  const prev = { ...(st.overrides || {}) };
  const overrides = { ...Object.fromEntries(OVR.map(([k]) => [k, prev[k] ?? null])), [key]: val };
  st.overrides = overrides; render();
  try {
    const res = await api('PUT', `/api/projects/${enc(pid)}/settings`, { overrides });
    if (pid === S.pid && res?.overrides) { st.overrides = res.overrides; st.effective = res.effective; }
    render(); reloadProjects();
  } catch (e) { st.overrides = prev; render(); toast(e.message); }
}
async function forgetProject() {
  const p = curProject(); if (!p) return;
  try {
    await api('DELETE', `/api/projects/${enc(p.id)}`);
    S.projects = S.projects.filter((x) => x.id !== p.id);
    S.forget = false; S.view = 'pulse';
    toast(`Forgot ${p.name}. Its history is gone from Pulse.`);
    await selectProject(S.projects[0]?.id || null);
  } catch (e) { toast(e.message); }
}
async function openLog() {
  try { await api('POST', '/api/diagnostics/open-log', {}); toast('Opened the log folder in File Explorer.'); } catch (e) { toast(e.message); }
}

/* ---------- toasts ---------- */
function toast(msg, action, ms = 5000) {
  const box = $('#toasts');
  let t;
  const close = () => { clearTimeout(t); if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), motionOn() ? 200 : 0); };
  const el = h('div', { class: 'toast' }, h('span', null, msg),
    action ? h('button', { type: 'button', onclick: () => { close(); action.fn(); } }, action.label) : null,
    h('button', { type: 'button', class: 'x', 'aria-label': 'Close message', onclick: close }, icon('x')));
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', () => { t = setTimeout(close, 2500); });
  box.append(el);
  t = setTimeout(close, ms);
  while (box.children.length > 3) box.firstChild.remove();
}

/* ---------- rendering ---------- */
function render() {
  renderHeader(); renderMenu();
  const key = `${S.view}:${S.pid}:${!!S.detail}`;
  swap($('#main'), h('div', { class: 'wrap' + (key !== S.lastKey ? ' enter' : '') }, viewNode()), key === S.lastKey);
  S.lastKey = key;
  renderDialog();
}
function renderHeader() {
  const p = curProject(), top = $('#top'), lr = S.detail?.latestReview;
  $('#projName').textContent = p ? p.name : S.loaded ? 'No projects yet' : 'Loading…';
  $('#switcher').title = p ? p.path : '';
  $('#liveDot').hidden = !p?.live;
  $('#projMeta').textContent = p ? [p.path, p.lastActivityAt && 'active ' + ago(p.lastActivityAt)].filter(Boolean).join(' · ') : '';
  top.dataset.s = lr && lr.state !== 'failed' ? lr.status : '';
  const busy = !!p?.job && p.job.state !== 'failed';
  top.classList.toggle('reviewing', busy);
  top.classList.toggle('live', !!p?.live && S.conn === 'ok');
  top.classList.toggle('offline', S.conn === 'offline');
  const rn = $('#reviewNow');
  const rl = busy ? 'Reviewing…' : 'Review now';
  rn.disabled = !p || busy || S.conn === 'offline'; rn.lastElementChild.textContent = rl; rn.title = busy ? 'Pulse is writing your review' : 'Ask Pulse to review the latest work now';
  rn.setAttribute('aria-label', rl);
  const planned = S.detail ? [...S.recs.values()].filter((r) => r.status === 'planned').length : p?.counts?.planned || 0;
  const pc = $('#planCount'); pc.hidden = !planned; pc.textContent = planned;
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.view === S.view));
  $('#gear').setAttribute('aria-pressed', String(S.view === 'settings'));
  const c = $('#conn'); c.hidden = S.conn !== 'reconnecting'; c.textContent = 'Reconnecting…';
  const msg = S.auth ? "This window's link is out of date. Open it again with /pulse open in Claude Code."
    : S.conn === 'offline' ? "Pulse isn't running right now. This window reconnects on its own when it's back." : '';
  const b = $('#banner'); b.hidden = !msg;
  if (msg && b.textContent !== msg) b.replaceChildren(icon('alert'), h('span', null, msg));
  document.title = p ? `${p.name} · Project Pulse` : 'Project Pulse';
}
function renderMenu() {
  const m = $('#switchMenu');
  $('#switcher').setAttribute('aria-expanded', String(S.menu));
  m.hidden = !S.menu;
  if (!S.menu) return;
  swap(m, h('div', null, S.projects.length ? S.projects.map((p) => h('button', {
    type: 'button', class: 'mi', role: 'menuitemradio', 'aria-checked': String(p.id === S.pid), 'data-k': 'mi:' + p.id, title: p.path,
    onclick: () => { S.menu = false; if (p.id !== S.pid) selectProject(p.id); else render(); focusEl($('#switcher')); },
  }, h('span', { class: 'mi-name' }, p.live ? h('span', { class: 'live-dot', title: 'Claude Code is active here' }) : null, p.name),
    h('span', { class: 'mi-ago' }, ago(p.lastActivityAt)),
    h('span', { class: 'mi-path' }, shortPath(p.path)))) : h('p', { class: 'plain-empty' }, 'No projects yet.')));
}
function viewNode() {
  if (S.view === 'settings') return S.settings ? settingsView() : skeleton();
  if (!S.loaded) {
    return S.conn === 'offline'
      ? stateCard("Pulse isn't running", 'Start Project Pulse, or type /pulse in Claude Code. This window connects on its own as soon as Pulse is back.')
      : skeleton();
  }
  if (!S.projects.length) return stateCard('No projects yet', 'Pulse adds a project the first time Claude Code works in its folder. Finish a coding task there and your first review shows up here.');
  if (!S.detail) return skeleton();
  return S.view === 'plan' ? planView() : S.view === 'history' ? historyView() : pulseView();
}
const skeleton = () => h('div', { class: 'stack' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'height:80px' }));
function stateCard(title, text, action, cls = '') {
  return h('div', { class: 'card state-card ' + cls }, art(), h('h2', null, title), h('p', null, text), action || null);
}
function chip(status, state) {
  const s = state === 'failed' ? 'failed' : STATUS[status] ? status : 'no-changes';
  return h('span', { class: 'chip', 'data-s': s }, icon(s), STATUS[s]);
}
function pri(p) {
  return h('span', { class: 'pri', 'data-p': p }, h('span', { class: 'bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), `${PRIORITY[p] || p} priority`);
}
const effortTag = (r) => h('span', { class: 'tag' }, icon('clock'), EFFORT[r.effort] || r.effort);

/* Pulse tab */
function pulseView() {
  const d = S.detail, p = d.project, lr = d.latestReview;
  const left = [];
  if (p.job) left.push(jobCard(p.job));
  if (!lr) { if (!p.job || p.job.state === 'failed') left.push(emptyCard()); }
  else if (lr.state === 'failed') left.push(stateCard("This review didn't finish", "Pulse couldn't finish reviewing your last session. Nothing in your project was changed.",
    [h('p', { class: 'err' }, lr.error || 'Something went wrong while writing the review.'), btn('Retry review', () => retry(lr), { cls: 'primary', icon: 'retry', k: 'retry' })], 'failed'));
  const lists = lr && lr.state !== 'failed' ? recLists(lr) : null;
  if (lists) left.push(reviewCard(lr, true, false, lists.shown));
  const right = lists ? recSection(lr, lists) : null;
  return h('div', { class: 'pulse-grid' + (right ? '' : ' single') }, h('div', { class: 'stack' }, left), right);
}
function recLists(lr) {
  const max = Math.min(3, S.detail.settings?.effective?.maxRecommendations || 3);
  const all = (lr.recommendations || []).map((r) => S.recs.get(r.id) || r);
  return { all, shown: all.filter((r) => r.status === 'suggested' || r.status === 'planned').slice(0, max) };
}
function jobCard(job) {
  if (job.state === 'failed') {
    return h('div', { class: 'card job failed', role: 'status' }, h('span', { class: 'pulse-ic' }, icon('alert')),
      h('div', null, h('b', null, "The last review didn't finish"), h('span', null, job.error || 'Use Review now to try again.')));
  }
  return h('div', { class: 'card job', role: 'status' }, h('span', { class: 'pulse-ic' }, icon('pulse')),
    h('div', null, h('b', null, 'Pulse is writing your review…'),
      h('span', null, job.state === 'queued' ? 'It starts in a moment.' : 'This usually takes under a minute. Keep working.')));
}
function emptyCard() {
  return stateCard('No reviews yet',
    'When a coding task here finishes, Pulse writes a short review on its own: what you built, what it helps, what to watch, and what to try next. Want one right away?',
    btn('Review now', reviewNow, { cls: 'primary', icon: 'pulse', k: 'empty-review' }));
}
function reviewCard(r, latest, compact, shown = []) {
  const dbs = (r.drawbacks || []).map((x) => S.dbs.get(x.id) || x);
  const evOpen = S.evidence.has(r.id);
  const wins = [
    ...(r.resolved || []).map((x) => ['Fixed earlier concern:', x.text, x.note]),
    ...(r.implemented || []).map((x) => ['Completed earlier suggestion:', x.title, x.evidence]),
  ];
  const s = PLAIN[r.status] ? r.status : 'no-changes';
  // Status block and "How we know" take part in the new-review crossfade (latest review only).
  const st = (el, delay = 0) => {
    if (!latest) return el;
    el.classList.add('st-fx'); if (S.stOut) el.classList.add('st-out');
    return fx(el, 'st:' + r.id, 'st-in', 260, delay);
  };
  const steps = (x) => shown.map((rec, n) => (rec.addressesDrawbackId === x.id
    ? h('button', { type: 'button', class: 'step-link', 'data-k': `step:${x.id}:${rec.id}`, onclick: () => jumpTo(rec.id) }, `Step ${n + 1} fixes this`) : null));
  return fx(h('article', { class: 'card review', 'aria-label': latest ? 'Latest review' : 'Review' },
    compact ? (r.statusReason ? h('p', { class: 'st-reason' }, r.statusReason) : null) : [
      st(h('div', { class: 'st-block' }, chip(r.status), h('p', { class: 'st-plain' }, PLAIN[s]))),
      st(h('div', { class: 'how' }, icon('search'), h('div', null, h('b', null, 'How we know'),
        r.statusReason ? h('span', null, r.statusReason) : h('span', { class: 'muted' }, "Pulse didn't record the evidence for this one."))), 60),
      h('button', { type: 'button', class: 'disclose', 'aria-expanded': S.legend, 'data-k': 'legend', onclick: () => { S.legend = !S.legend; render(); } },
        icon('chevR'), 'What the 5 statuses mean'),
      S.legend ? h('ul', { class: 'legend' }, Object.keys(PLAIN).map((k) => h('li', null, chip(k), h('span', null, PLAIN[k])))) : null,
      h('h2', { class: 'headline' }, r.title || 'Review'),
      h('p', { class: 'meta', title: fullDate(r.createdAt) }, [ago(r.createdAt), TRIGGER[r.trigger], SOURCE[r.source]].filter(Boolean).join(' · '))],
    r.built?.length ? [lbl('What You Just Built'), h('ul', { class: 'dots' }, r.built.slice(0, 4).map((t) => h('li', null, t)))] : null,
    wins.length ? h('div', { class: 'wins' }, wins.map(([b, t, note]) => h('div', { class: 'win', title: note || null }, icon('check'), h('span', null, h('b', null, b), ' ', t)))) : null,
    h('div', { class: 'pmgrid' },
      h('div', null, lbl('Benefits'), r.benefits?.length
        ? h('ul', { class: 'pm' }, r.benefits.map((t) => h('li', null, h('span', null, t))))
        : h('p', { class: 'plain-empty' }, 'None noted.')),
      h('div', null, lbl('Potential Drawbacks'), dbs.length
        ? h('ul', { class: 'pm minus' }, dbs.map((x) => h('li', { title: x.detail || null }, h('span', null, x.text,
          h('span', { class: 'badge ' + x.status }, DB_STATE[x.status] || x.status), steps(x)))))
        : h('p', { class: 'plain-empty' }, 'None spotted.'))),
    r.evidence?.length ? [
      h('button', { type: 'button', class: 'disclose', 'aria-expanded': evOpen, 'data-k': 'ev:' + r.id, onclick: () => toggle(S.evidence, r.id) },
        icon('chevR'), `What this review is based on (${r.evidence.length})`),
      evOpen ? h('ul', { class: 'evidence' }, r.evidence.map((t) => h('li', null, t))) : null,
    ] : null), latest ? 'flash:' + r.id : '', 'flash', 1600);
}
function recSection(lr, { all, shown }) {
  const key = 'recs:' + lr.id;
  if (!S.seen.has(lr.id)) { S.seen.add(lr.id); startFx(key); } // cards stagger in once per review
  const first = shown.findIndex((r) => r.status === 'suggested');
  return h('section', { class: 'recs', 'aria-label': 'Recommended Next Steps' },
    h('div', { class: 'sec-head' }, h('h2', null, 'Recommended Next Steps'), h('span', { class: 'muted' }, 'You decide what happens'))
    , shown.length ? shown.map((r, i) => fx(recCard(r, i, i === first), key, 'fx-rise', 220, i * 40)) : h('div', { class: 'caught' }, all.length
      ? ['All caught up on this review. ', h('button', { type: 'button', onclick: () => go('history') }, 'See what you handled')]
      : 'No next steps suggested this time.'));
}
// Content that only shows on an expanded card; animates open and closed.
function more(id, ...kids) {
  const el = h('div', { class: 'more' }, h('div', null, ...kids));
  fx(el, 'open:' + id, 'opening', 220);
  return fx(el, 'close:' + id, 'closing', 400);
}
function recCard(r, i, start) {
  const id = r.id, open = S.open.has(id), db = drawbackFor(r);
  return fx(h('article', { class: 'card rec' + (open ? ' is-open' : ''), 'data-rec': id },
    h('button', { type: 'button', class: 'rec-head', 'aria-expanded': open, 'data-k': 'open:' + id, onclick: () => toggleRec(id) },
      h('span', { class: 'rec-num' }, h('span', { class: 'sr' }, 'Step '), String(i + 1)),
      h('span', { class: 'rec-title' }, r.title), icon('chev')),
    h('div', { class: 'tags' }, pri(r.priority), effortTag(r), start ? h('span', { class: 'tag start' }, 'Start here') : null),
    h('p', { class: 'why' + (open ? '' : ' clamp') }, r.why),
    db ? h('p', { class: 'fixline' }, icon('link'), h('span', null, h('b', null, 'Fixes: '), db.text)) : null,
    open ? more(id, recDetails(r, db), promptBlock(r)) : null,
    S.explore.has(id) ? fx(h('div', { class: 'reveal explore' }, h('b', null, 'In more detail: '), r.explore || 'There is no longer explanation for this one.'), 'rv:ex:' + id, 'fx-rise', 220) : null,
    S.why.has(id) ? fx(h('div', { class: 'reveal simple' }, h('b', null, 'In plain words: '), r.simple || r.why), 'rv:why:' + id, 'fx-rise', 220) : null,
    S.confirm === id ? confirmRow(r) : null,
    h('div', { class: 'actions' },
      act('Explore', 'compass', () => toggle(S.explore, id, 'rv:ex:' + id), { k: 'ex:' + id, expanded: S.explore.has(id) }),
      act('Ask Why', 'help', () => toggle(S.why, id, 'rv:why:' + id), { k: 'why:' + id, expanded: S.why.has(id) }),
      r.status === 'planned'
        ? fx(act('In your plan', 'planOk', () => recAction(r, 'unplan'), { k: 'plan:' + id, cls: 'on', title: 'In your plan. Click to take it out.' }), 'plan:' + id, 'drew', 200)
        : act('Add to Plan', 'planAdd', () => { startFx('plan:' + id); recAction(r, 'plan'); }, { k: 'plan:' + id }),
      act('Discuss in Claude', 'chat', () => discuss(r), { k: 'disc:' + id, cls: 'primary', title: 'Put this prompt in your Claude Code box. You choose whether to send it.' }),
      act('Compare', 'compare', () => startCompare(r), { k: 'cmp:' + id, title: 'Compare with another suggestion' }),
      act('Mark Completed', 'check', () => { S.confirm = S.confirm === id ? null : id; render(); }, { k: 'done:' + id, expanded: S.confirm === id }),
      act('Copy Prompt', 'copy', () => copyPrompt(r), { k: 'copy:' + id, title: 'Copy Prompt: copy the prompt to paste into Claude' }),
      act('Dismiss', 'x', () => dismiss(r), { k: 'dis:' + id, cls: 'danger', title: 'Dismiss this suggestion' })),
    open ? more(id, h('p', { class: 'helper' }, 'Discuss in Claude puts this prompt in your Claude Code box. Nothing is sent until you press Enter.')) : null),
  'hl:' + id, 'hl', 900);
}
function promptBlock(r) {
  const open = S.promptOpen.has(r.id), text = S.full.get(r.id);
  return [
    h('button', { type: 'button', class: 'disclose', 'aria-expanded': open, 'data-k': 'pr:' + r.id, onclick: () => togglePrompt(r) }, icon('chevR'), 'Prompt to send'),
    open ? h('pre', { class: 'prompt', tabindex: '0', 'aria-label': 'Prompt to send', 'data-k': 'prt:' + r.id }, text ?? 'Loading the prompt…') : null,
  ];
}
function recDetails(r, db) {
  const kv = (k, v) => h('div', { class: 'kv' }, h('b', null, k), h('span', null, v));
  return h('div', { class: 'details' },
    r.benefit ? kv('Benefit', r.benefit) : null,
    r.drawback ? kv('Drawback', r.drawback) : null,
    db || r.connection ? h('div', null, lbl('How it connects'),
      db ? h('ol', { class: 'chain' },
        h('li', { class: 'c-built' }, h('small', null, 'Built'), reviewTitle(db.reviewId) || reviewTitle(r.reviewId) || 'Earlier work'),
        h('li', { class: 'c-concern' }, h('small', null, 'Concern'), db.text),
        h('li', { class: 'c-next' }, h('small', null, 'Next'), r.title)) : null,
      r.connection ? h('p', { class: 'connect' + (db ? '' : ' flush') }, r.connection) : null) : null);
}
function confirmRow(r) {
  return h('div', { class: 'confirm', role: 'group', 'aria-label': 'How did you check it works?' }, h('span', null, 'How did you check it works?'),
    [['tested', 'I tried it myself'], ['tests-pass', 'Tests pass'], ['reviewed', 'Claude reviewed it']].map(([how, label]) =>
      btn(label, () => complete(r, how), { cls: 'sm', k: `how:${how}:${r.id}` })),
    btn('Cancel', () => { S.confirm = null; render(); focusEl($(`[data-k="done:${CSS.escape(r.id)}"]`)); }, { cls: 'sm quiet', k: 'how-cancel:' + r.id }));
}

/* Compare */
function startCompare(r) { S.compare = { a: r.id, b: null, from: 'cmp:' + r.id }; render(); }
function closeCompare() {
  const from = S.compare?.from; S.compare = null; render();
  if (from) focusEl(document.querySelector(`[data-k="${CSS.escape(from)}"]`));
}
function pulsePick(a, b) {
  const fa = fixesOpen(a), fb = fixesOpen(b), both = fa && fb ? 'both fix an open concern, and ' : '';
  if (fa !== fb) { const w = fa ? a : b; return [w, `it fixes an open concern ("${drawbackFor(w).text}") and the other one doesn't.`]; }
  if (PR[a.priority] !== PR[b.priority]) return [PR[a.priority] > PR[b.priority] ? a : b, `${both}it has the higher priority.`];
  if (ER[a.effort] !== ER[b.effort]) return [ER[a.effort] < ER[b.effort] ? a : b, `${both || 'they have the same priority, and '}it takes less effort.`];
  return [null, "they're evenly matched. Go with whichever fits your next session better."];
}
function renderDialog() {
  const box = $('#dialog'), c = S.compare;
  const a = c && S.recs.get(c.a), b = c?.b && S.recs.get(c.b);
  const key = a ? `${c.a}:${c.b}` : '';
  if (key === S.dlgKey) return;
  const fresh = !S.dlgKey; S.dlgKey = key;
  if (!a) { box.replaceChildren(); return; }
  swap(box, h('div', { class: 'scrim', onclick: (e) => { if (e.target === e.currentTarget) closeCompare(); } },
    h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', onkeydown: trapTab },
      h('div', { class: 'sheet-head' }, h('h2', { id: 'dlg-title' }, b ? 'Compare next steps' : 'Compare with…'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close', 'data-k': 'dlg-close', onclick: closeCompare }, icon('x'))),
      b ? compareBody(a, b) : pickBody(a))));
  focusEl(box.querySelector(fresh ? '.pick, [data-k="dlg-close"]' : '[data-k="dlg-close"]'));
}
function trapTab(e) {
  if (e.key !== 'Tab') return;
  const f = [...e.currentTarget.querySelectorAll('button:not(:disabled)')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function pickBody(a) {
  const list = [...S.recs.values()].filter((x) => x.id !== a.id && (x.status === 'suggested' || x.status === 'planned'));
  return [
    h('p', { class: 'sheet-sub' }, `Pick another suggestion to put next to "${a.title}".`),
    list.length ? h('div', { class: 'picks' }, list.map((x) => h('button', { type: 'button', class: 'pick', onclick: () => { S.compare.b = x.id; render(); } },
      h('b', null, x.title),
      h('span', { class: 'tags' }, pri(x.priority), effortTag(x), h('span', { class: 'tag' }, REC_STATUS[x.status])))))
      : h('p', { class: 'plain-empty' }, 'There are no other open suggestions for this project yet.'),
  ];
}
function compareBody(a, b) {
  const [w, why] = pulsePick(a, b);
  const fix = (r) => { const d = drawbackFor(r); return d ? `${d.status === 'open' ? 'Yes' : 'Was'}: ${d.text}` : 'No'; };
  const rows = [['Why', (x) => x.why], ['Benefit', (x) => x.benefit], ['Drawback', (x) => x.drawback], ['Priority', (x) => PRIORITY[x.priority]],
    ['Effort', (x) => EFFORT[x.effort]], ['Fixes a known concern?', fix], ['Status', (x) => REC_STATUS[x.status]]];
  const hl = (x) => (w && w.id === x.id ? 'win-col' : null);
  return [
    h('div', { class: 'cmp' },
      h('span', { class: 'k' }), h('span', { class: 'h ' + (hl(a) || '') }, a.title), h('span', { class: 'h ' + (hl(b) || '') }, b.title),
      rows.map(([k, f]) => [h('span', { class: 'k' }, k), h('span', { class: hl(a) }, f(a) || '—'), h('span', { class: hl(b) }, f(b) || '—')])),
    h('div', { class: 'verdict' }, icon('pulse'), h('p', null, h('b', null, 'Pulse pick: '), w ? `${w.title}, because ${why}` : `No clear winner: ${why}`)),
    h('div', { class: 'sheet-foot' },
      btn('Pick a different one', () => { S.compare.b = null; render(); }, { cls: 'sm quiet' }),
      w && w.status === 'suggested' ? btn('Add the pick to your plan', async () => { closeCompare(); if (await recAction(w, 'plan')) toast('Added to your plan.'); }, { cls: 'sm primary', icon: 'planAdd' }) : null),
  ];
}

/* Plan tab */
function planView() {
  const items = [...S.recs.values()].filter((r) => r.status === 'planned')
    .sort((a, b) => PR[b.priority] - PR[a.priority] || String(a.decidedAt).localeCompare(String(b.decidedAt)));
  if (!items.length) {
    return stateCard('Your plan is empty', 'Use "Add to Plan" on a suggestion to keep it here. Planned items stay across sessions until you finish or remove them.',
      btn('See the latest review', () => go('pulse'), { k: 'to-pulse' }));
  }
  return h('div', { class: 'stack narrow' }, h('div', { class: 'sec-head' }, h('h2', null, 'Your plan'), h('span', { class: 'muted' }, `${items.length} to do`)),
    h('div', { class: 'recs' }, items.map((r) => {
      const db = drawbackFor(r);
      return h('article', { class: 'card rec', 'data-rec': r.id },
        h('div', { class: 'rec-head' }, h('span', { class: 'rec-title' }, r.title)),
        h('div', { class: 'tags' }, pri(r.priority), effortTag(r)),
        h('p', { class: 'why' }, r.why),
        db ? h('p', { class: 'fixline' }, icon('link'), h('span', null, h('b', null, db.status === 'open' ? 'Fixes: ' : 'Was for: '), db.text)) : null,
        S.confirm === r.id ? confirmRow(r) : null,
        h('div', { class: 'actions' },
          act('Mark Completed', 'check', () => { S.confirm = S.confirm === r.id ? null : r.id; render(); }, { k: 'done:' + r.id, expanded: S.confirm === r.id }),
          act('Remove from Plan', 'x', () => unplan(r), { k: 'unplan:' + r.id }),
          act('Discuss in Claude', 'chat', () => discuss(r), { k: 'disc:' + r.id, cls: 'primary', title: 'Put this prompt in your Claude Code box. You choose whether to send it.' }),
          act('Copy Prompt', 'copy', () => copyPrompt(r), { k: 'copy:' + r.id, title: 'Copy Prompt: copy the prompt to paste into Claude' })));
    })));
}

/* History tab */
async function openHist(id) {
  toggle(S.hist, id);
  if (!S.hist.has(id) || S.reviews.has(id)) return;
  try {
    const r = await api('GET', `/api/reviews/${enc(id)}`);
    S.reviews.set(id, r);
    for (const x of r.recommendations || []) if (!S.recs.has(x.id)) S.recs.set(x.id, x);
    for (const x of r.drawbacks || []) if (!S.dbs.has(x.id)) S.dbs.set(x.id, x);
  } catch (e) { S.hist.delete(id); toast(e.message); }
  render();
}
function historyView() {
  const d = S.detail, recs = [...S.recs.values()];
  const done = recs.filter((r) => r.status === 'completed'), gone = recs.filter((r) => r.status === 'dismissed');
  const reviews = h('section', { class: 'card' },
    h('div', { class: 'sec-head' }, h('h2', null, 'Reviews'), h('span', { class: 'muted' }, `${d.reviews.length} so far`)),
    d.reviews.length ? h('ol', { class: 'tl' }, d.reviews.map(tlItem)) : h('p', { class: 'plain-empty' }, 'No reviews yet. They appear here after each coding session.'));
  const lists = [
    done.length ? h('section', { class: 'card' }, h('div', { class: 'sec-head' }, h('h2', null, 'Completed'), h('span', { class: 'muted' }, String(done.length))),
      h('ul', { class: 'rows' }, done.map((r) => h('li', null, h('span', { class: 'row-ic ok' }, icon('check')),
        h('div', { class: 'grow' }, r.title, h('small', null, HOW[r.completedHow] || 'Completed', r.completedEvidence ? ` · ${r.completedEvidence}` : '')))))) : null,
    gone.length ? h('section', { class: 'card' }, h('div', { class: 'sec-head' }, h('h2', null, 'Dismissed'), h('span', { class: 'muted' }, String(gone.length))),
      h('ul', { class: 'rows' }, gone.map((r) => h('li', null, h('div', { class: 'grow' }, r.title, h('small', null, r.why)),
        btn('Restore', () => recAction(r, 'restore').then((ok) => ok && toast('Suggestion restored.')), { cls: 'sm', icon: 'undo', k: 'restore:' + r.id }))))) : null,
  ];
  return h('div', { class: 'pulse-grid' }, h('div', { class: 'stack' }, reviews), h('div', { class: 'stack' }, connectionsCard(d), lists));
}
function tlItem(rs) {
  const open = S.hist.has(rs.id), full = S.reviews.get(rs.id);
  let body = null;
  if (open) {
    body = !full ? h('div', { class: 'skeleton', style: 'height:80px' })
      : full.state === 'failed' ? h('p', { class: 'err' }, full.error || "This review didn't finish.")
        : [reviewCard(full, false, true), histRecs(full)];
  }
  return h('li', { 'data-s': rs.state === 'failed' ? 'failed' : rs.status },
    h('button', { type: 'button', class: 'tl-btn', 'aria-expanded': open, 'data-k': 'tl:' + rs.id, onclick: () => openHist(rs.id) },
      h('span', { class: 'tl-title' }, rs.title || 'Session review'),
      chip(rs.status, rs.state),
      h('span', { class: 'tl-date', title: fullDate(rs.createdAt) }, [ago(rs.createdAt), TRIGGER[rs.trigger]].filter(Boolean).join(' · '))),
    body ? h('div', { class: 'tl-body' }, body) : null);
}
function histRecs(full) {
  const rs = (full.recommendations || []).map((x) => S.recs.get(x.id) || x);
  return rs.length ? h('div', { class: 'hist-recs' }, lbl('Recommended Next Steps'),
    h('ul', { class: 'plain' }, rs.map((x) => h('li', null, x.title, h('span', { class: 'badge ' + x.status }, REC_STATUS[x.status]))))) : null;
}
function connectionsCard(d) {
  const dbs = [...S.dbs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const list = S.allConns ? dbs : dbs.slice(0, 6);
  const links = d.links || [];
  const item = (x) => {
    const ids = new Set([...S.recs.values()].filter((r) => r.addressesDrawbackId === x.id).map((r) => r.id));
    for (const l of links) if (l.relation === 'addresses' && l.toType === 'drawback' && l.toId === x.id && l.fromType === 'recommendation') ids.add(l.fromId);
    const fixes = [...ids].map((id) => S.recs.get(id)).filter(Boolean);
    const byId = x.resolvedByReviewId || links.find((l) => l.relation === 'resolved' && l.toType === 'drawback' && l.toId === x.id && l.fromType === 'review')?.fromId;
    const outcome = x.status === 'resolved' ? `Resolved by "${reviewTitle(byId) || 'a later session'}"${x.resolvedNote ? `. ${x.resolvedNote}` : ''}`
      : x.status === 'accepted' ? 'Accepted as is. You chose to live with it.' : 'Still open';
    return h('li', null,
      h('ol', { class: 'chain' },
        h('li', { class: 'c-concern' }, h('small', null, `Concern · ${ago(x.createdAt)}`), x.text),
        h('li', { class: fixes.length ? 'c-next' : 'c-idle' }, h('small', null, fixes.length > 1 ? 'Suggested fixes' : 'Suggested fix'),
          fixes.length ? fixes.map((r) => h('div', null, r.title, h('span', { class: 'badge ' + r.status }, REC_STATUS[r.status]))) : 'None suggested yet'),
        h('li', { class: x.status === 'resolved' ? 'c-built' : 'c-idle' }, h('small', null, 'Outcome'), outcome)),
      h('div', { class: 'mini-acts' }, x.status === 'open'
        ? btn('Accept as is', () => drawbackAction(x, 'accept'), { cls: 'sm quiet', k: 'acc:' + x.id, title: 'Keep it and stop treating it as an open concern' })
        : btn('Reopen', () => drawbackAction(x, 'reopen'), { cls: 'sm quiet', k: 'acc:' + x.id })));
  };
  return h('section', { class: 'card' },
    h('div', { class: 'sec-head' }, h('h2', null, 'Connections'), h('span', { class: 'muted' }, 'How concerns led to fixes')),
    dbs.length ? h('ul', { class: 'conns' }, list.map(item)) : h('p', { class: 'plain-empty' }, 'Concerns from your reviews, and what fixed them, show up here.'),
    dbs.length > 6 ? h('button', { type: 'button', class: 'disclose', 'aria-expanded': S.allConns, 'data-k': 'allconns', onclick: () => { S.allConns = !S.allConns; render(); } },
      icon('chevR'), S.allConns ? 'Show fewer' : `Show all ${dbs.length}`) : null);
}

/* Settings */
function field(k, current, commit, attrs, enterOnly) {
  return h('input', {
    class: 'inp', ...attrs, 'data-k': k, value: S.drafts.has(k) ? S.drafts.get(k) : current,
    oninput: (e) => S.drafts.set(k, e.target.value),
    onchange: enterOnly ? null : (e) => { S.drafts.delete(k); commit(e.target.value); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); S.drafts.delete(k); commit(e.target.value); } },
  });
}
const row = (label, hint, ctl, cls = '') => h('div', { class: 'row ' + cls }, h('div', { class: 'txt' }, label, hint ? h('small', null, hint) : null), ctl);
const sw = (label, on, fn, k) => h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': !!on, 'aria-label': label, 'data-k': k, onclick: () => fn(!on) });
const seg = (label, value, options, fn, k) => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
  options.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'aria-checked': v === value, 'data-k': `${k}:${v}`, onclick: () => fn(v) }, t)));
function settingsView() {
  const g = S.settings, p = curProject();
  const swRow = (key, label, hint) => row(label, hint, sw(label, g[key], (v) => setGlobal({ [key]: v }), 'g:' + key));
  const addWs = (v) => { v = String(v || '').trim(); S.drafts.delete('ws-add'); if (v && !(g.workspaces || []).includes(v)) setGlobal({ workspaces: [...(g.workspaces || []), v] }); else render(); };
  const settle = (v) => { const n = Math.round(Number(v)); if (Number.isFinite(n)) setGlobal({ settleSeconds: Math.max(10, Math.min(900, n)) }); };
  const dg = S.diag;
  return h('div', { class: 'stack narrow' },
    h('div', { class: 'set-head' }, h('h2', null, 'Settings'), btn('Done', () => go(S.prevView || 'pulse'), { cls: 'sm', k: 'set-done' })),
    h('section', { class: 'card group' }, h('h3', null, 'Everywhere'),
      swRow('autoReviews', 'Automatic session reviews', 'Pulse writes a review after a coding task finishes.'),
      swRow('autoOpenWindow', 'Open the window automatically', 'Show this window when a new review is ready.'),
      row('Next steps per review', 'The most suggestions a review can make.', seg('Next steps per review', g.maxRecommendations, [[1, '1'], [2, '2'], [3, '3']], (v) => setGlobal({ maxRecommendations: v }), 'g:max')),
      row('Explanation detail', 'How much reviews explain.', seg('Explanation detail', g.detail, Object.entries(DETAIL), (v) => setGlobal({ detail: v }), 'g:detail')),
      swRow('notifications', 'Notifications', 'A small Windows notification when a review is ready.'),
      swRow('animations', 'Animations', 'Gentle motion for new reviews and changes.'),
      row('Theme', null, seg('Theme', g.theme || 'system', [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], (v) => setGlobal({ theme: v }), 'g:theme')),
      swRow('openWhileTyping', "Open the window even while I'm typing", 'When off, Pulse waits until you pause typing so it never takes over your keyboard.'),
      row('Quiet time before a review', 'How long Pulse waits after a task finishes, in case you keep going.',
        h('div', { class: 'ctl' }, seg('Quiet time presets', g.settleSeconds, [[30, '30s'], [60, '60s'], [90, '90s'], [180, '3 min']], (v) => setGlobal({ settleSeconds: v }), 'g:settle'),
          field('settle', g.settleSeconds, settle, { type: 'number', min: 10, max: 900, step: 5, class: 'inp num', 'aria-label': 'Quiet time in seconds' }))),
      row('Review model', 'Used when no Claude Code session is open to write the review.',
        field('model', g.reviewModel || 'sonnet', (v) => setGlobal({ reviewModel: String(v).trim() || 'sonnet' }), { type: 'text', spellcheck: 'false', 'aria-label': 'Review model', placeholder: 'sonnet' })),
      row('Workspace folders', 'Folders that hold several projects, like D:\\Code. Each project inside gets its own reviews.',
        h('div', { class: 'ws' },
          (g.workspaces || []).length ? h('ul', { class: 'rows paths' }, g.workspaces.map((w) => h('li', null, h('span', { class: 'grow' }, w),
            act('Remove folder', 'x', () => setGlobal({ workspaces: g.workspaces.filter((x) => x !== w) }), { iconOnly: true, cls: 'danger', title: `Remove ${w}`, k: 'ws-rm:' + w }))))
            : h('p', { class: 'plain-empty' }, 'No workspace folders yet.'),
          h('div', { class: 'add-row' }, field('ws-add', '', addWs, { type: 'text', class: 'inp grow', spellcheck: 'false', placeholder: 'Folder path, e.g. D:\\Code', 'aria-label': 'Folder path to add' }, true),
            btn('Add', () => addWs(S.drafts.get('ws-add')), { cls: 'sm', k: 'ws-add-btn' }))), 'col')),
    p && S.detail ? h('section', { class: 'card group' }, h('h3', null, `This project · ${p.name}`), OVR.map(ovrRow),
      h('div', { class: 'forget' }, S.forget
        ? [h('p', null, `Forget ${p.name}? Pulse deletes its reviews, plan and history. Your code isn't touched.`),
          h('div', { class: 'add-row' }, btn('Forget project', forgetProject, { cls: 'sm danger solid', k: 'forget-yes' }), btn('Cancel', () => { S.forget = false; render(); }, { cls: 'sm quiet', k: 'forget' }))]
        : btn('Forget this project', () => { S.forget = true; render(); }, { cls: 'sm danger', icon: 'trash', k: 'forget' }))) : null,
    h('section', { class: 'card group' }, h('h3', null, 'Always on'),
      h('dl', { class: 'info' }, h('dt', null, 'Review history'), h('dd', null, 'Enabled'),
        h('dt', null, 'Manual review'), h('dd', null, 'Always available (/pulse in Claude Code, the Review now button, or the project-pulse tools in Claude Desktop)'))),
    h('section', { class: 'card group' }, h('h3', null, 'Diagnostics'),
      !dg ? h('p', { class: 'plain-empty' }, 'Loading…') : dg.error ? h('p', { class: 'plain-empty' }, dg.error) : [
        h('dl', { class: 'info' }, h('dt', null, 'Version'), h('dd', null, String(dg.version ?? '')), h('dt', null, 'Port'), h('dd', null, String(dg.port ?? '')),
          h('dt', null, 'Data folder'), h('dd', { class: 'mono' }, dg.dataDir || '')),
        lbl('Recent review runs'),
        dg.jobs?.length ? h('ul', { class: 'rows' }, dg.jobs.slice(0, 6).map((j) => h('li', null, h('span', { class: 'chip', 'data-s': j.state === 'failed' ? 'failed' : 'completed' }, RUN_STATE[j.state] || j.state),
          h('div', { class: 'grow' }, TRIGGER[j.trigger] || j.trigger, h('small', null, [j.startedAt ? ago(j.startedAt) : 'not started', j.error].filter(Boolean).join(' · '))))))
          : h('p', { class: 'plain-empty' }, 'No recent review runs.'),
        lbl('Log'), h('pre', { class: 'log' }, dg.logTail || 'The log is empty.'),
        h('div', { class: 'add-row' }, btn('Open log folder', openLog, { cls: 'sm', icon: 'folder', k: 'open-log' })),
      ]));
}
function ovrRow([key, label, kind]) {
  const cur = S.detail.settings?.overrides?.[key] ?? null, g = S.settings[key];
  const fmt = (v) => (kind === 'bool' ? (v ? 'On' : 'Off') : kind === 'detail' ? DETAIL[v] || v : String(v));
  const vals = kind === 'bool' ? [true, false] : kind === 'max' ? [1, 2, 3] : Object.keys(DETAIL);
  return h('div', { class: 'row' }, h('label', { class: 'txt', for: 'ov-' + key }, label),
    h('select', { class: 'sel', id: 'ov-' + key, 'data-k': 'ov:' + key, onchange: (e) => setOverride(key, e.target.value === '' ? null : vals[Number(e.target.value)]) },
      h('option', { value: '', selected: cur === null }, `Use global (${fmt(g)})`),
      vals.map((v, i) => h('option', { value: String(i), selected: cur === v }, fmt(v)))));
}

/* ---------- chrome wiring ---------- */
for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => go(t.dataset.view));
$('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('.tab')], i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  n.focus(); go(n.dataset.view);
});
$('#reviewNow').addEventListener('click', reviewNow);
$('#gear').addEventListener('click', () => go(S.view === 'settings' ? S.prevView || 'pulse' : 'settings'));
$('#switcher').addEventListener('click', (e) => {
  S.menu = !S.menu; renderMenu();
  if (S.menu) { reloadProjects(); if (e.detail === 0) focusEl($('#switchMenu [aria-checked="true"]') || $('#switchMenu .mi')); }
});
$('#switcher').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && !S.menu) { e.preventDefault(); S.menu = true; renderMenu(); focusEl($('#switchMenu [aria-checked="true"]') || $('#switchMenu .mi')); }
});
$('#switchMenu').addEventListener('keydown', (e) => {
  const items = [...$('#switchMenu').querySelectorAll('.mi')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    focusEl(items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]);
  } else if (e.key === 'Tab') { S.menu = false; renderMenu(); }
});
document.addEventListener('click', (e) => { if (S.menu && !e.target.closest?.('.switch-wrap')) { S.menu = false; renderMenu(); } });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.compare) closeCompare();
  else if (S.menu) { S.menu = false; renderMenu(); focusEl($('#switcher')); }
  else if (S.confirm) { S.confirm = null; render(); }
});
document.body.append(h('div', { id: 'sr', class: 'sr', 'aria-live': 'polite' }));
const markHidden = () => document.documentElement.toggleAttribute('data-hidden', document.hidden); // pauses the live ping
markHidden();
document.addEventListener('visibilitychange', () => { markHidden(); sendWindowState(); });
for (const ev of ['focus', 'blur']) addEventListener(ev, () => sendWindowState());
matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', render);

render();
connect();
await loadAll();
sendWindowState(true);
setInterval(() => sendWindowState(), 2000);
setInterval(() => { if (document.visibilityState === 'visible') render(); }, 60000);
