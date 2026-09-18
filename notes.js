const DRAWING_VERSION = 3;
const DEFAULT_DRAWING = () => ({ version: DRAWING_VERSION, strokes: [], view: { x: 0, y: 0, zoom: 1 }, theme: 'light', job_ids: [] });
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
  let linkedJobIds = [];
  let previousInkTool = 'fountain';
  let spaceHeld = false;
  let mousePan = null;
  let cacheCanvas = null;
  let cacheCtx = null;
  let cacheKey = '';
  let liveCanvas = null;
  let liveCtx = null;
  let liveDrawn = 0;
  let liveKey = '';
  let frameHandle = 0;
  let pendingLive = null;
  let inkStamp = 0;
  let paperKey = '';
  let shapeSnap = localStorage.getItem('field-shape-snap') !== 'off';
  let penDown = false;
  let lastPenAt = 0;
  let penSeen = false;
  let touchTap = null;

  const toolPreset = {
    fountain: { width: 1, opacity: 1, composite: 'source-over' },
    pencil: { width: .7, opacity: .48, composite: 'source-over' },
    marker: { width: 2.8, opacity: .9, composite: 'source-over' },
    highlighter: { width: 5.4, opacity: .28, composite: 'multiply' },
    eraser: { width: 7, opacity: 1, composite: 'destination-out' },
    fill: { width: 1, opacity: 1, composite: 'source-over' },
  };

  // A palm landing on the glass arrives as a touch pointer. While the Pencil is
  // in use — and for a moment after it lifts — touch is ignored completely.
  const PALM_GRACE_MS = 900;
  const PALM_CONTACT = 38;

  function ignoreTouch(event) {
    if (penDown || Date.now() - lastPenAt < PALM_GRACE_MS) return true;
    if (!penSeen) return false;
    return (event.width || 0) > PALM_CONTACT || (event.height || 0) > PALM_CONTACT;
  }

  function dropTouches() {
    touchPointers.clear();
    panGesture = null;
    pinchGesture = null;
    touchTap = null;
  }

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
    copy.strokes = (copy.strokes || []).flatMap((stroke) => (
      stroke.tool === 'scratch-erase' ? (stroke.removed || []) : [stroke]
    ));
    copy.job_ids = Array.isArray(copy.job_ids)
      ? copy.job_ids.filter(Boolean)
      : (copy.job_id ? [copy.job_id] : []);
    delete copy.job_id;
    copy.version = DRAWING_VERSION;
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
      const strokeCount = migrateDrawing(drawingFor(note)).strokes.filter((stroke) => stroke.tool !== 'eraser').length;
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
    inkStamp++;
    camera = {
      x: Number(drawing.view?.x) || 0,
      y: Number(drawing.view?.y) || 0,
      zoom: clamp(Number(drawing.view?.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    };
    paperTheme = drawing.theme;
    linkedJobIds = drawing.job_ids;
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
    active.drawing = { version: DRAWING_VERSION, strokes, view: camera, theme: paperTheme, job_ids: linkedJobIds };
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
    if (event.button !== undefined && event.button !== 0) return;
    if (event.pointerType === 'pen') {
      penSeen = true;
      penDown = true;
      lastPenAt = Date.now();
      if (touchPointers.size) { dropTouches(); redraw(); }
    }
    if (event.pointerType === 'touch' && ignoreTouch(event)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    if (event.pointerType === 'touch') {
      const point = screenPoint(event);
      touchPointers.set(event.pointerId, point);
      if (touchPointers.size === 1) {
        panGesture = { start: point, camera: { ...camera } };
        pinchGesture = null;
        touchTap = { pointerId: event.pointerId, start: point, at: Date.now() };
      } else if (touchPointers.size >= 2) {
        touchTap = null;
        startPinch();
      }
      return;
    }
    if (event.pointerType === 'mouse' && spaceHeld) {
      mousePan = { pointerId: event.pointerId, start: screenPoint(event), camera: { ...camera } };
      return;
    }
    if (tool === 'fill') {
      fillAt(worldPoint(event));
      return;
    }
    drawingPointerId = event.pointerId;
    currentStroke = {
      id: ++inkStamp,
      tool,
      colour: tool === 'eraser' ? '#000000' : colour,
      size,
      points: [worldPoint(event)],
    };
    redoStack = [];
  }

  function movePointer(event) {
    if (event.pointerType === 'pen') lastPenAt = Date.now();
    if (event.pointerType === 'touch') {
      if (!touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      const nextPoint = screenPoint(event);
      if (touchTap && touchTap.pointerId === event.pointerId
        && pointDistance(touchTap.start, nextPoint) > 7) touchTap = null;
      touchPointers.set(event.pointerId, nextPoint);
      if (touchPointers.size >= 2 && pinchGesture) {
        const [a, b] = [...touchPointers.values()];
        const centre = midpoint(a, b);
        const distance = pointDistance(a, b);
        const zoom = clamp(pinchGesture.zoom * distance / Math.max(1, pinchGesture.distance), MIN_ZOOM, MAX_ZOOM);
        camera.zoom = zoom;
        camera.x = pinchGesture.anchor.x - centre.x / zoom;
        camera.y = pinchGesture.anchor.y - centre.y / zoom;
        requestRedraw();
      } else if (touchPointers.size === 1 && panGesture) {
        const point = [...touchPointers.values()][0];
        camera.x = panGesture.camera.x - (point.x - panGesture.start.x) / camera.zoom;
        camera.y = panGesture.camera.y - (point.y - panGesture.start.y) / camera.zoom;
        requestRedraw();
      }
      return;
    }
    if (mousePan?.pointerId === event.pointerId) {
      const point = screenPoint(event);
      camera.x = mousePan.camera.x - (point.x - mousePan.start.x) / camera.zoom;
      camera.y = mousePan.camera.y - (point.y - mousePan.start.y) / camera.zoom;
      requestRedraw();
      return;
    }
    if (!currentStroke || event.pointerId !== drawingPointerId) return;
    event.preventDefault();
    const coalesced = event.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [event];
    for (const item of events) {
      const point = worldPoint(item);
      const previous = currentStroke.points[currentStroke.points.length - 1];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if ((dx * dx) + (dy * dy) > .18) currentStroke.points.push(point);
    }
    requestRedraw(currentStroke);
  }

  function endPointer(event) {
    if (event.pointerType === 'pen') {
      penDown = false;
      lastPenAt = Date.now();
    }
    if (event.pointerType === 'touch') {
      if (!touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      const tap = touchTap && touchTap.pointerId === event.pointerId
        && Date.now() - touchTap.at < 320
        ? touchPointers.get(event.pointerId)
        : null;
      touchPointers.delete(event.pointerId);
      const smallContact = (event.width || 0) <= PALM_CONTACT && (event.height || 0) <= PALM_CONTACT;
      if (tap && tool === 'fill' && smallContact && touchPointers.size === 0
        && Date.now() - lastPenAt > PALM_GRACE_MS) {
        touchTap = null;
        panGesture = null;
        pinchGesture = null;
        fillAt({ x: camera.x + tap.x / camera.zoom, y: camera.y + tap.y / camera.zoom });
        return;
      }
      touchTap = null;
      if (touchPointers.size >= 2) {
        startPinch();
      } else if (touchPointers.size === 1) {
        const point = [...touchPointers.values()][0];
        panGesture = { start: point, camera: { ...camera } };
        pinchGesture = null;
      } else if (touchPointers.size === 0) {
        panGesture = null;
        pinchGesture = null;
        scheduleSave();
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
    if (shapeSnap && finishedStroke.tool !== 'eraser') {
      const shape = recogniseShape(finishedStroke.points);
      if (shape) {
        finishedStroke.points = shape.points;
        finishedStroke.shape = shape.kind;
        toast(`${shape.label} tidied up`);
      }
    }
    strokes.push(finishedStroke);
    inkStamp++;
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }


  // ---- Shape tidying -----------------------------------------------------
  // Run once, when the stroke is finished. Only replaces the stroke when the
  // fit is convincing; anything ambiguous is left exactly as drawn.
  function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-9) return pointDistance(point, a);
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function ringPoints(list) {
    const ring = list.map((point) => ({ x: point.x, y: point.y, p: .62 }));
    ring.push({ ...ring[0] });
    return ring;
  }

  function ellipsePoints(centre, rx, ry) {
    const steps = Math.max(40, Math.min(120, Math.round((rx + ry) * .7)));
    const list = [];
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      list.push({ x: centre.x + Math.cos(angle) * rx, y: centre.y + Math.sin(angle) * ry });
    }
    return ringPoints(list);
  }

  function fitTriangle(points, tolerance) {
    const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
    const a = points.reduce((best, point) => (pointDistance(point, centroid) > pointDistance(best, centroid) ? point : best), points[0]);
    const b = points.reduce((best, point) => (pointDistance(point, a) > pointDistance(best, a) ? point : best), points[0]);
    const c = points.reduce((best, point) => (distanceToSegment(point, a, b) > distanceToSegment(best, a, b) ? point : best), points[0]);
    if (distanceToSegment(c, a, b) < tolerance * 1.5) return null;
    const corners = [a, b, c];
    for (const point of points) {
      const nearest = Math.min(
        distanceToSegment(point, a, b),
        distanceToSegment(point, b, c),
        distanceToSegment(point, c, a),
      );
      if (nearest > tolerance) return null;
    }
    return corners;
  }

  function recogniseShape(points) {
    if (!Array.isArray(points) || points.length < 10) return null;
    let length = 0;
    for (let i = 1; i < points.length; i++) length += pointDistance(points[i - 1], points[i]);
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const diagonal = Math.hypot(width, height);
    if (diagonal < 26 || length < 34) return null;
    if (length > diagonal * 9) return null;            // scribble, or writing
    const first = points[0];
    const last = points[points.length - 1];
    const closed = pointDistance(first, last) < Math.max(16, diagonal * .25);
    const tolerance = Math.max(4.5, diagonal * .075);

    if (!closed) {
      const span = pointDistance(first, last);
      if (span < 24 || length > span * 1.14) return null;
      let worst = 0;
      for (const point of points) worst = Math.max(worst, distanceToSegment(point, first, last));
      if (worst > Math.max(3.5, span * .05)) return null;
      return { kind: 'line', label: 'Line', points: [{ ...first, p: .62 }, { ...last, p: .62 }] };
    }

    const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const rx = width / 2;
    const ry = height / 2;
    if (rx > 9 && ry > 9) {
      let worst = 0;
      for (const point of points) {
        const nx = (point.x - centre.x) / rx;
        const ny = (point.y - centre.y) / ry;
        worst = Math.max(worst, Math.abs(Math.hypot(nx, ny) - 1));
      }
      if (worst < .17) {
        const round = Math.abs(rx - ry) < Math.max(rx, ry) * .14;
        const radius = (rx + ry) / 2;
        return {
          kind: 'ellipse',
          label: round ? 'Circle' : 'Ellipse',
          points: round ? ellipsePoints(centre, radius, radius) : ellipsePoints(centre, rx, ry),
        };
      }
    }

    if (width > 14 && height > 14) {
      const edgeTolerance = Math.max(4.5, Math.min(width, height) * .17);
      let onEdge = 0;
      for (const point of points) {
        const nearVertical = Math.min(Math.abs(point.x - minX), Math.abs(point.x - maxX)) < edgeTolerance;
        const nearHorizontal = Math.min(Math.abs(point.y - minY), Math.abs(point.y - maxY)) < edgeTolerance;
        if (nearVertical || nearHorizontal) onEdge++;
      }
      const perimeter = 2 * (width + height);
      const ratio = length / perimeter;
      if (onEdge / points.length > .9 && ratio > .8 && ratio < 1.35) {
        return {
          kind: 'rect',
          label: Math.abs(width - height) < Math.max(width, height) * .12 ? 'Square' : 'Rectangle',
          points: ringPoints([
            { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
          ]),
        };
      }
    }

    const triangle = fitTriangle(points, tolerance);
    if (triangle) return { kind: 'triangle', label: 'Triangle', points: ringPoints(triangle) };
    return null;
  }

  function setShapeSnap(next) {
    shapeSnap = next;
    localStorage.setItem('field-shape-snap', shapeSnap ? 'on' : 'off');
    const button = $('#shape-snap');
    if (button) {
      button.classList.toggle('is-active', shapeSnap);
      button.setAttribute('aria-pressed', String(shapeSnap));
    }
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
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

  function viewKey() {
    return `${camera.x.toFixed(3)}|${camera.y.toFixed(3)}|${camera.zoom.toFixed(4)}|${paperTheme}`;
  }

  function layerFor(existing, name) {
    const surface = existing || document.createElement('canvas');
    if (surface.width !== canvas.width || surface.height !== canvas.height) {
      surface.width = canvas.width;
      surface.height = canvas.height;
      if (name === 'cache') cacheKey = '';
      if (name === 'live') liveKey = '';
    }
    return surface;
  }

  // Committed ink is rendered once into a cache layer and the in-progress stroke
  // is appended to its own layer a segment at a time, so a long stroke costs the
  // same per frame as a short one.
  function redraw(liveStroke = null) {
    if (frameHandle) { cancelAnimationFrame(frameHandle); frameHandle = 0; }
    pendingLive = null;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / Math.max(1, rect.width);
    const map = (point) => ({
      x: (point.x - camera.x) * camera.zoom * dpr,
      y: (point.y - camera.y) * camera.zoom * dpr,
    });
    const strokeScale = camera.zoom * dpr;
    const view = viewKey();

    cacheCanvas = layerFor(cacheCanvas, 'cache');
    if (!cacheCtx || cacheCtx.canvas !== cacheCanvas) cacheCtx = cacheCanvas.getContext('2d');
    const nextCacheKey = `${view}|${strokes.length}|${inkStamp}`;
    if (cacheKey !== nextCacheKey) {
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      cacheCtx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
      paintStrokes(cacheCtx, strokes, map, strokeScale);
      cacheCtx.globalCompositeOperation = 'source-over';
      cacheCtx.globalAlpha = 1;
      cacheKey = nextCacheKey;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cacheCanvas, 0, 0);

    if (liveStroke && (liveStroke.points || []).length > 1) {
      liveCanvas = layerFor(liveCanvas, 'live');
      if (!liveCtx || liveCtx.canvas !== liveCanvas) liveCtx = liveCanvas.getContext('2d');
      const nextLiveKey = `${view}|${liveStroke.id}`;
      if (liveKey !== nextLiveKey) {
        liveCtx.setTransform(1, 0, 0, 1, 0, 0);
        liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
        liveKey = nextLiveKey;
        liveDrawn = 0;
      }
      if (liveStroke.points.length > liveDrawn + 1 || liveDrawn === 0) {
        paintStroke(liveCtx, liveStroke, map, strokeScale, paperTheme, {
          from: Math.max(1, liveDrawn),
          flat: true,
        });
        liveDrawn = liveStroke.points.length - 1;
      }
      const preset = toolPreset[liveStroke.tool] || toolPreset.fountain;
      ctx.globalCompositeOperation = preset.composite;
      ctx.globalAlpha = preset.opacity;
      ctx.drawImage(liveCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    } else if (liveKey) {
      liveKey = '';
      liveDrawn = 0;
    }

    if (paperKey !== view) {
      paperKey = view;
      updatePaperGrid();
      $('#zoom-level').textContent = `${Math.round(camera.zoom * 100)}%`;
    }
  }

  function requestRedraw(liveStroke = null) {
    pendingLive = liveStroke;
    if (frameHandle) return;
    frameHandle = requestAnimationFrame(() => {
      frameHandle = 0;
      const live = pendingLive;
      pendingLive = null;
      redraw(live);
    });
  }

  function themedColour(value, displayTheme) {
    let result = value || '#162034';
    if (displayTheme === 'dark' && result.toUpperCase() === '#162034') result = '#F3F4F6';
    if (displayTheme === 'light' && result.toUpperCase() === '#F3F4F6') result = '#162034';
    return result;
  }

  function paintFill(target, stroke, map, displayTheme) {
    const contours = stroke.contours || [];
    if (!contours.length) return;
    target.save();
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = stroke.opacity ?? 1;
    target.fillStyle = themedColour(stroke.colour, displayTheme);
    target.beginPath();
    for (const loop of contours) {
      if (!loop || loop.length < 3) continue;
      const start = map(loop[0]);
      target.moveTo(start.x, start.y);
      for (let i = 1; i < loop.length; i++) {
        const point = map(loop[i]);
        target.lineTo(point.x, point.y);
      }
      target.closePath();
    }
    target.fill('evenodd');
    target.restore();
  }

  // Fills sit under the ink, whatever order they were laid down in, so a fill
  // can never bury the lines it was poured between.
  function paintStrokes(target, list, map, strokeScale = 1, displayTheme = paperTheme) {
    for (const stroke of list) if (stroke.tool === 'fill') paintFill(target, stroke, map, displayTheme);
    for (const stroke of list) if (stroke.tool !== 'fill') paintStroke(target, stroke, map, strokeScale, displayTheme);
  }

  function paintStroke(target, stroke, map, strokeScale = 1, displayTheme = paperTheme, options = {}) {
    if (stroke.tool === 'fill') { paintFill(target, stroke, map, displayTheme); return; }
    const preset = toolPreset[stroke.tool] || toolPreset.fountain;
    const points = stroke.points || [];
    if (points.length < 2) return;
    const from = Math.max(1, options.from || 1);
    const flat = options.flat === true;
    target.save();
    target.globalCompositeOperation = flat ? 'source-over' : preset.composite;
    target.globalAlpha = flat ? 1 : preset.opacity;
    target.strokeStyle = themedColour(stroke.colour, displayTheme);
    target.lineCap = 'round';
    target.lineJoin = 'round';
    const base = Math.max(.55, Number(stroke.size || 4) * preset.width * strokeScale);
    for (let i = from; i < points.length; i++) {
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
    if (stroke.tool === 'pencil' && !flat) {
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


  // ---- Fill --------------------------------------------------------------
  // Rasterises the ink around the tap, floods the enclosed gap, then traces the
  // flooded pixels back into vector outlines so the fill stays sharp at any zoom.
  const FILL_RASTER_MAX = 1500;
  const FILL_ALPHA_GATE = 24;
  const FILL_MAX_EDGES = 260000;
  const FILL_MAX_POINTS = 6000;

  function simplifyPath(points, tolerance) {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      if (last - first < 2) continue;
      const [ax, ay] = points[first];
      const [bx, by] = points[last];
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      let best = -1;
      let bestDistance = tolerance;
      for (let i = first + 1; i < last; i++) {
        const [px, py] = points[i];
        const distance = length < 1e-6
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
        if (distance > bestDistance) { bestDistance = distance; best = i; }
      }
      if (best > 0) {
        keep[best] = 1;
        stack.push([first, best], [best, last]);
      }
    }
    const result = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
    return result;
  }

  // A closed ring has to be cut before it can be simplified — run it end to end
  // and every vertex measures zero from a zero-length baseline, so the ring
  // collapses to a single point.
  function simplifyLoop(points, tolerance) {
    if (points.length < 8) return points;
    const [ax, ay] = points[0];
    let far = 0;
    let farDistance = -1;
    for (let i = 1; i < points.length; i++) {
      const distance = Math.hypot(points[i][0] - ax, points[i][1] - ay);
      if (distance > farDistance) { farDistance = distance; far = i; }
    }
    if (far < 2 || far > points.length - 2) return points;
    const head = simplifyPath(points.slice(0, far + 1), tolerance);
    const tail = simplifyPath([...points.slice(far), points[0]], tolerance);
    const ring = [...head.slice(0, -1), ...tail.slice(0, -1)];
    return ring.length >= 3 ? ring : points;
  }

  function dilate(mask, width, height, times) {
    if (times <= 0) return mask;
    let source = mask;
    let target = new Uint8Array(mask.length);
    for (let pass = 0; pass < times; pass++) {
      target.set(source);
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          const index = row + x;
          if (source[index]) continue;
          if ((x > 0 && source[index - 1])
            || (x < width - 1 && source[index + 1])
            || (y > 0 && source[index - width])
            || (y < height - 1 && source[index + width])) target[index] = 1;
        }
      }
      const swap = source === mask ? new Uint8Array(mask.length) : source;
      source = target;
      target = swap;
    }
    return source;
  }

  function loopArea(loop) {
    let total = 0;
    for (let i = 0; i < loop.length; i++) {
      const [ax, ay] = loop[i];
      const [bx, by] = loop[(i + 1) % loop.length];
      total += ax * by - bx * ay;
    }
    return Math.abs(total) / 2;
  }

  function fillAt(world) {
    if (!active) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const margin = .3;
    const viewWidth = rect.width / camera.zoom;
    const viewHeight = rect.height / camera.zoom;
    const originX = camera.x - viewWidth * margin;
    const originY = camera.y - viewHeight * margin;
    const worldWidth = viewWidth * (1 + margin * 2);
    const worldHeight = viewHeight * (1 + margin * 2);
    const scale = Math.min(FILL_RASTER_MAX / worldWidth, FILL_RASTER_MAX / worldHeight, 2);
    const width = Math.max(8, Math.round(worldWidth * scale));
    const height = Math.max(8, Math.round(worldHeight * scale));
    const seedX = Math.round((world.x - originX) * scale);
    const seedY = Math.round((world.y - originY) * scale);
    if (seedX < 1 || seedY < 1 || seedX >= width - 1 || seedY >= height - 1) return;

    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    const bufferCtx = buffer.getContext('2d', { willReadFrequently: true });
    const map = (point) => ({ x: (point.x - originX) * scale, y: (point.y - originY) * scale });
    for (const stroke of strokes) {
      if (stroke.tool === 'fill') continue;   // earlier fills are not walls
      paintStroke(bufferCtx, stroke, map, scale);
    }
    const pixels = bufferCtx.getImageData(0, 0, width, height).data;
    const area = width * height;

    // Hand-drawn outlines rarely meet. Thicken the walls just for the flood so
    // small gaps seal, then grow the filled area back out by the same amount so
    // the colour still runs right up to the real ink.
    const gapClose = Math.max(2, Math.round(3 * scale));
    const walls = new Uint8Array(area);
    for (let i = 0; i < area; i++) if (pixels[i * 4 + 3] >= FILL_ALPHA_GATE) walls[i] = 1;
    const thickWalls = dilate(walls, width, height, gapClose);

    // Landing on a line is a near miss, not a mistake — step off it.
    let seed = seedY * width + seedX;
    if (thickWalls[seed]) {
      seed = -1;
      const reach = gapClose + 10;
      search: for (let radius = 1; radius <= reach; radius++) {
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = seedX + dx;
          const y = seedY + dy;
          if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
          const candidate = y * width + x;
          if (!thickWalls[candidate]) { seed = candidate; break search; }
        }
      }
      if (seed < 0) {
        toast('No space to fill there');
        return;
      }
    }

    const inside = new Uint8Array(area);
    const stack = new Int32Array(area);
    let top = 0;
    let escaped = false;
    stack[top++] = seed;
    inside[seed] = 1;
    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { escaped = true; break; }
      let next = index - 1;
      if (!inside[next] && !thickWalls[next]) { inside[next] = 1; stack[top++] = next; }
      next = index + 1;
      if (!inside[next] && !thickWalls[next]) { inside[next] = 1; stack[top++] = next; }
      next = index - width;
      if (!inside[next] && !thickWalls[next]) { inside[next] = 1; stack[top++] = next; }
      next = index + width;
      if (!inside[next] && !thickWalls[next]) { inside[next] = 1; stack[top++] = next; }
    }
    if (escaped) {
      toast('That outline is open — close the gap, then fill');
      return;
    }

    // Grow back under the ink: the gap-closing margin, plus one for the
    // anti-aliased edge of the stroke itself.
    const grown = dilate(inside, width, height, gapClose + 1);

    const vertexKey = (x, y) => x * (height + 1) + y;
    const starts = new Map();
    let edgeCount = 0;
    const addEdge = (ax, ay, bx, by) => {
      const k = vertexKey(ax, ay);
      const list = starts.get(k);
      if (list) list.push([bx, by]); else starts.set(k, [[bx, by]]);
      edgeCount++;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!grown[y * width + x]) continue;
      if (y === 0 || !grown[(y - 1) * width + x]) addEdge(x, y, x + 1, y);
      if (x === width - 1 || !grown[y * width + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
      if (y === height - 1 || !grown[(y + 1) * width + x]) addEdge(x + 1, y + 1, x, y + 1);
      if (x === 0 || !grown[y * width + x - 1]) addEdge(x, y + 1, x, y);
    }
    if (!edgeCount || edgeCount > FILL_MAX_EDGES) {
      toast('That area is too intricate to fill');
      return;
    }

    const loops = [];
    for (const startKey of [...starts.keys()]) {
      while (starts.get(startKey)?.length) {
        const sx = Math.floor(startKey / (height + 1));
        const sy = startKey % (height + 1);
        const loop = [[sx, sy]];
        let cx = sx;
        let cy = sy;
        let guard = edgeCount + 4;
        while (guard-- > 0) {
          const here = starts.get(vertexKey(cx, cy));
          if (!here || !here.length) break;
          const [nx, ny] = here.shift();
          cx = nx;
          cy = ny;
          if (cx === sx && cy === sy) break;
          loop.push([cx, cy]);
        }
        if (loop.length >= 4) loops.push(loop);
      }
    }

    const minLoopArea = Math.pow(2.5 * scale, 2);
    let tolerance = 1.1;
    let simplified = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      simplified = loops
        .filter((loop) => loopArea(loop) >= minLoopArea)
        .map((loop) => simplifyLoop(loop, tolerance))
        .filter((loop) => loop.length >= 3);
      const total = simplified.reduce((sum, loop) => sum + loop.length, 0);
      if (total <= FILL_MAX_POINTS) break;
      tolerance *= 2.2;
    }
    if (!simplified.length) return;

    const contours = simplified.map((loop) => loop.map(([x, y]) => ({
      x: Math.round((originX + x / scale) * 10) / 10,
      y: Math.round((originY + y / scale) * 10) / 10,
    })));

    strokes.push({ tool: 'fill', colour, contours });
    inkStamp++;
    redoStack = [];
    redraw();
    updateHistoryButtons();
    scheduleSave();
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
      const groups = stroke.tool === 'fill' ? (stroke.contours || []) : [stroke.points || []];
      for (const group of groups) for (const point of group) {
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
    paintStrokes(target, thumbnailStrokes, map, scale, migrated.theme);
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
    inkStamp++;
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
    inkStamp++;
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function setTool(next) {
    if (next !== 'eraser') previousInkTool = next;
    tool = next;
    $$('.ink-tool[data-tool]').forEach((button) => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    if (tool === 'highlighter' && colour === '#162034') selectColour('#F3C84B');
  }

  function selectColour(next) {
    colour = next;
    let matched = false;
    $$('.ink-color').forEach((button) => {
      const selected = button.dataset.color.toLowerCase() === colour.toLowerCase();
      if (selected) matched = true;
      button.classList.toggle('is-active', selected);
    });
    const wheel = $('#ink-wheel');
    if (wheel) {
      if (/^#[0-9a-f]{6}$/i.test(colour)) wheel.value = colour;
      wheel.closest('.ink-wheel')?.classList.toggle('is-active', !matched);
    }
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
    paintStrokes(outputCtx, strokes, map, scale);
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
    const count = linkedJobIds.length;
    button.classList.toggle('is-added', count > 0);
    label.textContent = count > 1 ? `View ${count} jobs` : (count === 1 ? 'View in jobs' : 'Add to jobs');
    button.setAttribute('aria-label', count ? 'View jobs created from this note' : 'Read handwriting and add separate jobs');
  }

  function splitRecognisedJobs(text) {
    const heading = /^(jobs?|tasks?|to[ -]?do(?: list)?)\s*:?[\s]*$/i;
    const marker = /^\s*(?:[-–—*•·]|(?:\d+|[a-z])[.)]|\[[ x✓]?\])\s*/i;
    const rawLines = String(text || '')
      .replace(/\r/g, '')
      .split(/\n+/)
      .flatMap((line) => line.split(/\s*[;•]\s*/))
      .map((line) => line.replace(marker, '').replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 1 && !heading.test(line));
    const seen = new Set();
    return rawLines.filter((line) => {
      const key = line.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function addNoteToJobs() {
    if (!active) return;
    if (linkedJobIds.length) {
      await closeNote();
      switchScreen('jobs');
      toast('Showing your job list');
      return;
    }
    const button = $('#note-add-job');
    button.classList.add('is-loading');
    const noteTitle = $('#note-title').value.trim() || 'Handwritten note';
    let cleanText = ($('#clean-text').value || active.clean_text || '').trim();
    const hasInk = strokes.some((stroke) => stroke.tool !== 'eraser' && stroke.tool !== 'scratch-erase');
    if (hasInk) {
      try {
        toast('Reading your handwriting…');
        cleanText = await recognisePage();
        $('#clean-text').value = cleanText;
      } catch {
        if (!cleanText) {
          button.classList.remove('is-loading');
          openCleanPanel();
          $('#ocr-status').textContent = 'I could not read this clearly. Write or correct the job list in the box, then tap Add to jobs again.';
          return;
        }
      }
    }
    const tasks = splitRecognisedJobs(cleanText);
    if (!tasks.length) {
      button.classList.remove('is-loading');
      openCleanPanel();
      $('#ocr-status').textContent = 'I could not find a job. Put each job on its own line, then tap Add to jobs again.';
      return;
    }
    const records = tasks.map((task) => ({
      title: task.slice(0, 140),
      client: null,
      notes: `From handwritten note “${noteTitle}”.\n\n${task}`,
      due_at: null,
      remind_at: null,
      priority: 'normal',
      status: 'todo',
      completed_at: null,
    }));
    const { data, error } = await supabase
      .from('board_jobs')
      .insert(records)
      .select('id')
    button.classList.remove('is-loading');
    if (error || !data?.length) {
      toast('Could not add those jobs');
      return;
    }
    linkedJobIds = data.map((job) => job.id);
    active.clean_text = cleanText;
    await saveActive();
    updateJobButton();
    toast(`${data.length} ${data.length === 1 ? 'job' : 'jobs'} added separately`);
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

  async function recognisePage(onProgress = null) {
    const visibleStrokes = strokes.filter((stroke) => stroke.tool !== 'eraser' && stroke.tool !== 'scratch-erase');
    if (!visibleStrokes.length) throw new Error('empty page');
    const Tesseract = await loadTesseract();
    const image = renderPage(1.35).toDataURL('image/png');
    const result = await Tesseract.recognize(image, 'eng', {
      logger: (message) => {
        if (message.status === 'recognizing text') onProgress?.(Math.round((message.progress || 0) * 100));
      },
    });
    const text = result?.data?.text?.trim() || '';
    if (!text) throw new Error('unreadable page');
    return text;
  }

  async function readPage() {
    if (!strokes.some((stroke) => stroke.tool !== 'eraser' && stroke.tool !== 'scratch-erase')) {
      $('#ocr-status').textContent = 'Add some handwriting to the page first.';
      return;
    }
    const button = $('#read-page');
    const status = $('#ocr-status');
    button.classList.add('is-loading');
    status.textContent = 'Preparing handwriting reader…';
    try {
      const text = await recognisePage((progress) => { status.textContent = `Reading your page… ${progress}%`; });
      $('#clean-text').value = text;
      status.textContent = 'Finished. Put each job on its own line, then save or add it to jobs.';
    } catch {
      status.textContent = 'I could not read that page clearly. You can write or correct the list in the box above.';
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

  // A resting palm used to start a text selection that ran away across the page.
  editor.addEventListener('selectstart', (event) => {
    if (!event.target.closest?.('input, textarea')) event.preventDefault();
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
    editor.addEventListener(name, (event) => event.preventDefault());
  });
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

  $$('.ink-tool[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $$('.ink-color').forEach((button) => button.addEventListener('click', () => selectColour(button.dataset.color)));
  $('#ink-wheel').addEventListener('input', (event) => selectColour(event.target.value));
  $('#shape-snap').addEventListener('click', () => {
    setShapeSnap(!shapeSnap);
    toast(shapeSnap ? 'Shapes will be tidied up' : 'Shapes left as drawn');
  });
  setShapeSnap(shapeSnap);
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
