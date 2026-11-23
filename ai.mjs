// Proxy de IA (Anthropic Messages API) con respuesta en streaming.
// Edge Function: no tiene el límite de 10-26 s de las Functions mientras el modelo escribe.
import { verifyReq, env } from '../shared/auth.mjs';

const DEFAULT_MODEL = 'claude-sonnet-5-5';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Método no permitido', { status: 405 });
  const user = await verifyReq(req);
  if (!user) return Response.json({ code: 'unauth' }, { status: 401 });
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return Response.json({ code: 'ai_disabled', error: 'Falta ANTHROPIC_API_KEY' }, { status: 501 });
  let body; try { body = await req.json(); } catch (e) { return Response.json({ code: 'bad_json' }, { status: 400 }); }
  const prompt = String(body.prompt || '');
  if (!prompt.trim()) return Response.json({ code: 'bad_request' }, { status: 400 });
  if (prompt.length > 400000) return Response.json({ code: 'prompt_too_large' }, { status: 413 });

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: req.signal,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(env('ANTHROPIC_WORKSPACE_ID') ? { 'anthropic-workspace-id': env('ANTHROPIC_WORKSPACE_ID') } : {}) },
    body: JSON.stringify({ model: env('ANTHROPIC_MODEL') || DEFAULT_MODEL, max_tokens: parseInt(env('ANTHROPIC_MAX_TOKENS') || '16000', 10), stream: true, metadata: { user_id: 'lev-' + user.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) }, messages: [{ role: 'user', content: prompt }] })
  }).catch(e => ({ fetchError: String(e && e.message || e) }));
  if (upstream.fetchError) return Response.json({ code: 'upstream_error', error: 'No se pudo conectar con la API de Anthropic: ' + upstream.fetchError }, { status: 502 });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    let type = '', msg = t.slice(0, 400); try { const j = JSON.parse(t); type = (j.error && j.error.type) || ''; msg = (j.error && j.error.message) || msg; } catch (e) { }
    const model = env('ANTHROPIC_MODEL') || DEFAULT_MODEL;
    const hint = type === 'authentication_error' ? 'La API key no es válida o fue revocada. Revise ANTHROPIC_API_KEY en Netlify y vuelva a desplegar.'
      : type === 'permission_error' ? 'La API key no tiene permiso para esta operación (revise su workspace y rol en la Claude Console).'
      : type === 'not_found_error' ? `El modelo «${model}» no existe o no está disponible para su cuenta. Revise ANTHROPIC_MODEL.`
      : /workspace/i.test(msg) ? 'La API key no está asignada a un workspace. Cree una llave asignada a un workspace o defina ANTHROPIC_WORKSPACE_ID en Netlify.'
      : /credit|balance|billing/i.test(msg) ? 'La cuenta de la API no tiene crédito disponible. Cargue crédito en Billing de la Claude Console.'
      : '';
    const status = upstream.status === 429 || upstream.status === 529 ? 429 : upstream.status === 413 ? 413 : 502;
    console.error('anthropic', upstream.status, type, msg);
    return Response.json({ code: status === 429 ? 'rate_limited' : status === 413 ? 'prompt_too_large' : 'upstream_error', upstreamStatus: upstream.status, type, error: (hint ? hint + ' ' : '') + 'Detalle: ' + msg }, { status });
  }

  const encoder = new TextEncoder(); const decoder = new TextDecoder();
  const out = new ReadableStream({
    async start(ctrl) {
      const rd = upstream.body.getReader(); let buf = ''; let stop = null; let errMsg = null;
      try {
        while (true) {
          const { done, value } = await rd.read(); if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') ctrl.enqueue(encoder.encode(ev.delta.text));
            else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
            else if (ev.type === 'error') errMsg = (ev.error && ev.error.message) || 'error';
          }
        }
      } catch (e) { errMsg = errMsg || String(e && e.message || e); }
      // Marca de cierre: carácter NUL + JSON con el motivo de término.
      ctrl.enqueue(encoder.encode('\u0000' + JSON.stringify({ stop, error: errMsg })));
      ctrl.close();
    }
  });
  return new Response(out, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
};

export const config = { path: '/api/ai' };
