import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateDescription,
  commandReference,
  loadProjectLocale,
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
  // Spec descriptions are ignored: each language reads only its own catalog.
  const spec = {
    actions: {
      on: { hint: '', description: 'ativa o roteamento' },
      setup: { hint: '[--global]', description: 'configuração', flags: { '--global': { hint: 'grava no global' } } },
      simulate: { hint: 'TEXT', description: 'simulação' },
      unknown: { hint: '', description: 'sem chave' },
    },
  };
  const english = commandReference('en', 'economist', spec);
  assert.deepEqual(english, [
    '/economist — Route each request to a capable model using risk, quality, cost and latency.',
    '/economist on',
    '    enable routing and switch to economist/auto',
    '/economist setup [--global]',
    '    guided setup from authenticated models',
    '    --global: write the global config instead',
    '/economist simulate TEXT',
    '    free dry run; no model is called',
    '/economist unknown',
  ]);
  const portuguese = commandReference('pt-BR', 'economist', spec);
  assert.match(portuguese[2], /ativa o roteamento e troca para economist\/auto/);
  assert.match(portuguese[5], /--global: grava no arquivo global/);
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
