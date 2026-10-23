import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// B40 R16 / MPL-2.0: axe-core stays an unmodified npm package that the installer ships with its licence.
// Whether the unpacked build really contains it is checked on the PC; this keeps the config honest.
describe('B40 packaging of axe-core', () => {
  it('is an exact-version runtime dependency of packages/core, not a dev one', () => {
    const pkg = JSON.parse(read('packages/core/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies['axe-core']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.['axe-core']).toBeUndefined();
  });

  it('the installer config does not exclude axe-core and ships its licence next to the notices', () => {
    const yml = read('apps/desktop/electron-builder.yml');
    expect(yml).not.toMatch(/!.*axe-core/);
    expect(yml).toMatch(/from: "\.\.\/\.\.\/node_modules\/axe-core\/LICENSE"/);
    expect(yml).toMatch(/to: "notice\/axe-core-LICENSE\.txt"/);
  });

  it('the licence file the config points to exists and is MPL-2.0', () => {
    expect(read('node_modules/axe-core/LICENSE')).toMatch(/Mozilla Public License/);
  });

  it('the code only reads the package, never copies or edits it', () => {
    const src = read('packages/core/src/axe-run.ts');
    expect(src).toMatch(/createRequire\(import\.meta\.url\)\.resolve\('axe-core\/axe\.min\.js'\)/);
    expect(src).not.toMatch(/writeFileSync|copyFileSync/);
  });
});
