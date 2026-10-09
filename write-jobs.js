// "Write a list" on the New job sheet: write jobs with the Pencil, the page is
// read (Claude via board-read-jobs, Tesseract on the device as a fallback),
// each job gets its own row to check, and they are all added to To Do at once.

const $ = (s, el = document) => el.querySelector(s);
const MODE_STORE = 'field-new-job-mode';

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = reject;
    document.head.append(script);
  });
}

export function splitJobLines(text) {
  const heading = /^(jobs?|tasks?|to[ -]?do(?: list)?)\s*:?[\s]*$/i;
  const marker = /^\s*(?:[-–—*•·]|(?:\d+|[a-z])[.)]|\[[ x✓]?\])\s*/i;
  const seen = new Set();
  return String(text || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*[;•]\s*/))
    .map((line) => line.replace(marker, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1 && !heading.test(line))
    .filter((line) => {
      const key = line.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Returns { jobs, by } where by is 'claude' or 'device'. Throws if neither can read it.
export async function readJobsFromImage({ supabase, url, anon, dataUrl, onProgress }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${url}/functions/v1/board-read-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ image: dataUrl }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(out.jobs)) return { jobs: out.jobs, by: 'claude' };
  } catch { /* offline or reader down: fall through to the device */ }
  const Tesseract = await loadTesseract();
  const result = await Tesseract.recognize(dataUrl, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(Math.round((m.progress || 0) * 100)); },
  });
  return { jobs: splitJobLines(result?.data?.text), by: 'device' };
}

