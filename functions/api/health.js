// Cloudflare Pages Function: GET /api/health
export async function onRequestGet() {
  return new Response(
    JSON.stringify({ ok: true, time: new Date().toISOString() }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
