// Cloudflare Pages Function: GET /api/query?reg=xxx&refresh=1
import { lookupAircraft } from '../../src/aggregate.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const reg = url.searchParams.get('reg') || url.searchParams.get('q');
  if (!reg) return json({ success: false, error: '请输入注册号' }, 400);
  try {
    const data = await lookupAircraft(String(reg), {
      forceRefresh: url.searchParams.get('refresh') === '1',
    });
    if (!data.success) return json(data, 404);
    return json(data);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
