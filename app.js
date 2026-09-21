import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { initNotes } from './notes.js';

const SUPABASE_URL = 'https://kmxhcvmxeoqglpshzuns.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtteGhjdm14ZW9xZ2xwc2h6dW5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzODg0MTIsImV4cCI6MjA5NTk2NDQxMn0.-Nm_KAabbu9FQTql81blTmULPivBUnzwXa_eDN5dFao';
const APP_SERVER_KEY = 'BJQz3w9ft1Eti87gUeqV-izXo7bwjYTCKlCIsc2CM_1XyBEElm7qiK_X8PcxoD311mTE7zeXpn6rFjmHeGlyAoc';
// Each person's Supabase password is derived from their PIN on the device,
// so nothing secret ships in this file. Wrong PIN = server says no.
// Accounts are created by an admin from the People panel (board-accounts function).
const OWNER_EMAIL = 'media@kwoter.co.uk';
const OWNER_USERNAME = 'louis';
const PIN_LENGTH = 4;
const KEY_STORE = 'board-key';
const BIO_STORE = 'board-bio';
const USER_STORE = 'board-user';
const PINLEN_STORE = 'board-pinlen';
const NAME_STORE = 'board-name';
const ADMIN_STORE = 'board-admin';

const emailFor = (username) => (username === OWNER_USERNAME ? OWNER_EMAIL : `${username}@field.kwoter.co.uk`);
// Devices set up before accounts existed have a key but no name: they are Louis's.
const currentUser = () => localStorage.getItem(USER_STORE) || (localStorage.getItem(KEY_STORE) ? OWNER_USERNAME : null);
const pinLength = () => Number(localStorage.getItem(PINLEN_STORE)) || PIN_LENGTH;
const displayName = () => {
  const saved = localStorage.getItem(NAME_STORE);
  if (saved) return saved;
  const user = currentUser() || '';
  return user ? user[0].toUpperCase() + user.slice(1) : '';
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };

let jobs = [];
let knownIds = new Set();
let prevCounts = { todo: -1, doing: -1, done: -1 };
let firstRender = true;
let editingId = null;
let channel = null;
let reloadTimer = null;
let unlocked = false;
let lockBusy = false;
let pinBuffer = '';
let wrongAttempts = 0;
let notesReady = false;

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* ---------- PIN lock ---------- */
const lockEl = $('#lock');
const dotsWrap = $('#pin-dots');
let pinDots = $$('.pin-dot');
const lockMsg = $('#lock-msg');
const numpadEl = $('#numpad');

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Louis keeps his original salt; everyone else is salted with their own sign-in name,
// so two people with the same PIN still have different passwords.
const derivePassword = (pin, username = currentUser()) =>
  sha256Hex(`jobs-board::${pin}::${username === OWNER_USERNAME ? 'kwoter' : username}`);

function buildDots() {
  dotsWrap.replaceChildren(...Array.from({ length: pinLength() }, () => {
    const dot = document.createElement('span');
    dot.className = 'pin-dot';
    return dot;
  }));
  pinDots = $$('.pin-dot');
}

function renderDots() {
  pinDots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

function pressKey(key) {
  if (lockBusy || unlocked) return;
  if (key === 'back') {
    pinBuffer = pinBuffer.slice(0, -1);
    renderDots();
    return;
  }
  if (key === 'bio') { bioUnlock(); return; }
  if (!/^[0-9]$/.test(key) || pinBuffer.length >= pinLength()) return;
  lockMsg.textContent = '';
  pinBuffer += key;
  renderDots();
  if (pinBuffer.length === pinLength()) submitPin();
}

numpadEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-key]');
  if (btn) pressKey(btn.dataset.key);
});

document.addEventListener('keydown', (e) => {
  if (unlocked || lockEl.hidden || lockEl.classList.contains('is-signin')) return;
  if (/^[0-9]$/.test(e.key)) pressKey(e.key);
  else if (e.key === 'Backspace') pressKey('back');
});

async function submitPin() {
  lockBusy = true;
  const derived = await derivePassword(pinBuffer);
  const stored = localStorage.getItem(KEY_STORE);
  let ok;
  if (stored) {
    ok = derived === stored;
  } else {
    // First unlock on this device: the server is the judge
    dotsWrap.classList.add('busy');
    const { error } = await supabase.auth.signInWithPassword({
      email: emailFor(currentUser()), password: derived,
    });
    dotsWrap.classList.remove('busy');
    if (error && !navigator.onLine) {
      lockMsg.textContent = 'You are offline. Connect once to set this device up.';
      pinBuffer = '';
      renderDots();
      lockBusy = false;
      return;
    }
    ok = !error;
    if (ok) localStorage.setItem(KEY_STORE, derived);
  }
  if (ok) {
    wrongAttempts = 0;
    dotsWrap.classList.add('success');
    unlockApp(derived);
  } else {
    pinFail();
  }
}

