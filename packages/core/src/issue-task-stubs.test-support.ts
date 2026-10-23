import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

/** Local stand-ins for the tracker REST APIs. Tests never contact a real host. */
export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface TrackerStub {
  /** `http://127.0.0.1:<port>` */
  base: string;
  requests: StubRequest[];
  /** Force the next answers (consumed one per request) instead of the enforcing logic. */
  force(...answers: { status: number; body: unknown }[]): void;
  close(): Promise<void>;
}

export const GOOD_GITHUB_TOKEN = 'ghp_stubtoken1234567890';
export const GOOD_BASECAMP_TOKEN = 'BAhbB0kiAbcStubBasecampToken';

// Trimmed from the official example response,
// https://docs.github.com/en/rest/issues/issues#create-an-issue
export const GITHUB_CREATED = {
  id: 1,
  number: 1347,
  state: 'open',
  title: 'Found a bug',
  html_url: 'https://github.com/octocat/Hello-World/issues/1347',
  url: 'https://example.invalid/repos/octocat/Hello-World/issues/1347',
};

// Trimmed from the official example response,
// https://github.com/basecamp/bc3-api/blob/master/sections/todos.md#create-a-to-do
export const BASECAMP_CREATED = {
  id: 1069479848,
  status: 'active',
  type: 'Todo',
  title: 'Program it',
  content: 'Program it',
  url: 'https://example.invalid/195539477/buckets/2085958499/todos/1069479848.json',
  app_url: 'https://3.basecamp.com/195539477/buckets/2085958499/todos/1069479848',
};

async function start(
  handle: (req: StubRequest) => { status: number; body: unknown },
): Promise<TrackerStub> {
  const requests: StubRequest[] = [];
  const forced: { status: number; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: StubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(r);
      const a = forced.shift() ?? handle(r);
      res.writeHead(a.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    force: (...a) => void forced.push(...a),
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

const header = (r: StubRequest, name: string): string => String(r.headers[name] ?? '');

/** GitHub: 403 without User-Agent, 415 without a JSON content type, 401 on a wrong token. */
export function startGithubStub(owner: string, repo: string): Promise<TrackerStub> {
  return start((r) => {
    if (!header(r, 'user-agent')) return { status: 403, body: { message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header.' } };
    if (r.method !== 'POST' || r.path !== `/repos/${owner}/${repo}/issues`) return { status: 404, body: { message: 'Not Found' } };
    if (header(r, 'authorization') !== `Bearer ${GOOD_GITHUB_TOKEN}`) return { status: 401, body: { message: 'Bad credentials' } };
    if (!header(r, 'content-type').startsWith('application/json')) return { status: 415, body: { message: 'Unsupported Media Type' } };
    if (!header(r, 'accept').includes('application/vnd.github+json')) return { status: 415, body: { message: 'bad Accept' } };
    if (header(r, 'x-github-api-version') !== '2022-11-28') return { status: 400, body: { message: 'bad api version' } };
    return { status: 201, body: GITHUB_CREATED };
  });
}

/** Basecamp: 400 without a User-Agent of the form `Name (contact)`, 415 without JSON, 401 on a wrong token. */
export function startBasecampStub(accountId: string, todolistId: string): Promise<TrackerStub> {
  return start((r) => {
    if (!/\(.+\)/.test(header(r, 'user-agent'))) return { status: 400, body: { error: 'Bad Request: User-Agent header with name and contact required' } };
    if (header(r, 'authorization') !== `Bearer ${GOOD_BASECAMP_TOKEN}`) return { status: 401, body: { error: 'Unauthorized' } };
    if (!header(r, 'content-type').startsWith('application/json')) return { status: 415, body: { error: 'Unsupported Media Type' } };
    if (r.method !== 'POST' || r.path !== `/${accountId}/todolists/${todolistId}/todos.json`) return { status: 404, body: { error: 'Not Found' } };
    return { status: 201, body: BASECAMP_CREATED };
  });
}
