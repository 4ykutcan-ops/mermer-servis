// Mermer İletişim - Ortak veritabanı (Cloudflare Worker + KV). Node.js gerekmez.
// Tarayıcılar kayıtlarını /api/sync adresine gönderir; sunucu birleştirir ve güncel hali geri verir.

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'x-api-key, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

const arr = (v) => (Array.isArray(v) ? v.filter(r => r && r.id !== undefined) : []);

function mergeList(a, b, del) {
  const m = {};
  [...a, ...b].forEach(r => {
    const c = m[r.id];
    if (!c || (r.updatedAt || 0) > (c.updatedAt || 0)) m[r.id] = r;
  });
  return Object.values(m)
    .filter(r => !(del[r.id] !== undefined && del[r.id] >= (r.updatedAt || 0)))
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

function mergeDeleted(a, b) {
  const out = { ...a };
  Object.keys(b || {}).forEach(id => { out[id] = Math.max(out[id] || 0, b[id] || 0); });
  const limit = Date.now() - 180 * 24 * 3600 * 1000; // 180 günden eski silme kayıtlarını temizle
  Object.keys(out).forEach(id => { if (out[id] < limit) delete out[id]; });
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === '/health') return json(env, { ok: !!env.DB });

    if (url.pathname === '/api/sync' && request.method === 'POST') {
      try {
        if (!env.API_KEY) {
          return json(env, { ok: false, error: 'Sunucuda API_KEY tanımlı değil (Cloudflare\'de secret eklenmemiş veya yayın sonrası silinmiş)' }, 401);
        }
        if ((request.headers.get('x-api-key') || '').trim() !== String(env.API_KEY).trim()) {
          return json(env, { ok: false, error: 'Anahtar yanlış (sitedeki ile Cloudflare\'deki aynı değil)' }, 401);
        }
        if (!env.DB) return json(env, { ok: false, error: 'KV bağlantısı (DB) tanımlı değil' }, 500);

        const incoming = await request.json().catch(() => ({}));
        const storedRaw = await env.DB.get('db');
        const stored = storedRaw ? JSON.parse(storedRaw) : {};

        const deleted = mergeDeleted(stored.deleted || {}, incoming.deleted || {});
        const merged = {
          orders: mergeList(arr(stored.orders), arr(incoming.orders), deleted),
          sales: mergeList(arr(stored.sales), arr(incoming.sales), deleted),
          stock: mergeList(arr(stored.stock), arr(incoming.stock), deleted),
          deleted
        };

        const out = JSON.stringify(merged);
        if (out !== storedRaw) await env.DB.put('db', out); // değişiklik yoksa yazma (ücretsiz yazma limiti)
        return json(env, { ok: true, data: merged });
      } catch (err) {
        return json(env, { ok: false, error: err.message }, 500);
      }
    }
    return json(env, { ok: false, error: 'Bulunamadı' }, 404);
  }
};
