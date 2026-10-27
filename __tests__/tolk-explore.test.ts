import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { resolveNamedTokens, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { ExploreSessionState } from '../src/mcp/explore-session-state';

let dir: string;
let cg: CodeGraph;
afterEach(() => { cg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it.each(['tolk', 'ts'])('renders the named %s callee connected to the path-pinned caller among repeated contract methods', async (ext) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-explore-'));
  for (const contract of [...Array.from({ length: 63 }, (_, i) => `alpha${String(i).padStart(2, '0')}`), 'counter']) {
    const base = path.join(dir, contract, 'contracts');
    fs.mkdirSync(base, { recursive: true });
    const count = contract === 'counter' ? '424242' : '0';
    fs.writeFileSync(path.join(base, `Counter.${ext}`), ext === 'tolk'
      ? 'import "types"\nfun onInternalMessage() { Storage.load(); }'
      : 'import { Storage } from "./types";\nexport function onInternalMessage() { Storage.load(); }');
    fs.writeFileSync(path.join(base, `types.${ext}`), ext === 'tolk'
      ? `struct Storage { count: int }\nfun Storage.load(): Storage {\n  return Storage { count: ${count} };\n}`
      : `export class Storage { static load() {\n  return { count: ${count} };\n} }`);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  const caller = cg.getNodesInFile(`counter/contracts/Counter.${ext}`).find(n => n.name === 'onInternalMessage')!;
  expect(cg.getCallees(caller.id).map(c => c.node.filePath)).toEqual([`counter/contracts/types.${ext}`]);
  const ambiguous = resolveNamedTokens(cg, 'onInternalMessage Storage.load');
  expect(ambiguous.tokenFamily.get('onInternalMessage')).toHaveLength(64);
  expect(ambiguous.tokenNodes.get('onInternalMessage')).toEqual([]);
  const flow = resolveNamedSymbolFlow(cg, 'onInternalMessage Storage.load', { preferredFiles: [`counter/contracts/Counter.${ext}`] });
  expect(flow.chains[0]!.steps.map(s => s.node.filePath)).toEqual([`counter/contracts/Counter.${ext}`, `counter/contracts/types.${ext}`]);
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: `counter/contracts/Counter.${ext} onInternalMessage Storage.load`,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect(out).toContain(`**\`counter/contracts/types.${ext}\``);
  expect(out).toContain('count: 424242');
  expect(out).not.toContain(`**\`alpha00/contracts/types.${ext}\``);
});

async function indexScopedContracts(storageFields = 0) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-scope-'));
  const files: Record<string, string> = {
    'sale/main.tolk': [
      'import "utils"', 'import "types"', 'import "unused"',
      ...Array.from({ length: 220 }, (_, i) => `// contract documentation ${i}`),
      'fun onExternalMessage() {', '  val storage = Storage.load();', '  val reserve = getRequiredReserve();',
      '  if (reserve > 0) {', '    storage.count;', '  }',
      '  if (reserve < 0) {', '    getRequiredReserve();', '  }', '}',
      'fun unrelatedLocal() { unusedOnly(); }',
    ].join('\n'),
    'sale/utils.tolk': [
      'import "../shared/constants"',
      ...Array.from({ length: 220 }, (_, i) => `// utility documentation ${i}`),
      'fun getRequiredReserve(): int { return saleStorageReserve(); }',
      'fun unrelatedUtility(): int { return 777777; }',
    ].join('\n'),
    'sale/types.tolk': ['struct Storage {', '  count: int',
      ...Array.from({ length: storageFields }, (_, i) => `  field${i}: int`),
      '}', 'fun Storage.load(): Storage { return Storage { count: 424242 }; }'].join('\n'),
    'sale/unused.tolk': 'fun unusedOnly() { }',
    'shared/constants.tolk': 'import "limit"\nfun saleStorageReserve(): int { return reserveLimit(); }',
    'shared/limit.tolk': 'import "beyond"\nfun reserveLimit(): int { return beyondScope(); }',
    'shared/beyond.tolk': 'fun beyondScope(): int { return 999999; }',
    'other/main.tolk': 'import "../shared/constants"\nfun onExternalMessage() { saleStorageReserve(); }\nfun getRequiredReserve(): int { return 111111; }',
    'other/types.tolk': 'struct Storage { wrong: int }\nfun Storage.load(): Storage { return Storage { wrong: 111111 }; }',
    'wrappers/Sale.ts': 'export function onExternalMessage() { getRequiredReserve(); }\nexport function getRequiredReserve() { return 222222; }',
    'extra.tolk': 'fun explicitlyPinned(): int { return 333333; }',
    'imports-only.tolk': 'import "sale/utils"',
    'shape.tolk': 'struct Shape {\n  value: int\n}',
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
}

it('keeps a pinned Tolk entrypoint, its helper chain and imports in one response without namesakes or shared-helper callers', async () => {
  await indexScopedContracts();
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'sale/main.tolk onExternalMessage getRequiredReserve Storage.load saleStorageReserve reserveLimit beyondScope',
    maxFiles: 5,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  for (const file of ['sale/main.tolk', 'sale/utils.tolk', 'sale/types.tolk', 'shared/constants.tolk', 'shared/limit.tolk']) {
    expect(out).toContain(`**\`${file}\``);
  }
  expect(out).toMatch(/1\s+import "utils"/);
  expect(out).toMatch(/2\s+import "types"/);
  expect(out).toMatch(/224\s+fun onExternalMessage\(\)/);
  expect(out).toMatch(/1\s+import "\.\.\/shared\/constants"/);
  expect(out).toContain('return saleStorageReserve();');
  expect(out).toContain('return reserveLimit();');
  expect(out).toContain('count: 424242');
  expect(out).toContain('struct Storage {');
  expect(out).toContain('Callers within this dependency scope');
  for (const forbidden of ['other/main.tolk', 'other/types.tolk', 'wrappers/Sale.ts', 'sale/unused.tolk', 'shared/beyond.tolk']) expect(out).not.toContain(forbidden);
  expect(out).not.toContain('import "unused"');
  expect(out.length).toBeLessThan(19000);
});

it('honors Tolk line pins, multiple file pins, maxFiles and source dedup within the scope', async () => {
  await indexScopedContracts();
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '1');
  const handler = new ToolHandler(cg);
  const session = new ExploreSessionState();
  const args = { query: 'sale/main.tolk:224-233 extra.tolk onExternalMessage getRequiredReserve', maxFiles: 2 };
  const first = await handler.execute('codegraph_explore', args, session);
  const out = first.content?.[0]?.text ?? '';
  expect(out).toContain('224\tfun onExternalMessage()');
  expect(out).toContain('233\t}');
  expect(out).toContain('333333');
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(2);
  expect(out).not.toContain('other/main.tolk');
  const again = await handler.execute('codegraph_explore', args, session);
  expect(again.content?.[0]?.text).toContain('Already sent earlier in this conversation');
});

it('leaves unpinned and mixed-language file queries on ordinary explore behavior', async () => {
  await indexScopedContracts();
  const handler = new ToolHandler(cg);
  for (const query of [
    'onExternalMessage getRequiredReserve',
    'sale/main.tolk wrappers/Sale.ts onExternalMessage getRequiredReserve',
  ]) {
    const result = await handler.execute('codegraph_explore', { query, maxFiles: 5 });
    expect(result.content?.[0]?.text).toContain('wrappers/Sale.ts');
  }
});

it('uses ordinary pinned declarations for a pure Tolk path query', async () => {
  await indexScopedContracts();
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'sale/main.tolk' });
  const out = result.content?.[0]?.text ?? '';
  expect(out).toContain('fun onExternalMessage()');
  expect(out).toContain('return saleStorageReserve();');
  expect(out).toContain('unusedOnly');
  expect(out).not.toContain('other/main.tolk');
  expect(out).not.toContain('wrappers/Sale.ts');
});

