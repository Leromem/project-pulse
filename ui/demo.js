// Demo mode (?demo=1 only): sample data plus an in-memory fake of the Pulse API and its event stream.
// Every action changes this in-memory data, so the whole UI can be tried without the service.
const VERSION = '0.1.0 (demo)';
const MIN = 60e3, HR = 60 * MIN, DAY = 24 * HR;
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const clone = (x) => structuredClone(x);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const uid = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

const DEFAULTS = { autoReviews: true, autoOpenWindow: true, maxRecommendations: 3, detail: 'brief', notifications: true, animations: true, theme: 'system', openWhileTyping: false, settleSeconds: 90, reviewModel: 'sonnet', workspaces: [] };
const OVR_KEYS = ['autoReviews', 'autoOpenWindow', 'maxRecommendations', 'detail', 'notifications'];
const settings = { ...DEFAULTS, workspaces: ['D:\\Code', 'D:\\Code\\clients'] };
const themeParam = new URLSearchParams(location.search).get('theme');
if (['light', 'dark', 'system'].includes(themeParam)) settings.theme = themeParam;

const db = { projects: [], reviews: [], drawbacks: [], recs: [], decisions: [], jobs: [] };
const find = (list, id) => db[list].find((x) => x.id === id);

function project(id, name, path, activityAgo, extra = {}) {
  db.projects.push({ id, name, path, createdAt: iso(21 * DAY), lastActivityAt: iso(activityAgo), live: false, job: null, overrides: {}, ...extra });
}
function review(id, projectId, agoMs, title, status, extra = {}) {
  const r = { id, projectId, sessionId: null, createdAt: iso(agoMs), title, status, state: 'ready', trigger: 'task-complete', source: 'claude-code', statusReason: '', built: [], benefits: [], evidence: [], resolved: [], implemented: [], error: null, ...extra };
  db.reviews.push(r);
  return r;
}
function drawback(id, reviewId, text, extra = {}) {
  const r = find('reviews', reviewId);
  db.drawbacks.push({ id, projectId: r.projectId, reviewId, text, detail: '', status: 'open', resolvedByReviewId: null, resolvedNote: null, createdAt: r.createdAt, updatedAt: r.createdAt, ...extra });
}
function rec(id, reviewId, title, extra = {}) {
  const r = find('reviews', reviewId);
  db.recs.push({ id, projectId: r.projectId, reviewId, title, why: '', benefit: '', drawback: '', priority: 'medium', effort: 'small', explore: '', simple: '', connection: '', addressesDrawbackId: null, status: 'suggested', completedHow: null, completedEvidence: null, createdAt: r.createdAt, updatedAt: r.createdAt, decidedAt: null, ...extra });
}

/* ---------- sample data ---------- */
project('p-acme', 'acme-storefront', 'D:\\Code\\acme-storefront', 6 * MIN, { live: true });
project('p-recipe', 'recipe-box-api', 'D:\\Code\\recipe-box-api', 3 * HR);
project('p-launch', 'launch-site', 'D:\\Code\\clients\\launch-site', 26 * HR);
project('p-photo', 'photo-sorter', 'C:\\Users\\you\\Projects\\photo-sorter', 4 * DAY, { overrides: { maxRecommendations: 2 } });

