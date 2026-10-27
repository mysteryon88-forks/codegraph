import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';

let dir: string;
let outside: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (outside) fs.rmSync(outside, { recursive: true, force: true });
  outside = undefined;
});
it('verifies the nominated build/index and rejects seeded incorrect expectations', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-verify-'));
  fs.writeFileSync(path.join(dir, 'main.tolk'), 'fun helper(): int { return 1; }\nfun run(): int { return helper(); }');
  const cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences(); cg.close();
  const expected = { files: ['main.tolk'], symbols: [{ file: 'main.tolk', name: 'run', kind: 'function', line: 2, source: 'return helper();' }],
    calls: [{ fromFile: 'main.tolk', fromName: 'run', toFile: 'main.tolk', toName: 'helper' }],
    forbidden: [{ fromFile: 'main.tolk', toLanguage: 'typescript' }] };
  const expectFile = path.join(dir, 'expected.json'); fs.writeFileSync(expectFile, JSON.stringify(expected));
  const invoke = () => spawnSync(process.execPath, [path.resolve('scripts/verify-tolk.mjs'), '--build', path.resolve('dist'), '--project', dir, '--expect', expectFile], { encoding: 'utf8', timeout: 30000 });
  const good = invoke(); expect(good.status, good.stderr).toBe(0);
  expect(JSON.parse(good.stdout)).toMatchObject({ success: true, missing: [], indexed: ['main.tolk'] });
  expected.symbols[0]!.name = 'doesNotExist'; fs.writeFileSync(expectFile, JSON.stringify(expected));
  const bad = invoke(); expect(bad.status).toBe(1);
  expect(JSON.parse(bad.stdout).failures.join('\n')).toContain('doesNotExist');
});

it('refuses to emit indexed source through an escaping junction or directory symlink', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-verify-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-outside-'));
  const secret = 'SYNTHETIC_OUTSIDE_SOURCE_MUST_NOT_BE_EMITTED';
  fs.writeFileSync(path.join(outside, 'secret.tolk'), `// ${secret}\nfun secret(): int { return 7; }`);
  fs.symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const cg = CodeGraph.initSync(dir);
  try { await cg.indexAll(); expect(cg.getNodesInFile('link/secret.tolk').some(n => n.name === 'secret')).toBe(true); }
  finally { cg.close(); }
  const expected = { files: ['link/secret.tolk'], symbols: [{ file: 'link/secret.tolk', name: 'secret', kind: 'function', line: 2 }] };
  const expectFile = path.join(dir, 'expected.json'); fs.writeFileSync(expectFile, JSON.stringify(expected));
  const reportFile = path.join(dir, 'report.json');
  const result = spawnSync(process.execPath, [path.resolve('scripts/verify-tolk.mjs'), '--build', path.resolve('dist'), '--project', dir,
    '--expect', expectFile, '--report', reportFile], { encoding: 'utf8', timeout: 30000 });
  expect(result.status).toBe(1);
  const emitted = result.stdout + result.stderr + (fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '');
  expect(emitted).not.toContain(secret);
  expect(emitted).not.toContain('return 7;');
  expect(emitted).toMatch(/(?:escapes|outside|refus)/i);
}, 30000);
