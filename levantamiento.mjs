// API del levantamiento de requerimientos (Netlify Functions v2 + Netlify Blobs).
import { getStore } from '@netlify/blobs';
import { users, checkPass, makeToken, verifyReq, sessionCookie, SESSION_HOURS, env } from '../shared/auth.mjs';

const COLLS = ['macro', 'sub', 'reqs'];
const ID_RE = /^[A-Za-z0-9._~:@+-]{1,80}$/;
const MAX_BODY = 900 * 1024;
const TZ = 'America/Costa_Rica';

function store() {
  if (globalThis.__LEV_TEST_STORE__) return globalThis.__LEV_TEST_STORE__; // solo pruebas locales
  if (env('LEV_LOCAL_BLOBS_URL')) return getStore({ name: 'levantamiento', siteID: 'local', token: 'local', edgeURL: env('LEV_LOCAL_BLOBS_URL') });
  return getStore({ name: 'levantamiento', consistency: 'strong' });
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (status, code, error) => json({ code, error }, status);
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
function deepMerge(a, b) { const o = isObj(a) ? { ...a } : {}; for (const k in b) { o[k] = isObj(b[k]) ? deepMerge(o[k], b[k]) : b[k]; } return o; }
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function hasDelete(o) { if (!isObj(o)) return false; for (const k in o) { if (k === 'deleted' && o[k] === true) return true; if (isObj(o[k]) && hasDelete(o[k])) return true; } return false; }
function badKeys(o, depth = 0) { if (depth > 30) return true; if (!isObj(o)) return false; for (const k in o) { if (k.startsWith('__') || k === 'constructor' || k === 'prototype') return true; if (isObj(o[k]) && badKeys(o[k], depth + 1)) return true; } return false; }
async function pmap(arr, n, fn) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const j = i++; out[j] = await fn(arr[j], j); } })); return out; }
const dayKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Manifiesto de revisiones (para sincronización incremental) ---------- */
async function bumpManifest(st, keys, del = false) {
  for (let i = 0; i < 12; i++) {
    const cur = await st.getWithMetadata('meta/manifest', { type: 'json' });
    const m = (cur && cur.data) || { rev: 0, keys: {} };
    m.rev = (m.rev || 0) + 1; m.keys = m.keys || {};
    keys.forEach(k => { m.keys[k] = del ? { r: m.rev, d: 1 } : { r: m.rev }; });
    const res = cur ? await st.setJSON('meta/manifest', m, { onlyIfMatch: cur.etag }) : await st.setJSON('meta/manifest', m, { onlyIfNew: true });
    if (res.modified) return m.rev;
    await sleep(20 + Math.random() * 60 * (i + 1));
  }
  throw new Error('manifest_conflict');
}

/* ---------- Bitácora (un blob por día, con agrupación de ediciones consecutivas) ---------- */
function trunc(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `[${v.length} elemento(s)]`;
  if (isObj(v)) return '{…}';
  const s = String(v); return s.length > 300 ? s.slice(0, 297) + '…' : s;
}
function flatten(o, pre = '', out = []) { for (const k in o) { if (!pre && ['updatedAt', 'updatedBy', 'historial', 'revisionesIA'].includes(k)) continue; const p = pre ? pre + '.' + k : k; if (isObj(o[k]) && Object.keys(o[k]).length) flatten(o[k], p, out); else out.push(p); } return out; }
async function appendLog(st, entry) {
  entry.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  entry.ts = entry.ts || new Date().toISOString();
  const key = 'log/' + dayKey(new Date(entry.ts));
  for (let i = 0; i < 12; i++) {
    const cur = await st.getWithMetadata(key, { type: 'json' });
    const d = (cur && cur.data) || { entries: [] };
    const last = d.entries[d.entries.length - 1];
    if (entry.action === 'modificar' && !entry.desc && last && last.action === 'modificar' && !last.desc && last.user === entry.user && last.coll === entry.coll && last.docId === entry.docId && (Date.parse(entry.ts) - Date.parse(last.ts)) < 180000) {
      (entry.fields || []).forEach(f => { const ex = (last.fields = last.fields || []).find(x => x.p === f.p); if (ex) ex.new = f.new; else if (last.fields.length < 60) last.fields.push(f); });
      last.ts = entry.ts; last.n = (last.n || 1) + 1;
    } else d.entries.push(entry);
    const res = cur ? await st.setJSON(key, d, { onlyIfMatch: cur.etag }) : await st.setJSON(key, d, { onlyIfNew: true });
    if (res.modified) return;
    await sleep(20 + Math.random() * 60 * (i + 1));
  }
}
async function safeLog(st, entry) { try { await appendLog(st, entry); } catch (e) { console.error('log', e); } }