review('r-a1', 'p-acme', 5 * DAY, 'Product pages read from the new catalog API', 'completed', {
  statusReason: 'Pages render from the API and the old JSON files are gone.',
  built: ['Swapped the static product files for calls to the catalog API', 'Added loading placeholders while products arrive'],
  benefits: ['Product changes show up without a redeploy'], evidence: ['Changed files: src/pages/product/[slug].tsx, src/lib/catalog.ts'],
});
review('r-a2', 'p-acme', 3 * DAY, 'Added a slide-out cart drawer', 'partial', {
  statusReason: 'The drawer works, but the cart is lost on reload.', trigger: 'session-end',
  built: ['Built a cart drawer that slides in from the right', 'Added quantity buttons and a running total'],
  benefits: ['Shoppers can check their cart without leaving the page'], evidence: ['Changed files: src/components/CartDrawer.tsx, src/cart/store.ts'],
});
review('r-a3', 'p-acme', 26 * HR, 'Product images load faster with caching', 'needs-testing', {
  statusReason: 'Caching is on, but nobody has tried it on a slow connection yet.',
  built: ['Turned on browser caching for product images', 'Images below the fold now load only when scrolled to'],
  benefits: ['Repeat visits feel much faster'], evidence: ['Changed files: next.config.js, src/components/ProductImage.tsx'],
  resolved: [{ drawbackId: 'd-a1', text: "Product images aren't cached, so repeat visits feel slow", note: 'Images now use a 7-day browser cache.' }],
  implemented: [{ recommendationId: 'x-a1', title: 'Cache product images in the browser', evidence: 'Cache headers added in next.config.js.' }],
});
review('r-a4', 'p-acme', 25 * MIN, 'Checkout now remembers the cart between visits', 'completed', {
  statusReason: 'You checked it in Edge, and 42 of 42 tests pass.',
  built: ['Saved the cart in the browser so it survives reloads and new tabs', "Merged a saved cart into the shopper's account cart at sign-in", 'Added a small "Cart restored" notice'],
  benefits: ['Shoppers stop losing their cart when a tab closes', 'Fewer abandoned checkouts after accidental reloads', 'Works without an account'],
  evidence: ['Changed files: src/cart/store.ts, src/cart/merge.ts, src/components/CartNotice.tsx', 'Ran npm test: 42 passed, 0 failed', 'Your message: "checked in Edge, the cart survives a reload"', 'Claude Code session: 14 turns, about 40 minutes'],
  resolved: [{ drawbackId: 'd-a2', text: 'The cart empties when the page reloads', note: 'The cart is saved in the browser now.' }],
  implemented: [{ recommendationId: 'x-a2', title: 'Keep the cart in browser storage', evidence: 'cart/store.ts writes to localStorage on every change.' }],
});
drawback('d-a1', 'r-a1', "Product images aren't cached, so repeat visits feel slow", { status: 'resolved', resolvedByReviewId: 'r-a3', resolvedNote: 'Images now use a 7-day browser cache.' });
drawback('d-a2', 'r-a2', 'The cart empties when the page reloads', { status: 'resolved', resolvedByReviewId: 'r-a4', resolvedNote: 'The cart is saved in the browser now.' });
drawback('d-a3', 'r-a3', "Lazy loading hasn't been checked on a slow connection", { detail: 'Images might pop in late on phones with weak signal.' });
drawback('d-a4', 'r-a4', 'A saved cart can show prices that changed since it was saved', { detail: 'Prices update at checkout, which can surprise people.' });
drawback('d-a5', 'r-a4', 'On a shared computer, the saved cart stays after signing out', { status: 'accepted' });
rec('x-a1', 'r-a1', 'Cache product images in the browser', { addressesDrawbackId: 'd-a1', status: 'completed', completedHow: 'detected', completedEvidence: 'Cache headers found in next.config.js', priority: 'high', why: 'Images download again on every visit.' });
rec('x-a2', 'r-a2', 'Keep the cart in browser storage', { addressesDrawbackId: 'd-a2', status: 'completed', completedHow: 'detected', completedEvidence: 'cart/store.ts now saves to localStorage', priority: 'high', why: 'A reload wipes the cart today.' });
rec('x-a3', 'r-a2', 'Limit how many of one item fit in the cart', { status: 'dismissed', priority: 'low', why: 'Someone could add 999 of an item by holding the + button.', decidedAt: iso(2 * DAY) });
rec('x-a4', 'r-a3', 'Test pages on a throttled connection', {
  addressesDrawbackId: 'd-a3', status: 'planned', decidedAt: iso(20 * HR), why: 'Lazy-loaded images might show up late on slow phones.',
  benefit: 'Confidence that pages feel fine on a weak signal.', drawback: 'A manual pass in the browser network tools.',
  explore: "Open the site in Edge, turn on 'Slow 4G' in the Network panel, and scroll a long product list. Watch for blank boxes or layout jumps while images arrive.",
  simple: 'Make sure the site still feels okay when the internet is slow.', connection: 'Caching sped up repeat visits; this checks the first visit on a slow line.',
});
rec('x-a5', 'r-a4', 'Re-check prices when a saved cart loads', {
  addressesDrawbackId: 'd-a4', priority: 'high', why: 'A cart saved last week can show an old price until checkout.',
  benefit: 'Shoppers see the real total before they reach checkout.', drawback: 'One extra price lookup each time a saved cart opens.',
  explore: 'When a saved cart loads, ask the catalog API for the current price of each item, update the cart, and show a short note if anything changed. The old prices can show for a moment while fresh ones load, so the page never waits. This touches the cart store and the CartNotice component you just added.',
  simple: 'Prices change. If someone saved a cart a while ago, check the prices again when they come back so checkout has no surprises.',
  connection: 'Saving the cart is what lets old prices stick around, so this closes the gap today\'s work opened.',
});
rec('x-a6', 'r-a4', 'Clear the saved cart when someone signs out', {
  addressesDrawbackId: 'd-a5', why: 'On a shared computer, the next person could see the last shopper\'s cart.',
  benefit: 'Protects shoppers on shared or public computers.', drawback: 'Someone who signs out by accident loses their cart.',
  explore: 'In the sign-out handler, remove the saved cart from browser storage after the account cart is synced. Signed-out shoppers on their own device keep their cart, because it only clears on an explicit sign-out.',
  simple: 'When someone signs out, forget their cart so the next person on that computer starts fresh.',
  connection: 'You accepted this risk earlier. This is the small fix if you change your mind.',
});
rec('x-a7', 'r-a4', 'Add a test for merging carts at sign-in', {
  effort: 'medium', why: "Merging two carts is the trickiest part of today's change and has no test yet.",
  benefit: 'Catches double-counted items before shoppers do.', drawback: 'About half an hour to write, plus a little upkeep.',
  explore: 'Write a test that starts with a saved cart and an account cart that share one item, signs in, and checks the merged quantities. Add a second case where the account cart is empty.',
  simple: 'Add an automatic check that combining two carts gives the right numbers.',
  connection: "Covers the merge step you built today, which nothing checks yet.",
});

