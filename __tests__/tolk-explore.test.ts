import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { exploreQueryTokens, ToolHandler } from '../src/mcp/tools';
import { resolveNamedTokens, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { pinnedTolkScope } from '../src/mcp/explore-tolk-scope';
import { namedTolkArmRanges } from '../src/mcp/explore-tolk-ranges';
import { MAX_PARSE_BYTES } from '../src/graph/branch-guards';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;
afterEach(() => { cg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function indexMessageContract(extraMain: string[] = [], extraFiles: Record<string, string> = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-message-'));
  const files: Record<string, string> = {
    'game/main.tolk': [
      'import "types"', 'import "helpers"', 'import "messages"',
      'contract PointsGame { storage: Storage }',
      'get fun score(): int { return 7; }',
      ...Array.from({ length: 220 }, () => '// Contract documentation separates unrelated declarations.'),
      'fun onInternalMessage(message: AddPoints) {',
      '  var storage = Storage.load();',
      '  if (message.score > 0) {',
      '    storage.addPoints(message.score);',
      '    storage.save();', '  }', '}',
      ...Array.from({ length: 220 }, () => '// Receiver implementation has its own source location.'),
      'fun Storage.addPoints(mutate self, score: int) {',
      '  if (score > 100) { throw 71234; }',
      '  self.count += bonusFor(score);', '}',
      ...extraMain,
    ].join('\n'),
    'game/types.tolk': [
      'struct Storage { count: int }',
      'fun Storage.load(): Storage { return Storage { count: 23 }; }',
      'fun Storage.save(self) { contract.setData(self.toCell()); }',
    ].join('\n'),
    'game/helpers.tolk': 'fun bonusFor(value: int): int { return value + 101; }',
    'game/messages.tolk': 'struct AddPoints { score: int }',
    'other/main.tolk': 'import "../game/types"\nfun onInternalMessage(storage: Storage) { storage.save(); }\nfun Storage.addPoints(self, score: int) { throw 81234; }',
    'wrappers/Game.ts': 'export function addPoints(score: number) { return score + 91234; }',
    ...extraFiles,
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
}

it('selects a message receiver and its containing handler before incidental storage and score matches', async () => {
  await indexMessageContract();
  const query = 'game/main.tolk Explain AddPoints handling storage changes score validation';
  const handler = cg.getNodesInFile('game/main.tolk').find(n => n.name === 'onInternalMessage')!;
  const receiver = cg.getNodesInFile('game/main.tolk').find(n => n.name === 'addPoints')!;
  expect(cg.getCallees(handler.id).map(c => c.node.id)).toContain(receiver.id);
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], exploreQueryTokens('Explain AddPoints handling storage changes score validation'), [])!;
  expect(scope.nodes.has(handler.id)).toBe(true);
  expect(scope.nodes.has(receiver.id)).toBe(true);
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query, maxFiles: 5 });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect(out).toContain('226\tfun onInternalMessage(message: AddPoints) {');
  expect(out).toContain('if (message.score > 0) {');
  expect(out).toContain('storage.addPoints(message.score);');
  expect(out).toContain('storage.save();');
  expect(out).toContain('453\tfun Storage.addPoints(mutate self, score: int) {');
  expect(out).toContain('if (score > 100) { throw 71234; }');
  expect(out).toContain('self.count += bonusFor(score);');
  expect(out).toContain('fun bonusFor(value: int): int { return value + 101; }');
  expect(out).toContain('struct Storage { count: int }');
  expect(out).toContain('struct AddPoints { score: int }');
  for (const [line, name] of [[1, 'types'], [2, 'helpers'], [3, 'messages']]) expect(out).toContain(`${line}\timport "${name}"`);
  for (const forbidden of ['other/main.tolk', 'wrappers/Game.ts', '81234', '91234']) expect(out).not.toContain(forbidden);
  expect(out.length).toBeLessThan(19000);
});

