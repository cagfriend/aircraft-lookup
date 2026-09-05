// Cloudflare Pages Function: GET /api/img?url=xxx （图片代理，规避防盗链）
const ALLOWED_HOSTS = ['t.plnspttrs.net', 'plnspttrs.net'];

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return json({ error: 'invalid url' }, 400);
  }
  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  // 安全限制：仅允许代理 planespotters 图片 CDN
  const host = upstream.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return json({ error: 'host not allowed' }, 403);
  }

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'AircraftLookup/1.0 (+https://example.com/aircraft-lookup)',
        Referer: 'https://www.planespotters.net/',
      },
      redirect: 'follow',
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!resp.ok) return json({ error: 'upstream failed' }, 502);
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return json({ error: 'proxy failed' }, 502);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