function pinFail() {
  wrongAttempts++;
  dotsWrap.classList.add('error', 'shake');
  lockMsg.textContent = 'Wrong PIN. Try again.';
  setTimeout(() => {
    dotsWrap.classList.remove('error', 'shake');
    pinBuffer = '';
    renderDots();
    if (wrongAttempts >= 3) cooldown(10 * (wrongAttempts - 2));
    else lockBusy = false;
  }, 620);
}

function cooldown(secs) {
  numpadEl.classList.add('disabled');
  let left = secs;
  lockMsg.textContent = `Too many tries. Wait ${left}s.`;
  const timer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(timer);
      numpadEl.classList.remove('disabled');
      lockMsg.textContent = '';
      lockBusy = false;
    } else {
      lockMsg.textContent = `Too many tries. Wait ${left}s.`;
    }
  }, 1000);
}

async function unlockApp(derived) {
  unlocked = true;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const { error } = await supabase.auth.signInWithPassword({
      email: emailFor(currentUser()), password: derived,
    });
    if (error && navigator.onLine) {
      // Stored key no longer matches the server: ask for the PIN fresh
      localStorage.removeItem(KEY_STORE);
      lockEl.classList.remove('is-resuming');
      unlocked = false;
      lockBusy = false;
      dotsWrap.classList.remove('success');
      pinBuffer = '';
      renderDots();
      lockMsg.textContent = 'PIN has changed. Enter the new one.';
      return;
    }
  }
  startApp();
}

function startApp() {
  paintGreeting();
  loadProfile();
  $('#hero-date').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  loadJobs();
  subscribeRealtime();
  initBell();
  if (!notesReady) {
    initNotes({ supabase, toast });
    notesReady = true;
  }
  $('#app-view').hidden = false;
  lockEl.classList.add('is-open');
  setTimeout(() => { lockEl.hidden = true; }, 460);
  requestAnimationFrame(() => setActiveTab(0));
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = displayName();
  return name ? `${part}, ${name}` : part;
}

function paintGreeting() {
  const g = $('#hero-greeting');
  g.textContent = greeting();
  const dot = document.createElement('span');
  dot.className = 'wordmark-dot';
  dot.textContent = '.';
  g.appendChild(dot);
}

// Name and admin flag come from the server; the cached copy only keeps the greeting
// right offline. The People panel is enforced server-side, not by this flag.
async function loadProfile() {
  $('#people-btn').hidden = false;
  const { data, error } = await supabase
    .from('board_profiles')
    .select('username, display_name, is_admin, pin_length')
    .maybeSingle();
  if (error || !data) return;
  localStorage.setItem(USER_STORE, data.username);
  localStorage.setItem(NAME_STORE, data.display_name);
  localStorage.setItem(ADMIN_STORE, data.is_admin ? 'yes' : 'no');
  paintGreeting();
}

// If the session ever drops mid-use, quietly sign back in with the device key.
supabase.auth.onAuthStateChange((_event, session) => {
  if (!session && unlocked) {
    const key = localStorage.getItem(KEY_STORE);
    if (key) supabase.auth.signInWithPassword({ email: emailFor(currentUser()), password: key });
  }
});

/* ---------- Face ID / Touch ID (WebAuthn platform authenticator) ---------- */
const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64ToBuf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function bioAvailable() {
  try {
    return !!window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

function showSignIn(show) {
  lockEl.classList.toggle('is-signin', show);
  $('#signin').hidden = !show;
  $('#switch-user').hidden = show;
  $('#lock-title').textContent = show ? 'Sign in' : (displayName() ? `Hello ${displayName()}, enter your PIN` : 'Enter your PIN');
  if (show) setTimeout(() => $('#signin-name').focus(), 60);
}

$('#signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lockBusy) return;
  const username = $('#signin-name').value.trim().toLowerCase();
  const pin = $('#signin-pin').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,23}$/.test(username)) { lockMsg.textContent = 'Use the sign-in name you were given, e.g. andy.'; return; }
  if (!/^[0-9]{4,8}$/.test(pin)) { lockMsg.textContent = 'Your PIN is 4 to 8 digits.'; return; }
  lockBusy = true;
  lockMsg.textContent = '';
  $('#signin-go').classList.add('is-loading');
  const derived = await derivePassword(pin, username);
  const { error } = await supabase.auth.signInWithPassword({ email: emailFor(username), password: derived });
  $('#signin-go').classList.remove('is-loading');
  if (error) {
    lockBusy = false;
    lockMsg.textContent = navigator.onLine ? 'That name and PIN do not match.' : 'You are offline. Connect once to sign in.';
    $('#signin-pin').value = '';
    return;
  }
  localStorage.setItem(USER_STORE, username);
  localStorage.setItem(KEY_STORE, derived);
  localStorage.setItem(PINLEN_STORE, String(pin.length));
  localStorage.removeItem(NAME_STORE);
  localStorage.removeItem(ADMIN_STORE);
  $('#signin-pin').value = '';
  unlockApp(derived);
});

