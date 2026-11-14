// A separate hostname keeps the public gallery outside the admin's Access application.
export default {
  async fetch(request, env) {
    if (env.PUBLIC_GALLERY !== 'true' || request.method !== 'GET' || new URL(request.url).pathname !== '/api/gallery')
      return new Response('Not found', { status: 404 });
    const response = await env.WORKSPACE.getByName('main').fetch(request);
    const headers = new Headers(response.headers);
    if (request.headers.get('Origin') === env.GALLERY_ORIGIN)
      headers.set('Access-Control-Allow-Origin', env.GALLERY_ORIGIN);
    headers.set('Vary', 'Origin');
    return new Response(response.body, { status: response.status, headers });
  },
};
