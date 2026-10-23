import { describe, expect, it } from 'vitest';
import {
  bareWorkingCopyPath,
  nextPreviousWorkDirs,
  sweepTargets,
  workFolder,
} from './work-dir.js';

describe('nextPreviousWorkDirs', () => {
  it('puts the folder being left first, newest first', () => {
    expect(nextPreviousWorkDirs(['/b', '/c'], '/a', '/d')).toEqual(['/a', '/b', '/c']);
  });
  it('dedups the folder being left', () => {
    expect(nextPreviousWorkDirs(['/b', '/a', '/c'], '/a', '/d')).toEqual(['/a', '/b', '/c']);
  });
  it('drops the new folder if it was on the list', () => {
    expect(nextPreviousWorkDirs(['/b', '/d'], '/a', '/d')).toEqual(['/a', '/b']);
  });
  it('keeps at most 10', () => {
    const prev = Array.from({ length: 10 }, (_, i) => `/p${i}`);
    const next = nextPreviousWorkDirs(prev, '/a', '/d');
    expect(next).toHaveLength(10);
    expect(next[0]).toBe('/a');
    expect(next).not.toContain('/p9');
  });
  it('does not add the left folder when it is the new one or not a string', () => {
    expect(nextPreviousWorkDirs(['/b'], '/a', '/a')).toEqual(['/b']);
    expect(nextPreviousWorkDirs(['/b'], undefined, '/a')).toEqual(['/b']);
  });
  it('clearing the folder (null) still remembers the one left', () => {
    expect(nextPreviousWorkDirs(['/b'], '/a', null)).toEqual(['/a', '/b']);
  });
});

describe('sweepTargets', () => {
  const input = {
    defaultDir: '/app/projects',
    activeDir: '/work/FreeCrawl',
    previous: ['/old1', '/old2'],
    tmp: '/tmp',
  };
  it('sweeps the app folder, the active folder and every previous work folder', () => {
    expect(sweepTargets(input).workingFolders).toEqual([
      '/app/projects',
      '/work/FreeCrawl',
      workFolder('/old1'),
      workFolder('/old2'),
    ]);
  });
  it('sweeps the OS tmpdir for compare copies', () => {
    expect(sweepTargets(input).tmpDir).toBe('/tmp');
  });
  it('drops duplicates', () => {
    const t = sweepTargets({ ...input, activeDir: '/app/projects' });
    expect(t.workingFolders.filter((d) => d === '/app/projects')).toHaveLength(1);
  });
});

describe('bareWorkingCopyPath', () => {
  it.each(['-wal', '-shm', '-journal'])('strips %s', (s) => {
    expect(bareWorkingCopyPath(`/w/work-1-2.seoproject${s}`)).toBe('/w/work-1-2.seoproject');
  });
  it('leaves other names alone', () => {
    expect(bareWorkingCopyPath('/w/work-1-2.seoproject')).toBe('/w/work-1-2.seoproject');
  });
});
