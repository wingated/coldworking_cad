// Editor viewport: WebGL2 rasterizer for the design view.
// Glass pieces draw translucent with flat shading and edge lines; picking is
// done on the CPU against the convex polyhedra (exact and cheap at this
// scale). The render tab has its own path tracer; this view is for editing.

import { triangulate, polyEdges, raycastPoly, faceNormal } from './geometry.js';
import { V, M4 } from './math.js';
import { spectrumToRGB, dichroicReflectance } from './spectra.js';

const SOLID_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aColor;
uniform mat4 uProj, uView;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPos;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorld;
uniform vec3 uEye;
out vec4 frag;
void main() {
  vec3 n = normalize(vNormal);
  vec3 viewDir = normalize(uEye - vWorld);
  if (dot(n, viewDir) < 0.0) n = -n;
  vec3 l1 = normalize(vec3(0.5, 0.8, 0.6));
  vec3 l2 = normalize(vec3(-0.6, 0.3, -0.5));
  float diff = 0.35 + 0.45 * max(dot(n, l1), 0.0) + 0.25 * max(dot(n, l2), 0.0);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  vec3 col = vColor.rgb * diff + vec3(0.9) * fres * 0.35;
  float spec = pow(max(dot(reflect(-l1, n), viewDir), 0.0), 60.0);
  col += vec3(spec) * 0.5;
  frag = vec4(col, vColor.a + fres * 0.25);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uProj, uView;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  gl_Position.z -= 0.0002 * gl_Position.w; // bias lines toward camera
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 frag;
void main() { frag = vColor; }`;

function compile(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vsSrc], [gl.FRAGMENT_SHADER, fsSrc]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Link: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

export class Viewport {
  constructor(canvas, model) {
    this.canvas = canvas;
    this.model = model;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    this.solidProg = compile(gl, SOLID_VS, SOLID_FS);
    this.lineProg = compile(gl, LINE_VS, LINE_FS);

    this.solidVAO = gl.createVertexArray();
    this.solidBuf = gl.createBuffer();
    this.lineVAO = gl.createVertexArray();
    this.lineBuf = gl.createBuffer();
    this._setupVAO(this.solidVAO, this.solidBuf, true);
    this._setupVAO(this.lineVAO, this.lineBuf, false);

    // Orbit camera.
    this.target = [0, 0, 0];
    this.theta = 0.7;   // azimuth
    this.phi = 1.1;     // polar from +z... we use y-up: phi from horizon
    this.dist = 10;
    this.fov = 45 * Math.PI / 180;

    this.selection = new Set();
    this.hoverFace = null;       // {pieceId, faceIndex}
    this.selectedFace = null;    // {pieceId, faceIndex} in face mode
    this.previewPlanes = [];     // [{n, d}]
    this.measurePoints = [];     // [[x,y,z], ...]

    this._builtRev = -1;
    this._dirty = true;
    this._solidCount = 0;
    this._lineCount = 0;
    this._matColorCache = new Map();

    this._bindEvents();
    model.onChange(() => this.invalidate());
    const loop = () => { this._frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _setupVAO(vao, buf, hasNormal) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = hasNormal ? 40 : 28; // pos3 + (normal3) + color4 floats
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    if (hasNormal) {
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    } else {
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 12);
    }
    gl.bindVertexArray(null);
  }

  invalidate() { this._dirty = true; }

  eye() {
    const cp = Math.cos(this.phi), sp = Math.sin(this.phi);
    const ct = Math.cos(this.theta), st = Math.sin(this.theta);
    return V.add(this.target, V.scale([cp * ct, sp, cp * st], this.dist));
  }

  fitView() {
    const bb = this.model.sceneBBox();
    this.target = V.scale(V.add(bb.min, bb.max), 0.5);
    const size = V.len(V.sub(bb.max, bb.min));
    this.dist = Math.max(2, size * 1.4);
    this.invalidate();
  }

  materialColor(materialId) {
    if (this._matColorCache.has(materialId)) return this._matColorCache.get(materialId);
    const m = this.model.library.get(materialId);
    let rgb;
    if (!m) rgb = [0.7, 0.7, 0.7];
    else if (m.kind === 'crystal') {
      const t = Math.min(1, Math.max(0, (m.nd - 1.45) / 0.5));
      rgb = [0.62 - 0.2 * t, 0.78 - 0.05 * t, 0.85 + 0.1 * t];
    } else {
      rgb = spectrumToRGB((l) => dichroicReflectance(m.bands, l)).map((c) => Math.min(1, c * 1.4));
    }
    this._matColorCache.set(materialId, rgb);
    return rgb;
  }

  _rebuild() {
    const gl = this.gl;
    const solid = [];
    const lines = [];
    this._matColorCache.clear();

    for (const piece of this.model.pieces) {
      if (!piece.visible) continue;
      const wp = this.model.worldPoly(piece);
      const tri = triangulate(wp);
      const selected = this.selection.has(piece.id);
      const base = this.materialColor(piece.materialId);
      const m = this.model.library.get(piece.materialId);
      const alpha = m && m.kind === 'dichroic' ? 0.75 : 0.42;
      const col = selected ? [
        Math.min(1, base[0] * 0.6 + 0.45), Math.min(1, base[1] * 0.6 + 0.35), base[2] * 0.6 + 0.1,
      ] : base;

      const hf = this.hoverFace && this.hoverFace.pieceId === piece.id ? this.hoverFace.faceIndex : -1;
      const sf = this.selectedFace && this.selectedFace.pieceId === piece.id ? this.selectedFace.faceIndex : -1;

      const nTris = tri.faceIds.length;
      for (let t = 0; t < nTris; t++) {
        const fi = tri.faceIds[t];
        let c = col, a = selected ? Math.min(1, alpha + 0.18) : alpha;
        if (fi === sf) { c = [1.0, 0.55, 0.15]; a = 0.85; }
        else if (fi === hf) { c = [1.0, 0.8, 0.3]; a = 0.7; }
        const coated = wp.faces[fi].coating != null;
        if (coated && fi !== sf && fi !== hf) { c = [c[0], c[1] * 0.9, c[2] * 0.6]; a = Math.min(1, a + 0.2); }
        for (let v = 0; v < 3; v++) {
          const o = (t * 3 + v) * 3;
          solid.push(
            tri.positions[o], tri.positions[o + 1], tri.positions[o + 2],
            tri.normals[o], tri.normals[o + 1], tri.normals[o + 2],
            c[0], c[1], c[2], a,
          );
        }
      }

      // Edges.
      const ec = selected ? [1, 0.75, 0.2, 1] : [0.15, 0.2, 0.28, 0.9];
      for (const e of polyEdges(wp)) {
        lines.push(...wp.verts[e.a], ...ec, ...wp.verts[e.b], ...ec);
      }
    }

    // Ground grid (y = bottom of scene bbox, or 0).
    const bb = this.model.sceneBBox();
    const gy = this.model.pieces.length ? Math.min(0, bb.min[1]) - 0.001 : 0;
    const ext = 10;
    for (let i = -ext; i <= ext; i++) {
      const major = i % 5 === 0;
      const c = major ? [0.45, 0.5, 0.58, 0.55] : [0.36, 0.4, 0.47, 0.3];
      lines.push(i, gy, -ext, ...c, i, gy, ext, ...c);
      lines.push(-ext, gy, i, ...c, ext, gy, i, ...c);
    }
    // Axes.
    lines.push(0, gy, 0, 0.9, 0.25, 0.25, 1, 1.5, gy, 0, 0.9, 0.25, 0.25, 1);
    lines.push(0, gy, 0, 0.3, 0.85, 0.3, 1, 0, gy + 1.5, 0, 0.3, 0.85, 0.3, 1);
    lines.push(0, gy, 0, 0.35, 0.5, 1, 1, 0, gy, 1.5, 0.35, 0.5, 1, 1);

    // Preview planes (slice tool).
    for (const pl of this.previewPlanes) {
      const quad = planeQuad(pl.n, pl.d, this.model, 1.3);
      const pc = [1.0, 0.35, 0.3, 1];
      for (let i = 0; i < 4; i++) {
        lines.push(...quad[i], ...pc, ...quad[(i + 1) % 4], ...pc);
      }
      lines.push(...quad[0], ...pc, ...quad[2], ...pc);
      lines.push(...quad[1], ...pc, ...quad[3], ...pc);
    }

    // Measure overlay.
    if (this.measurePoints.length >= 1) {
      const mc = [0.2, 1, 0.6, 1];
      for (const p of this.measurePoints) {
        const s = 0.06;
        lines.push(p[0] - s, p[1], p[2], ...mc, p[0] + s, p[1], p[2], ...mc);
        lines.push(p[0], p[1] - s, p[2], ...mc, p[0], p[1] + s, p[2], ...mc);
        lines.push(p[0], p[1], p[2] - s, ...mc, p[0], p[1], p[2] + s, ...mc);
      }
      if (this.measurePoints.length === 2) {
        lines.push(...this.measurePoints[0], ...mc, ...this.measurePoints[1], ...mc);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(solid), gl.DYNAMIC_DRAW);
    this._solidCount = solid.length / 10;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW);
    this._lineCount = lines.length / 7;
  }

  _frame() {
    if (!this._dirty) return;
    this._dirty = false;
    const gl = this.gl, canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    this._rebuild();

    gl.viewport(0, 0, w, h);
    gl.clearColor(0.13, 0.15, 0.18, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const eye = this.eye();
    const proj = M4.perspective(this.fov, w / h, 0.05, 500);
    const view = M4.lookAt(eye, this.target, [0, 1, 0]);

    // Lines first (opaque-ish, depth-tested).
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uView'), false, view);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.lineVAO);
    gl.drawArrays(gl.LINES, 0, this._lineCount);

    // Translucent solids: draw back faces then front faces for a fuller
    // glassy look, without depth writes.
    gl.useProgram(this.solidProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.solidProg, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.solidProg, 'uView'), false, view);
    gl.uniform3fv(gl.getUniformLocation(this.solidProg, 'uEye'), eye);
    gl.depthMask(false);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(this.solidVAO);
    gl.cullFace(gl.FRONT);
    gl.drawArrays(gl.TRIANGLES, 0, this._solidCount);
    gl.cullFace(gl.BACK);
    gl.drawArrays(gl.TRIANGLES, 0, this._solidCount);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  // Ray through pixel (CSS coords relative to canvas).
  pixelRay(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((px - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((py - rect.top) / rect.height) * 2;
    const eye = this.eye();
    const aspect = rect.width / rect.height;
    const tanF = Math.tan(this.fov / 2);
    const fwd = V.norm(V.sub(this.target, eye));
    const right = V.norm(V.cross(fwd, [0, 1, 0]));
    const up = V.cross(right, fwd);
    const dir = V.norm(V.add(fwd, V.add(V.scale(right, x * tanF * aspect), V.scale(up, y * tanF))));
    return { origin: eye, dir };
  }

  pick(px, py) {
    const { origin, dir } = this.pixelRay(px, py);
    let best = null;
    for (const piece of this.model.pieces) {
      if (!piece.visible) continue;
      const wp = this.model.worldPoly(piece);
      const hit = raycastPoly(wp, origin, dir);
      if (hit && hit.t > 0 && (!best || hit.t < best.t)) {
        best = {
          t: hit.t,
          pieceId: piece.id,
          faceIndex: hit.faceIndex,
          point: V.add(origin, V.scale(dir, hit.t)),
        };
      }
    }
    if (best && best.faceIndex >= 0) {
      const wp = this.model.worldPoly(this.model.getPiece(best.pieceId));
      best.faceNormal = faceNormal(wp, wp.faces[best.faceIndex]);
    }
    return best;
  }

  // Snap a picked point to the nearest vertex of the hit piece if close.
  pickSnapped(px, py, snapDist = 0.15) {
    const hit = this.pick(px, py);
    if (!hit) return null;
    const wp = this.model.worldPoly(this.model.getPiece(hit.pieceId));
    let best = null;
    for (const v of wp.verts) {
      const d = V.dist(v, hit.point);
      if (d < snapDist && (!best || d < best.d)) best = { d, v };
    }
    if (best) hit.point = best.v.slice();
    return hit;
  }

  _bindEvents() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, shift: e.shiftKey };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.onHover) this.onHover(e.clientX, e.clientY);
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.button === 0 && !drag.shift) {
        this.theta += dx * 0.008;
        this.phi = Math.max(-1.5, Math.min(1.5, this.phi + dy * 0.008));
      } else {
        // Pan.
        const eye = this.eye();
        const fwd = V.norm(V.sub(this.target, eye));
        const right = V.norm(V.cross(fwd, [0, 1, 0]));
        const up = V.cross(right, fwd);
        const scale = this.dist * 0.0016;
        this.target = V.add(this.target,
          V.add(V.scale(right, -dx * scale), V.scale(up, dy * scale)));
      }
      this.invalidate();
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && drag.button === 0 && this.onClick) {
        this.onClick(e.clientX, e.clientY, e);
      }
      drag = null;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist *= Math.exp(e.deltaY * 0.0012);
      this.dist = Math.max(0.3, Math.min(300, this.dist));
      this.invalidate();
    }, { passive: false });
    new ResizeObserver(() => this.invalidate()).observe(c);
  }
}

// A quad spanning the model bbox, lying in plane (n, d), for slice preview.
function planeQuad(n, d, model, scale = 1.2) {
  const bb = model.sceneBBox();
  const c0 = V.scale(V.add(bb.min, bb.max), 0.5);
  const half = (V.len(V.sub(bb.max, bb.min)) / 2 + 0.5) * scale;
  // Project bbox center onto plane.
  const c = V.add(c0, V.scale(n, d - V.dot(n, c0)));
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = V.norm(V.cross(n, a));
  const w = V.cross(n, u);
  return [
    V.add(c, V.add(V.scale(u, -half), V.scale(w, -half))),
    V.add(c, V.add(V.scale(u, half), V.scale(w, -half))),
    V.add(c, V.add(V.scale(u, half), V.scale(w, half))),
    V.add(c, V.add(V.scale(u, -half), V.scale(w, half))),
  ];
}
