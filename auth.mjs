// Autenticación compartida (Functions en Node y Edge Functions en Deno). Solo usa Web Crypto.
const enc = new TextEncoder();
const dec = new TextDecoder();

export function env(k) {
  try { if (globalThis.Netlify && globalThis.Netlify.env && typeof globalThis.Netlify.env.get === 'function') { const v = globalThis.Netlify.env.get(k); if (v !== undefined && v !== null) return v; } } catch (e) { }
  try { if (typeof process !== 'undefined' && process.env) return process.env[k]; } catch (e) { }
  return undefined;
}

/** Usuarios definidos como ADMIN_NAME1/ADMIN_PASSWORD1, ADMIN_NAME2/ADMIN_PASSWORD2, … (se admiten huecos, hasta 200). */
export function users() {
  const out = [];
  for (let i = 1; i <= 200; i++) {
    const n = env('ADMIN_NAME' + i), p = env('ADMIN_PASSWORD' + i);
    if (n && p && String(n).trim()) out.push({ name: String(n).trim(), pass: String(p) });
  }
  return out;
}
export function findUser(name) { const k = String(name || '').trim().toLowerCase(); return users().find(u => u.name.toLowerCase() === k) || null; }

export function b64u(bytes) { let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64uDec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
async function sha(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function eqBytes(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }
async function hmac(key, msg) { const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))); }

/** Compara la clave en tiempo constante. Devuelve el nombre canónico del usuario o null. */
export async function checkPass(name, pass) {
  const u = findUser(name);
  const a = await sha('p|' + String(pass ?? ''));
  const b = await sha('p|' + (u ? u.pass : '\u0000no-user\u0000'));
  return u && eqBytes(a, b) ? u.name : null;
}

async function secret() {
  const s = env('SESSION_SECRET');
  if (s && String(s).length >= 16) return String(s);
  // Respaldo: se deriva de las credenciales; cambiar una clave invalida todas las sesiones.
  return 'derived:' + b64u(await sha('coopecaja-lev|' + users().map(u => u.name + ':' + u.pass).join('|')));
}
export const SESSION_HOURS = () => { const h = parseFloat(env('SESSION_HOURS') || '10'); return isFinite(h) && h > 0 && h <= 72 ? h : 10; };

export async function makeToken(name) {
  const payload = b64u(enc.encode(JSON.stringify({ u: name, exp: Date.now() + SESSION_HOURS() * 3600e3 })));
  return payload + '.' + b64u(await hmac(await secret(), payload));
}
/** Valida la cookie de sesión. Devuelve el usuario (si sigue existiendo en las variables de entorno) o null. */
export async function verifyReq(req) {
  const c = req.headers.get('cookie') || '';
  const m = /(?:^|;\s*)lev_s=([^;]+)/.exec(c); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s) return null;
  const expSig = b64u(await hmac(await secret(), p));
  if (!eqBytes(enc.encode(expSig), enc.encode(s))) return null;
  let d; try { d = JSON.parse(dec.decode(b64uDec(p))); } catch (e) { return null; }
  if (!d || !d.exp || d.exp < Date.now()) return null;
  const u = users().find(x => x.name === d.u);
  return u ? u.name : null;
}
export function sessionCookie(token, maxAgeSec) { return `lev_s=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`; }
