import { authenticate } from './auth.mjs';
import { json } from './api.mjs';

export async function route(request, env, assets, verify = authenticate) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  try {
    if (env.PUBLIC_GALLERY === 'true' && url.pathname === '/api/gallery' && request.method === 'GET') {
      // The gallery is deliberately public. No credentials or administrative state are returned.
      const response = await env.WORKSPACE.getByName('main').fetch(request);
      const headers = new Headers(response.headers);
      if (origin === env.GALLERY_ORIGIN) headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.origin !== env.ADMIN_ORIGIN) return json({ error: 'Not found' }, 404);
    await verify(request, env);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (origin && origin !== env.ADMIN_ORIGIN) return json({ error: 'Cross-origin request denied' }, 403);
        if (request.headers.get('X-Oneshot-Client') !== 'admin' ||
          !request.headers.get('Content-Type')?.startsWith('application/json'))
          return json({ error: 'Expected an admin JSON request' }, 403);
      }
      return env.WORKSPACE.getByName('main').fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (url.pathname === '/gallery') return Response.redirect(url.origin + '/gallery/', 302);
    const asset = assets[url.pathname];
    if (!asset) return json({ error: 'Not found' }, 404);
    return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
      'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      // srcdoc inherits its parent's CSP. Its own strict policy controls generated code.
      'Content-Security-Policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    } });
  } catch (error) { return json({ error: error.message || 'Request failed' }, error.status || 500); }
}
