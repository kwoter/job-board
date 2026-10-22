// "Write a list" on the New job sheet: ruled lines you write straight into with the
// Pencil (iPadOS Scribble turns it into text as you go), one job per line, all added at once.
// The handwriting readers below are for Notes ("Add to jobs" reads a drawn page). Best first: the pen strokes line by line (Google's handwriting
// recogniser, the one behind its handwriting keyboard: free, no key), then
// Claude on a picture (board-read-jobs), then Tesseract on the device (weak on
// handwriting, it is what produced the random symbols, so it is only the last resort).

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

const HANDWRITING_URL = 'https://inputtools.google.com/request?itc=en-t-i0-handwrit&app=field';

// Strokes are [{ points: [{ x, y, t? }] }]. Groups them into written lines by height on
// the page, so each line is read on its own and becomes its own job.
export function groupLines(strokes) {
  const boxes = strokes
    .filter((s) => s.points?.length)
    .map((s) => {
      const ys = s.points.map((p) => p.y);
      const xs = s.points.map((p) => p.x);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return { s, top, bottom, left: Math.min(...xs), mid: (top + bottom) / 2, h: bottom - top };
    });
  if (!boxes.length) return [];
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const typical = Math.max(8, heights[Math.floor(heights.length * 0.6)]);
  const small = (b) => b.h < typical * 0.35;
  const lines = [];
  // Letters first, then dots and dashes go to whichever line they sit nearest.
  for (const b of boxes.filter((x) => !small(x)).sort((a, z) => a.mid - z.mid)) {
    const line = lines.find((l) => b.mid > l.top - typical * 0.15 && b.mid < l.bottom + typical * 0.15
      && Math.min(b.bottom, l.bottom) - Math.max(b.top, l.top) > Math.min(b.h, l.bottom - l.top) * 0.3);
    if (line) {
      line.items.push(b);
      line.top = Math.min(line.top, b.top);
      line.bottom = Math.max(line.bottom, b.bottom);
    } else {
      lines.push({ top: b.top, bottom: b.bottom, items: [b] });
    }
  }
  // A cross-bar or capital can open a line before its letters arrive: fold overlapping lines together.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlap > Math.min(a.bottom - a.top, b.bottom - b.top) * 0.5) {
        a.items.push(...b.items);
        a.top = Math.min(a.top, b.top);
        a.bottom = Math.max(a.bottom, b.bottom);
        lines.splice(j, 1);
        j = i;
      }
    }
  }
  for (const b of boxes.filter(small)) {
    if (!lines.length) { lines.push({ top: b.top, bottom: b.bottom, items: [b] }); continue; }
    const dist = (l) => (b.mid < l.top ? l.top - b.mid : b.mid > l.bottom ? b.mid - l.bottom : 0);
    lines.reduce((best, l) => (dist(l) < dist(best) ? l : best)).items.push(b);
  }
  return lines
    .sort((a, b) => a.top - b.top)
    .map((l) => l.items.sort((a, b) => a.left - b.left).map((b) => b.s));
}

async function readLine(strokes) {
  const all = strokes.flatMap((s) => s.points);
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  // Real pen timings help the reader; if they're missing or flat (notes, replays), make up a steady pace.
  const times = all.map((p) => p.t).filter((t) => t != null);
  const timed = times.length === all.length && Math.max(...times) - Math.min(...times) >= all.length;
  const t0 = timed ? Math.min(...times) : 0;
  let clock = 0;
  const ink = strokes.map((s) => {
    if (!timed) clock += 120;
    return [
      s.points.map((p) => Math.round(p.x - minX)),
      s.points.map((p) => Math.round(p.y - minY)),
      s.points.map((p) => (timed ? Math.round(p.t - t0) : (clock += 10))),
    ];
  });
  const width = Math.max(...all.map((p) => p.x)) - minX;
  const height = Math.max(...all.map((p) => p.y)) - minY;
  const res = await fetch(HANDWRITING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      options: 'enable_pre_space',
      requests: [{ writing_guide: { writing_area_width: Math.round(width + 20), writing_area_height: Math.round(height + 20) }, ink, language: 'en' }],
    }),
  });
  const out = await res.json();
  if (out?.[0] !== 'SUCCESS') throw new Error('handwriting reader refused');
  return out[1]?.[0]?.[1]?.[0] ?? '';
}