it('preserves getter and line focus and qualifies receiver callers within the pinned file', async () => {
  await indexMessageContract([
    'struct OtherStorage { count: int }',
    'fun OtherStorage.addPoints(mutate self, score: int) { self.count += 999; }',
    'fun otherHandler(value: OtherStorage) { value.addPoints(1); }',
    'fun directCaller(value: Storage) { value.addPoints(2); }',
    'fun indirectCaller(value: Storage) { directCaller(value); }',
    'fun unresolvedCaller() { missing.addPoints(3); }',
  ]);
  const main = cg.getNodesInFile('game/main.tolk');
  const handler = main.find(n => n.name === 'onInternalMessage')!;
  const getter = main.find(n => n.decorators?.includes('tolk:getter'))!;
  const scopeFor = (query: string, anchors: Parameters<typeof pinnedTolkScope>[3] = []) =>
    pinnedTolkScope(cg, ['game/main.tolk'], exploreQueryTokens(query), anchors)!;
  const getterScope = scopeFor('score');
  expect(getterScope.nodes.has(getter.id)).toBe(true);
  expect(getterScope.nodes.has(handler.id)).toBe(false);
  const lineScope = scopeFor('Storage.addPoints', [{ file: 'game/main.tolk', start: 453, end: 456 }]);
  expect(lineScope.nodes.has(handler.id)).toBe(false);
  expect([...lineScope.nodes.values()].some(n => n.name === 'directCaller')).toBe(false);
  const entryScope = scopeFor('onInternalMessage storage score');
  expect(entryScope.nodes.has(handler.id)).toBe(true);
  expect([...entryScope.nodes.values()].some(n => n.name === 'directCaller')).toBe(false);
  const receiverScope = scopeFor('Storage.addPoints');
  expect(receiverScope.nodes.has(handler.id)).toBe(true);
  expect([...receiverScope.nodes.values()].some(n => n.name === 'directCaller')).toBe(true);
  expect([...receiverScope.nodes.values()].some(n => n.decorators?.includes('tolk:receiver:OtherStorage'))).toBe(false);
  for (const name of ['otherHandler', 'indirectCaller', 'unresolvedCaller']) {
    expect([...receiverScope.nodes.values()].some(n => n.name === name)).toBe(false);
  }
  expect([...receiverScope.nodes.values()].every(n => n.filePath.startsWith('game/'))).toBe(true);
});

it('does not infer a receiver from message words found only in comments or strings', async () => {
  await indexMessageContract([
    '// MissingPoints must not stand in for the real receiver.',
    'fun textOnly(): slice { return "MissingPoints"; }',
  ]);
  const handler = cg.getNodesInFile('game/main.tolk').find(n => n.name === 'onInternalMessage')!;
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], ['MissingPoints', 'storage', 'score'], [])!;
  expect(scope.nodes.has(handler.id)).toBe(false);
  expect([...scope.nodes.values()].some(n => n.name === 'addPoints' && n.kind === 'method')).toBe(false);
  expect([...scope.nodes.values()].some(n => n.name === 'textOnly')).toBe(false);
});

it('keeps the selected receiver and its forward dependencies ahead of callers under the existing node cap', async () => {
  await indexMessageContract(Array.from({ length: 205 }, (_, i) =>
    `fun caller${i}(value: Storage) { value.addPoints(1); }`));
  const receiver = cg.getNodesInFile('game/main.tolk').find(n => n.name === 'addPoints')!;
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], ['Storage.addPoints'], [])!;
  expect(scope.nodes.has(receiver.id)).toBe(true);
  const helper = cg.getNodesInFile('game/helpers.tolk').find(n => n.name === 'bonusFor')!;
  expect(scope.nodes.has(helper.id)).toBe(true);
  expect(scope.edges).toContainEqual(expect.objectContaining({ source: receiver.id, target: helper.id, kind: 'calls' }));
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'game/main.tolk Storage.addPoints', maxFiles: 5 });
  const out = result.content?.[0]?.text ?? '';
  expect(out).toContain('**`game/helpers.tolk`');
  expect(out).toContain('fun bonusFor(value: int): int { return value + 101; }');
  expect(scope.nodes.size).toBeLessThanOrEqual(200);
  expect(scope.roots.length).toBeLessThanOrEqual(200);
});

it('expands deferred callers through shared dependencies at their shorter depth without exceeding depth three', async () => {
  await indexMessageContract([
    'fun directCaller(value: Storage) { value.addPoints(1); sharedWork(1); }',
  ], {
    'game/helpers.tolk': [
      'fun bonusFor(value: int): int { return middleStep(value); }',
      'fun middleStep(value: int): int { return sharedWork(value); }',
      'fun sharedWork(value: int): int { return tailWork(value); }',
      'fun tailWork(value: int): int { return depthLimit(value); }',
      'fun depthLimit(value: int): int { return beyondScope(value); }',
      'fun beyondScope(value: int): int { return value; }',
    ].join('\n'),
  });
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], ['Storage.addPoints'], [])!;
  const names = [...scope.nodes.values()].map(n => n.name);
  expect(names).toContain('directCaller');
  expect(names).toContain('tailWork');
  expect(names).toContain('depthLimit');
  expect(names).not.toContain('beyondScope');
});

