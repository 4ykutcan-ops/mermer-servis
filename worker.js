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

// --- Müşteri takip sorgusu (herkese açık; sadece takip no + telefonun son 4 hanesi ile) ---
const attempts = new Map(); // IP -> { n, t }  (en iyi çaba: Worker bellek içi sayaç)
function tooMany(ip) {
  const now = Date.now(), rec = attempts.get(ip);
  if (!rec || now - rec.t > 10 * 60 * 1000) return false;
  return rec.n >= 10;
}
function noteFail(ip) {
  const now = Date.now(), rec = attempts.get(ip);
  if (!rec || now - rec.t > 10 * 60 * 1000) attempts.set(ip, { n: 1, t: now });
  else rec.n++;
  if (attempts.size > 5000) attempts.clear();
}
function maskName(name) {
  return String(name || '').trim().split(/\s+/).map((w, i, a) => (i === a.length - 1 && a.length > 1) ? w[0] + '.' : w).join(' ');
}
const digits = (v) => String(v || '').replace(/\D/g, '');

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
    if (url.pathname === '/api/track' && request.method === 'POST') {
      try {
        if (!env.DB) return json(env, { ok: false, error: 'Sistem hazır değil' }, 500);
        const ip = request.headers.get('cf-connecting-ip') || 'x';
        if (tooMany(ip)) return json(env, { ok: false, error: 'Çok fazla deneme yaptınız. Lütfen 10 dakika sonra tekrar deneyin.' }, 429);

        const body = await request.json().catch(() => ({}));
        const code = String(body.trackingNo || '').trim().toUpperCase();
        const last4 = digits(body.phone4);
        const stored = JSON.parse((await env.DB.get('db')) || '{}');
        const o = arr(stored.orders).find(x => String(x.trackingNo || '').toUpperCase() === code);
        if (!code || last4.length !== 4 || !o || digits(o.customerPhone).slice(-4) !== last4) {
          noteFail(ip);
          return json(env, { ok: false, error: 'Kayıt bulunamadı. Takip numarasını ve telefonunuzun son 4 hanesini kontrol edin.' }, 404);
        }
        // Sadece müşterinin görmesi gereken alanlar (IMEI, şifre, telefon, tahsilat vb. verilmez)
        return json(env, { ok: true, order: {
          trackingNo: o.trackingNo,
          customerName: maskName(o.customerName),
          deviceModel: o.deviceModel,
          status: o.status,
          createdAt: o.createdAt,
          issueDesc: o.issueDesc,
          customerPrice: o.customerPrice === undefined ? null : o.customerPrice,
          approved: !!o.approved,
          warranty: o.warranty
        } });
      } catch (err) {
        return json(env, { ok: false, error: 'Sorgu yapılamadı' }, 500);
      }
    }
    return json(env, { ok: false, error: 'Bulunamadı' }, 404);
  }
};