export function initWriteJobs({ supabase, url, anon, toast, onAdded }) {
  const form = $('#job-form');
  const panel = $('#write-panel');
  const modeBar = $('#sheet-mode');
  const wrap = $('#write-pad');
  const canvas = $('#write-canvas');
  const ctx = canvas.getContext('2d');
  const status = $('#write-status');
  const review = $('#write-review');
  const list = $('#write-list');
  const readBtn = $('#write-read');
  const addBtn = $('#write-add');

  let strokes = [];
  let current = null;
  let penSeen = false;
  let penUpAt = 0;

  const inkColour = () => getComputedStyle(wrap).getPropertyValue('--ink').trim() || '#EDF2FB';

  function size() {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function drawStroke(c, stroke, colour, scale = 1, dx = 0, dy = 0) {
    const pts = stroke.points;
    c.strokeStyle = colour;
    c.fillStyle = colour;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (pts.length === 1) {
      c.beginPath();
      c.arc((pts[0].x - dx) * scale, (pts[0].y - dy) * scale, 1.6 * scale, 0, Math.PI * 2);
      c.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      c.lineWidth = (1.6 + 2.2 * (b.p || 0.5)) * scale;
      c.beginPath();
      c.moveTo((a.x - dx) * scale, (a.y - dy) * scale);
      c.lineTo((b.x - dx) * scale, (b.y - dy) * scale);
      c.stroke();
    }
  }

  function paint() {
    const rect = wrap.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const colour = inkColour();
    strokes.forEach((s) => drawStroke(ctx, s, colour));
    if (current) drawStroke(ctx, current, colour);
    wrap.classList.toggle('has-ink', strokes.length > 0 || !!current);
    readBtn.disabled = !strokes.length;
  }

  function point(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: e.pointerType === 'pen' ? e.pressure : 0.5 };
  }

  // Once the Pencil has been used, a lone finger or resting palm doesn't draw.
  const ignore = (e) => e.pointerType === 'touch' && (penSeen || Date.now() - penUpAt < 400);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (ignore(e) || current) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic ids */ }
    current = { id: e.pointerId, points: [point(e)] };
    wrap.classList.add('has-ink');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== current.id) return;
    const events = e.getCoalescedEvents?.() || [];
    const from = current.points.length - 1;
    (events.length ? events : [e]).forEach((ev) => current.points.push(point(ev)));
    // Only the new segments; a full repaint happens on undo, clear and resize.
    drawStroke(ctx, { points: current.points.slice(from) }, inkColour());
  });
  const finish = (e) => {
    if (!current || e.pointerId !== current.id) return;
    if (e.pointerType === 'pen') penUpAt = Date.now();
    strokes.push({ points: current.points });
    if (current.points.length === 1) drawStroke(ctx, current, inkColour());
    current = null;
    hideReview();
    wrap.classList.add('has-ink');
    readBtn.disabled = false;
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  ['touchstart', 'touchmove', 'gesturestart', 'selectstart'].forEach((t) =>
    canvas.addEventListener(t, (e) => e.preventDefault(), { passive: false }));

  $('#write-undo').addEventListener('click', () => { strokes.pop(); hideReview(); paint(); });
  $('#write-clear').addEventListener('click', () => { clearPad(); });

  function clearPad() {
    strokes = [];
    current = null;
    status.textContent = '';
    hideReview();
    paint();
  }

  // Black ink on white, cropped to the writing, which is what readers do best with.
  function pageImage() {
    const all = strokes.flatMap((s) => s.points);
    const pad = 24;
    const minX = Math.min(...all.map((p) => p.x)) - pad;
    const minY = Math.min(...all.map((p) => p.y)) - pad;
    const maxX = Math.max(...all.map((p) => p.x)) + pad;
    const maxY = Math.max(...all.map((p) => p.y)) + pad;
    const scale = Math.min(2, 1600 / Math.max(maxX - minX, maxY - minY));
    const out = document.createElement('canvas');
    out.width = Math.ceil((maxX - minX) * scale);
    out.height = Math.ceil((maxY - minY) * scale);
    const c = out.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, out.width, out.height);
    strokes.forEach((s) => drawStroke(c, s, '#111', scale, minX, minY));
    return out.toDataURL('image/png');
  }

  function row(text) {
    const item = document.createElement('label');
    item.className = 'write-item';
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = true;
    tick.addEventListener('change', countChecked);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = text;
    input.autocomplete = 'off';
    input.addEventListener('input', countChecked);
    item.append(tick, input);
    return item;
  }

  function chosen() {
    return [...list.querySelectorAll('.write-item')]
      .filter((item) => item.querySelector('input[type=checkbox]').checked)
      .map((item) => item.querySelector('input[type=text]').value.trim())
      .filter(Boolean);
  }

  function countChecked() {
    const n = chosen().length;
    $('.btn-label', addBtn).textContent = n ? `Add ${n} ${n === 1 ? 'job' : 'jobs'} to To Do` : 'Nothing ticked';
    addBtn.disabled = !n;
  }

  function hideReview() {
    review.hidden = true;
    list.replaceChildren();
  }

  readBtn.addEventListener('click', async () => {
    if (!strokes.length) return;
    readBtn.classList.add('is-loading');
    status.textContent = 'Reading your list…';
    try {
      const { jobs, by } = await readJobsFromImage({
        supabase, url, anon, dataUrl: pageImage(),
        onProgress: (n) => { status.textContent = `Reading on this iPad… ${n}%`; },
      });
      list.replaceChildren(...(jobs.length ? jobs : ['']).map(row));
      review.hidden = false;
      countChecked();
      status.textContent = jobs.length
        ? `Found ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}. Fix any words, untick any you don't want.`
        : 'I could not make out a job. Type it in below, or write it bigger and read again.';
      if (by === 'device' && jobs.length) status.textContent += ' (Read on the iPad, so check the spelling.)';
      review.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      status.textContent = 'I could not read that. Check you are online and try again.';
    } finally {
      readBtn.classList.remove('is-loading');
    }
  });

  $('#write-more').addEventListener('click', () => {
    const item = row('');
    list.append(item);
    countChecked();
    $('input[type=text]', item).focus();
  });

  addBtn.addEventListener('click', async () => {
    const titles = chosen();
    if (!titles.length) return;
    addBtn.classList.add('is-loading');
    // The board shows newest first, so the first line written gets the latest time.
    const now = Date.now();
    const { error } = await supabase.from('board_jobs').insert(titles.map((title, i) => ({
      created_at: new Date(now + (titles.length - i) * 1000).toISOString(),
      title: title.slice(0, 140),
      client: null,
      notes: null,
      due_at: null,
      remind_at: null,
      priority: 'normal',
      status: 'todo',
      completed_at: null,
    })));
    addBtn.classList.remove('is-loading');
    if (error) { toast('Could not add those jobs'); return; }
    toast(`${titles.length} ${titles.length === 1 ? 'job' : 'jobs'} added to To Do`);
    clearPad();
    onAdded?.();
  });

  function setMode(mode) {
    const write = mode === 'write';
    form.hidden = write;
    panel.hidden = !write;
    modeBar.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    localStorage.setItem(MODE_STORE, mode);
    if (write) requestAnimationFrame(size);
  }
  modeBar.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-mode]');
    if (button) setMode(button.dataset.mode);
  });
  window.addEventListener('resize', () => { if (!panel.hidden) size(); });

  // Called by openSheet. Editing a job is always the typed form.
  return function prepare(isNew) {
    modeBar.hidden = !isNew;
    if (!isNew) { form.hidden = false; panel.hidden = true; return; }
    const tablet = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) >= 700;
    setMode(localStorage.getItem(MODE_STORE) || (tablet ? 'write' : 'type'));
    return !panel.hidden;
  };
}
