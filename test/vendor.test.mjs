import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyVendor } from '../vendor/inteiro-terminal/verify-vendor.mjs';

const root = new URL('../', import.meta.url);
const vendorDir = new URL('vendor/inteiro-terminal/', root);

test('vendored terminal adapter matches its manifest hashes (no IDS checkout needed)', () => {
  const result = verifyVendor(fileURLToPath(vendorDir));
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  const m = result.manifest;
  assert.equal(m.package, '@inteiro/terminal');
  assert.equal(m.version, '2.0.0-rc.1');
  assert.equal(m.format, 'js', 'plain ESM: no build step and no type stripping on Node 20');
  assert.equal(m.entry, 'pi.js');
  assert.equal(m.source.dirty, false);
  assert.match(m.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(m.patches, []);
  // Only the Pi host is external: no width library, no prompts/linear adapters.
  assert.deepEqual(m.externals, ['@earendil-works/pi-tui']);
  assert.deepEqual(Object.keys(m.peerDependencies), ['@earendil-works/pi-tui']);
});

test('a tampered vendored file is reported as drift', async (t) => {
  const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const copy = await mkdtemp(join(tmpdir(), 'econ-vendor-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(fileURLToPath(vendorDir), copy, { recursive: true });
  await writeFile(join(copy, 'pi.js'), `${await readFile(join(copy, 'pi.js'), 'utf8')}\n// local edit\n`);
  await writeFile(join(copy, 'extra.js'), 'export {};\n');
  const result = verifyVendor(copy);
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('modified: pi.js'));
  assert.ok(result.problems.includes('unexpected: extra.js'));
});

test('vendored copy carries no design-system tokens, palette or fixed colors', async () => {
  const files = (await readdir(vendorDir)).filter((f) => f.endsWith('.js'));
  assert.ok(!files.includes('roles.js') && !files.includes('catalog.js') && !files.includes('prompts.js'));
  for (const file of files) {
    const source = await readFile(new URL(file, vendorDir), 'utf8');
    assert.doesNotMatch(source, /\\x1b\[[0-9;]*m|\\u001b\[[0-9;]*m/, `${file} has fixed ANSI color`);
    assert.doesNotMatch(source, /color\.identity|SEMANTIC_ROLES/, `${file} imports tokens`);
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g))
      assert.ok(
        // Node built-ins appear only in the theme installer (pi-theme-install.js).
        specifier.startsWith('./')
          ? specifier.endsWith('.js')
          : specifier === '@earendil-works/pi-tui' ||
            (file === 'pi-theme-install.js' && specifier.startsWith('node:')),
        `${file} imports ${specifier}`,
      );
  }
});

test('package ships the vendored adapter and pins the host range it was verified against', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.ok(pkg.files.includes('vendor/'), 'the adapter ships with the extension');
  assert.equal(pkg.peerDependencies['@earendil-works/pi-tui'], '>=1.5.2 <1.7.0');
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.5.2 <1.7.0');
  assert.equal(pkg.devDependencies['@earendil-works/pi-tui'], '1.6.0');
  assert.ok(!('string-width' in (pkg.dependencies ?? {})));
  const notice = await readFile(new URL('vendor/THIRD_PARTY_NOTICES.md', root), 'utf8');
  assert.match(notice, /License: MIT/);
  assert.match(notice, /"patches": \[\]/);
});

test('consumer README does not advertise the design system or its mark', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  assert.doesNotMatch(readme, /inteiro/i);
});

test('the package ships no design-system mark: only the vendored adapter carries that name', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const named = pkg.files.filter((entry) => /inteiro/i.test(entry) && !entry.startsWith('vendor/'));
  assert.deepEqual(named, [], 'no "files" entry outside vendor/ names the design system');
  const assets = await readdir(new URL('docs/assets/', root)).catch(() => []);
  assert.deepEqual(assets.filter((name) => /inteiro/i.test(name)), [], 'no mark asset left in docs/assets');
});
