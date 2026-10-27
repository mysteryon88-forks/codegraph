import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { resolveTolkImport, tolkMappingFingerprint } from '../src/resolution/tolk';

let root: string;
let outside: string;
let graph: CodeGraph | undefined;
afterEach(() => {
  graph?.close(); graph = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (outside) fs.rmSync(outside, { recursive: true, force: true });
});

it('rejects an escaping Acton config before reading mappings or fingerprint content', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-config-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-config-outside-'));
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'inside/util.tolk'), 'fun util() {}');
  graph = CodeGraph.initSync(root); await graph.indexAll();
  fs.writeFileSync(path.join(outside, 'Acton.toml'), '[import-mappings]\nlib = "../inside"\n');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const context = new ReferenceResolver(root, graph.queries).getResolutionContext();
  expect(resolveTolkImport('@lib/util', 'link/main.tolk', context)).toBeNull();
  const before = tolkMappingFingerprint(['link/main.tolk'], context);
  fs.writeFileSync(path.join(outside, 'Acton.toml'), '[import-mappings]\nlib = "../different"\n');
  const after = tolkMappingFingerprint(['link/main.tolk'], new ReferenceResolver(root, graph.queries).getResolutionContext());
  expect(after).toBe(before);
}, 30000);