export async function readJobsFromStrokes(strokes) {
  const lines = groupLines(strokes);
  const texts = await Promise.all(lines.map(readLine));
  return splitJobLines(texts.join('\n'));
}

// Returns { jobs, by } where by is 'pen', 'claude' or 'device'. Throws if none can read it.
export async function readJobsFromImage({ supabase, url, anon, dataUrl, strokes, onProgress }) {
  if (strokes?.length) {
    try {
      const jobs = await readJobsFromStrokes(strokes);
      if (jobs.length) return { jobs, by: 'pen' };
    } catch { /* offline or reader down: try the picture */ }
  }
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

export function initWriteJobs({ supabase, toast, listOwner, onAdded }) {
  const form = $('#job-form');
  const panel = $('#write-panel');
  const modeBar = $('#sheet-mode');
  const list = $('#write-list');
  const addBtn = $('#write-add');

  const inputs = () => [...list.querySelectorAll('input')];
  const titles = () => inputs().map((i) => i.value.trim()).filter(Boolean);

  function line(value = '') {
    const row = document.createElement('label');
    row.className = 'write-line';
    const n = document.createElement('span');
    n.className = 'write-num';
    n.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = 140;
    input.autocomplete = 'off';
    input.enterKeyHint = 'next';
    input.setAttribute('aria-label', 'Job');
    input.addEventListener('input', () => { grow(); count(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const all = inputs();
        const next = all[all.indexOf(input) + 1] || list.appendChild(line()).querySelector('input');
        next.focus();
      } else if (e.key === 'Backspace' && !input.value && inputs().length > 3) {
        e.preventDefault();
        const all = inputs();
        const prev = all[all.indexOf(input) - 1];
        row.remove();
        prev?.focus();
        count();
      }
    });
    row.append(n, input);
    return row;
  }

  // Always keep a blank line or two under the last thing written, so the Pencil has somewhere to go.
  function grow() {
    const all = inputs();
    const lastFilled = all.map((i) => !!i.value.trim()).lastIndexOf(true);
    for (let k = all.length; k < Math.max(5, lastFilled + 3); k++) list.append(line());
  }

  function count() {
    const n = titles().length;
    $('.btn-label', addBtn).textContent = n ? `Add ${n} ${n === 1 ? 'job' : 'jobs'}` : 'Add jobs';
    addBtn.disabled = !n;
  }

  function reset() {
    list.replaceChildren();
    grow();
    count();
  }

  addBtn.addEventListener('click', async () => {
    const chosen = titles();
    if (!chosen.length) return;
    addBtn.classList.add('is-loading');
    // Each new job goes on top of the list, so insert bottom line first and the list
    // lands in the order it was written.
    const now = Date.now();
    const owner = listOwner?.();
    const { error } = await supabase.from('board_jobs').insert(chosen.map((title, i) => ({
      ...(owner ? { user_id: owner } : {}),
      created_at: new Date(now + (chosen.length - i) * 1000).toISOString(),
      title: title.slice(0, 140),
      priority: 'normal',
      status: 'todo',
    })).reverse());
    addBtn.classList.remove('is-loading');
    if (error) { toast('Could not add those jobs'); return; }
    toast(`${chosen.length} ${chosen.length === 1 ? 'job' : 'jobs'} added`);
    reset();
    onAdded?.();
  });

  function setMode(mode) {
    const write = mode === 'write';
    form.hidden = write;
    panel.hidden = !write;
    modeBar.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    localStorage.setItem(MODE_STORE, mode);
  }
  modeBar.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-mode]');
    if (button) setMode(button.dataset.mode);
  });

  // Called by openSheet. Editing a job is always the detailed form.
  return function prepare(isNew) {
    modeBar.hidden = !isNew;
    if (!isNew) { form.hidden = false; panel.hidden = true; return false; }
    if (!titles().length) reset();
    const tablet = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) >= 700;
    setMode(localStorage.getItem(MODE_STORE) || (tablet ? 'write' : 'type'));
    return !panel.hidden;
  };
}
