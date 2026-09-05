// Cloudflare Pages Function: GET /api/route?callsign=xxx
import { queryFlightRoute } from '../../src/flightroute.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const cs = String(url.searchParams.get('callsign') || '').trim().toUpperCase();
  if (!cs) return json({ success: false, error: '缺少呼号' }, 400);
  try {
    const route = await queryFlightRoute(cs);
    if (!route) return json({ success: false, error: '未查到该航班信息' }, 404);
    return json({
      success: true,
      callsign: cs,
      from: route.from,
      to: route.to,
      icaoFrom: route.icaoFrom,
      icaoTo: route.icaoTo,
    });
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
