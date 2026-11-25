import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';

test('版本號：version.js、package.json、CHANGELOG.md 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(pkg.version, VERSION);
  assert.match(changelog, new RegExp(`## \\[${VERSION.replace(/\./g, '\\.')}\\]`));
});