/* ---------- Bloqueo por intentos fallidos ---------- */
async function failState(st, name) { return (await st.get('auth/fail/' + String(name || '').toLowerCase().slice(0, 80), { type: 'json' })) || { n: 0, until: 0 }; }
async function regFail(st, name) { const k = 'auth/fail/' + String(name || '').toLowerCase().slice(0, 80); const f = await failState(st, name); f.n = (f.n || 0) + 1; if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; } await st.setJSON(k, f); return f; }
async function clearFail(st, name) { await st.delete('auth/fail/' + String(name || '').toLowerCase().slice(0, 80)); }
async function verifyPassword(st, user, password) {
  const f = await failState(st, user);
  if (f.until && f.until > Date.now()) return { ok: false, res: err(429, 'locked', 'Demasiados intentos fallidos. Intente de nuevo en unos minutos.') };
  if (!(await checkPass(user, password))) { await regFail(st, user); await safeLog(st, { user, action: 'clave incorrecta', desc: 'Clave incorrecta al confirmar una eliminación o restauración' }); return { ok: false, res: err(403, 'bad_password', 'Clave incorrecta.') }; }
  await clearFail(st, user); return { ok: true };
}

/* ---------- Escritura con fusión y control de concurrencia ---------- */
async function writeDoc(st, coll, id, partial, user, create = false) {
  const key = `doc/${coll}/${id}`;
  for (let i = 0; i < 10; i++) {
    const cur = await st.getWithMetadata(key, { type: 'json' });
    const prev = cur ? cur.data : null;
    if (create && (cur || await st.get(`tomb/${coll}/${id}`))) return { conflict: true };
    const next = deepMerge(prev || {}, partial); next.updatedAt = new Date().toISOString(); next.updatedBy = user;
    const res = cur ? await st.setJSON(key, next, { onlyIfMatch: cur.etag }) : await st.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return { prev, next };
    await sleep(15 + Math.random() * 50 * (i + 1));
  }
  throw new Error('write_conflict');
}