it('includes exact named direct-import types without inventing edges or admitting transitive and unimported namesakes', async () => {
  await indexMessageContract([], {
    'game/messages.tolk': 'import "transitive"\nstruct AddPoints { score: int }',
    'game/transitive.tolk': 'struct HiddenMessage { value: int }',
    'unimported/messages.tolk': 'struct AddPoints { wrong: int }\nstruct UnknownMessage { wrong: int }',
  });
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], ['AddPoints', 'storage', 'score'], [])!;
  const message = [...scope.nodes.values()].find(n => n.kind === 'struct' && n.name === 'AddPoints')!;
  expect(message.filePath).toBe('game/messages.tolk');
  expect([...scope.nodes.values()].every(n => !n.filePath.startsWith('unimported/'))).toBe(true);
  const handler = cg.getNodesInFile('game/main.tolk').find(n => n.name === 'onInternalMessage')!;
  expect(scope.edges.some(e => e.source === handler.id && e.target === message.id)).toBe(false);
  for (const token of ['HiddenMessage', 'UnknownMessage']) {
    const missing = pinnedTolkScope(cg, ['game/main.tolk'], [token, 'storage', 'score'], [])!;
    expect([...missing.nodes.values()].some(n => n.filePath === 'game/messages.tolk' && n.kind === 'struct')).toBe(false);
    expect([...missing.nodes.values()].some(n => n.filePath === 'game/transitive.tolk')).toBe(false);
    expect([...missing.nodes.values()].some(n => n.filePath.startsWith('unimported/'))).toBe(false);
  }
  const normalized = pinnedTolkScope(cg, ['game/main.tolk'], ['add_points', 'storage', 'score'], [])!;
  expect(normalized.nodes.has(handler.id)).toBe(true);
  expect([...normalized.nodes.values()].some(n => n.kind === 'method' && n.name === 'addPoints')).toBe(true);
  expect([...normalized.nodes.values()].filter(n => n.kind === 'struct' && n.name === 'AddPoints'))
    .toEqual([expect.objectContaining({ filePath: 'game/messages.tolk' })]);
  expect([...normalized.nodes.values()].some(n => n.kind === 'struct' && n.name === 'add_points')).toBe(false);
  expect([...normalized.nodes.values()].some(n => n.filePath === 'game/transitive.tolk' || n.filePath.startsWith('unimported/'))).toBe(false);
  expect(normalized.edges.some(e => e.source === handler.id && e.target === message.id)).toBe(false);
});

it('keeps unique directly imported receiver, return and simple parameter types without guessing ambiguous or composite owners', async () => {
  await indexMessageContract([], {
    'owners/main.tolk': [
      'import "data"', 'import "other"',
      'struct Local { own: int }',
      'fun Ledger.update(self) {}',
      'fun inspectState<T>(value: Ledger, local: Local, clash: Clash, hidden: Hidden, nested: [Container], maybe: Maybe?, generic: T): Outcome {}',
    ].join('\n'),
    'owners/data.tolk': 'import "transitive"\nstruct Ledger { count: int }\nstruct Outcome { ok: bool }\nstruct Clash { first: int }\nstruct Container { count: int }\nstruct Maybe { count: int }\nstruct T { count: int }\nstruct Local { wrong: int }',
    'owners/other.tolk': 'struct Clash { second: int }',
    'owners/transitive.tolk': 'struct Hidden { wrong: int }',
    'unimported/owners.tolk': 'struct Ledger { wrong: int }\nstruct Outcome { wrong: int }',
  });
  for (const token of ['Ledger.update', 'inspectState']) {
    const scope = pinnedTolkScope(cg, ['owners/main.tolk'], [token], [])!;
    const types = [...scope.nodes.values()].filter(n => n.kind === 'struct');
    expect(types).toContainEqual(expect.objectContaining({ name: 'Ledger', filePath: 'owners/data.tolk' }));
    if (token === 'inspectState') {
      expect(types).toContainEqual(expect.objectContaining({ name: 'Local', filePath: 'owners/main.tolk' }));
      expect(types).toContainEqual(expect.objectContaining({ name: 'Outcome', filePath: 'owners/data.tolk' }));
    }
    for (const name of ['Clash', 'Hidden', 'Container', 'Maybe', 'T']) expect(types.some(n => n.name === name)).toBe(false);
    expect(types.some(n => n.filePath.startsWith('unimported/'))).toBe(false);
    expect([...scope.nodes.values()].some(n => n.kind === 'import' && n.name === 'data')).toBe(true);
  }
});