// Hand the device to someone else: this device stops getting the old person's reminders,
// and nothing of theirs is left behind.
async function signOutDevice({ reload = false } = {}) {
  if (lockBusy) return;
  if (!confirm(`Sign ${displayName() || 'this person'} out of this device?`)) return;
  lockBusy = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      const key = localStorage.getItem(KEY_STORE);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session && key) await supabase.auth.signInWithPassword({ email: emailFor(currentUser()), password: key });
      await supabase.from('board_push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* best effort: the server drops dead endpoints anyway */ }
  await supabase.auth.signOut().catch(() => {});
  [KEY_STORE, BIO_STORE, USER_STORE, PINLEN_STORE, NAME_STORE, ADMIN_STORE].forEach((k) => localStorage.removeItem(k));
  if (reload) { location.reload(); return; }
  $('#bio-key').classList.add('is-ghost');
  pinBuffer = '';
  lockMsg.textContent = '';
  lockBusy = false;
  showSignIn(true);
}
$('#switch-user').addEventListener('click', () => signOutDevice());

async function initLock() {
  buildDots();
  showSignIn(!currentUser());
  // Stay signed in (Louis, 21 Sep 2026): once a device has signed in it opens straight into
  // the app. The PIN is only asked for again after Sign out or if the PIN was changed.
  const key = localStorage.getItem(KEY_STORE);
  if (currentUser() && key) {
    lockEl.classList.add('is-resuming');
    unlockApp(key);
  }
  if (localStorage.getItem(BIO_STORE) && localStorage.getItem(KEY_STORE) && await bioAvailable()) {
    $('#bio-key').classList.remove('is-ghost');
  }
}

async function bioUnlock() {
  const credId = localStorage.getItem(BIO_STORE);
  const key = localStorage.getItem(KEY_STORE);
  if (!credId || !key) return;
  lockBusy = true;
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: b64ToBuf(credId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    dotsWrap.classList.add('success');
    pinDots.forEach((d) => d.classList.add('filled'));
    unlockApp(key);
  } catch {
    lockBusy = false;
    lockMsg.textContent = 'Face ID was cancelled. Use your PIN.';
  }
}

async function maybeOfferBio() {
  if (localStorage.getItem(BIO_STORE)) return;
  if (!(await bioAvailable())) return;
  $('#bio-prompt').hidden = false;
}

$('#bio-enable').addEventListener('click', async () => {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Jobs Board', id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: currentUser() || 'field',
          displayName: displayName() || 'Field',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
      },
    });
    localStorage.setItem(BIO_STORE, bufToB64(cred.rawId));
    $('#bio-prompt').hidden = true;
    toast('Face ID enabled for this device');
  } catch {
    toast('Could not set up Face ID');
  }
});
$('#bio-dismiss').addEventListener('click', () => { $('#bio-prompt').hidden = true; });

/* ---------- Data ---------- */
async function loadJobs() {
  const { data, error } = await supabase
    .from('board_jobs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { toast('Could not load jobs'); return; }
  jobs = data ?? [];
  render();
}

function subscribeRealtime() {
  if (channel) return;
  channel = supabase
    .channel('board-jobs')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board_jobs' }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadJobs, 120);
    })
    .subscribe();
}