/* ---------- Rutas ---------- */
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const st = store();
  try {
    if (route === 'config' && req.method === 'GET') return json({ ai: !!env('ANTHROPIC_API_KEY'), users: users().length > 0 });

    if (route === 'login' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (!users().length) return err(500, 'no_users', 'No hay usuarios configurados (ADMIN_NAME1 / ADMIN_PASSWORD1).');
      const f = await failState(st, b.user);
      if (f.until && f.until > Date.now()) return err(429, 'locked', 'Usuario bloqueado temporalmente por intentos fallidos. Intente en unos minutos.');
      const name = await checkPass(b.user, b.password);
      if (!name) { await regFail(st, b.user); await safeLog(st, { user: String(b.user || '').slice(0, 60), action: 'ingreso fallido', desc: 'Usuario o clave incorrectos' }); return err(401, 'bad_credentials', 'Usuario o clave incorrectos.'); }
      await clearFail(st, name);
      await safeLog(st, { user: name, action: 'ingreso', desc: 'Inicio de sesión' });
      return json({ user: name, hours: SESSION_HOURS() }, 200, { 'set-cookie': sessionCookie(await makeToken(name), Math.round(SESSION_HOURS() * 3600)) });
    }

    const user = await verifyReq(req);
    if (route === 'logout' && req.method === 'POST') { if (user) await safeLog(st, { user, action: 'salida', desc: 'Cierre de sesión' }); return json({ ok: true }, 200, { 'set-cookie': sessionCookie('x', 0) }); }
    if (!user) return err(401, 'unauth', 'Sesión no válida o vencida.');
    if (route === 'me') return json({ user });

    if (route === 'changes' && req.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const m = (await st.get('meta/manifest', { type: 'json' })) || { rev: 0, keys: {} };
      if (since >= m.rev && since > 0) return json({ rev: m.rev, docs: [], deleted: [] });
      const entries = Object.entries(m.keys || {}).filter(([, v]) => since === 0 ? !v.d : v.r > since);
      const deleted = entries.filter(([, v]) => v.d).map(([k]) => { const [coll, ...r] = k.split('/'); return { coll, id: r.join('/') }; });
      const live = entries.filter(([, v]) => !v.d).map(([k]) => k);
      if (since === 0) { // autocorrección: incluye documentos que existan aunque falten en el manifiesto
        try { const { blobs } = await st.list({ prefix: 'doc/' }); const have = new Set(live); blobs.forEach(b => { const k = b.key.slice(4); if (!have.has(k) && !(m.keys[k] && m.keys[k].d)) live.push(k); }); } catch (e) { console.error('list', e); }
      }
      const docs = (await pmap(live, 16, async k => { const data = await st.get('doc/' + k, { type: 'json' }); const [coll, ...r] = k.split('/'); return data ? { coll, id: r.join('/'), data } : null; })).filter(Boolean);
      return json({ rev: m.rev, full: since === 0, docs, deleted });
    }

    if (route === 'write' && req.method === 'POST') {
      const raw = await req.text(); if (raw.length > MAX_BODY) return err(413, 'too_large', 'El cambio es demasiado grande.');
      let b; try { b = JSON.parse(raw); } catch (e) { return err(400, 'bad_json', 'JSON inválido.'); }
      const { coll, id, partial, password, desc, create } = b;
      if (!COLLS.includes(coll) || !ID_RE.test(String(id || '')) || !isObj(partial) || badKeys(partial)) return err(400, 'bad_request', 'Solicitud inválida.');
      delete partial.updatedAt; delete partial.updatedBy;
      const del = hasDelete(partial);
      const restore = partial.deleted === false;
      if (del) { const v = await verifyPassword(st, user, password); if (!v.ok) return v.res; }
      const w = await writeDoc(st, coll, id, partial, user, !!create);
      if (w.conflict) return err(409, 'exists', 'Ya existe un documento con ese código.');
      const { prev, next } = w;
      await bumpManifest(st, [`${coll}/${id}`]);
      const action = !prev ? 'crear' : del ? 'eliminar' : (restore && prev.deleted) ? 'restaurar' : 'modificar';
      const fields = flatten(partial).slice(0, 60).map(p => ({ p, old: trunc(getPath(prev || {}, p)), new: trunc(getPath(next, p)) })).filter(f => f.old !== f.new || action !== 'modificar');
      let d = typeof desc === 'string' ? desc.slice(0, 500) : '';
      if (!d && Array.isArray(partial.historial) && partial.historial.length) { const h = partial.historial[partial.historial.length - 1]; if (h && h.texto && h.at && Date.now() - Date.parse(h.at) < 120000) d = String(h.texto).slice(0, 500); }
      if (action !== 'modificar' || fields.length || d) await safeLog(st, { user, action, coll, docId: id, desc: d, fields });
      return json({ doc: next });
    }

    if (route === 'delete' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const { coll, id, password, desc } = b;
      if (coll !== 'reqs' || !ID_RE.test(String(id || ''))) return err(400, 'bad_request', 'Solicitud inválida.');
      const v = await verifyPassword(st, user, password); if (!v.ok) return v.res;
      const prev = await st.get(`doc/${coll}/${id}`, { type: 'json' });
      await st.delete(`doc/${coll}/${id}`);
      await st.setJSON(`tomb/${coll}/${id}`, { at: new Date().toISOString(), by: user, titulo: prev ? prev.titulo || '' : '' }); // el código no se reutiliza
      await bumpManifest(st, [`${coll}/${id}`], true);
      await safeLog(st, { user, action: 'eliminar', coll, docId: id, desc: (typeof desc === 'string' && desc.slice(0, 500)) || `Eliminó el requerimiento ${id}`, fields: prev ? [{ p: 'titulo', old: trunc(prev.titulo), new: '' }, { p: 'ubicación', old: `${prev.macro || '—'}/${prev.sub || '—'}`, new: '' }] : [] });
      return json({ ok: true });
    }

    if (route === 'restore' && req.method === 'POST') {
      const raw = await req.text(); if (raw.length > 8 * 1024 * 1024) return err(413, 'too_large', 'El respaldo es demasiado grande.');
      const b = JSON.parse(raw);
      const v = await verifyPassword(st, user, b.password); if (!v.ok) return v.res;
      const d = b.data || {}; const keys = [];
      for (const coll of COLLS) for (const [id, doc] of Object.entries(d[coll] || {})) { if (!ID_RE.test(id) || !isObj(doc) || badKeys(doc)) continue; await st.setJSON(`doc/${coll}/${id}`, { ...doc, updatedAt: new Date().toISOString(), updatedBy: user }); keys.push(`${coll}/${id}`); }
      if (keys.length) await bumpManifest(st, keys);
      await safeLog(st, { user, action: 'restaurar respaldo', desc: `Restauró ${keys.length} documento(s) desde un respaldo JSON del ${String(d.exportedAt || '').slice(0, 10)}` });
      return json({ ok: true, n: keys.length });
    }

    if (route === 'log' && req.method === 'GET') {
      const to = url.searchParams.get('to') || dayKey(); const from = url.searchParams.get('from') || dayKey(new Date(Date.now() - 6 * 864e5));
      const { blobs } = await st.list({ prefix: 'log/' });
      const ks = blobs.map(x => x.key).filter(k => { const d = k.slice(4); return d >= from && d <= to; }).sort().reverse();
      const days = await pmap(ks, 10, k => st.get(k, { type: 'json' }));
      const entries = days.flatMap(d => (d && d.entries) || []).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8000);
      return json({ from, to, entries });
    }

    return err(404, 'not_found', 'Ruta no encontrada.');
  } catch (e) {
    console.error(route, e);
    return err(500, 'server_error', 'Error del servidor: ' + (e && e.message || e));
  }
};

export const config = { path: '/api/*' };
