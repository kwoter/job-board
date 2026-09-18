const DRAWING_VERSION = 2;
const DEFAULT_DRAWING = () => ({ version: DRAWING_VERSION, strokes: [], view: { x: 0, y: 0, zoom: 1 }, theme: 'light', job_id: null });
const MIN_ZOOM = .05;
const MAX_ZOOM = 8;

export function initNotes({ supabase, toast }) {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const jobsScreen = $('#jobs-screen');
  const notesScreen = $('#notes-screen');
  const editor = $('#note-editor');
  const canvas = $('#ink-canvas');
  const paper = $('#paper');
  const ctx = canvas.getContext('2d', { alpha: true });
  const grid = $('#notes-grid');
  const syncLabel = $('#notes-sync-label');
  const saveState = $('#note-save-state');

  let notes = [];
  let active = null;
  let strokes = [];
  let redoStack = [];
  let currentStroke = null;
  let tool = 'fountain';
  let colour = '#162034';
  let size = 4;
  let saveTimer = null;
  let resizeFrame = null;
  let channel = null;
  let loaded = false;
  let camera = { x: 0, y: 0, zoom: 1 };
  let drawingPointerId = null;
  const touchPointers = new Map();
  let panGesture = null;
  let pinchGesture = null;
  let paperTheme = 'light';
  let linkedJobId = null;
  let previousInkTool = 'fountain';
  let lastPencilTap = null;
  let touchGesture = null;
  let spaceHeld = false;
  let mousePan = null;

  const toolPreset = {
    fountain: { width: 1, opacity: 1, composite: 'source-over' },
    pencil: { width: .7, opacity: .48, composite: 'source-over' },
    marker: { width: 2.8, opacity: .9, composite: 'source-over' },
    highlighter: { width: 5.4, opacity: .28, composite: 'multiply' },
    eraser: { width: 7, opacity: 1, composite: 'destination-out' },
  };

  function switchScreen(name) {
    const isNotes = name === 'notes';
    jobsScreen.hidden = isNotes;
    notesScreen.hidden = !isNotes;
    document.body.classList.toggle('notes-active', isNotes);
    $$('.app-switch').forEach((button) => {
      const selected = button.dataset.screen === name;
      button.classList.toggle('is-active', selected);
      button.toggleAttribute('aria-current', selected);
    });
    if (isNotes && !loaded) loadNotes();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('.app-switch').forEach((button) => button.addEventListener('click', () => switchScreen(button.dataset.screen)));

  async function loadNotes() {
    syncLabel.textContent = 'Syncing…';
    const { data, error } = await supabase
      .from('board_notes')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) {
      syncLabel.textContent = 'Offline — saved pages remain on this device';
      if (!loaded) notes = readLocalIndex();
      renderLibrary();
      return;
    }
    notes = data ?? [];
    loaded = true;
    syncLabel.textContent = `${notes.length} ${notes.length === 1 ? 'page' : 'pages'} · synced`;
    writeLocalIndex(notes);
    renderLibrary();
  }

  function subscribeNotes() {
    if (channel) return;
    channel = supabase
      .channel('board-notes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_notes' }, () => {
        if (!active) setTimeout(loadNotes, 120);
      })
      .subscribe();
  }

  function readLocalIndex() {
    try { return JSON.parse(localStorage.getItem('field-notes-cache') || '[]'); } catch { return []; }
  }

  function writeLocalIndex(list) {
    try { localStorage.setItem('field-notes-cache', JSON.stringify(list.slice(0, 30))); } catch { /* storage can be full */ }
  }

  function drawingFor(note) {
    const drawing = note?.drawing;
    if (drawing && Array.isArray(drawing.strokes)) return drawing;
    return DEFAULT_DRAWING();
  }

  function migrateDrawing(drawing) {
    const copy = structuredClone(drawing || DEFAULT_DRAWING());
    if ((copy.version || 1) < 2) {
      copy.strokes = (copy.strokes || []).map((stroke) => ({
        ...stroke,
        points: (stroke.points || []).map((point) => ({ ...point, x: point.x * 1200, y: point.y * 1600 })),
      }));
      copy.view = { x: 0, y: 0, zoom: .55 };
      copy.version = 2;
    }
    copy.view ||= { x: 0, y: 0, zoom: 1 };
    copy.theme = copy.theme === 'dark' ? 'dark' : 'light';
    copy.job_id ||= null;
    return copy;
  }

  function relativeDate(value) {
    const date = new Date(value || Date.now());
    const diff = Date.now() - date.getTime();
    if (diff < 60_000) return 'Just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function renderLibrary() {
    grid.replaceChildren();
    const add = document.createElement('button');
    add.className = 'note-card-new';
    add.innerHTML = '<span>＋</span><strong>Start a fresh page</strong>';
    add.addEventListener('click', createNote);
    grid.append(add);

    notes.forEach((note) => {
      const card = document.createElement('button');
      card.className = 'note-card';
      card.dataset.id = note.id;

      const drawing = migrateDrawing(drawingFor(note));
      const preview = document.createElement('div');
      preview.className = `note-preview paper-${note.page_style || 'dot'} paper-theme-${drawing.theme}`;
      const mini = document.createElement('canvas');
      preview.append(mini);

      if (note.clean_text?.trim()) {
        const badge = document.createElement('span');
        badge.className = 'clean-badge';
        badge.title = 'Has a clean typed copy';
        badge.textContent = 'Aa';
        preview.append(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'note-card-meta';
      const title = document.createElement('strong');
      title.textContent = note.title || 'Untitled note';
      const updated = document.createElement('span');
      const strokeCount = drawingFor(note).strokes.filter((stroke) => stroke.tool !== 'scratch-erase').length;
      updated.textContent = `${strokeCount} strokes · ${relativeDate(note.updated_at)}`;
      meta.append(title, updated);
      card.append(preview, meta);
      card.addEventListener('click', () => openNote(note));
      grid.append(card);
      requestAnimationFrame(() => drawThumbnail(mini, drawing));
    });
  }

  async function createNote() {
    const now = new Date().toISOString();
    const { data: { user } } = await supabase.auth.getUser();
    const note = {
      id: crypto.randomUUID(),
      user_id: user?.id,
      title: 'Untitled note',
      drawing: DEFAULT_DRAWING(),
      clean_text: '',
      page_style: 'dot',
      created_at: now,
      updated_at: now,
    };
    notes.unshift(note);
    renderLibrary();
    openNote(note);
    const { error } = await supabase.from('board_notes').insert(note);
    if (error) {
      saveLocal(note);
      setSaveState('error', 'Saved on device');
    }
  }

  function openNote(note) {
    active = structuredClone(note);
    const drawing = migrateDrawing(drawingFor(note));
    strokes = drawing.strokes;
    camera = {
      x: Number(drawing.view?.x) || 0,
      y: Number(drawing.view?.y) || 0,
      zoom: clamp(Number(drawing.view?.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    };
    paperTheme = drawing.theme;
    linkedJobId = drawing.job_id;
    redoStack = [];
    $('#note-title').value = active.title || 'Untitled note';
    $('#clean-text').value = active.clean_text || '';
    setPaper(active.page_style || 'dot', false);
    setPaperTheme(paperTheme, false);
    updateJobButton();
    updateHistoryButtons();
    editor.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(resizeCanvas);
    setSaveState('', 'Saved');
  }

  async function closeNote() {
    clearTimeout(saveTimer);
    if (active) await saveActive();
    active = null;
    currentStroke = null;
    editor.hidden = true;
    $('#note-menu').hidden = true;
    document.body.style.overflow = '';
    await loadNotes();
  }

  function setSaveState(kind, label) {
    saveState.classList.toggle('is-saving', kind === 'saving');
    saveState.classList.toggle('is-error', kind === 'error');
    saveState.lastChild.textContent = ` ${label}`;
  }

  function scheduleSave() {
    if (!active) return;
    setSaveState('saving', 'Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveActive, 650);
  }

  async function saveActive() {
    if (!active) return;
    active.title = $('#note-title').value.trim() || 'Untitled note';
    active.drawing = { version: DRAWING_VERSION, strokes, view: camera, theme: paperTheme, job_id: linkedJobId };
    active.clean_text = $('#clean-text').value;
    active.updated_at = new Date().toISOString();
    saveLocal(active);
    const record = {
      id: active.id,
      user_id: active.user_id,
      title: active.title,
      drawing: active.drawing,
      clean_text: active.clean_text,
      page_style: active.page_style || 'dot',
      created_at: active.created_at,
      updated_at: active.updated_at,
    };
    const { error } = await supabase.from('board_notes').upsert(record);
    if (error) {
      setSaveState('error', 'On device');
      return;
    }
    setSaveState('', 'Saved');
    const index = notes.findIndex((note) => note.id === active.id);
    if (index >= 0) notes[index] = structuredClone(active);
    else notes.unshift(structuredClone(active));
    writeLocalIndex(notes);
  }

  function saveLocal(note) {
    try {
      localStorage.setItem(`field-note-${note.id}`, JSON.stringify(note));
      const index = notes.findIndex((item) => item.id === note.id);
      if (index >= 0) notes[index] = structuredClone(note);
      else notes.unshift(structuredClone(note));
      writeLocalIndex(notes);
    } catch { /* cloud save will still be attempted */ }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function resizeCanvas() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      redraw();
    });
  }

  function screenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function worldPoint(event) {
    const point = screenPoint(event);
    return {
      x: camera.x + point.x / camera.zoom,
      y: camera.y + point.y / camera.zoom,
      p: event.pressure > 0 ? event.pressure : .5,
    };
  }

  function beginPointer(event) {
    const barrelErase = event.pointerType === 'pen' && (event.button === 2 || event.button === 5);
    if (event.button !== undefined && event.button !== 0 && !barrelErase) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    if (event.pointerType === 'touch') {
      const point = screenPoint(event);
      touchPointers.set(event.pointerId, point);
      if (!touchGesture) touchGesture = { startedAt: performance.now(), maxTouches: 1, moved: false, starts: new Map() };
      touchGesture.maxTouches = Math.max(touchGesture.maxTouches, touchPointers.size);
      touchGesture.starts.set(event.pointerId, point);
      if (touchPointers.size === 1) {
        panGesture = { start: point, camera: { ...camera } };
        pinchGesture = null;
      } else if (touchPointers.size >= 2) {
        startPinch();
      }
      return;
    }
    if (event.pointerType === 'mouse' && spaceHeld) {
      mousePan = { pointerId: event.pointerId, start: screenPoint(event), camera: { ...camera } };
      return;
    }
    if (barrelErase) setTool('eraser');
    drawingPointerId = event.pointerId;
    currentStroke = {
      tool,
      colour: tool === 'eraser' ? '#000000' : colour,
      size,
      startedAt: performance.now(),
      points: [worldPoint(event)],
    };
    redoStack = [];
    $('#pencil-hint').hidden = true;
  }

  function movePointer(event) {
    if (event.pointerType === 'touch') {
      if (!touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      const nextPoint = screenPoint(event);
      touchPointers.set(event.pointerId, nextPoint);
      const touchStart = touchGesture?.starts.get(event.pointerId);
      if (touchStart && pointDistance(touchStart, nextPoint) > 12) touchGesture.moved = true;
      if (touchPointers.size >= 2 && pinchGesture) {
        const [a, b] = [...touchPointers.values()];
        const centre = midpoint(a, b);
        const distance = pointDistance(a, b);
        const zoom = clamp(pinchGesture.zoom * distance / Math.max(1, pinchGesture.distance), MIN_ZOOM, MAX_ZOOM);
        camera.zoom = zoom;
        camera.x = pinchGesture.anchor.x - centre.x / zoom;
        camera.y = pinchGesture.anchor.y - centre.y / zoom;
        redraw();
      } else if (touchPointers.size === 1 && panGesture) {
        const point = [...touchPointers.values()][0];
        camera.x = panGesture.camera.x - (point.x - panGesture.start.x) / camera.zoom;
        camera.y = panGesture.camera.y - (point.y - panGesture.start.y) / camera.zoom;
        redraw();
      }
      return;
    }
    if (mousePan?.pointerId === event.pointerId) {
      const point = screenPoint(event);
      camera.x = mousePan.camera.x - (point.x - mousePan.start.x) / camera.zoom;
      camera.y = mousePan.camera.y - (point.y - mousePan.start.y) / camera.zoom;
      redraw();
      return;
    }
    if (!currentStroke || event.pointerId !== drawingPointerId) return;
    event.preventDefault();
    const events = event.getCoalescedEvents?.() || [event];
    for (const item of events) {
      const point = worldPoint(item);
      const previous = currentStroke.points[currentStroke.points.length - 1];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if ((dx * dx) + (dy * dy) > .18) currentStroke.points.push(point);
    }
    redraw(currentStroke);
  }

  function endPointer(event) {
    if (event.pointerType === 'touch') {
      if (!touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      touchPointers.delete(event.pointerId);
      if (touchPointers.size >= 2) {
        startPinch();
      } else if (touchPointers.size === 1) {
        const point = [...touchPointers.values()][0];
        panGesture = { start: point, camera: { ...camera } };
        pinchGesture = null;
      } else if (touchPointers.size === 0) {
        panGesture = null;
        pinchGesture = null;
        const gesture = touchGesture;
        touchGesture = null;
        if (gesture && !gesture.moved && performance.now() - gesture.startedAt < 420 && gesture.maxTouches === 2) {
          undo();
          toast('Undo');
        } else if (gesture && !gesture.moved && performance.now() - gesture.startedAt < 420 && gesture.maxTouches >= 3) {
          redo();
          toast('Redo');
        } else {
          scheduleSave();
        }
      }
      return;
    }
    if (mousePan?.pointerId === event.pointerId) {
      mousePan = null;
      scheduleSave();
      return;
    }
    if (!currentStroke || event.pointerId !== drawingPointerId) return;
    event.preventDefault();
    if (currentStroke.points.length === 1) {
      const point = currentStroke.points[0];
      currentStroke.points.push({ ...point, x: point.x + .5 / camera.zoom });
    }
    const finishedStroke = currentStroke;
    currentStroke = null;
    drawingPointerId = null;
    const isPencilTap = event.pointerType === 'pen' && isTinyStroke(finishedStroke);
    if (isPencilTap && lastPencilTap
      && performance.now() - lastPencilTap.time < 380
      && pointDistance(screenPoint(event), lastPencilTap.screen) < 34) {
      const index = strokes.indexOf(lastPencilTap.stroke);
      if (index >= 0) strokes.splice(index, 1);
      lastPencilTap = null;
      toggleEraserShortcut();
      redraw();
      updateHistoryButtons();
      scheduleSave();
      return;
    }
    const savedStroke = { ...finishedStroke };
    delete savedStroke.startedAt;
    if (isPencilTap) {
      strokes.push(savedStroke);
      lastPencilTap = { time: performance.now(), screen: screenPoint(event), stroke: savedStroke };
    } else {
      lastPencilTap = null;
      const erased = finishedStroke.tool !== 'eraser' && isScratchGesture(finishedStroke)
        ? eraseUnderScratch(finishedStroke)
        : [];
      if (erased.length) {
        strokes.push({ tool: 'scratch-erase', points: [], removed: erased });
        toast(`Erased ${erased.length} ${erased.length === 1 ? 'stroke' : 'strokes'}`);
      }
      else strokes.push(savedStroke);
    }
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function strokeMetrics(stroke) {
    const points = stroke.points || [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let length = 0;
    let reversals = 0;
    let lastDirection = 0;
    const directionThreshold = 3 / camera.zoom;
    points.forEach((point, index) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      if (!index) return;
      const previous = points[index - 1];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      length += Math.hypot(dx, dy);
      if (Math.abs(dx) > directionThreshold) {
        const direction = Math.sign(dx);
        if (lastDirection && direction !== lastDirection) reversals++;
        lastDirection = direction;
      }
    });
    return { minX, minY, maxX, maxY, length, reversals };
  }

  function isTinyStroke(stroke) {
    const metrics = strokeMetrics(stroke);
    return metrics.length < 9 / camera.zoom
      && performance.now() - (stroke.startedAt || 0) < 300;
  }

  function isScratchGesture(stroke) {
    if ((stroke.points || []).length < 10) return false;
    const metrics = strokeMetrics(stroke);
    const width = metrics.maxX - metrics.minX;
    const height = metrics.maxY - metrics.minY;
    const diagonal = Math.hypot(width, height);
    const duration = performance.now() - (stroke.startedAt || 0);
    return duration < 1500
      && metrics.reversals >= 3
      && width > 24 / camera.zoom
      && metrics.length > diagonal * 3.1;
  }

  function eraseUnderScratch(scratch) {
    const metrics = strokeMetrics(scratch);
    const padding = 14 / camera.zoom;
    const box = {
      minX: metrics.minX - padding,
      minY: metrics.minY - padding,
      maxX: metrics.maxX + padding,
      maxY: metrics.maxY + padding,
    };
    const erased = [];
    strokes = strokes.filter((stroke) => {
      if (stroke.tool === 'eraser' || stroke.tool === 'scratch-erase') return true;
      const hit = (stroke.points || []).some((point, index, points) => {
        if (point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY) return true;
        if (!index) return false;
        const previous = points[index - 1];
        return Math.max(previous.x, point.x) >= box.minX
          && Math.min(previous.x, point.x) <= box.maxX
          && Math.max(previous.y, point.y) >= box.minY
          && Math.min(previous.y, point.y) <= box.maxY;
      });
      if (hit) erased.push(stroke);
      return !hit;
    });
    return erased;
  }

  function toggleEraserShortcut() {
    const nextTool = tool === 'eraser' ? previousInkTool : 'eraser';
    setTool(nextTool);
    toast(nextTool === 'eraser' ? 'Eraser selected' : `${nextTool[0].toUpperCase()}${nextTool.slice(1)} selected`);
  }

  function startPinch() {
    const [a, b] = [...touchPointers.values()];
    const centre = midpoint(a, b);
    pinchGesture = {
      distance: pointDistance(a, b),
      zoom: camera.zoom,
      anchor: { x: camera.x + centre.x / camera.zoom, y: camera.y + centre.y / camera.zoom },
    };
    panGesture = null;
  }

  function setZoom(nextZoom, anchor = null, save = true) {
    const rect = canvas.getBoundingClientRect();
    const point = anchor || { x: rect.width / 2, y: rect.height / 2 };
    const world = { x: camera.x + point.x / camera.zoom, y: camera.y + point.y / camera.zoom };
    camera.zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    camera.x = world.x - point.x / camera.zoom;
    camera.y = world.y - point.y / camera.zoom;
    redraw();
    if (save) scheduleSave();
  }

  function redraw(liveStroke = null) {
    const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const map = (point) => ({
      x: (point.x - camera.x) * camera.zoom * dpr,
      y: (point.y - camera.y) * camera.zoom * dpr,
    });
    const strokeScale = camera.zoom * dpr;
    strokes.forEach((stroke) => paintStroke(ctx, stroke, map, strokeScale));
    if (liveStroke) paintStroke(ctx, liveStroke, map, strokeScale);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    updatePaperGrid();
    $('#zoom-level').textContent = `${Math.round(camera.zoom * 100)}%`;
  }

  function paintStroke(target, stroke, map, strokeScale = 1, displayTheme = paperTheme) {
    const preset = toolPreset[stroke.tool] || toolPreset.fountain;
    const points = stroke.points || [];
    if (points.length < 2) return;
    target.save();
    target.globalCompositeOperation = preset.composite;
    target.globalAlpha = preset.opacity;
    let strokeColour = stroke.colour || '#162034';
    if (displayTheme === 'dark' && strokeColour.toUpperCase() === '#162034') strokeColour = '#F3F4F6';
    if (displayTheme === 'light' && strokeColour.toUpperCase() === '#F3F4F6') strokeColour = '#162034';
    target.strokeStyle = strokeColour;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    const base = Math.max(.55, Number(stroke.size || 4) * preset.width * strokeScale);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const from = map(a);
      const to = map(b);
      const pressure = stroke.tool === 'highlighter' || stroke.tool === 'marker'
        ? 1
        : Math.max(.45, ((a.p || .5) + (b.p || .5)) / 2);
      target.lineWidth = Math.max(.55, base * (.6 + pressure * .8));
      target.beginPath();
      target.moveTo(from.x, from.y);
      target.lineTo(to.x, to.y);
      target.stroke();
    }
    if (stroke.tool === 'pencil') {
      target.globalAlpha = .17;
      target.lineWidth = Math.max(.45, base * .42);
      const first = map(points[0]);
      target.beginPath();
      target.moveTo(first.x + strokeScale, first.y);
      points.slice(1).forEach((point) => {
        const mapped = map(point);
        target.lineTo(mapped.x + strokeScale, mapped.y);
      });
      target.stroke();
    }
    target.restore();
  }

  function updatePaperGrid() {
    const fineGrid = camera.zoom >= .28;
    const spacing = (fineGrid ? 22 : 110) * camera.zoom;
    if (active?.page_style === 'dot') {
      paper.style.backgroundSize = `${spacing}px ${spacing}px`;
      paper.style.backgroundPosition = `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`;
    } else if (active?.page_style === 'ruled') {
      const ruledSpacing = 32 * camera.zoom;
      paper.style.backgroundSize = `100% ${ruledSpacing}px`;
      paper.style.backgroundPosition = `0 ${-camera.y * camera.zoom}px`;
    } else {
      paper.style.backgroundSize = '';
      paper.style.backgroundPosition = '';
    }
  }

  function contentBounds(items = strokes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of items) {
      if (stroke.tool === 'eraser') continue;
      for (const point of stroke.points || []) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1200, maxY: 1600 };
    return { minX, minY, maxX, maxY };
  }

  function fitDrawing() {
    const rect = canvas.getBoundingClientRect();
    const bounds = contentBounds();
    const width = Math.max(240, bounds.maxX - bounds.minX);
    const height = Math.max(320, bounds.maxY - bounds.minY);
    camera.zoom = clamp(Math.min((rect.width - 80) / width, (rect.height - 80) / height), MIN_ZOOM, 1.5);
    camera.x = (bounds.minX + bounds.maxX) / 2 - rect.width / (2 * camera.zoom);
    camera.y = (bounds.minY + bounds.maxY) / 2 - rect.height / (2 * camera.zoom);
    redraw();
    scheduleSave();
  }

  function drawThumbnail(targetCanvas, drawing) {
    const migrated = migrateDrawing(drawing);
    const thumbnailStrokes = migrated.strokes;
    const rect = targetCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    targetCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    targetCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    if (!thumbnailStrokes.length) return;
    const bounds = contentBounds(thumbnailStrokes);
    const width = Math.max(100, bounds.maxX - bounds.minX);
    const height = Math.max(100, bounds.maxY - bounds.minY);
    const padding = 22 * dpr;
    const scale = Math.min((targetCanvas.width - padding * 2) / width, (targetCanvas.height - padding * 2) / height);
    const offsetX = (targetCanvas.width - width * scale) / 2 - bounds.minX * scale;
    const offsetY = (targetCanvas.height - height * scale) / 2 - bounds.minY * scale;
    const target = targetCanvas.getContext('2d');
    const map = (point) => ({ x: point.x * scale + offsetX, y: point.y * scale + offsetY });
    thumbnailStrokes.forEach((stroke) => paintStroke(target, stroke, map, scale, migrated.theme));
    target.globalCompositeOperation = 'source-over';
  }

  function updateHistoryButtons() {
    $('#note-undo').disabled = strokes.length === 0;
    $('#note-redo').disabled = redoStack.length === 0;
  }

  function undo() {
    const stroke = strokes.pop();
    if (stroke?.tool === 'scratch-erase') strokes.push(...(stroke.removed || []));
    if (stroke) redoStack.push(stroke);
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function redo() {
    const stroke = redoStack.pop();
    if (stroke?.tool === 'scratch-erase') {
      const removed = new Set(stroke.removed || []);
      strokes = strokes.filter((item) => !removed.has(item));
      strokes.push(stroke);
    } else if (stroke) {
      strokes.push(stroke);
    }
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function setTool(next) {
    if (next !== 'eraser') previousInkTool = next;
    tool = next;
    $$('.ink-tool').forEach((button) => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    if (tool === 'highlighter' && colour === '#162034') selectColour('#F3C84B');
  }

  function selectColour(next) {
    colour = next;
    $$('.ink-color').forEach((button) => button.classList.toggle('is-active', button.dataset.color.toLowerCase() === colour.toLowerCase()));
  }

  function setPaper(style, save = true) {
    if (!active) return;
    active.page_style = style;
    applyPaperClass();
    $$('.paper-style').forEach((button) => button.classList.toggle('is-active', button.dataset.paper === style));
    updatePaperGrid();
    if (save) scheduleSave();
  }

  function setPaperTheme(theme, save = true) {
    paperTheme = theme === 'dark' ? 'dark' : 'light';
    applyPaperClass();
    $$('.paper-theme').forEach((button) => button.classList.toggle('is-active', button.dataset.theme === paperTheme));
    if (paperTheme === 'dark' && colour === '#162034') selectColour('#F3F4F6');
    if (paperTheme === 'light' && colour === '#F3F4F6') selectColour('#162034');
    if (canvas.width && canvas.height) redraw();
    else updatePaperGrid();
    if (save) scheduleSave();
  }

  function applyPaperClass() {
    paper.className = `paper paper-${active?.page_style || 'dot'} paper-theme-${paperTheme}`;
  }

  function renderPage(density = 1) {
    const bounds = contentBounds();
    const padding = 120;
    const minX = bounds.minX - padding;
    const minY = bounds.minY - padding;
    const worldWidth = Math.max(500, bounds.maxX - bounds.minX + padding * 2);
    const worldHeight = Math.max(650, bounds.maxY - bounds.minY + padding * 2);
    const scale = Math.min(2 * density, (2600 * density) / Math.max(worldWidth, worldHeight));
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(worldWidth * scale));
    output.height = Math.max(1, Math.round(worldHeight * scale));
    const outputCtx = output.getContext('2d');
    const darkPaper = paperTheme === 'dark';
    const paperColour = darkPaper ? '#101722' : '#F8F6EF';
    outputCtx.fillStyle = paperColour;
    outputCtx.fillRect(0, 0, output.width, output.height);
    if (active?.page_style === 'ruled') {
      outputCtx.strokeStyle = darkPaper ? 'rgba(164, 190, 220, .18)' : 'rgba(59, 92, 126, .16)';
      outputCtx.lineWidth = Math.max(1, scale);
      const firstLine = Math.floor(minY / 32) * 32;
      for (let worldY = firstLine; worldY < minY + worldHeight; worldY += 32) {
        const y = (worldY - minY) * scale;
        outputCtx.beginPath(); outputCtx.moveTo(0, y); outputCtx.lineTo(output.width, y); outputCtx.stroke();
      }
    } else if (active?.page_style === 'dot') {
      outputCtx.fillStyle = darkPaper ? 'rgba(196, 214, 235, .24)' : 'rgba(47, 71, 95, .22)';
      const firstX = Math.floor(minX / 22) * 22;
      const firstY = Math.floor(minY / 22) * 22;
      for (let worldX = firstX; worldX < minX + worldWidth; worldX += 22) for (let worldY = firstY; worldY < minY + worldHeight; worldY += 22) {
        const x = (worldX - minX) * scale;
        const y = (worldY - minY) * scale;
        outputCtx.beginPath(); outputCtx.arc(x, y, Math.max(1, scale), 0, Math.PI * 2); outputCtx.fill();
      }
    }
    const map = (point) => ({ x: (point.x - minX) * scale, y: (point.y - minY) * scale });
    strokes.forEach((stroke) => paintStroke(outputCtx, stroke, map, scale));
    outputCtx.globalCompositeOperation = 'destination-over';
    outputCtx.fillStyle = paperColour;
    outputCtx.fillRect(0, 0, output.width, output.height);
    return output;
  }

  function exportPage() {
    const output = renderPage(1.5);
    output.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(active?.title || 'note').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'note'}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      $('#note-menu').hidden = true;
      toast('Page exported');
    }, 'image/png');
  }

  function updateJobButton() {
    const button = $('#note-add-job');
    const label = $('span', button);
    button.classList.toggle('is-added', Boolean(linkedJobId));
    label.textContent = linkedJobId ? 'View in jobs' : 'Add to jobs';
    button.setAttribute('aria-label', linkedJobId ? 'View note in jobs' : 'Add note to jobs');
  }

  async function addNoteToJobs() {
    if (!active) return;
    if (linkedJobId) {
      await closeNote();
      switchScreen('jobs');
      toast('Showing your job list');
      return;
    }
    const button = $('#note-add-job');
    button.classList.add('is-loading');
    const title = $('#note-title').value.trim() || 'Handwritten note';
    const cleanText = ($('#clean-text').value || active.clean_text || '').trim();
    const { data, error } = await supabase
      .from('board_jobs')
      .insert({
        title,
        client: null,
        notes: cleanText || 'Created from a handwritten page in Notes Studio.',
        due_at: null,
        remind_at: null,
        priority: 'normal',
        status: 'todo',
        completed_at: null,
      })
      .select('id')
      .single();
    button.classList.remove('is-loading');
    if (error || !data?.id) {
      toast('Could not add that job');
      return;
    }
    linkedJobId = data.id;
    active.clean_text = cleanText;
    await saveActive();
    updateJobButton();
    toast('Added to your To Do list');
  }

  function openCleanPanel() {
    $('#clean-text').value = active?.clean_text || '';
    $('#ocr-status').textContent = '';
    $('#clean-panel').hidden = false;
    setTimeout(() => $('#clean-text').focus(), 120);
  }

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

  async function readPage() {
    if (!strokes.length) {
      $('#ocr-status').textContent = 'Add some handwriting to the page first.';
      return;
    }
    const button = $('#read-page');
    const status = $('#ocr-status');
    button.classList.add('is-loading');
    status.textContent = 'Preparing handwriting reader…';
    try {
      const Tesseract = await loadTesseract();
      const image = renderPage(1).toDataURL('image/png');
      const result = await Tesseract.recognize(image, 'eng', {
        logger: (message) => {
          if (message.status === 'recognizing text') status.textContent = `Reading your page… ${Math.round((message.progress || 0) * 100)}%`;
        },
      });
      const text = result?.data?.text?.trim() || '';
      if (text) {
        $('#clean-text').value = text;
        status.textContent = 'Finished. Check the text, then save the clean copy.';
      } else {
        status.textContent = 'I could not read that page clearly. Try iPad Scribble in the box above.';
      }
    } catch {
      status.textContent = 'The reader could not load. You can still use Apple Pencil Scribble in the box above.';
    } finally {
      button.classList.remove('is-loading');
    }
  }

  async function deleteActive() {
    if (!active || !confirm(`Delete “${active.title || 'Untitled note'}”?`)) return;
    const id = active.id;
    const { error } = await supabase.from('board_notes').delete().eq('id', id);
    if (error && navigator.onLine) {
      toast('Could not delete that note');
      return;
    }
    localStorage.removeItem(`field-note-${id}`);
    notes = notes.filter((note) => note.id !== id);
    writeLocalIndex(notes);
    active = null;
    editor.hidden = true;
    $('#note-menu').hidden = true;
    document.body.style.overflow = '';
    renderLibrary();
    toast('Note deleted');
  }

  canvas.addEventListener('pointerdown', beginPointer);
  canvas.addEventListener('pointermove', movePointer);
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = screenPoint(event);
    if (event.ctrlKey || event.metaKey) {
      setZoom(camera.zoom * Math.exp(-event.deltaY * .008), point);
    } else {
      camera.x += event.deltaX / camera.zoom;
      camera.y += event.deltaY / camera.zoom;
      redraw();
      scheduleSave();
    }
  }, { passive: false });
  window.addEventListener('resize', resizeCanvas);
  new ResizeObserver(resizeCanvas).observe(paper);

  $$('.ink-tool').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $$('.ink-color').forEach((button) => button.addEventListener('click', () => selectColour(button.dataset.color)));
  $$('.paper-style').forEach((button) => button.addEventListener('click', () => setPaper(button.dataset.paper)));
  $$('.paper-theme').forEach((button) => button.addEventListener('click', () => setPaperTheme(button.dataset.theme)));
  $('#ink-size').addEventListener('input', (event) => { size = Number(event.target.value); });
  $('#note-title').addEventListener('input', scheduleSave);
  $('#note-back').addEventListener('click', closeNote);
  $('#note-undo').addEventListener('click', undo);
  $('#note-redo').addEventListener('click', redo);
  $('#zoom-out').addEventListener('click', () => setZoom(camera.zoom / 1.35));
  $('#zoom-in').addEventListener('click', () => setZoom(camera.zoom * 1.35));
  $('#zoom-level').addEventListener('click', fitDrawing);
  $('#new-note').addEventListener('click', createNote);
  $('#note-clean').addEventListener('click', openCleanPanel);
  $('#note-add-job').addEventListener('click', addNoteToJobs);
  $('#clean-close').addEventListener('click', () => { $('#clean-panel').hidden = true; });
  $('#clean-panel').addEventListener('click', (event) => { if (event.target.id === 'clean-panel') event.currentTarget.hidden = true; });
  $('#read-page').addEventListener('click', readPage);
  $('#copy-clean').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#clean-text').value);
    toast('Clean text copied');
  });
  $('#save-clean').addEventListener('click', async () => {
    active.clean_text = $('#clean-text').value;
    await saveActive();
    $('#clean-panel').hidden = true;
    toast('Clean copy saved');
  });
  $('#note-more').addEventListener('click', () => { $('#note-menu').hidden = !$('#note-menu').hidden; });
  $('#show-shortcuts').addEventListener('click', () => {
    $('#note-menu').hidden = true;
    $('#shortcut-panel').hidden = false;
  });
  $('#shortcut-close').addEventListener('click', () => { $('#shortcut-panel').hidden = true; });
  $('#shortcut-panel').addEventListener('click', (event) => { if (event.target.id === 'shortcut-panel') event.currentTarget.hidden = true; });
  $('#export-note').addEventListener('click', exportPage);
  $('#delete-note').addEventListener('click', deleteActive);
  document.addEventListener('pointerdown', (event) => {
    const menu = $('#note-menu');
    if (!menu.hidden && !menu.contains(event.target) && !$('#note-more').contains(event.target)) menu.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (editor.hidden || event.target.matches('input, textarea')) return;
    if (event.code === 'Space') {
      spaceHeld = true;
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'e') toggleEraserShortcut();
    else if (key === 'i') setTool('fountain');
    else if (key === 'p') setTool('pencil');
    else if (key === 'm') setTool('marker');
    else if (key === 'h') setTool('highlighter');
    else if (key === '0') fitDrawing();
    else if (key === '-' || key === '_') setZoom(camera.zoom / 1.35);
    else if (key === '+' || key === '=') setZoom(camera.zoom * 1.35);
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') spaceHeld = false;
  });
  window.addEventListener('blur', () => { spaceHeld = false; mousePan = null; });

  subscribeNotes();
}