async function indexLargeMessageHandler(newline: string) {
  const source = [
    '// Привет 🌍', 'import "data"', 'import "messages"', 'import "helpers"',
    'fun Storage.load(): Storage { return Storage.fromCell(contract.getData()); }',
    'fun Storage.save(self) { contract.setData(self.toCell()); }',
    'fun onInternalMessage(message: Payload) {',
    '  var storage = Storage.load();', '  match (message) {',
    '    FirstMessage => {',
    ...Array.from({ length: 140 }, () => '      // Earlier message accounting and checks occupy the source allocation before the requested branch.'),
    '      storage.count += 1;', '    }',
    '    ClaimBonus => {',
    '      val entry = loadEntry(message.key);',
    '      assert(entry.owner == message.sender) throw 701;',
    '      if (!entry.active) { throw 702; }',
    '      val label = "Бонус 🌍";',
    '      val points = entry.score + message.extra;',
    '      recordBonus(points);', '    }',
    '    LastMessage => {',
    ...Array.from({ length: 140 }, () => '      // Later message accounting and checks are unrelated to the requested middle branch.'),
    '      storage.count += 2;', '    }', '  }', '  storage.save();', '}',
  ].join(newline);
  await indexMessageContract([], {
    'large/main.tolk': source,
    'large/data.tolk': 'struct Storage { count: int }\nstruct Entry { owner: int, active: bool, score: int }',
    'large/messages.tolk': 'struct FirstMessage {}\nstruct ClaimBonus { key: int, sender: int, extra: int }\nstruct LastMessage {}\ntype Payload = FirstMessage | ClaimBonus | LastMessage;',
    'large/helpers.tolk': 'import "data"\nfun loadEntry(key: int): Entry { return Entry { owner: key, active: true, score: 41 }; }\nfun recordBonus(points: int) {}',
  });
  return source.split(/\r?\n/);
}

it.each(['\n', '\r\n'])('retains a named middle message arm and handler completion within existing budgets (%j)', async newline => {
  const source = await indexLargeMessageHandler(newline);
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'large/main.tolk onInternalMessage ClaimBonus storage score', maxFiles: 5,
  });
  const out = result.content?.[0]?.text ?? '';
  for (const text of [
    'fun onInternalMessage(message: Payload) {', '    ClaimBonus => {',
    '      val entry = loadEntry(message.key);', '      assert(entry.owner == message.sender) throw 701;',
    '      if (!entry.active) { throw 702; }', '      val label = "Бонус 🌍";',
    '      val points = entry.score + message.extra;', '      recordBonus(points);', '  storage.save();',
  ]) expect(out).toContain(`${source.indexOf(text) + 1}\t${text}`);
  expect(out).toContain('2\timport "data"');
  expect(out).toContain('struct Storage { count: int }');
  expect(out).toContain('fun loadEntry(key: int): Entry');
  expect(out).not.toContain('other/main.tolk');
  expect(out).not.toContain('wrappers/Game.ts');
  expect(out.length).toBeLessThan(19500);
  const capped = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'large/main.tolk onInternalMessage ClaimBonus storage score', maxFiles: 1,
  });
  const cappedOut = capped.content?.[0]?.text ?? '';
  expect([...cappedOut.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(1);
  expect(cappedOut).toContain('153\t    ClaimBonus => {');
  expect(cappedOut).not.toContain('**`large/data.tolk`');
  expect(cappedOut).not.toContain('**`large/helpers.tolk`');
  expect(cappedOut.length).toBeLessThan(19500);
});

it('derives ranges only from literal AST message arms inside the selected callable', async () => {
  const source = [
    'fun onInternalMessage(msg: Payload) {',
    '  // FakeBranch => { claim(); }',
    '  val text = "FakeBranch => { claim(); }";',
    '  match (msg) {',
    '    GoodBranch => { val label = "Бонус 🌍"; }',
    '    else => {}', '  }', '}',
    'fun unrelated(msg: Payload) { match (msg) { OutsideBranch => {} else => {} } }',
  ].join('\r\n');
  const selected = [{ name: 'onInternalMessage', startLine: 1, endLine: 8 }];
  const ranges = await namedTolkArmRanges(source, selected, ['GoodBranch']);
  expect(ranges).toHaveLength(1);
  expect(ranges[0]!.arm).toEqual({ start: 5, end: 5 });
  expect(source.split(/\r?\n/).slice(ranges[0]!.arm.start - 1, ranges[0]!.arm.end).join('\n')).toContain('GoodBranch =>');
  for (const token of ['FakeBranch', 'OutsideBranch', 'goodBranch', 'UnknownBranch']) {
    expect(await namedTolkArmRanges(source, selected, [token])).toEqual([]);
  }
  expect(await namedTolkArmRanges(source, [{ ...selected[0]!, endLine: 9 }], ['GoodBranch'])).toEqual([]);
});