it('keeps explicitly pinned Tolk files containing only a type or import', async () => {
  await indexScopedContracts();
  const handler = new ToolHandler(cg);
  const shape = await handler.execute('codegraph_explore', { query: 'shape.tolk' });
  expect(shape.content?.[0]?.text).toContain('1\tstruct Shape {');
  const imports = await handler.execute('codegraph_explore', { query: 'imports-only.tolk' });
  expect(imports.content?.[0]?.text).toContain('1\timport "sale/utils"');
});

it('keeps unnamed second-hop helpers beside a field-heavy storage type within the existing file budget', async () => {
  await indexScopedContracts(30);
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'sale/main.tolk onExternalMessage reserve storage auto renew', maxFiles: 5,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(out).toContain('fun saleStorageReserve(): int { return reserveLimit(); }');
  expect(out).toContain('fun reserveLimit(): int { return beyondScope(); }');
  expect(out).toContain('1\timport "../shared/constants"');
  expect(out).toContain('struct Storage {');
  expect(out).not.toContain('other/main.tolk');
  expect(out).not.toContain('wrappers/Sale.ts');
  expect(out.length).toBeLessThan(19000);
});

it('prioritizes a normalized reachable callable name over incidental helper bodies without inventing that name', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-priority-'));
  const steps = Array.from({ length: 40 }, (_, i) => `prepareStep${i}`);
  fs.writeFileSync(path.join(dir, 'main.tolk'), [
    'import "helpers"', 'fun onInternalMessage() {',
    ...steps.map(name => `  ${name}();`), '  finalizeDeal();', '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'helpers.tolk'), [
    ...steps.map((name, i) => [
      `fun ${name}(): int {`,
      ...Array.from({ length: 10 }, () => '  // Incidental preparation details occupy the source allocation before settlement.'),
      `  return ${i};`, '}',
    ].join('\n')),
    'fun finalizeDeal(): int {',
    ...Array.from({ length: 90 }, () => '  // Settlement accounting and conditions.'),
    '  val balance = 100;', '  if (balance < 200) {', '    throw 424242;', '  }',
    '  return 31337;', '}',
  ].join('\n'));
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'main.tolk onInternalMessage finalize_deal', maxFiles: 5,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(out).toContain('fun finalizeDeal(): int {');
  expect(out).toContain('throw 424242;');
  expect(out).toContain('return 31337;');
  expect(out).toContain('**Not in the index:** `finalize_deal`');
  expect(out).not.toContain('fun finalize_deal');
  expect(out.length).toBeLessThan(19500);
});