/* ---------- Render ---------- */
function sortJobs(list) {
  return [...list].sort((a, b) => {
    const ad = a.due_at ? Date.parse(a.due_at) : Infinity;
    const bd = b.due_at ? Date.parse(b.due_at) : Infinity;
    if (ad !== bd) return ad - bd;
    const ap = PRIORITY_WEIGHT[a.priority] ?? 1;
    const bp = PRIORITY_WEIGHT[b.priority] ?? 1;
    if (ap !== bp) return ap - bp;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

function render() {
  const finePointer = matchMedia('(pointer: fine)').matches;
  const animate = !firstRender && !reducedMotion();

  // FLIP: remember where every card sits before the rebuild
  const before = new Map();
  if (animate) {
    $$('.card').forEach((el) => before.set(el.dataset.id, el.getBoundingClientRect()));
  }

  for (const status of STATUSES) {
    const col = $(`.cards[data-col="${status}"]`);
    const list = sortJobs(jobs.filter((j) => j.status === status));
    col.replaceChildren();
    list.forEach((job, i) => {
      const el = cardEl(job, finePointer);
      if (!knownIds.has(job.id)) {
        el.classList.add('is-new');
        el.style.animationDelay = firstRender ? `${Math.min(i * 45, 360)}ms` : '0ms';
      }
      col.appendChild(el);
    });
    const column = col.closest('.column');
    $('.empty', column).hidden = list.length > 0;
    $$(`.count[data-count="${status}"]`).forEach((c) => {
      c.textContent = list.length;
      if (prevCounts[status] !== -1 && prevCounts[status] !== list.length) {
        c.classList.remove('pop');
        requestAnimationFrame(() => c.classList.add('pop'));
      }
    });
    prevCounts[status] = list.length;
  }

  // FLIP: glide moved cards from their old spot to the new one
  if (animate) {
    $$('.card').forEach((el) => {
      const a = before.get(el.dataset.id);
      if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx || dy) {
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 340, easing: 'cubic-bezier(0.32, 0.72, 0.24, 1)' }
        );
      }
    });
  }

  renderStats();
  renderHero();
  knownIds = new Set(jobs.map((j) => j.id));
  firstRender = false;
}

function renderHero() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);
  const open = jobs.filter((j) => j.status !== 'done');
  const doneToday = jobs.filter((j) =>
    j.status === 'done' && j.completed_at && new Date(j.completed_at) >= startOfDay
  );
  const onPlateToday = open.filter((j) => j.due_at && new Date(j.due_at) < endOfDay);

  // Progress ring: today's workload
  const total = doneToday.length + onPlateToday.length;
  const ring = $('#ring');
  if (!total) {
    ring.hidden = true;
  } else {
    ring.hidden = false;
    const C = 2 * Math.PI * 27;
    const frac = doneToday.length / total;
    const fill = $('#ring-fill');
    fill.style.strokeDashoffset = `${C * (1 - Math.max(0.015, frac))}`;
    $('#ring-num').textContent = `${doneToday.length}/${total}`;
  }

  // Up next: the most urgent open job
  const next = sortJobs(open)[0];
  const wrap = $('#upnext');
  wrap.replaceChildren();
  wrap.hidden = !next;
  if (next) wrap.appendChild(upnextCard(next));
}

function upnextCard(job) {
  const card = document.createElement('div');
  card.className = 'upnext-card';

  const info = document.createElement('div');
  info.className = 'upnext-info';

  const label = document.createElement('span');
  label.className = 'upnext-label';
  label.innerHTML = '<span class="pulse-dot"></span>Up next';

  const title = document.createElement('h3');
  title.className = 'upnext-title';
  title.textContent = job.title;

  const meta = document.createElement('p');
  meta.className = 'upnext-meta';
  if (job.client) {
    const c = document.createElement('span');
    c.textContent = job.client;
    meta.appendChild(c);
  }
  if (job.due_at) {
    if (job.client) meta.appendChild(document.createTextNode('·'));
    const { label: dueText, cls } = dueInfo(job.due_at, job.status);
    const d = document.createElement('span');
    d.className = cls;
    d.textContent = dueText;
    meta.appendChild(d);
  }

  info.append(label, title);
  if (meta.children.length) info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'upnext-actions';
  if (job.status === 'todo') {
    const startBtn = document.createElement('button');
    startBtn.className = 'upnext-start';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      updateJob(job.id, { status: 'doing' });
      toast('Moved to Doing');
    });
    actions.appendChild(startBtn);
  }
  const doneBtn = document.createElement('button');
  doneBtn.className = 'upnext-done';
  doneBtn.setAttribute('aria-label', 'Mark as done');
  doneBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  doneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = doneBtn.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2);
    updateJob(job.id, { status: 'done' });
  });
  actions.appendChild(doneBtn);

  card.append(info, actions);
  card.addEventListener('click', () => openSheet(job));
  return card;
}