review('r-r1', 'p-recipe', 2 * DAY, 'Recipes can be searched by ingredient', 'needs-testing', {
  statusReason: 'Search works for the sample data; no tests cover it yet.',
  built: ['Added a /recipes?ingredient= search endpoint', 'Indexed ingredient names when a recipe is saved'],
  benefits: ['Find recipes by what is already in the fridge'], evidence: ['Changed files: src/routes/recipes.ts, src/db/ingredients.ts'],
});
review('r-r2', 'p-recipe', 3 * HR, '', 'no-changes', { state: 'failed', trigger: 'session-end', error: 'The review timed out after 120 seconds while waiting for Claude.' });
drawback('d-r1', 'r-r1', "Search is case-sensitive, so 'Tomato' misses 'tomato'");
rec('x-r1', 'r-r1', 'Make ingredient search ignore upper and lower case', { addressesDrawbackId: 'd-r1', priority: 'high', why: "People type 'Tomato' and get nothing back.", benefit: 'Search finds what people expect.', drawback: 'Existing ingredient rows need a one-time cleanup.', explore: 'Store a lower-case copy of each ingredient name and compare against the lower-cased search text.', simple: "Treat 'Tomato' and 'tomato' as the same word.", connection: 'Fixes the main gap in the search you just built.' });
rec('x-r2', 'r-r1', 'Add an index on the ingredients column', { status: 'planned', decidedAt: iso(DAY), effort: 'medium', why: 'Search will slow down as the recipe list grows.', benefit: 'Fast search with thousands of recipes.', drawback: 'Slightly slower saves.', explore: 'Create a database index on ingredient name, then compare search times before and after with 5,000 sample recipes.', simple: 'Help the database find ingredients quickly.', connection: 'Keeps the new search fast later on.' });

