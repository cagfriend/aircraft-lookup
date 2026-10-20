const CACHE_NAME = 'aircraft-natural-earth-v1';

// Only content-hashed, same-origin Natural Earth JSON is persisted. Cache
// failures (private mode/quota) must never prevent the map from being drawn.
export async function loadBasemapData(url) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      try {
        const data = await cached.json();
        validate(data);
        return data;
      } catch { await cache.delete(url); }
    }
  } catch { /* HTTP cache and network remain available. */ }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(url, {cache:'force-cache', signal:abort.signal});
    if (!response.ok) throw new Error(`Basemap HTTP ${response.status}`);
    const copy = response.clone();
    const data = await response.json();
    validate(data);
    if (cache) await cache.put(url, copy).catch(() => {});
    return data;
  } finally { clearTimeout(timeout); }
}

function validate(data) {
  if (data?.countries?.type !== 'FeatureCollection' || !data.countries.features?.length) {
    throw new Error('Invalid Natural Earth basemap');
  }
}