/* ---------- Completion burst ---------- */
function burst(x, y) {
  if (reducedMotion()) return;
  const colours = ['#34D399', '#4D8DFF', '#FBBF24'];
  for (let i = 0; i < 11; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = colours[i % colours.length];
    document.body.appendChild(p);
    const ang = Math.random() * Math.PI * 2;
    const dist = 26 + Math.random() * 30;
    p.animate(
      [
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(0.15)`, opacity: 0 },
      ],
      { duration: 540 + Math.random() * 240, easing: 'cubic-bezier(0.16, 0.84, 0.44, 1)' }
    ).onfinish = () => p.remove();
  }
}

function renderStats() {
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const open = jobs.filter((j) => j.status !== 'done');
  const overdue = open.filter((j) => j.due_at && new Date(j.due_at) < now);
  const dueToday = open.filter((j) => {
    if (!j.due_at) return false;
    const d = new Date(j.due_at);
    return d >= now && d < endOfDay;
  });

  const stats = $('#stats');
  stats.replaceChildren();
  const add = (cls, n, label, dot) => {
    const el = document.createElement('span');
    el.className = `stat ${cls}`.trim();
    if (dot) {
      const d = document.createElement('span');
      d.className = `status-dot ${dot}`;
      el.appendChild(d);
    }
    const strong = document.createElement('strong');
    strong.textContent = n;
    el.append(strong, document.createTextNode(` ${label}`));
    stats.appendChild(el);
  };
  if (open.length) add('', open.length, open.length === 1 ? 'open job' : 'open jobs', 'dot-todo');
  if (dueToday.length) add('stat-amber', dueToday.length, 'due today');
  if (overdue.length) add('stat-red', overdue.length, 'overdue');
}

function cardEl(job, draggable) {
  const el = document.createElement('article');
  el.className = `card prio-${job.priority}${job.status === 'done' ? ' is-done' : ''}`;
  el.dataset.id = job.id;

  const btn = document.createElement('button');
  btn.className = 'complete-btn';
  btn.setAttribute('aria-label', job.status === 'done' ? 'Mark as not done' : 'Mark as done');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDone(job, el, btn);
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = job.title;
  body.appendChild(title);

  if (job.notes) {
    const notes = document.createElement('p');
    notes.className = 'card-notes';
    notes.textContent = job.notes;
    body.appendChild(notes);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (job.priority === 'high') meta.appendChild(chip('High', 'flag', 'flag-high'));
  if (job.priority === 'low') meta.appendChild(chip('Low', 'flag', 'flag-low'));
  if (job.client) meta.appendChild(chip(job.client, 'tag'));
  if (job.due_at) {
    const { label, cls } = dueInfo(job.due_at, job.status);
    meta.appendChild(chip(label, 'clock', cls));
  }
  if (job.remind_at && !job.reminded_at && job.status !== 'done') {
    meta.appendChild(chip(remindLabel(job), 'bell', 'bell-chip'));
  }
  if (meta.children.length) body.appendChild(meta);

  el.append(btn, body);
  el.addEventListener('click', () => openSheet(job));

  if (draggable && job.status !== 'done') {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', job.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  }
  return el;
}

const ICONS = {
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  tag: '<path d="M20.59 13.41 12 22 2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

function chip(text, icon, cls = '') {
  const span = document.createElement('span');
  span.className = `chip ${cls}`.trim();
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`;
  span.appendChild(document.createTextNode(text));
  return span;
}

function dueInfo(iso, status) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round((startOf(d) - startOf(now)) / 86400000);
  const diffMs = d - now;
  let label;
  if (status !== 'done' && diffMs > 0 && diffMs < 3600000) label = `in ${Math.max(1, Math.round(diffMs / 60000))} min`;
  else if (dayDiff === 0) label = `Today ${time}`;
  else if (dayDiff === 1) label = `Tomorrow ${time}`;
  else label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + (time !== '00:00' ? ` ${time}` : '');
  let cls = '';
  if (status !== 'done') {
    if (d < now) cls = 'due-overdue';
    else if (dayDiff === 0) cls = 'due-today';
  }
  if (cls === 'due-overdue') label = `Overdue · ${label}`;
  return { label, cls };
}

function remindLabel(job) {
  const diffMin = Math.round((Date.parse(job.due_at) - Date.parse(job.remind_at)) / 60000);
  if (diffMin <= 0) return 'Reminder set';
  if (diffMin < 60) return `Reminds ${diffMin}m before`;
  if (diffMin < 1440) return `Reminds ${Math.round(diffMin / 60)}h before`;
  return `Reminds ${Math.round(diffMin / 1440)}d before`;
}

/* ---------- Complete toggle ---------- */
async function toggleDone(job, el, btn) {
  if (job.status === 'done') {
    await updateJob(job.id, { status: 'todo' });
    return;
  }
  btn.classList.add('is-ticked');
  const r = btn.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2);
  el.classList.add('is-leaving');
  setTimeout(() => updateJob(job.id, { status: 'done' }), 340);
}

async function updateJob(id, patch) {
  const local = jobs.find((j) => j.id === id);
  if (patch.status === 'done' && local?.status !== 'done') {
    patch.completed_at = new Date().toISOString();
  } else if (patch.status && patch.status !== 'done') {
    patch.completed_at = null;
  }
  if (local) Object.assign(local, patch);
  render();
  const { error } = await supabase.from('board_jobs').update(patch).eq('id', id);
  if (error) { toast('Could not save that'); loadJobs(); }
}

/* ---------- Sheet ---------- */
const sheet = $('#sheet');
const backdrop = $('#sheet-backdrop');
const deleteBtn = $('#delete-btn');
let deleteArmed = null;

function segValue(id) {
  return $(`#${id} button.is-active`)?.dataset.value;
}
function setSeg(id, value) {
  $$(`#${id} button`).forEach((b) => b.classList.toggle('is-active', b.dataset.value === value));
}
$$('.segmented').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) setSeg(seg.id, btn.dataset.value);
  });
});

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSheet(job = null) {
  editingId = job?.id ?? null;
  $('#sheet-title').textContent = job ? 'Edit job' : 'New job';
  $('#f-title').value = job?.title ?? '';
  $('#f-client').value = job?.client ?? '';
  $('#f-notes').value = job?.notes ?? '';
  $('#f-due').value = job?.due_at ? toLocalInput(job.due_at) : '';
  setSeg('f-priority', job?.priority ?? 'normal');
  setSeg('f-status', job?.status ?? 'todo');
  deleteBtn.hidden = !job;
  disarmDelete();
  syncRemindSelect();
  if (job?.remind_at && job?.due_at) {
    const diff = Math.round((Date.parse(job.due_at) - Date.parse(job.remind_at)) / 60000);
    const options = ['0', '15', '60', '1440'];
    $('#f-remind').value = options.includes(String(diff)) ? String(diff) : '0';
  } else {
    $('#f-remind').value = '';
  }
  sheet.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add('is-open');
    backdrop.classList.add('is-open');
  });
  if (!job) setTimeout(() => $('#f-title').focus({ preventScroll: true }), 380);
}

