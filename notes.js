import { loadPicture, preparePicture, paintPictures, MAX_PICTURE_DATA } from './note-pictures.js';

const DRAWING_VERSION = 4;
const DEFAULT_DRAWING = () => ({ version: DRAWING_VERSION, strokes: [], pictures: [], view: { x: 0, y: 0, zoom: 1 }, theme: 'light', job_ids: [] });
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
  let undoStack = [];
  let pictures = [];
  let selectedPicture = null;
  let pictureGesture = null;
  let addingPictures = false;
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
  let toolSizes = readStored('field-tool-sizes', {});
  let recentColours = readStored('field-recent-colours', []);
  let openPop = null;
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
  const PALM_GRACE_MS = 400;
  const PALM_CONTACT = 58;

  function ignoreTouch(event) {
    // A second finger is always deliberate — never mistake a pinch for a palm.
    if (touchPointers.size >= 1) return false;
    if (penDown) return true;
    if (Date.now() - lastPenAt < PALM_GRACE_MS) return true;
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
    copy.pictures = Array.isArray(copy.pictures) ? copy.pictures.filter((picture) =>
      picture && typeof picture.src === 'string' && [picture.x, picture.y, picture.width, picture.height].every(Number.isFinite)
      && picture.width > 0 && picture.height > 0) : [];
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
      updated.textContent = `${strokeCount} strokes${drawing.pictures.length ? ` · ${drawing.pictures.length} pictures` : ''} · ${relativeDate(note.updated_at)}`;
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
    pictures = drawing.pictures;
    selectedPicture = null;
    pictureGesture = null;
    undoStack = [];
    Promise.allSettled(pictures.map(loadPicture)).then(() => { if (active?.id === note.id) redraw(); });
    inkStamp++;
    camera = {
      x: Number(drawing.view?.x) || 0,
      y: Number(drawing.view?.y) || 0,
      zoom: clamp(Number(drawing.view?.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    };
    paperTheme = drawing.theme;
    linkedJobIds = drawing.job_ids;
    redoStack = [];
    updatePictureControls();
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
    if (pictureGesture) finishPictureGesture();
    clearTimeout(saveTimer);
    if (active) await saveActive();
    active = null;
    currentStroke = null;
    editor.hidden = true;
    $('#note-menu').hidden = true;
    closePops();
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
    active.drawing = { version: DRAWING_VERSION, strokes, pictures, view: camera, theme: paperTheme, job_ids: linkedJobIds };
    active.clean_text = $('#clean-text').value;
    active.updated_at = new Date().toISOString();
    const locallySaved = saveLocal(active);
    const record = structuredClone({
      id: active.id,
      user_id: active.user_id,
      title: active.title,
      drawing: active.drawing,
      clean_text: active.clean_text,
      page_style: active.page_style || 'dot',
      created_at: active.created_at,
      updated_at: active.updated_at,
    });
    const { error } = await supabase.from('board_notes').upsert(record);
    if (error) {
      if (active?.id === record.id) setSaveState('error', locallySaved ? 'On device' : 'Not saved — retry');
      if (!locallySaved) toast('Could not save this page. Keep it open and try again when connected.');
      return;
    }
    if (active?.id !== record.id || active.updated_at !== record.updated_at) return;
    setSaveState('', 'Saved');
    const index = notes.findIndex((note) => note.id === record.id);
    if (index >= 0) notes[index] = record;
    else notes.unshift(record);
    writeLocalIndex(notes);
  }

  function saveLocal(note) {
    try {
      localStorage.setItem(`field-note-${note.id}`, JSON.stringify(note));
      const index = notes.findIndex((item) => item.id === note.id);
      if (index >= 0) notes[index] = structuredClone(note);
      else notes.unshift(structuredClone(note));
      writeLocalIndex(notes);
      return true;
    } catch { return false; /* cloud save will still be attempted */ }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function editSnapshot() {
    return { strokes: [...strokes], pictures: pictures.map((picture) => ({ ...picture })) };
  }

  function rememberEdit(snapshot = editSnapshot()) {
    undoStack.push(snapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }

  function restoreEdit(snapshot) {
    strokes = [...snapshot.strokes];
    pictures = snapshot.pictures.map((picture) => ({ ...picture }));
    selectedPicture = null;
    updatePictureControls();
  }

  function updatePictureControls() {
    $('#picture-controls').hidden = tool !== 'image';
    const selected = pictures.find((picture) => picture.id === selectedPicture);
    $('#picture-hint').textContent = selected ? 'Drag to move · drag the corner to resize' : 'Tap a picture to move or resize it';
    ['#picture-smaller', '#picture-larger', '#picture-remove'].forEach((selector) => { $(selector).disabled = !selected; });
    canvas.style.cursor = tool === 'image' ? 'grab' : 'crosshair';
  }

  async function addPictures(files, position = null) {
    if (!active || addingPictures) return;
    const noteId = active.id;
    addingPictures = true;
    $('#note-add-image').disabled = true;
    let added = 0;
    try {
      for (const file of files) {
        if (active?.id !== noteId) break;
        try {
          const picture = await preparePicture(file);
          if (active?.id !== noteId) break;
          if (pictures.reduce((total, item) => total + item.src.length, picture.src.length) > MAX_PICTURE_DATA) {
            toast('This page has lots of pictures. Start a new page or remove one first.');
            break;
          }
          const rect = canvas.getBoundingClientRect();
          const scale = Math.min(1, rect.width * .55 / (picture.width * camera.zoom), rect.height * .55 / (picture.height * camera.zoom));
          picture.width *= scale;
          picture.height *= scale;
          picture.x = (position?.x ?? camera.x + rect.width / (2 * camera.zoom)) - picture.width / 2 + added * 24 / camera.zoom;
          picture.y = (position?.y ?? camera.y + rect.height / (2 * camera.zoom)) - picture.height / 2 + added * 24 / camera.zoom;
          rememberEdit();
          pictures.push(picture);
          selectedPicture = picture.id;
          added++;
          setTool('image');
          updateHistoryButtons();
          scheduleSave();
        } catch (error) {
          if (active?.id === noteId) toast(error.message || 'Could not add this picture');
        }
      }
      if (added && active?.id === noteId) toast('Picture added. Position it, then tap Done to write around it.');
    } finally {
      addingPictures = false;
      $('#note-add-image').disabled = false;
      $('#note-image-input').value = '';
    }
  }

  function beginPictureGesture(event) {
    if (pictureGesture) return false;
    const point = worldPoint(event);
    const selected = pictures.find((picture) => picture.id === selectedPicture);
    const resizing = selected && Math.hypot(point.x - selected.x - selected.width, point.y - selected.y - selected.height) <= 22 / camera.zoom;
    const picture = resizing ? selected : [...pictures].reverse().find((item) =>
      point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height);
    selectedPicture = picture?.id || null;
    updatePictureControls();
    redraw();
    if (!picture) return false;
    pictureGesture = { pointerId: event.pointerId, pointerType: event.pointerType, picture, start: point, screen: screenPoint(event), before: { ...picture }, snapshot: editSnapshot(), resizing };
    return true;
  }

  function finishPictureGesture(cancel = false) {
    if (!pictureGesture) return;
    const { picture, before, snapshot } = pictureGesture;
    pictureGesture = null;
    if (cancel) Object.assign(picture, before);
    else if (['x', 'y', 'width', 'height'].some((key) => picture[key] !== before[key])) {
      rememberEdit(snapshot);
      scheduleSave();
    }
    updateHistoryButtons();
    redraw();
  }

  function changePicture(scale = null) {
    const picture = pictures.find((item) => item.id === selectedPicture);
    if (!picture) return;
    rememberEdit();
    if (scale) {
      picture.x -= picture.width * (scale - 1) / 2;
      picture.y -= picture.height * (scale - 1) / 2;
      picture.width *= scale;
      picture.height *= scale;
    } else {
      pictures = pictures.filter((item) => item !== picture);
      selectedPicture = null;
    }
    updatePictureControls();
    updateHistoryButtons();
    redraw();
    scheduleSave();
  }

  function paintPictureSelection(dpr) {
    if (tool !== 'image') return;
    const picture = pictures.find((item) => item.id === selectedPicture);
    if (!picture) return;
    const x = (picture.x - camera.x) * camera.zoom * dpr;
    const y = (picture.y - camera.y) * camera.zoom * dpr;
    const width = picture.width * camera.zoom * dpr;
    const height = picture.height * camera.zoom * dpr;
    ctx.save();
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(x + width, y + height, 8 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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
    if (tool === 'image' && !spaceHeld && !touchPointers.size && beginPictureGesture(event)) return;
    if (pictureGesture) {
      if (event.pointerType === 'touch' && pictureGesture.pointerType === 'touch') {
        touchPointers.set(pictureGesture.pointerId, pictureGesture.screen);
      }
      finishPictureGesture();
    }
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
    if (tool === 'image') return;
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
    if (pictureGesture?.pointerId === event.pointerId) {
      const point = worldPoint(event);
      pictureGesture.screen = screenPoint(event);
      const { picture, start, before, resizing } = pictureGesture;
      if (resizing) {
        const scale = clamp((point.x - before.x) / before.width, .1, 10);
        picture.width = before.width * scale;
        picture.height = before.height * scale;
      } else {
        picture.x = before.x + point.x - start.x;
        picture.y = before.y + point.y - start.y;
      }
      requestRedraw();
      return;
    }
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
    if (pictureGesture?.pointerId === event.pointerId) { finishPictureGesture(event.type === 'pointercancel'); return; }
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
    rememberEdit();
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


  function convexHull(points) {
    const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    if (sorted.length < 3) return sorted;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // Smallest rectangle that contains the stroke, at any angle — a box drawn on
  // the skew is still a box.
  function minAreaRect(points) {
    const hull = convexHull(points);
    if (hull.length < 3) return null;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const edge = Math.hypot(b.x - a.x, b.y - a.y);
      if (edge < 1e-6) continue;
      const ux = (b.x - a.x) / edge;
      const uy = (b.y - a.y) / edge;
      let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
      for (const point of hull) {
        const u = point.x * ux + point.y * uy;
        const v = -point.x * uy + point.y * ux;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        best = { area, ux, uy, minU, maxU, minV, maxV };
      }
    }
    if (!best) return null;
    const { ux, uy, minU, maxU, minV, maxV } = best;
    const corner = (u, v) => ({ x: u * ux - v * uy, y: u * uy + v * ux });
    return {
      corners: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)],
      width: maxU - minU,
      height: maxV - minV,
      angle: Math.atan2(uy, ux),
    };
  }

  // Algebraic circle fit (Kåsa) — good enough to tell an arc from a wiggle.
  function fitCircle(points) {
    let sumX = 0; let sumY = 0;
    for (const point of points) { sumX += point.x; sumY += point.y; }
    const meanX = sumX / points.length;
    const meanY = sumY / points.length;
    let suu = 0; let svv = 0; let suv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
    for (const point of points) {
      const u = point.x - meanX;
      const v = point.y - meanY;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v;
      suvv += u * v * v; svuu += v * u * u;
    }
    const determinant = 2 * (suu * svv - suv * suv);
    if (Math.abs(determinant) < 1e-9) return null;
    const cu = (svv * (suuu + suvv) - suv * (svvv + svuu)) / determinant;
    const cv = (suu * (svvv + svuu) - suv * (suuu + suvv)) / determinant;
    const centre = { x: cu + meanX, y: cv + meanY };
    const radius = Math.sqrt(cu * cu + cv * cv + (suu + svv) / points.length);
    return { centre, radius };
  }

  function arcPoints(centre, radius, from, to) {
    const sweep = to - from;
    const steps = Math.max(24, Math.min(160, Math.round(Math.abs(sweep) * radius / 4)));
    const list = [];
    for (let i = 0; i <= steps; i++) {
      const angle = from + sweep * (i / steps);
      list.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius, p: .62 });
    }
    return list;
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
      if (span >= 22 && length < span * 1.18) {
        let worst = 0;
        for (const point of points) worst = Math.max(worst, distanceToSegment(point, first, last));
        if (worst < Math.max(4.5, span * .06)) {
          // Nearly horizontal, vertical or 45 degrees? Make it exact.
          let end = { x: last.x, y: last.y, p: .62 };
          const angle = Math.atan2(last.y - first.y, last.x - first.x);
          const step = Math.PI / 4;
          const snapped = Math.round(angle / step) * step;
          if (Math.abs(angle - snapped) < .14) {
            end = { x: first.x + Math.cos(snapped) * span, y: first.y + Math.sin(snapped) * span, p: .62 };
          }
          return { kind: 'line', label: 'Line', points: [{ ...first, p: .62 }, end] };
        }
      }
      return recogniseArc(points, length, diagonal);
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

    const box = minAreaRect(points);
    if (box && box.width > 14 && box.height > 14) {
      const edgeTolerance = Math.max(5, Math.min(box.width, box.height) * .18);
      let fits = true;
      for (const point of points) {
        let nearest = Infinity;
        for (let i = 0; i < 4; i++) {
          nearest = Math.min(nearest, distanceToSegment(point, box.corners[i], box.corners[(i + 1) % 4]));
        }
        if (nearest > edgeTolerance) { fits = false; break; }
      }
      const ratio = length / (2 * (box.width + box.height));
      if (fits && ratio > .78 && ratio < 1.4) {
        // Close to upright? Sit it exactly on the axes rather than 2 degrees off.
        const step = Math.PI / 2;
        const drift = box.angle - Math.round(box.angle / step) * step;
        const corners = Math.abs(drift) < .075
          ? [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
          : box.corners;
        const square = Math.abs(box.width - box.height) < Math.max(box.width, box.height) * .13;
        return { kind: 'rect', label: square ? 'Square' : 'Rectangle', points: ringPoints(corners) };
      }
    }

    const triangle = fitTriangle(points, tolerance);
    if (triangle) return { kind: 'triangle', label: 'Triangle', points: ringPoints(triangle) };
    return null;
  }


  // An open stroke that hugs one circle: quarter, semicircle, anything up to
  // almost a full turn.
  function recogniseArc(points, length, diagonal) {
    if (points.length < 12) return null;
    const circle = fitCircle(points);
    if (!circle || !Number.isFinite(circle.radius)) return null;
    const { centre, radius } = circle;
    if (radius < 12 || radius > diagonal * 6) return null;
    let worst = 0;
    for (const point of points) worst = Math.max(worst, Math.abs(pointDistance(point, centre) - radius));
    if (worst > Math.max(4.5, radius * .13)) return null;

    // Unwrap the angles so the sweep is continuous, then take the total turn.
    let previous = Math.atan2(points[0].y - centre.y, points[0].x - centre.x);
    const from = previous;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const angle = Math.atan2(points[i].y - centre.y, points[i].x - centre.x);
      let delta = angle - previous;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      total += delta;
      previous = angle;
    }
    const sweep = Math.abs(total);
    if (sweep < .7 || sweep > Math.PI * 2 - .35) return null;
    // Arc length should account for most of what was drawn, or it is a squiggle.
    if (length > radius * sweep * 1.3) return null;

    const half = Math.abs(sweep - Math.PI) < .38;
    const quarter = Math.abs(sweep - Math.PI / 2) < .35;
    return {
      kind: 'arc',
      label: half ? 'Semicircle' : quarter ? 'Quarter arc' : 'Arc',
      points: arcPoints(centre, radius, from, from + total),
    };
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

    ctx.globalCompositeOperation = 'destination-over';
    paintPictures(ctx, pictures, map, strokeScale);
    ctx.globalCompositeOperation = 'source-over';
    paintPictureSelection(dpr);

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

    rememberEdit();
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

  function contentBounds(items = strokes, photos = pictures) {
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
    for (const picture of photos) {
      minX = Math.min(minX, picture.x);
      minY = Math.min(minY, picture.y);
      maxX = Math.max(maxX, picture.x + picture.width);
      maxY = Math.max(maxY, picture.y + picture.height);
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

  async function drawThumbnail(targetCanvas, drawing) {
    const migrated = migrateDrawing(drawing);
    await Promise.allSettled(migrated.pictures.map(loadPicture));
    const thumbnailStrokes = migrated.strokes;
    const rect = targetCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    targetCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    targetCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    if (!thumbnailStrokes.length && !migrated.pictures.length) return;
    const bounds = contentBounds(thumbnailStrokes, migrated.pictures);
    const width = Math.max(100, bounds.maxX - bounds.minX);
    const height = Math.max(100, bounds.maxY - bounds.minY);
    const padding = 22 * dpr;
    const scale = Math.min((targetCanvas.width - padding * 2) / width, (targetCanvas.height - padding * 2) / height);
    const offsetX = (targetCanvas.width - width * scale) / 2 - bounds.minX * scale;
    const offsetY = (targetCanvas.height - height * scale) / 2 - bounds.minY * scale;
    const target = targetCanvas.getContext('2d');
    const map = (point) => ({ x: point.x * scale + offsetX, y: point.y * scale + offsetY });
    paintStrokes(target, thumbnailStrokes, map, scale, migrated.theme);
    target.globalCompositeOperation = 'destination-over';
    paintPictures(target, migrated.pictures, map, scale);
    target.globalCompositeOperation = 'source-over';
  }

  function updateHistoryButtons() {
    $('#note-undo').disabled = strokes.length === 0 && undoStack.length === 0;
    $('#note-redo').disabled = redoStack.length === 0;
  }

  function undo() {
    if (pictureGesture) finishPictureGesture();
    if (!undoStack.length && !strokes.length) return;
    redoStack.push(editSnapshot());
    if (undoStack.length) restoreEdit(undoStack.pop());
    else strokes.pop();
    inkStamp++;
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(editSnapshot());
    restoreEdit(redoStack.pop());
    inkStamp++;
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function setTool(next) {
    if (pictureGesture) finishPictureGesture();
    if (next !== 'eraser' && next !== 'image') previousInkTool = next;
    tool = next;
    if (tool !== 'image') selectedPicture = null;
    updatePictureControls();
    redraw();
    $$('.ink-tool[data-tool]').forEach((button) => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    if (tool === 'highlighter' && colour === '#162034') selectColour('#F3C84B');
    setSize(toolSizes[tool] || 4, false);
    $('#rail-colour')?.classList.toggle('is-muted', tool === 'eraser');
    $('#rail-size')?.classList.toggle('is-muted', tool === 'fill');
  }

  function readStored(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value && typeof value === 'object' ? value : fallback;
    } catch { return fallback; }
  }

  // One size per tool, so a fat highlighter does not make the next pen stroke fat too.
  function setSize(next, remember = true) {
    size = clamp(Math.round(Number(next) || 4), 1, 18);
    if (remember) {
      toolSizes[tool] = size;
      localStorage.setItem('field-tool-sizes', JSON.stringify(toolSizes));
    }
    const slider = $('#ink-size');
    if (slider && Number(slider.value) !== size) slider.value = String(size);
    const readout = $('#size-readout');
    if (readout) readout.textContent = String(size);
    const width = size * (toolPreset[tool] || toolPreset.fountain).width;
    $('#size-preview-dot')?.style.setProperty('--d', `${clamp(width, 2, 60)}px`);
    $('#chip-size-dot')?.style.setProperty('--d', `${clamp(3 + size * .8, 3, 17)}px`);
    $$('.size-preset').forEach((button) => button.classList.toggle('is-active', Number(button.dataset.size) === size));
  }

  function rememberColour(value) {
    const key = value.toUpperCase();
    recentColours = [key, ...recentColours.filter((entry) => entry !== key)].slice(0, 4);
    localStorage.setItem('field-recent-colours', JSON.stringify(recentColours));
    renderQuickColours();
  }

  // The rail shows the last three colours used that are not the current one: one tap to swap back.
  function renderQuickColours() {
    const holder = $('#quick-colours');
    if (!holder) return;
    holder.replaceChildren(...recentColours
      .filter((entry) => entry !== colour.toUpperCase())
      .slice(0, 3)
      .map((entry) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quick-colour';
        button.style.setProperty('--swatch', entry);
        button.setAttribute('aria-label', `Switch to recent colour ${entry}`);
        button.append(document.createElement('i'));
        button.addEventListener('click', () => { selectColour(entry); rememberColour(entry); });
        return button;
      }));
  }

  function closePops() {
    if (!openPop) return;
    openPop.hidden = true;
    $$('.rail-chip[data-pop]').forEach((chip) => chip.setAttribute('aria-expanded', 'false'));
    openPop = null;
  }

  // Pop-outs sit beside the rail (landscape) or above it (portrait) and are clamped to the screen.
  function togglePop(chip) {
    const pop = document.getElementById(chip.dataset.pop);
    const wasOpen = openPop === pop;
    closePops();
    if (wasOpen || !pop) return;
    pop.hidden = false;
    const rail = chip.closest('.instrument-rail');
    const sideways = getComputedStyle(rail).flexDirection === 'column';
    const anchor = chip.getBoundingClientRect();
    const box = { width: pop.offsetWidth, height: pop.offsetHeight }; // offset*, not the rect: the open animation scales it
    const head = $('.note-editor-head').getBoundingClientRect().bottom;
    const gap = 12;
    const left = sideways ? rail.getBoundingClientRect().right + gap : anchor.left + anchor.width / 2 - box.width / 2;
    const top = sideways ? anchor.top + anchor.height / 2 - box.height / 2 : rail.getBoundingClientRect().top - box.height - gap;
    pop.style.left = `${clamp(left, 10, window.innerWidth - box.width - 10)}px`;
    pop.style.top = `${clamp(top, head + 10, window.innerHeight - box.height - 10)}px`;
    chip.setAttribute('aria-expanded', 'true');
    openPop = pop;
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
    editor.style.setProperty('--chip', colour);
    renderQuickColours();
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
    editor.dataset.paper = paperTheme;
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
    paintPictures(outputCtx, pictures, map, scale);
    const ink = document.createElement('canvas');
    ink.width = output.width;
    ink.height = output.height;
    paintStrokes(ink.getContext('2d'), strokes, map, scale);
    outputCtx.drawImage(ink, 0, 0);
    outputCtx.globalCompositeOperation = 'destination-over';
    outputCtx.fillStyle = paperColour;
    outputCtx.fillRect(0, 0, output.width, output.height);
    return output;
  }

  async function exportPage() {
    const noteId = active?.id;
    try { await Promise.all(pictures.map(loadPicture)); }
    catch { toast('A picture could not be loaded. Please reopen the note and try again.'); return; }
    if (active?.id !== noteId) return;
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
  $$('.ink-color').forEach((button) => button.addEventListener('click', () => {
    selectColour(button.dataset.color);
    rememberColour(button.dataset.color);
    closePops();
  }));
  $('#ink-wheel').addEventListener('input', (event) => selectColour(event.target.value));
  $('#ink-wheel').addEventListener('change', (event) => rememberColour(event.target.value));
  $$('.rail-chip[data-pop]').forEach((chip) => chip.addEventListener('click', () => togglePop(chip)));
  $$('.size-preset').forEach((button) => button.addEventListener('click', () => setSize(button.dataset.size)));
  window.addEventListener('resize', closePops);
  $('#shape-snap').addEventListener('click', () => {
    setShapeSnap(!shapeSnap);
    toast(shapeSnap ? 'Shapes will be tidied up' : 'Shapes left as drawn');
  });
  setShapeSnap(shapeSnap);
  $$('.paper-style').forEach((button) => button.addEventListener('click', () => setPaper(button.dataset.paper)));
  $$('.paper-theme').forEach((button) => button.addEventListener('click', () => setPaperTheme(button.dataset.theme)));
  $('#ink-size').addEventListener('input', (event) => setSize(event.target.value));
  selectColour(colour);
  setSize(toolSizes[tool] || 4, false);
  $('#note-title').addEventListener('input', scheduleSave);
  $('#note-add-image').addEventListener('click', () => { closePops(); $('#note-image-input').click(); });
  $('#note-image-input').addEventListener('change', (event) => addPictures([...event.target.files]));
  $('#picture-smaller').addEventListener('click', () => changePicture(.85));
  $('#picture-larger').addEventListener('click', () => changePicture(1.15));
  $('#picture-remove').addEventListener('click', () => changePicture());
  $('#picture-done').addEventListener('click', () => setTool(previousInkTool));
  document.addEventListener('paste', (event) => {
    if (editor.hidden || !$('#clean-panel').hidden || event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); addPictures(files); }
  });
  paper.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  });
  paper.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) addPictures(files, worldPoint(event));
  });
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
    if (openPop && !openPop.contains(event.target) && !event.target.closest?.('.rail-chip[data-pop]')) closePops();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openPop) { closePops(); return; }
    if (editor.hidden || event.target.matches?.('input, textarea')) return;
    if (event.key === 'Escape' && tool === 'image') { setTool(previousInkTool); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'image' && selectedPicture) {
      event.preventDefault(); changePicture(); return;
    }
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
