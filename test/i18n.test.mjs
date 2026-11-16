import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateDescription,
  loadProjectLocale,
  localizedHelpLines,
  localeName,
  normalizeLocale,
  translate,
  translationCatalogs,
} from '../lib/i18n.mjs';

test('English and Brazilian Portuguese catalogs have matching keys and placeholders', () => {
  const catalogs = translationCatalogs();
  const englishKeys = Object.keys(catalogs.en).sort();
  const portugueseKeys = Object.keys(catalogs['pt-BR']).sort();
  assert.deepEqual(portugueseKeys, englishKeys);

  for (const key of englishKeys) {
    const placeholders = (text) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      placeholders(catalogs['pt-BR'][key]),
      placeholders(catalogs.en[key]),
      `${key} has the same placeholders in both languages`,
    );
    const values = Object.fromEntries(placeholders(catalogs.en[key]).map((name) => [name, 'sample']));
    assert.doesNotThrow(() => translate('en', key, values), key);
    assert.doesNotThrow(() => translate('pt-BR', key, values), key);
  }
});

test('locale normalization, candidate copy, and command help use complete translations', () => {
  assert.equal(normalizeLocale('pt-BR'), 'pt-BR');
  assert.equal(normalizeLocale('fr'), 'en');
  assert.equal(localeName('missing'), 'English');
  assert.match(candidateDescription({ tier: 2, tools: true, live: true, inScope: true }, 'en'), /tier 2 · tools/);
  assert.match(candidateDescription({ tier: 2, tools: false, live: false, inScope: false }, 'pt-BR'), /tier 2 · sem ferramentas · não autenticado/);
  const help = localizedHelpLines('en', [
    '/economist — Roteie cada pedido',
    '/economist on — ativa o roteamento',
    '/economist simulate TEXT — simulação',
  ]);
  assert.match(help[0], /Route each request/);
  assert.match(help[1], /enable routing/);
  assert.match(help[2], /free dry run/);
});

test('project locale reads only for a trusted project and falls back safely', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-i18n-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, '.pi');
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, 'pi-suite.yaml');
  await writeFile(configPath, 'modelEconomist:\n  locale: pt-BR\n');

  assert.deepEqual(await loadProjectLocale(dir, false), {
    locale: 'en',
    hasStoredValue: false,
    invalid: false,
  });
  assert.deepEqual(await loadProjectLocale(dir, true), {
    locale: 'pt-BR',
    hasStoredValue: true,
    invalid: false,
  });

  await writeFile(configPath, 'modelEconomist:\n  locale: fr\n');
  assert.deepEqual(await loadProjectLocale(dir, true), {
    locale: 'en',
    hasStoredValue: true,
    invalid: true,
  });
  await writeFile(configPath, 'modelEconomist: [\n');
  assert.deepEqual(await loadProjectLocale(dir, true), {
    locale: 'en',
    hasStoredValue: false,
    invalid: true,
  });
  await rm(configPath);
  assert.deepEqual(await loadProjectLocale(dir, true), {
    locale: 'en',
    hasStoredValue: false,
    invalid: false,
  });
});