it('keeps a separated dependency import beside large focused bodies within the existing source allowance', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-import-budget-'));
  fs.writeFileSync(path.join(dir, 'main.tolk'), [
    ...Array.from({ length: 4 }, (_, i) => `import "context${i}"`),
    '', '// Local settlement helpers', '', 'import "utils"', '',
    'fun onInternalMessage() {',
    ...Array.from({ length: 4 }, (_, i) => `  contextStep${i}();`),
    ...Array.from({ length: 140 }, () => '  // Incoming payment state and validation details remain part of the handler body.'),
    '  if (100 < 200) { throw 424242; }', '  finalizeDeal();', '}', '',
    'fun onExternalMessage() {',
    ...Array.from({ length: 140 }, () => '  // External payment state and validation details remain part of the handler body.'),
    '  finalizeDeal();', '}',
  ].join('\n'));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `context${i}.tolk`), `fun contextStep${i}() {}`);
  fs.writeFileSync(path.join(dir, 'utils.tolk'), 'fun finalizeDeal(): int { return 31337; }');
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'main.tolk onInternalMessage onExternalMessage finalize_deal', maxFiles: 5,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(out).toContain('8\timport "utils"');
  expect(out).toContain('fun finalizeDeal(): int { return 31337; }');
  expect(out).toContain('if (100 < 200) { throw 424242; }');
  expect(out).toContain('finalizeDeal();');
  expect(out.length).toBeLessThan(19500);
});