function closeSheet() {
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 360);
}

function syncRemindSelect() {
  const remind = $('#f-remind');
  remind.disabled = !$('#f-due').value;
  if (remind.disabled) remind.value = '';
}
$('#f-due').addEventListener('input', syncRemindSelect);

$('#fab').addEventListener('click', () => openSheet());
$('#add-desktop').addEventListener('click', () => openSheet());
$('#sheet-close').addEventListener('click', closeSheet);
backdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});

$('#job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#f-title').value.trim();
  if (!title) { $('#f-title').focus(); return; }

  const dueVal = $('#f-due').value;
  const remindVal = $('#f-remind').value;
  const due = dueVal ? new Date(dueVal) : null;
  let remindAt = null;
  if (due && remindVal !== '') {
    remindAt = new Date(due.getTime() - Number(remindVal) * 60000).toISOString();
  }

  const record = {
    title,
    client: $('#f-client').value.trim() || null,
    notes: $('#f-notes').value.trim() || null,
    due_at: due ? due.toISOString() : null,
    remind_at: remindAt,
    priority: segValue('f-priority') ?? 'normal',
    status: segValue('f-status') ?? 'todo',
  };
  if (remindAt && Date.parse(remindAt) > Date.now()) record.reminded_at = null;

  const original = editingId ? jobs.find((j) => j.id === editingId) : null;
  if (record.status === 'done' && original?.status !== 'done') {
    record.completed_at = new Date().toISOString();
  } else if (record.status !== 'done') {
    record.completed_at = null;
  }

  const btn = $('#save-btn');
  btn.classList.add('is-loading');
  let error;
  if (editingId) {
    ({ error } = await supabase.from('board_jobs').update(record).eq('id', editingId));
  } else {
    ({ error } = await supabase.from('board_jobs').insert(record));
  }
  btn.classList.remove('is-loading');
  if (error) { toast('Could not save that'); return; }
  closeSheet();
  toast(editingId ? 'Job updated' : 'Job added');
  loadJobs();
});

