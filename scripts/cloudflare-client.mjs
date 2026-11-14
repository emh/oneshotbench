import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const paths = [
    resolve(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    resolve(homedir(), '.config/.wrangler/config/default.toml'),
    resolve(homedir(), '.wrangler/config/default.toml'),
  ];
  const file = paths.find(existsSync);
  if (!file) throw Error('Log into Cloudflare or set CLOUDFLARE_API_TOKEN.');
  let source = readFileSync(file, 'utf8');
  const field = key => {
    const value = source.match(new RegExp('^' + key + '\\s*=\\s*("[^"\\n]*")', 'm'))?.[1];
    return value ? JSON.parse(value) : undefined;
  };
  if (field('oauth_token') && Date.parse(field('expiration_time')) > Date.now() + 60000) return field('oauth_token');
  if (!field('refresh_token')) throw Error('Cloudflare login expired. Log in again.');
  const response = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: field('refresh_token'), client_id: '54d11594-84e4-41aa-b438-e81b8fa78ee7' }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw Error(`Cloudflare login refresh failed (${response.status}). Log in again.`);
  for (const [key, value] of Object.entries({ oauth_token: data.access_token,
    refresh_token: data.refresh_token || field('refresh_token'),
    expiration_time: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  })) source = source.replace(new RegExp('^' + key + '\\s*=.*$', 'm'), key + ' = ' + JSON.stringify(value));
  writeFileSync(file, source, { mode: 0o600 });
  return data.access_token;
}
export async function cloudflare(path, options = {}) {
  const token = await cloudflareToken();
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw Error(`Cloudflare request failed (${response.status}; codes ${(data.errors || []).map(e => e.code).join(',')}).`);
  return data.result;
}
