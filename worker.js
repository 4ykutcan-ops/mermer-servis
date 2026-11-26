// Mermer İletişim - WhatsApp Business API köprüsü (Cloudflare Worker, Node.js gerekmez)

function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '9' + p;
  if (p.length === 10) p = '90' + p;
  return p;
}

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

async function graphJson(env, path, body) {
  const base = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v21.0'}/${env.PHONE_NUMBER_ID}`;
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Graph API hatası (${r.status})`);
  return d;
}

async function uploadPdf(env, file, filename) {
  const base = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v21.0'}/${env.PHONE_NUMBER_ID}`;
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'application/pdf');
  fd.append('file', new Blob([await file.arrayBuffer()], { type: 'application/pdf' }), filename);
  const r = await fetch(base + '/media', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
    body: fd
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `PDF yüklenemedi (${r.status})`);
  return d.id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === '/health') return json(env, { ok: true });

    if (url.pathname === '/api/send-status' && request.method === 'POST') {
      try {
        if (request.headers.get('x-api-key') !== env.API_KEY) return json(env, { ok: false, error: 'Yetkisiz' }, 401);

        const form = await request.formData();
        const to = normalizePhone(form.get('phone'));
        if (to.length < 11) return json(env, { ok: false, error: 'Geçersiz telefon numarası' }, 400);

        const customerName = form.get('customerName');
        const trackingNo = form.get('trackingNo');
        const device = form.get('device');
        const status = form.get('status');
        const total = form.get('total');
        const message = form.get('message');
        const pdf = form.get('pdf');
        const filename = `${trackingNo || 'servis-fisi'}.pdf`;
        const mediaId = pdf && typeof pdf !== 'string' ? await uploadPdf(env, pdf, filename) : null;

        if (env.TEMPLATE_NAME) {
          const components = [];
          if (mediaId) components.push({ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] });
          components.push({
            type: 'body',
            parameters: [customerName, trackingNo, device, status, total].map(t => ({ type: 'text', text: String(t ?? '-') }))
          });
          await graphJson(env, '/messages', {
            messaging_product: 'whatsapp', to, type: 'template',
            template: { name: env.TEMPLATE_NAME, language: { code: env.TEMPLATE_LANG || 'tr' }, components }
          });
        } else {
          await graphJson(env, '/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body: message, preview_url: false } });
          if (mediaId) {
            await graphJson(env, '/messages', {
              messaging_product: 'whatsapp', to, type: 'document',
              document: { id: mediaId, filename, caption: `${trackingNo} servis fişi` }
            });
          }
        }
        return json(env, { ok: true });
      } catch (err) {
        return json(env, { ok: false, error: err.message }, 500);
      }
    }
    return json(env, { ok: false, error: 'Bulunamadı' }, 404);
  }
};