review('r-l1', 'p-launch', 26 * HR, "Contact form is wired up but can't send email yet", 'blocked', {
  statusReason: "Sending fails: the mail service key isn't set on this machine.",
  built: ['Built the contact form with name, email and message fields', 'Added form checks and a thank-you screen', 'Connected the form to the mail service'],
  benefits: ['Visitors can reach you without leaving the page', 'Bad email addresses are caught before sending'],
  evidence: ['Changed files: app/contact/page.tsx, app/api/contact/route.ts', 'Test send failed: 401 from the mail service'],
});
drawback('d-l1', 'r-l1', 'Messages are lost while email sending is broken');
rec('x-l1', 'r-l1', 'Set the mail service key and send a test message', { addressesDrawbackId: 'd-l1', priority: 'high', why: 'Nothing sends until the key is in place.', benefit: 'Unblocks the whole contact form.', drawback: 'You need access to the mail service dashboard.', explore: 'Add the key to .env.local (never commit it), restart the dev server, and send yourself a message from the form.', simple: 'Give the site the password it needs to send email, then try it.', connection: 'This is the one thing standing between the form and working email.' });
rec('x-l2', 'r-l1', 'Save each message before trying to email it', { addressesDrawbackId: 'd-l1', effort: 'medium', why: 'If email fails again, the message is gone for good.', benefit: 'No lost messages, even during outages.', drawback: 'Adds a small table to look after.', explore: 'Write each submission to a messages table first, then send the email. Mark the row as sent when it succeeds.', simple: 'Keep a copy of every message, just in case the email does not go out.', connection: 'Protects against the same failure happening later.' });
rec('x-l3', 'r-l1', 'Add a spam check to the form', { priority: 'low', effort: 'medium', why: 'Public forms attract bots within days.', benefit: 'Cleaner inbox.', drawback: 'A little extra friction for real visitors.', explore: 'Add a hidden field that bots fill in and humans do not, and reject submissions that fill it.', simple: 'Stop robots from sending junk through the form.', connection: 'Worth doing before the site goes public.' });

db.jobs.push({ id: 'job-1', state: 'failed', trigger: 'session-end', startedAt: iso(3 * HR + 2 * MIN), error: 'Timed out after 120 s' });

/* ---------- reviews the demo writes when you press Review now / Retry ---------- */
const scripts = {
  'p-acme': [(id) => {
    const r = review(id, 'p-acme', 0, 'Saved carts now refresh their prices', 'completed', {
      trigger: 'manual', statusReason: 'Prices update on load; the new test passes.',
      built: ['Checked current prices when a saved cart opens', 'Showed a note when a price changed'],
      benefits: ['Totals are right before checkout'], evidence: ['Changed files: src/cart/store.ts, src/components/CartNotice.tsx', 'Ran npm test: 43 passed'],
      resolved: [{ drawbackId: 'd-a4', text: find('drawbacks', 'd-a4').text, note: 'Prices refresh when the cart loads.' }],
      implemented: [{ recommendationId: 'x-a5', title: find('recs', 'x-a5').title, evidence: 'store.ts calls the catalog API on load.' }],
    });
    Object.assign(find('drawbacks', 'd-a4'), { status: 'resolved', resolvedByReviewId: id, resolvedNote: 'Prices refresh when the cart loads.', updatedAt: iso() });
    Object.assign(find('recs', 'x-a5'), { status: 'completed', completedHow: 'detected', completedEvidence: 'store.ts calls the catalog API on load', decidedAt: iso() });
    drawback(uid('d'), id, 'The price note can flash briefly on fast connections');
    rec(uid('x'), id, 'Only show the price note when a price really changed', { priority: 'low', why: 'The note can appear for a split second even when nothing changed.', benefit: 'A calmer cart.', drawback: 'One more comparison in the cart code.', explore: 'Compare old and new totals and skip the note when they match.', simple: 'Only tell people about price changes when there is one.', connection: 'Smooths out the note you just added.' });
    return r;
  }],
  'p-photo': [(id) => review(id, 'p-photo', 0, 'Photos are sorted into folders by date taken', 'needs-testing', {
    trigger: 'manual', statusReason: 'Sorting works on the sample folder; large libraries are untested.',
    built: ['Read the date taken from each photo', 'Moved photos into Year\\Month folders'], benefits: ['A tidy library without manual sorting'],
    evidence: ['Changed files: sorter.py, tests/test_dates.py'],
  })],
  'p-recipe': [(id) => {
    const r = review(id, 'p-recipe', 0, 'Recipe photos upload to local storage', 'partial', {
      trigger: 'retry', statusReason: 'Uploads work; resizing is still missing.',
      built: ['Added a photo upload endpoint', 'Saved photos under /uploads with safe file names'], benefits: ['Recipes can show a picture'],
      evidence: ['Changed files: src/routes/photos.ts'],
    });
    drawback(uid('d'), id, 'Big photos are stored at full size');
    return r;
  }],
};
function nextReview(pid, trigger) {
  const id = uid('r'), make = scripts[pid]?.shift();
  if (make) return make(id);
  const r = review(id, pid, 0, 'No new changes since the last review', 'no-changes', { trigger, statusReason: 'No files changed since the last review.', evidence: ['Compared with the last review: 0 changed files'] });
  return r;
}

