// Server-side proxy to TMDB. The browser calls /api/tmdb?path=/movie/123/credits
// and this function adds the secret key, so it never ships to the client.

const TMDB = 'https://api.themoviedb.org/3';

// Only the endpoints the app uses, so the proxy can't be used as an open relay.
const ROUTES = [
  { re: /^\/search\/person$/, ttl: 3600 },
  { re: /^\/person\/popular$/, ttl: 3600 },
  { re: /^\/person\/\d+$/, ttl: 86400 },
  { re: /^\/person\/\d+\/movie_credits$/, ttl: 86400 },
  { re: /^\/movie\/\d+\/credits$/, ttl: 86400 },
];
const PARAMS = ['query', 'page', 'include_adult'];

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export async function GET(request) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return json(500, { error: 'TMDB_API_KEY is not set on the server.' });

  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const route = ROUTES.find((r) => r.re.test(path));
  if (!route) return json(404, { error: `Unsupported path: ${path}` });

  const upstream = new URL(TMDB + path);
  for (const p of PARAMS) {
    const v = url.searchParams.get(p);
    if (v !== null) upstream.searchParams.set(p, v.slice(0, 200));
  }

  // Accept either a v3 API key or a v4 read access token (a long JWT).
  const headers = { accept: 'application/json' };
  if (key.length > 64) headers.authorization = `Bearer ${key}`;
  else upstream.searchParams.set('api_key', key);

  let res;
  try {
    res = await fetch(upstream, { headers });
  } catch {
    return json(502, { error: 'Could not reach TMDB.' });
  }

  if (res.status === 401) return json(500, { error: 'TMDB rejected the server API key. Check TMDB_API_KEY in Vercel.' });
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    return json(res.status, { error: `TMDB answered ${res.status}` }, retry ? { 'retry-after': retry } : {});
  }

  return new Response(await res.text(), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cache at Vercel's edge; credits change rarely.
      'cache-control': `public, max-age=300, s-maxage=${route.ttl}, stale-while-revalidate=604800`,
    },
  });
}
