// Application UI: tool system, panels, dialogs, and the render tab.

import { Model } from './model.js';
import { Viewport } from './viewport.js';
import { ProjectStore } from './store.js';
import { buildRenderScene } from './export.js';
import { PathTracer } from './raytracer/pathtracer.js';
import { materialSwatch, dichroicTransmitSwatch } from './materials.js';
import { buildDemoSculpture } from './demo.js';
import { V } from './math.js';

const $ = (sel) => document.querySelector(sel);

export function initApp() {
  const model = new Model();
  const store = new ProjectStore(model);
  const viewport = new Viewport($('#design-canvas'), model);

  const state = {
    selection: viewport.selection, // Set of piece ids (shared with viewport)
    selectedMaterialId: 'crystal_bk7',
    selectedDichroicId: 'dichro_cyan_red',
    activeTool: 'select',
    selectedFace: null,   // {pieceId, faceIndex}
    glueFirst: null,      // first-picked face for the glue tool
    measurePts: [],
    slice: { axis: 'x', offset: 0, tiltA: 0, tiltB: 0, base: [0, 0, 0], count: 2 },
    tracer: null,
    renderCam: { theta: 0.7, phi: 0.5, dist: 8, target: [0, 0, 0] },
  };

  // =====================================================================
  // Status bar
  function status(html) { $('#status-bar').innerHTML = html; }

  // =====================================================================
  // Tools
  const TOOLS = {
    select: {
      label: 'Select', key: 'q',
      help: 'Click a piece to select it; Shift-click to add. Click a face twice to select the face. Drag = orbit, right-drag = pan, wheel = zoom.',
      panel: `
        <div class="row">
          <button data-act="dup">Duplicate</button>
          <button data-act="del" class="danger">Delete</button>
        </div>`,
      onPanel(el) {
        el.querySelector('[data-act=dup]').onclick = () => {
          if (state.selection.size === 0) return status('Nothing selected to duplicate.');
          const ids = model.duplicatePieces([...state.selection], [0.5, 0.5, 0.5]);
          setSelection(ids);
          status(`Duplicated ${ids.length} piece(s), offset by 0.5".`);
        };
        el.querySelector('[data-act=del]').onclick = deleteSelection;
      },
      onClick(hit, ev) {
        if (!hit) { if (!ev.shiftKey) clearSelection(); return; }
        if (state.selection.has(hit.pieceId) && state.selection.size === 1 && !ev.shiftKey) {
          // Second click on the sole selected piece: select the face.
          state.selectedFace = { pieceId: hit.pieceId, faceIndex: hit.faceIndex };
          viewport.selectedFace = state.selectedFace;
          status(`Face ${hit.faceIndex} of <b>${model.getPiece(hit.pieceId).name}</b> selected (normal ${fmtVec(hit.faceNormal)}).`);
          viewport.invalidate();
          refreshSelectionPanel();
          return;
        }
        if (ev.shiftKey) {
          state.selection.has(hit.pieceId) ? state.selection.delete(hit.pieceId) : state.selection.add(hit.pieceId);
        } else {
          state.selection.clear();
          state.selection.add(hit.pieceId);
        }
        state.selectedFace = null;
        viewport.selectedFace = null;
        afterSelectionChange();
      },
    },

    block: {
      label: 'Add Block', key: 'b',
      help: 'Add a rectangular optical crystal block. Material comes from the Materials panel selection.',
      panel: `
        <label>Width (X) <input id="blk-w" type="number" step="0.125" value="2"></label>
        <label>Height (Y) <input id="blk-h" type="number" step="0.125" value="2"></label>
        <label>Depth (Z) <input id="blk-d" type="number" step="0.125" value="2"></label>
        <label>Position <span>
          <input id="blk-x" type="number" step="0.125" value="0" style="width:52px">
          <input id="blk-y" type="number" step="0.125" value="0" style="width:52px">
          <input id="blk-z" type="number" step="0.125" value="0" style="width:52px"></span></label>
        <div class="row"><button data-act="add" class="primary">Add block</button></div>`,
      onPanel(el) {
        el.querySelector('[data-act=add]').onclick = () => {
          const mat = model.library.get(state.selectedMaterialId);
          if (!mat || mat.kind !== 'crystal') return status('Select a <b>crystal</b> material first (left panel).');
          const g = (id) => parseFloat(el.querySelector(id).value) || 0;
          const p = model.addBlock(state.selectedMaterialId, g('#blk-w'), g('#blk-h'), g('#blk-d'),
            [g('#blk-x'), g('#blk-y'), g('#blk-z')]);
          setSelection([p.id]);
          status(`Added <b>${p.name}</b>.`);
        };
      },
    },

    slice: {
      label: 'Slice', key: 's',
      help: 'Saw cut with a plane. Click a piece to anchor the plane at that point; adjust axis/tilt/offset, then Apply. With no selection the cut goes through every piece it crosses — like a real saw.',
      panel: `
        <label>Plane normal <select id="sl-axis">
          <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
        </select></label>
        <label>Offset (in) <input id="sl-offset" type="number" step="0.0625" value="0"></label>
        <label>Tilt A (°) <input id="sl-ta" type="number" step="1" value="0"></label>
        <label>Tilt B (°) <input id="sl-tb" type="number" step="1" value="0"></label>
        <div class="row"><button data-act="cut" class="primary">Cut</button></div>
        <hr style="border-color:var(--border)">
        <label>Equal pieces <input id="sl-count" type="number" min="2" max="64" value="4"></label>
        <div class="row"><button data-act="cutn">Cut into N equal slabs</button></div>
        <p class="tool-help">N-cut slices the selection (or everything) into equal slabs along the chosen axis — the classic "cut the laminated bar into identical tiles" step.</p>`,
      onPanel(el) {
        const upd = () => {
          state.slice.axis = el.querySelector('#sl-axis').value;
          state.slice.offset = parseFloat(el.querySelector('#sl-offset').value) || 0;
          state.slice.tiltA = parseFloat(el.querySelector('#sl-ta').value) || 0;
          state.slice.tiltB = parseFloat(el.querySelector('#sl-tb').value) || 0;
          updateSlicePreview();
        };
        for (const id of ['#sl-axis', '#sl-offset', '#sl-ta', '#sl-tb']) {
          el.querySelector(id).addEventListener('input', upd);
        }
        el.querySelector('[data-act=cut]').onclick = () => {
          const { n, d } = slicePlane();
          const targets = state.selection.size ? [...state.selection] : model.pieces.map((p) => p.id);
          let cuts = 0;
          model.checkpoint();
          for (const id of targets) {
            if (model.slicePiece(id, n, d, { checkpoint: false }).length) cuts++;
          }
          status(cuts ? `Cut ${cuts} piece(s).` : 'The plane does not pass through any targeted piece.');
        };
        el.querySelector('[data-act=cutn]').onclick = () => {
          const count = parseInt(el.querySelector('#sl-count').value) || 2;
          const targets = state.selection.size ? [...state.selection] : model.pieces.map((p) => p.id);
          if (!targets.length) return status('Nothing to cut.');
          const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[state.slice.axis];
          model.sliceEqual(targets, axis, count);
          status(`Sliced into ${count} equal slabs along ${state.slice.axis.toUpperCase()}.`);
        };
        upd();
      },
      onClick(hit) {
        if (!hit) return;
        state.slice.base = hit.point;
        state.slice.offset = 0;
        const panel = $('#tool-panel');
        panel.querySelector('#sl-offset').value = '0';
        updateSlicePreview();
        status(`Slice plane anchored at ${fmtVec(hit.point)}. Adjust tilt/offset, then <b>Cut</b>.`);
      },
      onDeactivate() { viewport.previewPlanes = []; viewport.invalidate(); },
    },

    glue: {
      label: 'Glue', key: 'g',
      help: 'Click the face of the piece you want to MOVE, then click the target face. The piece snaps flush — face centers aligned, normals opposed — like gluing two ground faces.',
      panel: `<p class="tool-help" id="glue-state">Step 1: click the face of the piece to move.</p>`,
      onClick(hit) {
        if (!hit) return;
        if (!state.glueFirst) {
          state.glueFirst = { pieceId: hit.pieceId, faceIndex: hit.faceIndex };
          viewport.selectedFace = state.glueFirst;
          viewport.invalidate();
          const el = $('#glue-state');
          if (el) el.textContent = 'Step 2: click the face to glue it onto.';
          status(`Moving face picked on <b>${model.getPiece(hit.pieceId).name}</b>. Now click the target face.`);
        } else {
          if (hit.pieceId === state.glueFirst.pieceId) {
            status('Target must be a different piece. Pick the target face.');
            return;
          }
          model.mateFaces(hit.pieceId, hit.faceIndex, state.glueFirst.pieceId, state.glueFirst.faceIndex);
          status(`Glued <b>${model.getPiece(state.glueFirst.pieceId).name}</b> onto <b>${model.getPiece(hit.pieceId).name}</b>.`);
          state.glueFirst = null;
          viewport.selectedFace = null;
          const el = $('#glue-state');
          if (el) el.textContent = 'Step 1: click the face of the piece to move.';
        }
      },
      onDeactivate() { state.glueFirst = null; viewport.selectedFace = null; },
    },

    plate: {
      label: 'Dichroic', key: 'p',
      help: 'Attach a 1/8" dichroic plate flush onto a face: pick the dichroic from the dropdown, then click a face.',
      panel: `
        <label>Coating <select id="pl-mat"></select></label>
        <label>Coated side <select id="pl-side">
          <option value="in">Toward host piece</option>
          <option value="out">Away from host</option>
        </select></label>`,
      onPanel(el) {
        const sel = el.querySelector('#pl-mat');
        sel.innerHTML = model.library.dichroics()
          .map((m) => `<option value="${m.id}" ${m.id === state.selectedDichroicId ? 'selected' : ''}>${m.name}</option>`).join('');
        sel.onchange = () => { state.selectedDichroicId = sel.value; };
      },
      onClick(hit) {
        if (!hit) return;
        const side = $('#pl-side') ? $('#pl-side').value : 'in';
        const p = model.addPlateOnFace(hit.pieceId, hit.faceIndex, state.selectedDichroicId, side);
        if (p) status(`Attached <b>${p.name}</b> (1/8") to ${model.getPiece(hit.pieceId).name}.`);
      },
    },

    move: {
      label: 'Move', key: 'm',
      help: 'Translate the selection numerically (inches). Arrow keys nudge by the step (PgUp/PgDn for Y).',
      panel: `
        <label>ΔX <input id="mv-x" type="number" step="0.125" value="0"></label>
        <label>ΔY <input id="mv-y" type="number" step="0.125" value="0"></label>
        <label>ΔZ <input id="mv-z" type="number" step="0.125" value="0"></label>
        <div class="row"><button data-act="go" class="primary">Move</button></div>
        <label>Nudge step <input id="mv-step" type="number" step="0.0625" value="0.125"></label>`,
      onPanel(el) {
        el.querySelector('[data-act=go]').onclick = () => {
          if (!state.selection.size) return status('Select pieces to move.');
          const g = (id) => parseFloat(el.querySelector(id).value) || 0;
          model.translatePieces([...state.selection], [g('#mv-x'), g('#mv-y'), g('#mv-z')]);
          status('Moved.');
        };
      },
    },

    rotate: {
      label: 'Rotate', key: 'r',
      help: 'Rotate the selection about an axis through its center (or the origin). Cuts can be angled, so any angle is allowed.',
      panel: `
        <label>Axis <select id="rot-axis">
          <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
        </select></label>
        <label>Angle (°) <input id="rot-angle" type="number" step="5" value="90"></label>
        <label>Pivot <select id="rot-pivot">
          <option value="center">Selection center</option>
          <option value="origin">World origin</option>
        </select></label>
        <div class="row"><button data-act="go" class="primary">Rotate</button></div>`,
      onPanel(el) {
        el.querySelector('[data-act=go]').onclick = () => {
          if (!state.selection.size) return status('Select pieces to rotate.');
          const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[el.querySelector('#rot-axis').value];
          const angle = parseFloat(el.querySelector('#rot-angle').value) || 0;
          const pivot = el.querySelector('#rot-pivot').value === 'origin' ? [0, 0, 0] : selectionCenter();
          model.rotatePieces([...state.selection], axis, angle, pivot);
          status(`Rotated ${angle}° about ${el.querySelector('#rot-axis').value.toUpperCase()}.`);
        };
      },
    },

    array: {
      label: 'Array', key: 'a',
      help: 'Replicate the selection: linear arrays for tiling bars/plates, rotational arrays for radial cores.',
      panel: `
        <h3>Linear</h3>
        <label>Count <input id="ar-count" type="number" min="2" max="64" value="4"></label>
        <label>Step <span>
          <input id="ar-x" type="number" step="0.125" value="1" style="width:52px">
          <input id="ar-y" type="number" step="0.125" value="0" style="width:52px">
          <input id="ar-z" type="number" step="0.125" value="0" style="width:52px"></span></label>
        <div class="row"><button data-act="lin" class="primary">Linear array</button></div>
        <h3>Rotational</h3>
        <label>Count <input id="ar-rcount" type="number" min="2" max="64" value="6"></label>
        <label>Axis <select id="ar-raxis">
          <option value="y">Y</option><option value="x">X</option><option value="z">Z</option>
        </select></label>
        <label>Total angle (°) <input id="ar-rangle" type="number" value="360"></label>
        <label>Pivot <select id="ar-rpivot">
          <option value="origin">World origin</option>
          <option value="center">Selection center</option>
        </select></label>
        <div class="row"><button data-act="rot" class="primary">Rotational array</button></div>`,
      onPanel(el) {
        el.querySelector('[data-act=lin]').onclick = () => {
          if (!state.selection.size) return status('Select pieces to array.');
          const g = (id) => parseFloat(el.querySelector(id).value) || 0;
          const ids = model.arrayLinear([...state.selection], parseInt(el.querySelector('#ar-count').value) || 2,
            [g('#ar-x'), g('#ar-y'), g('#ar-z')]);
          status(`Created ${ids.length} copies.`);
        };
        el.querySelector('[data-act=rot]').onclick = () => {
          if (!state.selection.size) return status('Select pieces to array.');
          const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[el.querySelector('#ar-raxis').value];
          const pivot = el.querySelector('#ar-rpivot').value === 'center' ? selectionCenter() : [0, 0, 0];
          const ids = model.arrayRotational([...state.selection],
            parseInt(el.querySelector('#ar-rcount').value) || 2, axis, pivot,
            parseFloat(el.querySelector('#ar-rangle').value) || 360);
          status(`Created ${ids.length} rotated copies.`);
        };
      },
    },

    extrude: {
      label: 'Extrude', key: 'e',
      help: 'Lengthen or shorten a piece by moving one face along its normal: click a face, set the distance, Apply. Positive = outward.',
      panel: `
        <p class="tool-help" id="ex-face">No face picked yet.</p>
        <label>Distance (in) <input id="ex-dist" type="number" step="0.125" value="0.5"></label>
        <div class="row"><button data-act="go" class="primary">Apply</button></div>`,
      onPanel(el) {
        el.querySelector('[data-act=go]').onclick = () => {
          if (!state.selectedFace) return status('Click a face first.');
          const dist = parseFloat(el.querySelector('#ex-dist').value) || 0;
          model.extrudeFace(state.selectedFace.pieceId, state.selectedFace.faceIndex, dist);
          status(`Face moved ${dist > 0 ? 'outward' : 'inward'} ${Math.abs(dist)}".`);
        };
      },
      onClick(hit) {
        if (!hit) return;
        state.selectedFace = { pieceId: hit.pieceId, faceIndex: hit.faceIndex };
        viewport.selectedFace = state.selectedFace;
        viewport.invalidate();
        const el = $('#ex-face');
        if (el) el.innerHTML = `Face ${hit.faceIndex} of <b>${model.getPiece(hit.pieceId).name}</b>, normal ${fmtVec(hit.faceNormal)}.`;
      },
      onDeactivate() { viewport.selectedFace = null; },
    },

    bevel: {
      label: 'Bevel', key: 'v',
      help: 'Chamfer every sharp edge of the selected piece(s) by a set-back distance — the final polish pass.',
      panel: `
        <label>Chamfer (in) <input id="bv-dist" type="number" step="0.0078125" value="0.0625"></label>
        <div class="row"><button data-act="go" class="primary">Bevel selection</button></div>`,
      onPanel(el) {
        el.querySelector('[data-act=go]').onclick = () => {
          if (!state.selection.size) return status('Select pieces to bevel.');
          const dist = parseFloat(el.querySelector('#bv-dist').value) || 0;
          if (dist <= 0) return status('Chamfer distance must be positive.');
          model.chamferPieces([...state.selection], dist);
          status(`Beveled ${state.selection.size} piece(s) at ${dist}".`);
        };
      },
    },

    measure: {
      label: 'Measure', key: 'x',
      help: 'Click two points (snaps to corners) to measure the distance.',
      panel: `<p class="tool-help" id="me-out">Click the first point.</p>`,
      onClick(hit) {
        if (!hit) return;
        if (state.measurePts.length >= 2) state.measurePts = [];
        state.measurePts.push(hit.point);
        viewport.measurePoints = state.measurePts;
        viewport.invalidate();
        const el = $('#me-out');
        if (state.measurePts.length === 2) {
          const d = V.dist(state.measurePts[0], state.measurePts[1]);
          const delta = V.sub(state.measurePts[1], state.measurePts[0]);
          const msg = `Distance: <b>${d.toFixed(4)}"</b> &nbsp; Δ ${fmtVec(delta)}`;
          if (el) el.innerHTML = msg;
          status(msg);
        } else {
          if (el) el.textContent = 'Click the second point.';
          status(`First point ${fmtVec(hit.point)}. Click the second point.`);
        }
      },
      onDeactivate() { state.measurePts = []; viewport.measurePoints = []; viewport.invalidate(); },
    },
  };

  // =====================================================================
  // Tool activation & toolbar
  function activateTool(name) {
    const prev = TOOLS[state.activeTool];
    if (prev && prev.onDeactivate) prev.onDeactivate();
    state.activeTool = name;
    const tool = TOOLS[name];
    document.querySelectorAll('#toolbar button[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === name);
    });
    const panel = $('#tool-panel');
    panel.innerHTML = `<h3>${tool.label}</h3><p class="tool-help">${tool.help}</p>${tool.panel ?? ''}`;
    if (tool.onPanel) tool.onPanel(panel);
    if (name !== 'slice') { viewport.previewPlanes = []; viewport.invalidate(); }
    status(`<b>${tool.label}</b> — ${tool.help}`);
  }

  function buildToolbar() {
    const bar = $('#toolbar');
    bar.innerHTML = '';
    const order = ['select', 'block', 'slice', 'glue', 'plate', 'move', 'rotate', 'array', 'extrude', 'bevel', 'measure'];
    for (const name of order) {
      const b = document.createElement('button');
      b.dataset.tool = name;
      b.textContent = TOOLS[name].label;
      b.title = `${TOOLS[name].help} (${TOOLS[name].key.toUpperCase()})`;
      b.onclick = () => activateTool(name);
      bar.appendChild(b);
    }
    const sep = document.createElement('div');
    sep.className = 'sep';
    bar.appendChild(sep);
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title; b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    mk('Undo', 'Undo (Ctrl+Z)', () => { model.undo(); refreshAll(); });
    mk('Redo', 'Redo (Ctrl+Shift+Z)', () => { model.redo(); refreshAll(); });
    mk('Fit', 'Fit view to sculpture (F)', () => viewport.fitView());
    mk('Demo', 'Load a small demo sculpture', loadDemo);
  }

  // =====================================================================
  // Slice plane math
  function slicePlane() {
    const s = state.slice;
    const base = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[s.axis];
    const orthoA = { x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] }[s.axis];
    const orthoB = { x: [0, 0, 1], y: [1, 0, 0], z: [0, 1, 0] }[s.axis];
    let n = base;
    n = rotAround(n, orthoA, s.tiltA * Math.PI / 180);
    n = rotAround(n, orthoB, s.tiltB * Math.PI / 180);
    n = V.norm(n);
    const d = V.dot(n, s.base) + s.offset;
    return { n, d };
  }

  function rotAround(v, axis, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const k = V.norm(axis);
    return V.add(V.add(V.scale(v, c), V.scale(V.cross(k, v), s)), V.scale(k, V.dot(k, v) * (1 - c)));
  }

  function updateSlicePreview() {
    viewport.previewPlanes = model.pieces.length ? [slicePlane()] : [];
    viewport.invalidate();
  }

  // =====================================================================
  // Selection helpers
  function setSelection(ids) {
    state.selection.clear();
    for (const id of ids) state.selection.add(id);
    afterSelectionChange();
  }
  function clearSelection() {
    state.selection.clear();
    state.selectedFace = null;
    viewport.selectedFace = null;
    afterSelectionChange();
  }
  function afterSelectionChange() {
    viewport.invalidate();
    refreshPieceList();
    refreshSelectionPanel();
  }
  function deleteSelection() {
    if (!state.selection.size) return status('Nothing selected.');
    const n = state.selection.size;
    model.deletePieces([...state.selection]);
    state.selection.clear();
    state.selectedFace = null;
    viewport.selectedFace = null;
    status(`Deleted ${n} piece(s).`);
  }
  function selectionCenter() {
    let c = [0, 0, 0], n = 0;
    for (const id of state.selection) {
      const p = model.getPiece(id);
      if (p) { c = V.add(c, p.position); n++; }
    }
    return n ? V.scale(c, 1 / n) : [0, 0, 0];
  }

  // =====================================================================
  // Panels
  function refreshMaterialList() {
    const el = $('#material-list');
    el.innerHTML = '';
    for (const m of model.library.all()) {
      const item = document.createElement('div');
      item.className = 'mat-item' + (m.id === state.selectedMaterialId ? ' selected' : '');
      const sw = document.createElement('div');
      if (m.kind === 'dichroic') {
        sw.className = 'swatch dual';
        sw.style.setProperty('--c1', materialSwatch(m));
        sw.style.setProperty('--c2', dichroicTransmitSwatch(m));
        sw.title = 'reflect / transmit';
      } else {
        sw.className = 'swatch';
        sw.style.background = materialSwatch(m);
      }
      const name = document.createElement('div');
      name.className = 'mat-name';
      name.textContent = m.name;
      name.title = m.notes ?? '';
      const meta = document.createElement('div');
      meta.className = 'mat-meta';
      meta.textContent = m.kind === 'crystal' ? `n=${m.nd} V=${m.abbe}` : '1/8″';
      item.append(sw, name, meta);
      if (!m.preset) {
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete user material';
        del.onclick = (e) => { e.stopPropagation(); model.library.remove(m.id); refreshMaterialList(); };
        item.append(del);
      }
      item.onclick = () => {
        state.selectedMaterialId = m.id;
        if (m.kind === 'dichroic') state.selectedDichroicId = m.id;
        refreshMaterialList();
        status(`Material: <b>${m.name}</b>${m.notes ? ' — ' + m.notes : ''}`);
      };
      el.appendChild(item);
    }
  }

  function refreshPieceList() {
    const el = $('#piece-list');
    el.innerHTML = '';
    $('#piece-count').textContent = `(${model.pieces.length})`;
    for (const p of model.pieces) {
      const item = document.createElement('div');
      item.className = 'piece-item' + (state.selection.has(p.id) ? ' selected' : '');
      const vis = document.createElement('span');
      vis.className = 'vis';
      vis.textContent = p.visible ? '👁' : '–';
      vis.title = 'Toggle visibility';
      vis.onclick = (e) => { e.stopPropagation(); model.setVisibility([p.id], !p.visible); };
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.width = '12px'; sw.style.height = '12px';
      sw.style.background = materialSwatch(model.library.get(p.materialId) ?? {});
      const name = document.createElement('span');
      name.className = 'piece-name';
      name.textContent = p.name;
      name.ondblclick = (e) => {
        e.stopPropagation();
        const nn = prompt('Rename piece', p.name);
        if (nn) model.renamePiece(p.id, nn);
      };
      item.append(vis, sw, name);
      item.onclick = (e) => {
        if (e.shiftKey) {
          state.selection.has(p.id) ? state.selection.delete(p.id) : state.selection.add(p.id);
        } else {
          state.selection.clear();
          state.selection.add(p.id);
        }
        afterSelectionChange();
      };
      el.appendChild(item);
    }
  }

  function refreshSelectionPanel() {
    const el = $('#selection-panel');
    if (state.selection.size === 0) {
      el.innerHTML = '<p class="hint">No selection.</p>';
      return;
    }
    if (state.selection.size > 1) {
      let vol = 0;
      for (const id of state.selection) {
        const info = model.pieceInfo(id);
        if (info) vol += info.volume;
      }
      el.innerHTML = `<h2>${state.selection.size} pieces</h2>
        <table><tr><td>Total volume</td><td>${vol.toFixed(3)} in³</td></tr></table>`;
      return;
    }
    const id = [...state.selection][0];
    const info = model.pieceInfo(id);
    if (!info) { el.innerHTML = ''; return; }
    el.innerHTML = `<h2>Selection</h2>
      <table>
        <tr><td>Name</td><td>${info.name}</td></tr>
        <tr><td>Material</td><td>
          <select id="sel-mat">${model.library.all().map((m) =>
            `<option value="${m.id}" ${m.id === (info.material && info.material.id) ? 'selected' : ''}>${m.name}</option>`).join('')}
        </select></td></tr>
        <tr><td>Bounds</td><td>${info.dims.map((d) => d.toFixed(3)).join(' × ')} in</td></tr>
        <tr><td>Volume</td><td>${info.volume.toFixed(4)} in³</td></tr>
        <tr><td>Faces</td><td>${info.faces}</td></tr>
        ${state.selectedFace ? `<tr><td>Face</td><td>#${state.selectedFace.faceIndex} selected</td></tr>` : ''}
      </table>`;
    el.querySelector('#sel-mat').onchange = (e) => {
      model.setPieceMaterial([id], e.target.value);
      refreshMaterialList();
    };
  }

  function refreshAll() {
    refreshMaterialList();
    refreshPieceList();
    refreshSelectionPanel();
    $('#project-name').value = model.projectName;
  }

  // =====================================================================
  // Viewport interaction
  viewport.onClick = (x, y, ev) => {
    const tool = TOOLS[state.activeTool];
    const hit = state.activeTool === 'measure' ? viewport.pickSnapped(x, y) : viewport.pick(x, y);
    if (tool.onClick) tool.onClick(hit, ev);
  };

  let hoverPending = false;
  viewport.onHover = (x, y) => {
    if (hoverPending) return;
    const faceTools = ['glue', 'plate', 'extrude', 'select', 'slice'];
    if (!faceTools.includes(state.activeTool)) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const hit = viewport.pick(x, y);
      const next = hit ? { pieceId: hit.pieceId, faceIndex: hit.faceIndex } : null;
      const cur = viewport.hoverFace;
      if ((cur && next && cur.pieceId === next.pieceId && cur.faceIndex === next.faceIndex) || (!cur && !next)) return;
      viewport.hoverFace = next;
      viewport.invalidate();
    });
  };

  // =====================================================================
  // Model change -> refresh lists
  model.onChange(() => {
    refreshPieceList();
    refreshSelectionPanel();
    // Drop selection of pieces that vanished.
    for (const id of [...state.selection]) {
      if (!model.getPiece(id)) state.selection.delete(id);
    }
  });

  // =====================================================================
  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? model.redo() : model.undo();
      refreshAll();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); model.redo(); refreshAll(); return; }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      store.saveCurrent();
      status('Project saved.');
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
    if (e.key === 'Escape') { activateTool('select'); clearSelection(); return; }
    if (e.key.toLowerCase() === 'f') { viewport.fitView(); return; }
    // Arrow nudges in move tool.
    if (state.activeTool === 'move' && state.selection.size) {
      const step = parseFloat(($('#mv-step') || {}).value) || 0.125;
      const map = {
        ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0],
        ArrowUp: [0, 0, -step], ArrowDown: [0, 0, step],
        PageUp: [0, step, 0], PageDown: [0, -step, 0],
      };
      if (map[e.key]) {
        e.preventDefault();
        model.translatePieces([...state.selection], map[e.key]);
        return;
      }
    }
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (e.key.toLowerCase() === tool.key) { activateTool(name); return; }
    }
  });

  // =====================================================================
  // Modals
  function openModal(html) {
    const m = $('#modal');
    m.innerHTML = html;
    $('#modal-backdrop').classList.remove('hidden');
    return m;
  }
  function closeModal() { $('#modal-backdrop').classList.add('hidden'); }
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });

  $('#btn-projects').onclick = () => {
    const projects = store.listProjects();
    const m = openModal(`<h2>Projects</h2>
      <div id="proj-list">${projects.length ? '' : '<p class="hint">No saved projects yet.</p>'}</div>
      <div class="modal-buttons"><button data-act="close">Close</button></div>`);
    const list = m.querySelector('#proj-list');
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<span style="flex:1">${p.name}</span>
        <span class="hint">${new Date(p.updated).toLocaleString()}</span>
        <button data-open>Open</button><button data-del class="danger">Delete</button>`;
      row.querySelector('[data-open]').onclick = () => {
        store.loadProject(p.id);
        clearSelection();
        refreshAll();
        viewport.fitView();
        closeModal();
        status(`Opened <b>${model.projectName}</b>.`);
      };
      row.querySelector('[data-del]').onclick = () => {
        if (confirm(`Delete project "${p.name}" and all its versions?`)) {
          store.deleteProject(p.id);
          row.remove();
        }
      };
      list.appendChild(row);
    }
    m.querySelector('[data-act=close]').onclick = closeModal;
  };

  $('#btn-versions').onclick = () => {
    const versions = store.listVersions();
    const m = openModal(`<h2>Versions of "${model.projectName}"</h2>
      <div id="ver-list">${versions.length ? '' : '<p class="hint">No versions saved yet. Use "Save Version" to snapshot milestones.</p>'}</div>
      <div class="modal-buttons"><button data-act="close">Close</button></div>`);
    const list = m.querySelector('#ver-list');
    for (const v of [...versions].reverse()) {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<span style="flex:1">${v.label}</span>
        <span class="hint">${new Date(v.ts).toLocaleString()}</span>
        <button data-restore>Restore</button><button data-del class="danger">Delete</button>`;
      row.querySelector('[data-restore]').onclick = () => {
        store.restoreVersion(v.index);
        clearSelection();
        refreshAll();
        closeModal();
        status(`Restored version <b>${v.label}</b> (undo to go back).`);
      };
      row.querySelector('[data-del]').onclick = () => { store.deleteVersion(v.index); row.remove(); };
      list.appendChild(row);
    }
    m.querySelector('[data-act=close]').onclick = closeModal;
  };

  $('#btn-save-version').onclick = () => {
    const label = prompt('Version label', `After ${model.pieces.length} pieces`);
    if (label === null) return;
    store.saveVersion(label);
    status(`Saved version <b>${label}</b>.`);
  };

  $('#btn-new').onclick = () => {
    if (model.pieces.length && !confirm('Start a new project? (current project stays saved)')) return;
    store.saveCurrent();
    model.deserialize({ format: 'coldworking-cad', version: 1, projectName: 'Untitled sculpture', pieces: [] });
    store.newProject('Untitled sculpture');
    clearSelection();
    refreshAll();
    status('New project.');
  };

  $('#btn-export').onclick = () => { store.saveCurrent(); store.exportFile(); };
  $('#btn-import').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      await store.importFile(f);
      clearSelection();
      refreshAll();
      viewport.fitView();
      status(`Imported <b>${model.projectName}</b>.`);
    } catch (err) {
      status(`<span class="error">Import failed: ${err.message}</span>`);
    }
  };

  $('#project-name').addEventListener('change', (e) => {
    model.projectName = e.target.value || 'Untitled sculpture';
    store.saveCurrent();
  });

  // ---- add material dialogs ----
  $('#btn-add-crystal').onclick = () => {
    const m = openModal(`<h2>New crystal material</h2>
      <label>Name <input id="nc-name" value="Custom crystal"></label>
      <label>Index n<sub>d</sub> <input id="nc-nd" type="number" step="0.001" value="1.52"></label>
      <label>Abbe number V<sub>d</sub> <input id="nc-abbe" type="number" step="0.1" value="60"></label>
      <p class="hint">Lower Abbe number = more dispersion ("fire"). BK7 ≈ 64, dense flint ≈ 25.</p>
      <div class="modal-buttons"><button data-act="cancel">Cancel</button>
      <button data-act="ok" class="primary">Add</button></div>`);
    m.querySelector('[data-act=cancel]').onclick = closeModal;
    m.querySelector('[data-act=ok]').onclick = () => {
      const mat = model.library.addCrystal({
        name: m.querySelector('#nc-name').value || 'Custom crystal',
        nd: parseFloat(m.querySelector('#nc-nd').value) || 1.52,
        abbe: parseFloat(m.querySelector('#nc-abbe').value) || 60,
      });
      state.selectedMaterialId = mat.id;
      store.saveCurrent();
      refreshMaterialList();
      closeModal();
    };
  };

  $('#btn-add-dichroic').onclick = () => {
    const m = openModal(`<h2>New dichroic coating</h2>
      <label>Name <input id="nd-name" value="Custom dichroic"></label>
      <h3 style="font-size:13px">Reflection band 1</h3>
      <label>Center (nm) <input id="nd-c1" type="number" min="380" max="730" value="520"></label>
      <label>Width (nm) <input id="nd-w1" type="number" min="20" max="350" value="120"></label>
      <label>Peak reflectance <input id="nd-s1" type="number" min="0" max="0.99" step="0.01" value="0.95"></label>
      <label class="check"><input id="nd-b2" type="checkbox"> Second band</label>
      <div id="nd-band2" class="hidden">
        <label>Center (nm) <input id="nd-c2" type="number" min="380" max="730" value="650"></label>
        <label>Width (nm) <input id="nd-w2" type="number" min="20" max="350" value="100"></label>
        <label>Peak reflectance <input id="nd-s2" type="number" min="0" max="0.99" step="0.01" value="0.9"></label>
      </div>
      <div class="row">Preview: reflect <div class="swatch" id="nd-prev-r"></div>
        transmit <div class="swatch" id="nd-prev-t"></div></div>
      <div class="modal-buttons"><button data-act="cancel">Cancel</button>
      <button data-act="ok" class="primary">Add</button></div>`);
    const bands = () => {
      const out = [{
        center: parseFloat(m.querySelector('#nd-c1').value) || 520,
        width: parseFloat(m.querySelector('#nd-w1').value) || 120,
        strength: parseFloat(m.querySelector('#nd-s1').value) || 0.95,
      }];
      if (m.querySelector('#nd-b2').checked) {
        out.push({
          center: parseFloat(m.querySelector('#nd-c2').value) || 650,
          width: parseFloat(m.querySelector('#nd-w2').value) || 100,
          strength: parseFloat(m.querySelector('#nd-s2').value) || 0.9,
        });
      }
      return out;
    };
    const updPrev = () => {
      const fake = { bands: bands() };
      m.querySelector('#nd-prev-r').style.background = materialSwatch({ kind: 'dichroic', ...fake });
      m.querySelector('#nd-prev-t').style.background = dichroicTransmitSwatch(fake);
    };
    m.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
      m.querySelector('#nd-band2').classList.toggle('hidden', !m.querySelector('#nd-b2').checked);
      updPrev();
    }));
    updPrev();
    m.querySelector('[data-act=cancel]').onclick = closeModal;
    m.querySelector('[data-act=ok]').onclick = () => {
      const mat = model.library.addDichroic({
        name: m.querySelector('#nd-name').value || 'Custom dichroic',
        bands: bands(),
      });
      state.selectedDichroicId = mat.id;
      store.saveCurrent();
      refreshMaterialList();
      closeModal();
    };
  };

  // =====================================================================
  // Render tab
  let renderActive = false;

  function switchTab(which) {
    $('#tab-design').classList.toggle('active', which === 'design');
    $('#tab-render').classList.toggle('active', which === 'render');
    $('#design-tab').classList.toggle('active', which === 'design');
    $('#render-tab').classList.toggle('active', which === 'render');
    renderActive = which === 'render';
    if (renderActive) startRender();
    else if (state.tracer) state.tracer.stop();
    if (which === 'design') viewport.invalidate();
  }
  $('#tab-design').onclick = () => switchTab('design');
  $('#tab-render').onclick = () => switchTab('render');

  function ensureTracer() {
    if (state.tracer) return state.tracer;
    try {
      state.tracer = new PathTracer($('#render-canvas'));
      state.tracer.onProgress = (s) => {
        const tris = state.tracer.scene ? state.tracer.scene.triangles.matFront.length : 0;
        $('#render-stats').textContent = `${s} samples/pixel · ${tris} triangles · ${state.tracer.nodeCount} BVH nodes`;
      };
      bindRenderControls();
    } catch (err) {
      $('#render-error').textContent = err.message;
      return null;
    }
    return state.tracer;
  }

  function syncRenderScene() {
    const tracer = ensureTracer();
    if (!tracer) return;
    const scene = buildRenderScene(model);
    // Normalize typed arrays.
    scene.triangles.positions = new Float32Array(scene.triangles.positions);
    scene.triangles.normals = new Float32Array(scene.triangles.normals);
    tracer.setScene(scene);
    tracer.setOptions({ floorY: scene.bbox.min[1] - 1e-4 });
    const warnings = [];
    if (scene.materials.length > 16) warnings.push('More than 15 distinct materials; extras render incorrectly.');
    if (scene.coatings.length > 16) warnings.push('More than 16 distinct coatings; extras are ignored.');
    const overlaps = model.findOverlaps();
    if (overlaps.length) {
      const names = overlaps.slice(0, 3).map((o) =>
        `${model.getPiece(o.a)?.name} ∩ ${model.getPiece(o.b)?.name}`).join('; ');
      warnings.push(`${overlaps.length} piece pair(s) interpenetrate (${names}${overlaps.length > 3 ? '…' : ''}) — real glass can't overlap, and the render will be wrong there.`);
    }
    $('#render-error').textContent = warnings.join('\n');
  }

  function startRender() {
    const tracer = ensureTracer();
    if (!tracer) return;
    // Adopt the design camera orbit.
    state.renderCam.theta = viewport.theta;
    state.renderCam.phi = viewport.phi;
    state.renderCam.dist = viewport.dist;
    state.renderCam.target = viewport.target.slice();
    syncRenderScene();
    applyRenderCamera();
    tracer.start();
  }

  function applyRenderCamera() {
    const c = state.renderCam;
    const cp = Math.cos(c.phi), sp = Math.sin(c.phi);
    const ct = Math.cos(c.theta), st = Math.sin(c.theta);
    const eye = V.add(c.target, V.scale([cp * ct, sp, cp * st], c.dist));
    state.tracer.setCamera({ eye, target: c.target.slice(), fov: 40 * Math.PI / 180 });
  }

  function bindRenderControls() {
    const canvas = $('#render-canvas');
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      state.renderCam.theta += dx * 0.008;
      state.renderCam.phi = Math.max(-1.5, Math.min(1.5, state.renderCam.phi + dy * 0.008));
      applyRenderCamera();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.renderCam.dist *= Math.exp(e.deltaY * 0.0012);
      state.renderCam.dist = Math.max(0.3, Math.min(300, state.renderCam.dist));
      applyRenderCamera();
    }, { passive: false });

    const opt = () => state.tracer.setOptions({
      bounces: parseInt($('#rt-bounces').value) || 24,
      envIntensity: parseFloat($('#rt-env').value) || 1,
      exposure: parseFloat($('#rt-exposure').value) || 1,
      scale: parseFloat($('#rt-scale').value) || 1,
      dispersion: $('#rt-dispersion').checked,
      floor: $('#rt-floor').checked,
    });
    for (const id of ['#rt-bounces', '#rt-env', '#rt-exposure', '#rt-scale', '#rt-dispersion', '#rt-floor']) {
      $(id).addEventListener('change', opt);
    }
    $('#rt-update').onclick = syncRenderScene;
    $('#rt-restart').onclick = () => state.tracer.reset();
    $('#rt-save-png').onclick = () => {
      const a = document.createElement('a');
      a.download = `${model.projectName.replace(/\s+/g, '_')}_render.png`;
      a.href = $('#render-canvas').toDataURL('image/png');
      a.click();
    };
    $('#rt-export-scene').onclick = () => {
      const scene = buildRenderScene(model);
      store.exportRenderScene(scene);
      status('Render scene exported — open it with render.html (standalone visualizer).');
    };
    opt();
  }

  // =====================================================================
  // Demo sculpture
  function loadDemo() {
    if (model.pieces.length && !confirm('Replace current pieces with the demo sculpture?')) return;
    buildDemoSculpture(model);
    store.newProject(model.projectName);
    clearSelection();
    refreshAll();
    viewport.fitView();
    store.saveCurrent();
    status('Demo sculpture loaded — try the <b>Render</b> tab.');
  }

  // =====================================================================
  // Boot
  buildToolbar();
  activateTool('select');

  // Reopen the most recent project, if any.
  const recent = store.listProjects();
  if (recent.length && store.loadProject(recent[0].id)) {
    status(`Reopened <b>${model.projectName}</b>.`);
  } else {
    store.newProject('Untitled sculpture');
    status('Welcome! Add a block (B), or press <b>Demo</b> in the toolbar to load a sample sculpture.');
  }
  refreshAll();
  viewport.fitView();
}

function fmtVec(v) {
  return `(${v.map((x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(3)).join(', ')})`;
}
