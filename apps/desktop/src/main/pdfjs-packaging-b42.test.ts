import * as fs from 'node:fs';
import * as path from 'node:path';
import { getResolvedPDFJS } from 'unpdf';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// B42 / r1 M7 + r2 Low 4: unpdf is MIT but its dist/pdfjs.mjs is pdf.js (Apache-2.0) with the notices
// stripped, and core ships in the installer. Both licences go next to the app, like axe-core's (c98aecd).
// Whether the unpacked build really loads unpdf (asar, Electron's node) is checked on the PC, not here.
describe('B42 packaging of unpdf and the pdf.js it bundles', () => {
  it('unpdf is a runtime dependency of packages/core with no native file; pdf-lib only writes test PDFs', () => {
    const pkg = JSON.parse(read('packages/core/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies['unpdf']).toMatch(/^\^?\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.['unpdf']).toBeUndefined();
    expect(pkg.dependencies['pdf-lib']).toBeUndefined();
    expect(pkg.devDependencies?.['pdf-lib']).toMatch(/^\^?\d+\.\d+\.\d+$/);
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.node')) found.push(p);
      }
    };
    walk(path.join(root, 'node_modules/unpdf'));
    expect(found).toEqual([]);
  });

  it('the installer config does not exclude unpdf and ships both licences in the notice folder', () => {
    const yml = read('apps/desktop/electron-builder.yml');
    expect(yml).not.toMatch(/!.*unpdf/);
    expect(yml).toMatch(/from: "\.\.\/\.\.\/node_modules\/unpdf\/LICENSE"\s+to: "notice\/unpdf-LICENSE\.txt"/);
    expect(yml).toMatch(/from: "resources\/notice\/pdfjs-LICENSE-Apache-2\.0\.txt"\s+to: "notice\/pdfjs-LICENSE-Apache-2\.0\.txt"/);
  });

  it('both licence files exist: unpdf is MIT', () => {
    expect(read('node_modules/unpdf/LICENSE')).toMatch(/MIT License/);
  });

  it('the checked-in pdf.js notice is the Apache-2.0 text and its first line names the bundled version', async () => {
    const text = read('apps/desktop/resources/notice/pdfjs-LICENSE-Apache-2.0.txt');
    const version = (await getResolvedPDFJS()).version;
    expect(text.split('\n')[0]).toContain(`pdf.js ${version}`);
    expect(text).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    expect(text).toMatch(/END OF TERMS AND CONDITIONS/);
  });
});