/* ---------- event stream ---------- */
let listeners = {};
const emit = (type, data) => { for (const fn of listeners[type] || []) fn({ type, data: JSON.stringify(data) }); };
export function events() {
  listeners = {};
  const src = {
    readyState: 1, onopen: null, onerror: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    close() { this.readyState = 2; listeners = {}; },
  };
  setTimeout(() => { src.onopen?.(); emit('hello', { version: VERSION }); }, 50);
  return src;
}
function runJob(pid, trigger) {
  const p = find('projects', pid);
  p.job = { id: uid('job'), state: 'queued', trigger, startedAt: null, error: null };
  emit('job', { projectId: pid, state: 'queued' });
  setTimeout(() => { if (!p.job) return; Object.assign(p.job, { state: 'running', startedAt: iso() }); emit('job', { projectId: pid, state: 'running' }); }, 1200);
  setTimeout(() => {
    if (!find('projects', pid)) return;
    db.jobs.unshift({ ...p.job, state: 'done' });
    p.job = null; p.lastActivityAt = iso();
    const r = nextReview(pid, trigger);
    emit('job', { projectId: pid, state: 'done' });
    emit('review', { projectId: pid, reviewId: r.id, title: r.title });
  }, 4800);
}
// One background review for another project, so the "New review for…" toast can be seen.
setTimeout(() => { if (find('projects', 'p-photo') && !db.reviews.some((r) => r.projectId === 'p-photo') && !find('projects', 'p-photo').job) runJob('p-photo', 'task-complete'); }, 45000);