it('returns no inferred arm for missing, malformed or over-budget source', async () => {
  const source = 'fun onInternalMessage(msg: Payload) {\n match (msg) { GoodBranch => {} else => {} }\n}';
  const selected = [{ name: 'onInternalMessage', startLine: 1, endLine: 3 }];
  expect(await namedTolkArmRanges(source, selected, ['GoodBranch'])).toHaveLength(1);
  for (const invalid of ['', source.slice(0, -1), source.replace('msg: Payload)', 'msg: Payload'), `${source}\n//${'x'.repeat(MAX_PARSE_BYTES)}`]) {
    expect(await namedTolkArmRanges(invalid, selected, ['GoodBranch'])).toEqual([]);
  }
});

it('starts named arm parsing from its own source after a cached parser cancellation', async () => {
  await loadGrammarsForLanguages(['tolk']);
  const parser = getParser('tolk')!;
  const source = 'fun onInternalMessage(msg: Payload) {\n match (msg) { GoodBranch => {} else => {} }\n}';
  const selected = [{ name: 'onInternalMessage', startLine: 1, endLine: 3 }];
  let interrupted: ReturnType<typeof parser.parse> = null;
  try {
    parser.reset();
    interrupted = parser.parse('fun abandoned(msg: Payload) { match (msg) { AbandonedBranch => {} else => {} } }\n'.repeat(20000), null, {
      progressCallback: () => true,
    });
    expect(interrupted).toBeNull();
    const evidence = await namedTolkArmRanges(source, selected, ['GoodBranch']);
    expect(evidence).toEqual([{ name: 'GoodBranch', arm: { start: 2, end: 2 }, context: [{ start: 1, end: 3 }, { start: 1, end: 3 }] }]);
  } finally {
    interrupted?.delete();
    parser.reset();
  }
});

it('rejects an arm owned by a nested lambda but keeps nested ordinary control blocks', async () => {
  await loadGrammarsForLanguages(['tolk']);
  const source = [
    'fun onInternalMessage(msg: Payload) {',
    '  val cb = fun(nested: Payload) { match (nested) { NestedBranch => { throw 711; } else => {} } };',
    '  if (1 > 0) {',
    '    match (msg) { PlainBranch => { throw 712; } else => {} }',
    '  }', '}',
  ].join('\n');
  const parser = getParser('tolk')!;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('lambda_expression')).toHaveLength(1);
  } finally {
    tree.delete();
    parser.reset();
  }
  const selected = [{ name: 'onInternalMessage', startLine: 1, endLine: 6 }];
  expect(await namedTolkArmRanges(source, selected, ['NestedBranch'])).toEqual([]);
  const evidence = await namedTolkArmRanges(source, selected, ['PlainBranch']);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.arm).toEqual({ start: 4, end: 4 });
});

it('preserves large-handler dedup, explicit line focus and freshness when adding arm ranges', async () => {
  const source = await indexLargeMessageHandler('\n');
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '1');
  const handler = new ToolHandler(cg), session = new ExploreSessionState();
  const query = 'large/main.tolk onInternalMessage ClaimBonus storage score';
  await handler.execute('codegraph_explore', { query, maxFiles: 5 }, session);
  const again = await handler.execute('codegraph_explore', { query, maxFiles: 5 }, session);
  expect(again.content?.[0]?.text).toContain('Already sent earlier in this conversation');
  expect(again.content?.[0]?.text).not.toContain('153\t    ClaimBonus => {');
  const line = await handler.execute('codegraph_explore', { query: 'large/main.tolk:10-12 ClaimBonus', maxFiles: 1 });
  expect(line.content?.[0]?.text).toContain('10\t    FirstMessage => {');
  expect(line.content?.[0]?.text).not.toContain('153\t    ClaimBonus => {');
  fs.writeFileSync(path.join(dir, 'large/main.tolk'), source.join('\n') + '\n// Changed after indexing.');
  const stale = await new ToolHandler(cg).execute('codegraph_explore', { query, maxFiles: 1 });
  expect(stale.content?.[0]?.text).toContain('changed on disk after the last index sync');
  expect(stale.content?.[0]?.text).not.toContain('153\t    ClaimBonus => {');
});

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
