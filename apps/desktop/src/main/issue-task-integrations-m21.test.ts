import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getIntegration } from '@freecrawl/shared-types';

const dir = mkdtempSync(join(tmpdir(), 'm21-cred-'));
vi.mock('electron', () => {
  const flip = (s: string) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a);
  return {
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(flip(s)),
      decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
    },
  };
});

const { getState, setCredentials, resolveCredentials } = await import('./credentials.js');

describe('tracker integrations in the catalog', () => {
  it('github-tasks has a secret token and an optional apiBase', () => {
    const def = getIntegration('github-tasks');
    expect(def?.name).toBeTruthy();
    expect(def?.description).toBeTruthy();
    const f = Object.fromEntries(def!.fields.map((x) => [x.key, x]));
    expect(f['token']?.secret).toBe(true);
    expect(f['owner']?.secret).toBe(false);
    expect(f['repo']?.secret).toBe(false);
    expect(f['apiBase']).toMatchObject({ secret: false, optional: true });
    expect(def!.setupHint).toMatch(/Issues/);
  });

  it('basecamp-tasks has a secret accessToken, no projectId, and says the token expires every 2 weeks', () => {
    const def = getIntegration('basecamp-tasks');
    const f = Object.fromEntries(def!.fields.map((x) => [x.key, x]));
    expect(f['accessToken']?.secret).toBe(true);
    expect(f['accountId']?.secret).toBe(false);
    expect(f['todolistId']?.secret).toBe(false);
    expect(f['apiBase']).toMatchObject({ optional: true });
    expect(f['projectId']).toBeUndefined();
    expect(def!.setupHint).toMatch(/2 weeks/);
  });

  it('getState hides both tokens and returns the plain fields', () => {
    setCredentials('github-tasks', { token: 'ghp_secret', owner: 'o', repo: 'r' });
    setCredentials('basecamp-tasks', { accessToken: 'bc_secret', accountId: '1', todolistId: '2' });
    const st = getState();
    expect(st['github-tasks']?.fields['token']).toEqual({ set: true, value: '' });
    expect(st['github-tasks']?.fields['owner']).toEqual({ set: true, value: 'o' });
    expect(st['basecamp-tasks']?.fields['accessToken']).toEqual({ set: true, value: '' });
    expect(st['github-tasks']?.configured).toBe(true);
    expect(st['basecamp-tasks']?.configured).toBe(true);
    expect(JSON.stringify(st)).not.toMatch(/ghp_secret|bc_secret/);
    expect(resolveCredentials('github-tasks')['token']).toBe('ghp_secret');
  });
});
