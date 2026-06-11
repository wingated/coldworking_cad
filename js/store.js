// Project persistence: autosave + named version snapshots in localStorage,
// plus file export/import (.coldwork.json) for backup and sharing.

const INDEX_KEY = 'cwcad_projects_v1';
const PROJ_PREFIX = 'cwcad_proj_v1_';

function readJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch { return fallback; }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export class ProjectStore {
  constructor(model) {
    this.model = model;
    this.currentProjectId = null;
    this._autosaveTimer = null;
    model.onChange(() => this._scheduleAutosave());
  }

  listProjects() {
    return readJSON(INDEX_KEY, []).sort((a, b) => b.updated - a.updated);
  }

  _updateIndex(id, name) {
    const idx = readJSON(INDEX_KEY, []).filter((p) => p.id !== id);
    idx.push({ id, name, updated: Date.now() });
    writeJSON(INDEX_KEY, idx);
  }

  newProject(name = 'Untitled sculpture') {
    this.currentProjectId = `p${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    this.model.projectName = name;
    this.saveCurrent();
    return this.currentProjectId;
  }

  saveCurrent() {
    if (!this.currentProjectId) this.newProject(this.model.projectName);
    const key = PROJ_PREFIX + this.currentProjectId;
    const data = readJSON(key, { versions: [] });
    data.current = this.model.serialize();
    data.updated = Date.now();
    writeJSON(key, data);
    this._updateIndex(this.currentProjectId, this.model.projectName);
  }

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this.saveCurrent(), 800);
  }

  // Named snapshot, kept forever (until deleted).
  saveVersion(label) {
    if (!this.currentProjectId) this.newProject(this.model.projectName);
    const key = PROJ_PREFIX + this.currentProjectId;
    const data = readJSON(key, { versions: [] });
    data.versions.push({
      ts: Date.now(),
      label: label || `Version ${data.versions.length + 1}`,
      doc: this.model.serialize(),
    });
    data.current = this.model.serialize();
    writeJSON(key, data);
    this._updateIndex(this.currentProjectId, this.model.projectName);
  }

  listVersions() {
    if (!this.currentProjectId) return [];
    const data = readJSON(PROJ_PREFIX + this.currentProjectId, { versions: [] });
    return data.versions.map((v, i) => ({ index: i, ts: v.ts, label: v.label }));
  }

  restoreVersion(index) {
    const data = readJSON(PROJ_PREFIX + this.currentProjectId, null);
    if (!data || !data.versions[index]) return false;
    this.model.checkpoint(); // restoring is undoable
    this.model.deserialize(structuredClone(data.versions[index].doc), { silent: true });
    this.model._notify();
    return true;
  }

  deleteVersion(index) {
    const key = PROJ_PREFIX + this.currentProjectId;
    const data = readJSON(key, null);
    if (!data) return;
    data.versions.splice(index, 1);
    writeJSON(key, data);
  }

  loadProject(id) {
    const data = readJSON(PROJ_PREFIX + id, null);
    if (!data || !data.current) return false;
    this.currentProjectId = id;
    this.model.deserialize(data.current);
    return true;
  }

  deleteProject(id) {
    localStorage.removeItem(PROJ_PREFIX + id);
    writeJSON(INDEX_KEY, readJSON(INDEX_KEY, []).filter((p) => p.id !== id));
    if (this.currentProjectId === id) this.currentProjectId = null;
  }

  // ---- file export/import ----
  exportFile() {
    const doc = this.model.serialize();
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    downloadBlob(blob, `${sanitize(this.model.projectName)}.coldwork.json`);
  }

  exportRenderScene(scene) {
    const blob = new Blob([JSON.stringify(scene)], { type: 'application/json' });
    downloadBlob(blob, `${sanitize(this.model.projectName)}.render.json`);
  }

  async importFile(file) {
    const text = await file.text();
    const json = JSON.parse(text);
    this.model.deserialize(json);
    this.newProject(this.model.projectName);
  }
}

function sanitize(name) {
  return (name || 'sculpture').replace(/[^a-z0-9_\- ]/gi, '').replace(/\s+/g, '_') || 'sculpture';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
