import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { analyzeEntry } from './check-bundle-size.mjs';

it('counts the entry script, root stylesheet and local preloads once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgtc-bundle-'));
  try {
    mkdirSync(join(dir, 'assets'));
    for (const path of ['critical.css', 'assets/app.js', 'assets/framework.js']) {
      writeFileSync(join(dir, path), '1234');
    }
    writeFileSync(join(dir, 'index.html'), `
      <link href="/critical.css" rel="stylesheet">
      <script type="module" src="./assets/app.js?v=1"></script>
      <link href="/assets/app.js" rel="modulepreload">
      <link rel="modulepreload" href='assets/framework.js'>
      <script src="https://example.org/remote.js"></script>
    `);
    const entry = analyzeEntry(dir);
    expect(entry.critical.map(file => file.path)).toEqual(['critical.css', 'assets/app.js', 'assets/framework.js']);
    expect(entry.bytes).toBe(12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