/* ---------- shapes ---------- */
const summary = ({ id, createdAt, title, status, state, trigger, source }) => ({ id, createdAt, title, status, state, trigger, source });
const reviewsOf = (pid) => db.reviews.filter((r) => r.projectId === pid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const full = (r) => r && { ...r, drawbacks: db.drawbacks.filter((x) => x.reviewId === r.id), recommendations: db.recs.filter((x) => x.reviewId === r.id) };
function effective(p) {
  const e = {};
  for (const k of OVR_KEYS) e[k] = p.overrides[k] ?? settings[k];
  return e;
}
function projectOut(p) {
  const recs = db.recs.filter((x) => x.projectId === p.id), revs = reviewsOf(p.id);
  return {
    id: p.id, name: p.name, path: p.path, createdAt: p.createdAt, lastActivityAt: p.lastActivityAt, lastReviewAt: revs[0]?.createdAt || null,
    counts: { suggested: recs.filter((x) => x.status === 'suggested').length, planned: recs.filter((x) => x.status === 'planned').length, openDrawbacks: db.drawbacks.filter((x) => x.projectId === p.id && x.status === 'open').length, reviews: revs.length },
    live: p.live, job: p.job, autoReviews: effective(p).autoReviews,
  };
}
function linksOf(pid) {
  const out = [], add = (fromType, fromId, toType, toId, relation, createdAt) => out.push({ id: `l-${out.length}`, projectId: pid, fromType, fromId, toType, toId, relation, note: '', createdAt });
  for (const d of db.drawbacks.filter((x) => x.projectId === pid)) {
    add('review', d.reviewId, 'drawback', d.id, 'introduced', d.createdAt);
    if (d.resolvedByReviewId) add('review', d.resolvedByReviewId, 'drawback', d.id, 'resolved', d.updatedAt);
  }
  for (const r of db.recs.filter((x) => x.projectId === pid)) {
    add('review', r.reviewId, 'recommendation', r.id, 'suggested', r.createdAt);
    if (r.addressesDrawbackId) add('recommendation', r.id, 'drawback', r.addressesDrawbackId, 'addresses', r.createdAt);
  }
  return out;
}
function detail(pid) {
  const p = find('projects', pid);
  if (!p) throw new Error('That project is no longer in Pulse.');
  const revs = reviewsOf(pid);
  return {
    project: projectOut(p),
    settings: { effective: effective(p), overrides: Object.fromEntries(OVR_KEYS.map((k) => [k, p.overrides[k] ?? null])) },
    latestReview: full(revs[0]) || null, reviews: revs.map(summary),
    recommendations: db.recs.filter((x) => x.projectId === pid), drawbacks: db.drawbacks.filter((x) => x.projectId === pid),
    links: linksOf(pid), decisions: db.decisions.filter((x) => x.projectId === pid),
  };
}
const STATUS_LABEL = { completed: 'Completed', partial: 'Partially Completed', 'needs-testing': 'Needs Testing', blocked: 'Blocked', 'no-changes': 'No Meaningful Changes' };
const LEVEL = { high: 'High', medium: 'Medium', low: 'Low', small: 'Small', large: 'Large' };
// Same text for GET /api/recommendations/:id/prompt, Discuss in Claude and Copy Prompt.
function promptFor(r, p) {
  const last = reviewsOf(p.id).find((x) => x.state !== 'failed') || find('reviews', r.reviewId);
  const d = r.addressesDrawbackId ? find('drawbacks', r.addressesDrawbackId) : null;
  const planned = db.recs.filter((x) => x.projectId === p.id && x.status === 'planned' && x.id !== r.id).map((x) => x.title);
  const out = [
    `Project Pulse suggestion for ${p.name} (${p.path})`, '',
    `Suggestion: ${r.title}`,
    `Priority: ${LEVEL[r.priority] || r.priority} · Estimated effort: ${LEVEL[r.effort] || r.effort}`, '',
    'Context',
  ];
  if (last) out.push(`- Last work reviewed: "${last.title}"`, `  Status: ${STATUS_LABEL[last.status] || last.status}${last.statusReason ? ` (${last.statusReason})` : ''}`);
  if (d) { out.push(`- Concern this fixes: ${d.text}`); if (d.detail) out.push(`  (${d.detail})`); }
  if (r.why) out.push(`- Why Pulse suggests it: ${r.why}`);
  if (r.benefit) out.push(`- Expected benefit: ${r.benefit}`);
  if (r.drawback) out.push(`- Possible downside: ${r.drawback}`);
  if (planned.length) out.push(`- Already planned here (don't repeat): ${planned.join(', ')}`);
  out.push('',
    'Please do NOT edit any files yet. First:',
    '1. Read the relevant code and tell me if this concern is real here, naming the files and functions involved.',
    '2. Give me 2–3 ways to do it, each with effort, risk, and what could break.',
    '3. Recommend one, explained in plain words a non-coder could follow.',
    '4. Tell me how we will test it: what to run or click, and what "working" looks like.',
    '5. End with a short step-by-step plan, then wait for my go-ahead.');
  return out.join('\n');
}

/* ---------- fake API ---------- */
export async function request(method, path, body = {}) {
  await wait(90 + Math.random() * 140);
  const url = new URL(path, location.href), p = url.pathname;
  let m;
  const is = (verb, re) => method === verb && (m = p.match(re));
  if (is('GET', /^\/api\/health$/)) return { ok: true, version: VERSION, port: 47821 };
  if (is('GET', /^\/api\/projects$/)) return clone(db.projects.map(projectOut).sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '')));
  if (is('GET', /^\/api\/projects\/([^/]+)$/)) return clone(detail(decodeURIComponent(m[1])));
  if (is('GET', /^\/api\/reviews\/([^/]+)$/)) { const r = find('reviews', decodeURIComponent(m[1])); if (!r) throw new Error('That review no longer exists.'); return clone(full(r)); }
  if (is('GET', /^\/api\/settings$/)) return clone({ global: settings, defaults: DEFAULTS });
  if (is('GET', /^\/api\/diagnostics$/)) {
    return clone({
      version: VERSION, port: 47821, dataDir: 'C:\\Users\\you\\AppData\\Local\\ProjectPulse', logFile: 'C:\\Users\\you\\AppData\\Local\\ProjectPulse\\logs\\pulse.log', jobs: db.jobs.slice(0, 6),
      logTail: [
        `${iso(3 * HR)} INFO  service listening on 127.0.0.1:47821`,
        `${iso(3 * HR - 2 * MIN)} WARN  review for recipe-box-api timed out after 120 s`,
        `${iso(25 * MIN)} INFO  review ready for acme-storefront (task-complete)`,
        `${iso(6 * MIN)} INFO  heartbeat from Claude Code session in D:\\Code\\acme-storefront`,
      ].join('\n'),
    });
  }
  if (is('POST', /^\/api\/projects\/([^/]+)\/review$/)) {
    const pr = find('projects', decodeURIComponent(m[1]));
    if (!pr) throw new Error('That project is no longer in Pulse.');
    if (pr.job) return { mode: 'none', message: 'A review is already being written.' };
    runJob(pr.id, 'manual');
    return pr.live ? { mode: 'live-session', message: 'Asked your Claude Code session to write a review.' } : { mode: 'headless', message: 'Pulse is writing a review in the background.' };
  }
  if (is('POST', /^\/api\/reviews\/([^/]+)\/retry$/)) {
    const r = find('reviews', decodeURIComponent(m[1])), pr = r && find('projects', r.projectId);
    if (!pr) throw new Error('That review no longer exists.');
    if (pr.job) return { mode: 'none', message: 'A review is already being written.' };
    runJob(pr.id, 'retry');
    return { mode: 'headless', message: 'Trying the review again in the background.' };
  }
  if (is('POST', /^\/api\/recommendations\/([^/]+)\/action$/)) {
    const r = find('recs', decodeURIComponent(m[1]));
    if (!r) throw new Error('That suggestion no longer exists.');
    const next = { plan: 'planned', unplan: 'suggested', dismiss: 'dismissed', restore: 'suggested', complete: 'completed' }[body.action];
    if (!next) throw new Error('Unknown action.');
    Object.assign(r, { status: next, updatedAt: iso(), decidedAt: iso(), completedHow: body.action === 'complete' ? body.how || 'tested' : body.action === 'restore' ? null : r.completedHow });
    db.decisions.push({ id: uid('dec'), projectId: r.projectId, recommendationId: r.id, drawbackId: null, action: body.action, note: body.note || '', at: iso() });
    emit('project', { projectId: r.projectId });
    return clone({ recommendation: r });
  }
  if (is('GET', /^\/api\/recommendations\/([^/]+)\/prompt$/)) {
    const r = find('recs', decodeURIComponent(m[1])), pr = r && find('projects', r.projectId);
    if (!pr) throw new Error('That suggestion no longer exists.');
    return { prompt: promptFor(r, pr) };
  }
  if (is('POST', /^\/api\/recommendations\/([^/]+)\/discuss$/)) {
    const r = find('recs', decodeURIComponent(m[1])), pr = r && find('projects', r.projectId);
    if (!pr) throw new Error('That suggestion no longer exists.');
    return pr.live
      ? { mode: 'sent-to-claude-code', prompt: promptFor(r, pr), message: 'Added to your Claude Code prompt box.' }
      : { mode: 'copy', prompt: promptFor(r, pr), message: 'No live Claude Code session, so the prompt is ready to copy.' };
  }
  if (is('POST', /^\/api\/drawbacks\/([^/]+)\/action$/)) {
    const d = find('drawbacks', decodeURIComponent(m[1]));
    if (!d) throw new Error('That concern no longer exists.');
    const next = { accept: 'accepted', reopen: 'open', resolve: 'resolved' }[body.action];
    if (!next) throw new Error('Unknown action.');
    Object.assign(d, { status: next, updatedAt: iso(), ...(next === 'open' ? { resolvedByReviewId: null, resolvedNote: null } : {}) });
    emit('project', { projectId: d.projectId });
    return clone({ drawback: d });
  }
  if (is('PUT', /^\/api\/settings$/)) {
    for (const [k, v] of Object.entries(body)) if (k in DEFAULTS) settings[k] = v;
    emit('settings', {});
    return clone({ global: settings });
  }
  if (is('PUT', /^\/api\/projects\/([^/]+)\/settings$/)) {
    const pr = find('projects', decodeURIComponent(m[1]));
    if (!pr) throw new Error('That project is no longer in Pulse.');
    for (const [k, v] of Object.entries(body.overrides || {})) if (OVR_KEYS.includes(k)) { if (v === null) delete pr.overrides[k]; else pr.overrides[k] = v; }
    emit('project', { projectId: pr.id });
    return clone(detail(pr.id).settings);
  }
  if (is('DELETE', /^\/api\/projects\/([^/]+)$/)) {
    const id = decodeURIComponent(m[1]);
    for (const k of ['projects']) db[k] = db[k].filter((x) => x.id !== id);
    for (const k of ['reviews', 'drawbacks', 'recs', 'decisions']) db[k] = db[k].filter((x) => x.projectId !== id);
    return { ok: true };
  }
  if (is('POST', /^\/api\/window\/state$/) || is('POST', /^\/api\/diagnostics\/open-log$/)) return { ok: true };
  throw new Error(`The demo doesn't know ${method} ${p}.`);
}
