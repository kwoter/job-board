import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const SUPABASE_URL = 'https://kmxhcvmxeoqglpshzuns.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtteGhjdm14ZW9xZ2xwc2h6dW5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzODg0MTIsImV4cCI6MjA5NTk2NDQxMn0.-Nm_KAabbu9FQTql81blTmULPivBUnzwXa_eDN5dFao';
const APP_SERVER_KEY = 'BJQz3w9ft1Eti87gUeqV-izXo7bwjYTCKlCIsc2CM_1XyBEElm7qiK_X8PcxoD311mTE7zeXpn6rFjmHeGlyAoc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };

let jobs = [];
let knownIds = new Set();
let firstRender = true;
let editingId = null;
let channel = null;
let reloadTimer = null;

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* ---------- Auth ---------- */
async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  setAuthed(!!session);
  supabase.auth.onAuthStateChange((_event, s) => setAuthed(!!s));
}

function setAuthed(on) {
  $('#login-view').hidden = on;
  $('#app-view').hidden = !on;
  if (on) {
    $('#header-date').textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    loadJobs();
    subscribeRealtime();
    initBell();
  } else if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const errEl = $('#login-error');
  errEl.hidden = true;
  btn.classList.add('is-loading');
  const { error } = await supabase.auth.signInWithPassword({
    email: $('#login-email').value.trim(),
    password: $('#login-password').value,
  });
  btn.classList.remove('is-loading');
  if (error) {
    errEl.textContent = 'That did not work. Check the password and try again.';
    errEl.hidden = false;
    $('.login-card').classList.remove('shake');
    requestAnimationFrame(() => $('.login-card').classList.add('shake'));
  }
});

$('#logout-btn').addEventListener('click', () => supabase.auth.signOut());

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
  for (const status of STATUSES) {
    const col = $(`.cards[data-col="${status}"]`);
    const list = sortJobs(jobs.filter((j) => j.status === status));
    col.replaceChildren();
    list.forEach((job, i) => {
      const el = cardEl(job, finePointer);
      if (!knownIds.has(job.id)) {
        el.classList.add('is-new');
        el.style.animationDelay = firstRender ? `${Math.min(i * 40, 320)}ms` : '0ms';
      }
      col.appendChild(el);
    });
    const column = col.closest('.column');
    $('.empty', column).hidden = list.length > 0;
    $$(`.count[data-count="${status}"]`).forEach((c) => { c.textContent = list.length; });
  }
  knownIds = new Set(jobs.map((j) => j.id));
  firstRender = false;
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
  let label;
  if (dayDiff === 0) label = `Today ${time}`;
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
  el.classList.add('is-leaving');
  setTimeout(() => updateJob(job.id, { status: 'done' }), 320);
}

async function updateJob(id, patch) {
  const local = jobs.find((j) => j.id === id);
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
  if (!job) setTimeout(() => $('#f-title').focus({ preventScroll: true }), 360);
}

function closeSheet() {
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 340);
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
    reminded_at: remindAt && Date.parse(remindAt) > Date.now() ? null : undefined,
    priority: segValue('f-priority') ?? 'normal',
    status: segValue('f-status') ?? 'todo',
  };
  if (record.reminded_at === undefined) delete record.reminded_at;

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
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
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
requestAnimationFrame(() => setActiveTab(0));

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

init();
