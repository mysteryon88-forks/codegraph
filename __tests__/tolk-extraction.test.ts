import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, isSourceFile, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { kernelRoutes } from '../src/extraction/kernel';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

describe('Tolk extraction', () => {
  beforeAll(async () => { await initGrammars(); });

  it('discovers .tolk without configuration', () => {
    expect(isSourceFile('contracts/counter.tolk')).toBe(true);
    expect(detectLanguage('counter.tolk')).toBe('tolk');
  });

  it('extracts source declarations, receiver ownership and real calls', async () => {
    await loadGrammarsForLanguages(['tolk' as any]);
    const source = [
      '// Привет 🌍: fun fake() {}',
      'import "./utils"',
      'struct Storage { count: uint64 }',
      'enum State { Idle = 0, Active = 1 }',
      'type Amount = int;',
      'const LIMIT = 100;',
      'global total: int;',
      'contract Counter { storage: Storage, author: "TON" }',
      '@inline',
      'fun identity<T>(value: T): T { return value; }',
      'fun Storage.save(mutate self): void { total = self.count; }',
      'fun add(a: int, b: int): int asm "ADD";',
      'fun onInternalMessage(in: InMessage) { total = identity<int>(add(1, 2)); }',
      'get fun answer(): int { return identity<int>(42); }',
    ].join('\r\n');
    const result = extractFromSource('counter.tolk', source);
    expect(result.errors).toEqual([]);
    const find = (name: string) => result.nodes.find(n => n.name === name)!;
    expect(find('Storage')).toMatchObject({ kind: 'struct', language: 'tolk', startLine: 3, startColumn: 0 });
    expect(find('count')).toMatchObject({ kind: 'field', signature: 'count: uint64', startLine: 3, startColumn: 17 });
    expect(find('Idle').kind).toBe('enum_member');
    expect(find('Amount').kind).toBe('type_alias');
    expect(find('LIMIT').kind).toBe('constant');
    expect(find('total').kind).toBe('variable');
    expect(find('Counter')).toMatchObject({ kind: 'class', decorators: ['tolk:contract'] });
    expect(find('save')).toMatchObject({ kind: 'method', qualifiedName: 'counter.tolk::Storage::save', returnType: 'void' });
    expect(find('identity')).toMatchObject({ startLine: 9, endLine: 10, signature: '@inline\r\nfun identity<T>(value: T): T', typeParameters: ['T'], returnType: 'T' });
    expect(find('value')).toMatchObject({ kind: 'parameter', signature: 'value: T' });
    expect(find('answer').decorators).toContain('tolk:getter');
    expect(result.edges).toContainEqual(expect.objectContaining({ source: find('counter.tolk').id, target: find('save').id, kind: 'contains' }));
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName).sort()).toEqual(['add', 'identity', 'identity']);
    expect(find('fake')).toBeUndefined();
  });

  it('retains parse diagnostics and recovers valid siblings', async () => {
    await loadGrammarsForLanguages(['tolk' as any]);
    const result = extractFromSource('broken.tolk', 'fun good(): int { return 1; }\nfun broken( {');
    expect(result.nodes.some(n => n.name === 'good')).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('parses decimal, hex and binary numeric separators without hiding errors', async () => {
    await loadGrammarsForLanguages(['tolk']);
    const result = extractFromSource('numbers.tolk', 'const DEC = 1_700_000_000;\nconst HEX = 0xFF_FF;\nconst BIN = 0b10_01;');
    expect(result.errors).toEqual([]);
    expect(result.nodes.filter(n => n.kind === 'constant').map(n => n.name)).toEqual(['DEC', 'HEX', 'BIN']);
  });

  it.each(['auto', 'all', 'disabled'])('keeps Tolk on WASM with %s kernel routing', async (mode) => {
    const oldKernel = process.env.CODEGRAPH_KERNEL, oldLanguages = process.env.CODEGRAPH_KERNEL_LANGS;
    try {
      if (mode === 'disabled') process.env.CODEGRAPH_KERNEL = '0'; else delete process.env.CODEGRAPH_KERNEL;
      if (mode === 'all') process.env.CODEGRAPH_KERNEL_LANGS = 'all'; else delete process.env.CODEGRAPH_KERNEL_LANGS;
      await loadGrammarsForLanguages(['tolk']);
      expect(kernelRoutes('tolk')).toBe(false);
      const result = extractFromSource('routed.tolk', 'fun routed(): int { return 1; }');
      expect(result.errors).toEqual([]);
      expect(result.nodes.some(n => n.name === 'routed')).toBe(true);
      expect(result.kernelBuffers).toBeUndefined();
    } finally {
      if (oldKernel === undefined) delete process.env.CODEGRAPH_KERNEL; else process.env.CODEGRAPH_KERNEL = oldKernel;
      if (oldLanguages === undefined) delete process.env.CODEGRAPH_KERNEL_LANGS; else process.env.CODEGRAPH_KERNEL_LANGS = oldLanguages;
    }
  });

  it('ships the pinned grammar together with its license, provenance and local patch', () => {
    for (const suffix of ['LICENSE', 'PROVENANCE.md', 'patch']) {
      const file = `tree-sitter-tolk.${suffix}`;
      expect(fs.readFileSync(path.resolve('dist/extraction/wasm', file))).toEqual(fs.readFileSync(path.resolve('src/extraction/wasm', file)));
    }
    const wasm = fs.readFileSync(path.resolve('dist/extraction/wasm/tree-sitter-tolk.wasm'));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe('4829ff208e5fa1c45ea2b546b608d331bd3fcc7671692edd6f3a250630f1cb8f');
  });
});
