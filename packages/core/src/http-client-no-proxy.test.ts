import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, request, setGlobalDispatcher } from 'undici';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

let origin: http.Server;
let proxy: http.Server;
let originPort = 0;
let proxyPort = 0;
/** Every target the proxy was asked to reach (CONNECT authority or absolute URL). */
const proxied: string[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  origin = http.createServer((_req, res) => res.end('ok'));
  originPort = await listen(origin);
  // Minimal forward proxy: tunnels CONNECT and forwards absolute-form requests.
  proxy = http.createServer((req, res) => {
    proxied.push(req.url ?? '');
    const target = new URL(req.url ?? '');
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  proxy.on('connect', (req, socket, head) => {
    proxied.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    // Every name used here resolves to the local origin.
    const upstream = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  await new Promise((r) => origin.close(r));
  await new Promise((r) => proxy.close(r));
});

const savedEnv: Record<string, string | undefined> = {};
const savedDispatcher = getGlobalDispatcher();

beforeEach(() => {
  for (const k of PROXY_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  proxied.length = 0;
  // initHttpClient keeps the last proxy key in module state: start each test fresh.
  vi.resetModules();
});

afterEach(() => {
  for (const k of PROXY_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setGlobalDispatcher(savedDispatcher);
});

async function init(opts: { proxyOverride?: string } = {}): Promise<(opts?: { proxyOverride?: string }) => void> {
  const mod = await import('./http-client.js');
  mod.initHttpClient(opts);
  return mod.initHttpClient;
}

async function get(host: string): Promise<string> {
  const res = await request(`http://${host}:${originPort}/`);
  return res.body.text();
}

function wentThroughProxy(host: string): boolean {
  return proxied.some((t) => t.includes(`${host}:${originPort}`));
}

describe('initHttpClient NO_PROXY', () => {
  it('sends hosts listed in no_proxy direct and the rest through the proxy', async () => {
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['no_proxy'] = '127.0.0.1';
    await init();
    expect(await get('127.0.0.1')).toBe('ok');
    expect(wentThroughProxy('127.0.0.1')).toBe(false);
    expect(await get('localhost')).toBe('ok');
    expect(wentThroughProxy('localhost')).toBe(true);
  });

  it('matches a leading-dot suffix entry and an entry with a port', async () => {
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    // ".localhost" also covers "localhost" itself (curl rules); the entry for another port must not match.
    process.env['NO_PROXY'] = `.localhost,127.0.0.1:${originPort + 1}`;
    await init();
    await get('localhost');
    expect(wentThroughProxy('localhost')).toBe(false);
    await get('127.0.0.1');
    expect(wentThroughProxy('127.0.0.1')).toBe(true);
  });

  it('treats NO_PROXY=* as never proxy', async () => {
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['NO_PROXY'] = '*';
    await init();
    await get('127.0.0.1');
    await get('localhost');
    expect(proxied).toEqual([]);
  });

  it('rebuilds the dispatcher when only NO_PROXY changes', async () => {
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    const initAgain = await init();
    await get('127.0.0.1');
    expect(wentThroughProxy('127.0.0.1')).toBe(true);
    proxied.length = 0;
    process.env['NO_PROXY'] = '127.0.0.1';
    initAgain();
    await get('127.0.0.1');
    expect(wentThroughProxy('127.0.0.1')).toBe(false);
  });

  it('keeps the Settings override proxying every host, NO_PROXY or not', async () => {
    process.env['NO_PROXY'] = '127.0.0.1,localhost';
    await init({ proxyOverride: `http://127.0.0.1:${proxyPort}` });
    await get('127.0.0.1');
    expect(wentThroughProxy('127.0.0.1')).toBe(true);
  });
});