function disarmDelete() {
  deleteBtn.classList.remove('confirm');
  deleteBtn.textContent = 'Delete job';
  clearTimeout(deleteArmed);
  deleteArmed = null;
}

deleteBtn.addEventListener('click', async () => {
  if (!deleteBtn.classList.contains('confirm')) {
    deleteBtn.classList.add('confirm');
    deleteBtn.textContent = 'Tap again to delete';
    deleteArmed = setTimeout(disarmDelete, 2600);
    return;
  }
  disarmDelete();
  const id = editingId;
  closeSheet();
  jobs = jobs.filter((j) => j.id !== id);
  render();
  const { error } = await supabase.from('board_jobs').delete().eq('id', id);
  if (error) { toast('Could not delete that'); loadJobs(); }
  else toast('Job deleted');
});

/* ---------- Tabs + swipe ---------- */
const board = $('#board');
const tabs = $$('.tab');
const indicator = $('#tab-indicator');

function setActiveTab(idx) {
  tabs.forEach((t, i) => t.classList.toggle('is-active', i === idx));
  const tab = tabs[idx];
  indicator.style.left = `${tab.offsetLeft}px`;
  indicator.style.width = `${tab.offsetWidth}px`;
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => {
    setActiveTab(i);
    board.scrollTo({
      left: i * board.clientWidth,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  });
});

let scrollTimer = null;
board.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const idx = Math.round(board.scrollLeft / board.clientWidth);
    setActiveTab(Math.max(0, Math.min(2, idx)));
  }, 80);
}, { passive: true });

window.addEventListener('resize', () => {
  const idx = tabs.findIndex((t) => t.classList.contains('is-active'));
  if (idx >= 0) setActiveTab(idx);
});

/* ---------- Drag and drop (desktop) ---------- */
$$('.cards').forEach((col) => {
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('drop-hint');
  });
  col.addEventListener('dragleave', () => col.classList.remove('drop-hint'));
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('drop-hint');
    const id = e.dataTransfer.getData('text/plain');
    const status = col.dataset.col;
    const job = jobs.find((j) => j.id === id);
    if (job && job.status !== status) updateJob(id, { status });
  });
});

/* ---------- Push notifications ---------- */
const bellBtn = $('#bell-btn');

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function setBell(on) {
  bellBtn.classList.toggle('is-on', on);
  bellBtn.setAttribute('aria-pressed', String(on));
}

async function initBell() {
  if (!pushSupported()) { setBell(false); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setBell(!!sub && Notification.permission === 'granted');
  } catch { setBell(false); }
}

function urlB64ToUint8(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

bellBtn.addEventListener('click', async () => {
  if (!pushSupported()) {
    toast(isIOS() && !isStandalone()
      ? 'Add this to your Home Screen first: Share, then Add to Home Screen'
      : 'Notifications are not supported in this browser');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === 'granted') {
      await supabase.from('board_push_subscriptions').delete().eq('endpoint', existing.endpoint);
      await existing.unsubscribe();
      setBell(false);
      toast('Notifications off on this device');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were blocked'); return; }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(APP_SERVER_KEY),
    });
    const j = sub.toJSON();
    const { error } = await supabase.from('board_push_subscriptions').upsert({
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      device: navigator.userAgent.slice(0, 160),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    setBell(true);
    toast('Notifications on for this device');
  } catch (err) {
    console.error(err);
    toast('Could not enable notifications');
  }
});

/* ---------- People (admin only; the server checks, this is just the screen) ---------- */
const peoplePanel = $('#people-panel');
const personMsg = $('#person-msg');
let resetTarget = null;

async function accounts(body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/board-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || out.message || 'Something went wrong');
  return out;
}

function personRow(person, me) {
  const row = document.createElement('div');
  row.className = 'person-row';
  const avatar = document.createElement('span');
  avatar.className = 'person-avatar';
  avatar.textContent = (person.display_name[0] || '?').toUpperCase();
  const who = document.createElement('div');
  who.className = 'person-who';
  const name = document.createElement('strong');
  name.textContent = person.display_name;
  if (person.user_id === me || person.is_admin) {
    const tag = document.createElement('span');
    tag.className = 'person-tag';
    tag.textContent = person.user_id === me ? 'You' : 'Admin';
    name.append(tag);
  }
  const detail = document.createElement('span');
  detail.textContent = `Signs in as "${person.username}" · ${person.pin_length}-digit PIN`;
  who.append(name, detail);
  row.append(avatar, who);
  if (person.user_id !== me && !person.is_admin) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.textContent = 'New PIN';
    pin.addEventListener('click', () => setResetMode(person));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${person.display_name}? This deletes ALL of their jobs and notes for good.`)) return;
      try { await accounts({ action: 'remove', user_id: person.user_id }); toast(`${person.display_name} removed`); loadPeople(); }
      catch (err) { personMsg.textContent = err.message; }
    });
    row.append(pin, remove);
  }
  return row;
}

async function loadPeople() {
  const list = $('#people-list');
  try {
    const { people, me } = await accounts({ action: 'list' });
    list.replaceChildren(...people.map((person) => personRow(person, me)));
  } catch (err) {
    list.textContent = err.message;
  }
}

function setResetMode(person) {
  resetTarget = person;
  $('#person-form-title').textContent = person ? `New PIN for ${person.display_name}` : 'Add a person';
  $('#person-save').textContent = person ? 'Save new PIN' : 'Create account';
  $('#person-cancel').hidden = !person;
  $('#person-name').value = person ? person.display_name : '';
  $('#person-username').value = person ? person.username : '';
  $('#person-username').dataset.touched = person ? 'yes' : '';
  [$('#person-name'), $('#person-username')].forEach((input) => input.closest('.field').classList.toggle('is-locked', !!person));
  $('#person-pin').value = '';
  personMsg.textContent = '';
  if (person) $('#person-pin').focus();
}

$('#people-btn').addEventListener('click', () => {
  const isAdmin = localStorage.getItem(ADMIN_STORE) === 'yes';
  $$('.admin-only', peoplePanel).forEach((el) => { el.hidden = !isAdmin; });
  $('#people-title').textContent = isAdmin ? 'People' : 'Account';
  $('#account-avatar').textContent = (displayName()[0] || '?').toUpperCase();
  $('#account-name').textContent = displayName();
  $('#account-detail').textContent = `Signed in as "${currentUser()}" on this device`;
  peoplePanel.hidden = false;
  if (isAdmin) { setResetMode(null); loadPeople(); }
});
$('#sign-out').addEventListener('click', () => signOutDevice({ reload: true }));
$('#people-close').addEventListener('click', () => { peoplePanel.hidden = true; });
peoplePanel.addEventListener('click', (event) => { if (event.target === peoplePanel) peoplePanel.hidden = true; });
$('#person-cancel').addEventListener('click', () => setResetMode(null));
$('#person-username').addEventListener('input', (event) => { event.target.dataset.touched = 'yes'; });
$('#person-name').addEventListener('input', (event) => {
  const field = $('#person-username');
  if (field.dataset.touched === 'yes') return;
  field.value = event.target.value.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9._-]/g, '').slice(0, 24);
});

$('#person-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#person-name').value.trim();
  const username = $('#person-username').value.trim().toLowerCase();
  const pin = $('#person-pin').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,23}$/.test(username)) { personMsg.textContent = 'Sign-in name: 2 to 24 letters or numbers, no spaces.'; return; }
  if (!/^[0-9]{4,8}$/.test(pin)) { personMsg.textContent = 'The PIN must be 4 to 8 digits.'; return; }
  const save = $('#person-save');
  save.classList.add('is-loading');
  personMsg.textContent = '';
  try {
    const password = await derivePassword(pin, username);
    if (resetTarget) {
      await accounts({ action: 'reset_pin', user_id: resetTarget.user_id, password, pin_length: pin.length });
      const who = resetTarget.display_name;
      setResetMode(null);
      personMsg.textContent = `Done. On ${who}'s device: tap "Not you? Switch account" on the PIN screen, then sign in with the new PIN.`;
    } else {
      await accounts({ action: 'create', display_name: name, username, password, pin_length: pin.length });
      setResetMode(null);
      personMsg.textContent = `Done. ${name} opens kwoter.github.io/job-board and signs in as "${username}" with that PIN.`;
      toast(`${name}'s account is ready`);
    }
    loadPeople();
  } catch (err) {
    personMsg.textContent = err.message;
  } finally {
    save.classList.remove('is-loading');
  }
});

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 260);
  }, 3200);
}

// Keep countdown chips and the ring honest as time passes
setInterval(() => {
  if (unlocked && !document.hidden) render();
}, 60000);

initLock();
