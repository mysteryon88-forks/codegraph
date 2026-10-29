import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { CodeGraph } from '../src';
import { exploreQueryTokens, ToolHandler } from '../src/mcp/tools';
import { resolveNamedTokens, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { pinnedTolkScope } from '../src/mcp/explore-tolk-scope';
import { namedTolkArmRanges } from '../src/mcp/explore-tolk-ranges';
import { referencedTolkContext } from '../src/mcp/explore-tolk-context';
import * as tolkContext from '../src/mcp/explore-tolk-context';
import { MAX_PARSE_BYTES } from '../src/graph/branch-guards';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;
afterEach(() => { cg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function indexReferencedContext(extraFiles: Record<string, string> = {}, mainExtra = '') {
  const gap = Array.from({ length: 80 }, () => '// Unrelated declarations stay outside the selected ranges.');
  const messages = [
    'struct ApplySolve { value: int }',
    'struct Receipt { outcome: ReceiptOutcome }',
    'fun allocateMarker() {}',
    ...gap,
    'enum ReceiptOutcome {', '  Accepted = 1,', '  Rejected = 2', '}',
    ...gap,
    'struct SubmitTask { answer: int, hidden: NestedOnly }',
    ...gap,
    'type PlayerStatisticsMessage = ApplySolve | Receipt;',
    'type FactoryMessage = SubmitTask | OtherMessage;',
    ...gap,
    'struct NestedOnly { secret: int }',
    'struct OtherMessage { unrelated: int }',
    'struct TextOnly { forbidden: int }',
  ].join('\n');
  await indexMessageContract([], {
    'ref/main.tolk': [
      'import "messages"',
      'contract Demo { incomingMessages: FactoryMessage }',
      'fun run(message: ApplySolve, receipt: Receipt) {',
      '  allocateMarker();',
      '  val next = SubmitTask { answer: 1 };',
      '  // TextOnly is documentation, not a type reference.',
      '  val text = "TextOnly";', '}', mainExtra,
    ].join('\n'),
    'ref/messages.tolk': messages,
    'elsewhere/messages.tolk': 'enum ReceiptOutcome { Wrong = 997 }\nstruct SubmitTask { wrong: int }',
    'ref/wrapper.ts': 'export type ReceiptOutcome = { forbidden: 998 };',
    ...extraFiles,
  });
  return fs.readFileSync(path.join(dir, 'ref/messages.tolk'), 'utf8').split('\n');
}

it.each(['ReceiptOutcome', 'SubmitTask', 'PlayerStatisticsMessage', 'FactoryMessage'])(
  'adds complete referenced %s source in an already allocated Tolk file without graph changes', async name => {
    const source = await indexReferencedContext();
    const before = cg.getFiles().flatMap(f => cg.getNodesInFile(f.path)).flatMap(n => cg.getOutgoingEdges(n.id));
    const scope = pinnedTolkScope(cg, ['ref/main.tolk'], [], [])!;
    expect([...scope.nodes.values()].some(n => n.name === name && n.kind !== 'field')).toBe(false);
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'ref/main.tolk', maxFiles: 2 });
    const out = result.content?.[0]?.text ?? '';
    const declaration = cg.getNodesInFile('ref/messages.tolk').find(n => n.name === name)!;
    for (let line = declaration.startLine; line <= declaration.endLine; line++) {
      expect(out).toContain(`${line}\t${source[line - 1]}`);
    }
    for (const forbidden of ['elsewhere/messages.tolk', 'ref/wrapper.ts', 'struct NestedOnly', 'struct OtherMessage', 'struct TextOnly']) {
      expect(out).not.toContain(forbidden);
    }
    expect(cg.getFiles().flatMap(f => cg.getNodesInFile(f.path)).flatMap(n => cg.getOutgoingEdges(n.id))).toEqual(before);
    expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(2);
    expect(out.length).toBeLessThan(19000);
  },
);

async function referencedContext(emitted = new Map([
  ['ref/main.tolk', { ranges: [{ start: 1, end: 8 }] }],
  ['ref/messages.tolk', { ranges: [{ start: 1, end: 3 }] }],
])) {
  return referencedTolkContext(cg, emitted, (file, maxBytes) => {
    try {
      if (fs.statSync(path.join(dir, file)).size > maxBytes) return undefined;
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      return createHash('sha256').update(source).digest('hex') === cg.getFile(file)?.contentHash ? source : undefined;
    } catch { return undefined; }
  });
}

it('resolves referenced types locally before imports and refuses ambiguous imports and transitive visibility', async () => {
  await indexReferencedContext({
    'ref/competitor.tolk': 'struct SubmitTask { wrong: int }',
    'ref/transitive.tolk': 'struct HiddenType { forbidden: int }',
    'ref/bridge.tolk': 'import "transitive"',
  }, 'import "competitor"\nimport "bridge"\nenum ReceiptOutcome { Local = 701 }\nfun hidden() { val v = HiddenType { forbidden: 1 }; }');
  const context = await referencedContext(new Map([
    ['ref/main.tolk', { ranges: [{ start: 1, end: 13 }] }],
    ['ref/messages.tolk', { ranges: [{ start: 1, end: 3 }] }],
    ['ref/competitor.tolk', { ranges: [] }],
    ['ref/transitive.tolk', { ranges: [] }],
  ]));
  const admitted = [...context.values()].flat();
  expect(admitted.some(n => n.name === 'SubmitTask')).toBe(false);
  expect(admitted.some(n => n.name === 'HiddenType')).toBe(false);
  // The field in messages still resolves its own local enum independently.
  expect(admitted).toContainEqual(expect.objectContaining({ name: 'ReceiptOutcome', filePath: 'ref/messages.tolk' }));
  const localSource = fs.readFileSync(path.join(dir, 'ref/main.tolk'), 'utf8').replace('val next = SubmitTask', 'val next = ReceiptOutcome');
  fs.writeFileSync(path.join(dir, 'ref/main.tolk'), localSource);
  await cg.indexAll(); cg.resolveReferences();
  const local = [...(await referencedContext()).values()].flat().filter(n => n.name === 'ReceiptOutcome');
  expect(local).toContainEqual(expect.objectContaining({ filePath: 'ref/main.tolk' }));
});

it.each(['fresh', 'stale', 'missing', 'over-cap'])(
  'checks the complete visible alias inventory including a non-allocated %s competitor', async state => {
    const cappedFiles = state === 'over-cap'
      ? Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`ref/extra${i}.tolk`, `struct Extra${i} {}`])) : {};
    await indexReferencedContext({
      'ref/competitor.tolk': 'import "messages"\ntype RivalMessage = ApplySolve | Receipt;',
      ...cappedFiles,
    }, ['import "competitor"', ...Object.keys(cappedFiles).map(file => `import "${path.basename(file, '.tolk')}"`)].join('\n'));
    if (state === 'stale') fs.appendFileSync(path.join(dir, 'ref/competitor.tolk'), '\n// Changed since indexing.');
    if (state === 'missing') fs.unlinkSync(path.join(dir, 'ref/competitor.tolk'));
    const admitted = [...(await referencedContext()).values()].flat();
    expect(admitted.some(n => n.name === 'PlayerStatisticsMessage')).toBe(false);
    expect(admitted.some(n => n.filePath === 'ref/competitor.tolk')).toBe(false);
    expect(admitted).toContainEqual(expect.objectContaining({ name: 'ReceiptOutcome' }));
  },
);

it('rejects generic shadows, comments, strings and dot receivers as referenced types', async () => {
  await indexReferencedContext();
  const mainPath = path.join(dir, 'ref/main.tolk'), messagesPath = path.join(dir, 'ref/messages.tolk');
  fs.writeFileSync(mainPath, fs.readFileSync(mainPath, 'utf8')
    .replace('fun run(', 'fun run<SubmitTask>(').replace('val text = "TextOnly";', 'val text = "TextOnly"; TextOnly.fromSlice();'));
  fs.writeFileSync(messagesPath, fs.readFileSync(messagesPath, 'utf8')
    .replace('struct Receipt {', 'struct Receipt<ReceiptOutcome> {'));
  await cg.indexAll(); cg.resolveReferences();
  const admitted = [...(await referencedContext()).values()].flat();
  for (const name of ['SubmitTask', 'ReceiptOutcome', 'TextOnly']) expect(admitted.some(n => n.name === name)).toBe(false);
  expect(admitted.some(n => n.name === 'PlayerStatisticsMessage')).toBe(true);
});

it('resolves an alias member in its definition file rather than matching a same-spelled imported variant', async () => {
  await indexReferencedContext({
    'ref/competitor.tolk': 'struct ApplySolve { wrong: int }\nstruct Foreign {}\ntype RivalMessage = ApplySolve | Foreign;',
  }, 'import "competitor"\nstruct ApplySolve { local: int }');
  const mainPath = path.join(dir, 'ref/main.tolk');
  fs.writeFileSync(mainPath, fs.readFileSync(mainPath, 'utf8').replace(', receipt: Receipt', ''));
  await cg.indexAll(); cg.resolveReferences();
  const admitted = [...(await referencedContext(new Map([
    ['ref/main.tolk', { ranges: [{ start: 1, end: 8 }] }],
    ['ref/messages.tolk', { ranges: [] }],
  ]))).values()].flat();
  expect(admitted).toContainEqual(expect.objectContaining({ name: 'ApplySolve', filePath: 'ref/main.tolk' }));
  expect(admitted.some(n => n.name === 'PlayerStatisticsMessage')).toBe(false);
  expect(admitted.some(n => n.name === 'RivalMessage')).toBe(false);
  expect(admitted.some(n => n.filePath === 'ref/competitor.tolk')).toBe(false);
});

it.each(['stale', 'malformed'])( 'refuses referenced context from %s selected source', async state => {
  await indexReferencedContext();
  fs.appendFileSync(path.join(dir, 'ref/main.tolk'), state === 'malformed' ? '\nfun broken( {' : '\n// Drift.');
  if (state === 'malformed') { await cg.indexAll(); cg.resolveReferences(); }
  const emitted = new Map([['ref/main.tolk', { ranges: [{ start: 1, end: 8 }] }], ['ref/messages.tolk', { ranges: [] }]]);
  expect([...(await referencedContext(emitted)).values()].flat()).toEqual([]);
});

it('does not allocate new files or change explicit line output when adding referenced context', async () => {
  await indexReferencedContext();
  const one = await new ToolHandler(cg).execute('codegraph_explore', { query: 'ref/main.tolk', maxFiles: 1 });
  expect(one.content?.[0]?.text).not.toContain('**`ref/messages.tolk`');
  expect(one.content?.[0]?.text).not.toContain('enum ReceiptOutcome');
  const anchored = await new ToolHandler(cg).execute('codegraph_explore', { query: 'ref/main.tolk:3-8', maxFiles: 2 });
  const out = anchored.content?.[0]?.text ?? '';
  for (const name of ['enum ReceiptOutcome', 'struct SubmitTask', 'type PlayerStatisticsMessage', 'type FactoryMessage']) expect(out).not.toContain(name);
  expect(out).toContain('3\tfun run(message: ApplySolve, receipt: Receipt) {');
  expect(out).toContain('8\t}');
});

it('records optional source in session dedup without claiming unseen declarations', async () => {
  await indexReferencedContext();
  const file = path.join(dir, 'ref/messages.tolk');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  Rejected = 2',
    [...Array.from({ length: 5 }, (_, i) => `  Deferred${i} = ${i + 10},`), '  Rejected = 2'].join('\n')));
  await cg.indexAll(); cg.resolveReferences();
  const source = fs.readFileSync(file, 'utf8').split('\n');
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '1');
  const handler = new ToolHandler(cg), session = new ExploreSessionState();
  await handler.execute('codegraph_explore', { query: 'ref/main.tolk', maxFiles: 2 }, session);
  const emission = session.forProject(dir)!.calls[0]!.files.find(f => f.path === 'ref/messages.tolk')!;
  const enumLine = source.indexOf('enum ReceiptOutcome {') + 1;
  expect(emission.ranges.some(r => r.start <= enumLine && r.end >= enumLine + 3)).toBe(true);
  const forbiddenLine = source.indexOf('struct NestedOnly { secret: int }') + 1;
  expect(emission.ranges.some(r => r.start <= forbiddenLine && r.end >= forbiddenLine)).toBe(false);
  // Fresh explicitly requested source prevents the existing no-new-source restore from re-serving a file.
  const again = await handler.execute('codegraph_explore', { query: 'ref/main.tolk ref/messages.tolk:310-320', maxFiles: 2 }, session);
  expect(again.content?.[0]?.text).not.toContain(`${enumLine}\tenum ReceiptOutcome {`);
  expect(again.content?.[0]?.text).toContain('L84-92');
});

it('preserves every core source row when adjacent optional context cannot fit the remaining file budget', async () => {
  await indexReferencedContext({
    'ref/messages.tolk': [
      'struct ApplySolve { value: int }',
      'struct Receipt { outcome: ReceiptOutcome }',
      'fun allocateMarker() { throw 12345; }',
      'enum ReceiptOutcome {',
      ...Array.from({ length: 300 }, (_, i) => `  Outcome${i} = ${i}, // This detailed enum is optional source context, never a reason to clip the selected core.`),
      '}',
      'type PlayerStatisticsMessage = ApplySolve | Receipt;',
    ].join('\n'),
  });
  const spy = vi.spyOn(tolkContext, 'referencedTolkContext').mockResolvedValue(new Map());
  let baseline: string;
  try {
    baseline = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'ref/main.tolk', maxFiles: 2 })).content?.[0]?.text ?? '';
  } finally { spy.mockRestore(); }
  const out = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'ref/main.tolk', maxFiles: 2 })).content?.[0]?.text ?? '';
  const rows = (text: string) => text.split('\n').filter(line => /^\d+\t/.test(line));
  for (const row of rows(baseline)) expect(rows(out)).toContain(row);
  expect(out).toContain('3\tfun allocateMarker() { throw 12345; }');
  expect(out).not.toContain('4\tenum ReceiptOutcome {');
  expect(out).not.toContain('Outcome299 =');
  expect(out).toContain('Some file sections were trimmed for size.');
  expect(out).toContain('gap: ReceiptOutcome (ref/messages.tolk:4)');
  expect(out.length).toBeLessThan(19000);
});

it.each(['no competitor', 'competitor', 'changed'])(
  'inventories a fresh generated import with %s without adding generated payload', async state => {
    const generated = [
      '// @generated by the test fixture',
      'import "../messages"',
      'struct GeneratedPayload { secret: int }',
      'fun generatedMarker() {',
      '  val text = "type FakeAlias = ApplySolve | Receipt;";',
      '  // type FakeComment = ApplySolve | Receipt;',
      '  val payload = TextOnly { forbidden: 1 };', '}',
      'fun generatedAsm(): int asm "type FakeAsm = ApplySolve | Receipt;";',
      ...(state === 'competitor' ? ['type GeneratedRival = ApplySolve | Receipt;'] : []),
    ].join('\n');
    await indexReferencedContext({ 'ref/gen/Protocol.code.tolk': generated },
      'import "gen/Protocol.code"\nfun usesGenerated() { val payload = GeneratedPayload { secret: 1 }; }');
    expect(cg.generatedFilePredicate(['ref/gen/Protocol.code.tolk'])('ref/gen/Protocol.code.tolk')).toBe(true);
    if (state === 'changed') fs.appendFileSync(path.join(dir, 'ref/gen/Protocol.code.tolk'), '\n// New generated revision.');
    const emitted = new Map([
      ['ref/main.tolk', { ranges: [{ start: 1, end: 10 }] }],
      ['ref/messages.tolk', { ranges: [{ start: 1, end: 3 }] }],
      ['ref/gen/Protocol.code.tolk', { ranges: [{ start: 4, end: 9 }] }],
    ]);
    const context = await referencedContext(emitted), admitted = [...context.values()].flat();
    expect(admitted.some(n => n.name === 'PlayerStatisticsMessage')).toBe(state === 'no competitor');
    expect(context.has('ref/gen/Protocol.code.tolk')).toBe(false);
    expect(admitted.some(n => n.name === 'TextOnly')).toBe(false);
    const explicit = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'ref/gen/Protocol.code.tolk:4-8', maxFiles: 1,
    });
    if (state !== 'changed') {
      expect(explicit.content?.[0]?.text).toContain('4\tfun generatedMarker() {');
      expect(explicit.content?.[0]?.text).toContain('7\t  val payload = TextOnly { forbidden: 1 };');
    }
  },
);

it('refuses oversized inventory before reading its source', async () => {
  await indexReferencedContext();
  const getFile = cg.getFile.bind(cg);
  const spy = vi.spyOn(cg, 'getFile').mockImplementation(file => {
    const record = getFile(file);
    return file === 'ref/messages.tolk' && record ? { ...record, size: MAX_PARSE_BYTES + 1 } : record;
  });
  const read = vi.fn((file: string) => fs.readFileSync(path.join(dir, file), 'utf8'));
  try {
    await referencedTolkContext(cg, new Map([['ref/messages.tolk', { ranges: [{ start: 1, end: 3 }] }]]), read);
    expect(read).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it('stops the whole referenced-context pass when its deadline expires', async () => {
  await indexReferencedContext();
  let tick = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => tick += 1000);
  try { expect([...(await referencedContext()).values()].flat()).toEqual([]); }
  finally { clock.mockRestore(); }
});

it('uses an exact selected match variant for simple union context without matching its spelling in other files', async () => {
  await indexReferencedContext();
  const file = path.join(dir, 'ref/main.tolk');
  fs.writeFileSync(file, [
    'import "messages"',
    'fun run(message: slice) {',
    '  allocateMarker();',
    '  match (message) { ApplySolve => {} else => {} }', '}',
  ].join('\n'));
  await cg.indexAll(); cg.resolveReferences();
  const out = (await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'ref/main.tolk run ApplySolve', maxFiles: 2,
  })).content?.[0]?.text ?? '';
  expect(out).toContain('4\t  match (message) { ApplySolve => {} else => {} }');
  expect(out).toContain('249\ttype PlayerStatisticsMessage = ApplySolve | Receipt;');
  expect(out).not.toContain('elsewhere/messages.tolk');
});

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

const generatedRankingQuery = 'game/main.tolk onInternalMessage finalizeRound validateResult statistics';
const generatedRankingFile = 'game/gen/PlayerStatistics.code.tolk';

async function indexGeneratedRankingContract(extraGenerated: string[] = [], generatedOwner = false) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-generated-ranking-'));
  const files: Record<string, string> = {
    'game/main.tolk': [
      'import "helpers"', 'import "messages"',
      'fun onInternalMessage(message: FinishRound) {',
      '  validateResult(message);', '  finalizeRound();', '}',
    ].join('\n'),
    'game/helpers.tolk': [
      'import "storage"', 'import "gen/PlayerStatistics.code"',
      'fun finalizeRound() {', '  val state = State.load();',
      '  playerStatisticsCompiledCode();', '  state.count;', '}',
    ].join('\n'),
    'game/messages.tolk': 'struct FinishRound { score: int }\nfun validateResult(message: FinishRound) { assert(message.score > 0) throw 123; }',
    'game/storage.tolk': [
      ...(generatedOwner ? ['// Code generated by synthetic-fixture. DO NOT EDIT.'] : []),
      'struct State { count: int }', 'fun State.load(): State { return State { count: 424242 }; }',
    ].join('\n'),
    [generatedRankingFile]: [
      '// Code generated by synthetic-fixture. DO NOT EDIT.',
      'struct GeneratedMetadata { version: int }',
      'fun playerStatisticsCompiledCode(): cell asm',
      `  "x{${'1234abcd'.repeat(240)}} PUSHREF"`,
      // Enough source lines to exercise the existing dedup minimum, even with an opaque asm body.
      ...Array.from({ length: 8 }, (_, i) => `  // Synthetic assembly annotation ${i}.`),
      ';',
      ...extraGenerated,
    ].join('\n'),
    'other/main.tolk': 'fun onInternalMessage() { playerStatisticsCompiledCode(); }\nfun playerStatisticsCompiledCode(): int { return 81234; }',
    'wrappers/Game.ts': 'export function playerStatisticsCompiledCode() { return 91234; }',
    'extra.tolk': 'fun newlyRequested(): int { return 31337; }',
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  expect(cg.getFile(generatedRankingFile)?.generated).toBe(true);
}

it.each([undefined, 4, 4.5])('keeps scoped storage ahead of a weak generated name with maxFiles=%s', async maxFiles => {
  await indexGeneratedRankingContract();
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: generatedRankingQuery, ...(maxFiles === undefined ? {} : { maxFiles }),
  });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  expect(out).toContain('3\tfun onInternalMessage(message: FinishRound) {');
  expect(out).toContain('3\tfun finalizeRound() {');
  expect(out).toContain('1\tstruct State { count: int }');
  expect(out).toContain('2\tfun State.load(): State { return State { count: 424242 }; }');
  expect(out).toContain('2\tfun validateResult(message: FinishRound)');
  expect(out).not.toContain('1234abcd1234abcd');
  expect(out).not.toContain(`**\`${generatedRankingFile}\``);
  expect(out).toContain(`- ${generatedRankingFile}: playerStatisticsCompiledCode:3`);
  for (const forbidden of ['other/main.tolk', 'wrappers/Game.ts', '81234', '91234']) expect(out).not.toContain(forbidden);
  for (const section of out.matchAll(/\*\*`([^`]+)`\*\*[^\n]*\n\n```tolk\n([\s\S]*?)\n```/g)) {
    const source = fs.readFileSync(path.join(dir, section[1]!), 'utf8').split(/\r?\n/);
    for (const line of section[2]!.matchAll(/^(\d+)\t(.*)$/gm)) expect(line[2]).toBe(source[Number(line[1]) - 1]);
  }
  expect(out.length).toBeLessThan(19000);
});

it.each([2, 5])('honors maxFiles=%s without suppressing weak generated source when room remains', async maxFiles => {
  await indexGeneratedRankingContract();
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: generatedRankingQuery, maxFiles });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(maxFiles);
  expect(out).toContain('3\tfun onInternalMessage(message: FinishRound) {');
  expect(out).toContain('3\tfun finalizeRound() {');
  if (maxFiles === 5) {
    expect(out).toContain('1\tstruct State { count: int }');
    expect(out).toContain('3\tfun playerStatisticsCompiledCode(): cell asm');
    expect(out).toContain('1234abcd1234abcd');
  }
});

it('keeps scoped generated owner/data source ahead of a weak generated callable under the default budget', async () => {
  await indexGeneratedRankingContract([], true);
  expect(cg.getFile('game/storage.tolk')?.generated).toBe(true);
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: generatedRankingQuery });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  expect(out).toContain('**`game/storage.tolk`');
  expect(out).toContain('2\tstruct State { count: int }');
  expect(out).toContain('3\tfun State.load(): State { return State { count: 424242 }; }');
  expect(out).not.toContain('1234abcd1234abcd');
  expect(out).toContain(`- ${generatedRankingFile}: playerStatisticsCompiledCode:3`);
});

it('reserves a weak generated slot for scoped storage even when an unnamed helper ranks between them', async () => {
  await indexGeneratedRankingContract();
  fs.writeFileSync(path.join(dir, 'game/helpers.tolk'), [
    'import "storage"', 'import "gen/PlayerStatistics.code"', 'import "limits"',
    'fun finalizeRound() {', '  val state = State.load();', '  playerStatisticsCompiledCode();',
    '  reserveLimit();', '  state.count;', '}',
    'fun State.load(): State { return State { count: 424242 }; }',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'game/storage.tolk'), 'struct State { count: int }');
  fs.writeFileSync(path.join(dir, 'game/limits.tolk'), 'fun reserveLimit(): int { return 100; }');
  await cg.sync(); cg.resolveReferences();
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], exploreQueryTokens(generatedRankingQuery.replace('game/main.tolk', '')), [])!;
  expect([...scope.nodes.values()].some(n => n.filePath === 'game/limits.tolk')).toBe(true);
  expect([...scope.nodes.values()].some(n => n.filePath === 'game/storage.tolk' && n.kind === 'struct')).toBe(true);
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: generatedRankingQuery });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  for (const file of ['game/main.tolk', 'game/helpers.tolk', 'game/messages.tolk', 'game/storage.tolk']) expect(out).toContain(`**\`${file}\``);
  expect(out).toContain('1\tstruct State { count: int }');
  expect(out).not.toContain('1234abcd1234abcd');
  expect(out).not.toContain('**`game/limits.tolk`');
  expect(out).toContain('game/limits.tolk: reserveLimit:1');
});

it.each(['feature_cap', 'limits.feature_cap'])('does not pass an explicitly requested unallocated intermediate file for %s', async request => {
  await indexGeneratedRankingContract();
  fs.writeFileSync(path.join(dir, 'game/helpers.tolk'), [
    'import "storage"', 'import "gen/PlayerStatistics.code"', 'import "limits"',
    'fun finalizeRound() { val state = State.load(); playerStatisticsCompiledCode(); reserveLimit(); }',
    'fun State.load(): State { return State { count: 424242 }; }',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'game/storage.tolk'), 'struct State { count: int }');
  fs.writeFileSync(path.join(dir, 'game/limits.tolk'), 'const FEATURE_CAP = 100;\nfun reserveLimit(): int { return FEATURE_CAP; }');
  await cg.sync(); cg.resolveReferences();
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: `${generatedRankingQuery} ${request}` });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  expect(out).toContain(`**\`${generatedRankingFile}\``);
  expect(out).toContain('1234abcd1234abcd');
  expect(out).not.toContain('**`game/storage.tolk`');
  expect(out).not.toContain('**`game/limits.tolk`');
});

it.each([5, 7])('trades at most one weak slot for the first unallocated owner and leaves allocated owners alone with maxFiles=%s', async maxFiles => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-multiple-owners-'));
  const names = ['First', 'Second', 'Third'];
  const files: Record<string, string> = {
    'main.tolk': 'import "helpers"\nfun onInternalMessage() { finalizeRound(); }',
    'helpers.tolk': [
      'import "data"', 'import "extra-data"', ...names.map(name => `import "gen/${name.toLowerCase()}"`),
      `fun finalizeRound(): State { ${names.map(name => `playerStatistics${name}Code();`).join(' ')} ExtraState.load(); return State { count: 42 }; }`,
      'fun ExtraState.load(): ExtraState { return ExtraState { count: 71 }; }',
    ].join('\n'),
    'data.tolk': 'struct State { count: int }',
    'extra-data.tolk': 'struct ExtraState { count: int }',
  };
  for (const name of names) files[`gen/${name.toLowerCase()}.tolk`] =
    `// Code generated by synthetic-fixture. DO NOT EDIT.\nfun playerStatistics${name}Code(): cell asm "x{1234abcd} PUSHREF";`;
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: 'main.tolk onInternalMessage finalizeRound statistics', maxFiles,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  const shown = [...out.matchAll(/^\*\*`([^`]+)`/gm)].map(m => m[1]);
  expect(shown).toHaveLength(maxFiles);
  expect(shown.slice(0, 2)).toEqual(['main.tolk', 'helpers.tolk']);
  expect(shown).toContain('data.tolk');
  expect(new Set(shown).size).toBe(maxFiles);
  expect(shown.filter(fp => fp!.startsWith('gen/'))).toHaveLength(maxFiles === 5 ? 2 : 3);
  if (maxFiles === 5) expect(shown).not.toContain('extra-data.tolk');
  else expect(shown).toContain('extra-data.tolk');
});

it.each([
  'playerStatisticsCompiledCode',
  'player_statistics_compiled_code',
  'gen.playerStatisticsCompiledCode',
  'gen.player_statistics_compiled_code',
  'GeneratedMetadata',
  'generated_metadata',
  'gen.GeneratedMetadata',
  'gen.generated_metadata',
  generatedRankingFile,
  `${generatedRankingFile}:3-4`,
])('preserves explicitly requested generated source for %s alongside a weak match', async request => {
  await indexGeneratedRankingContract();
  const result = await new ToolHandler(cg).execute('codegraph_explore', {
    query: `${generatedRankingQuery} ${request}`,
  });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect(out).toContain(`**\`${generatedRankingFile}\``);
  expect(out).toContain('3\tfun playerStatisticsCompiledCode(): cell asm');
  expect(out).toContain('1234abcd1234abcd');
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  expect(out).not.toContain('other/main.tolk');
  expect(out).not.toContain('wrappers/Game.ts');
});

it('keeps omitted generated source available for a follow-up, deduplicates only sent source and refreshes changed files', async () => {
  await indexGeneratedRankingContract();
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '1');
  const handler = new ToolHandler(cg);
  const session = new ExploreSessionState();
  const first = await handler.execute('codegraph_explore', { query: generatedRankingQuery }, session);
  expect(first.content?.[0]?.text).toContain('1\tstruct State { count: int }');
  expect(first.content?.[0]?.text).not.toContain('1234abcd1234abcd');
  const args = { query: generatedRankingFile, maxFiles: 1 };
  const followup = await handler.execute('codegraph_explore', args, session);
  expect(followup.content?.[0]?.text).toContain('1234abcd1234abcd');
  // Dedup retains a source fallback for all-pointer replies; add a new file to exercise withholding.
  const repeated = await handler.execute('codegraph_explore', { query: `${generatedRankingFile} extra.tolk`, maxFiles: 2 }, session);
  expect(repeated.content?.[0]?.text).toContain('Already sent earlier in this conversation');
  expect(repeated.content?.[0]?.text).toContain('return 31337;');
  expect(repeated.content?.[0]?.text).not.toContain('1234abcd1234abcd');
  const filePath = path.join(dir, generatedRankingFile);
  fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('1234abcd', 'feedbeef'));
  await cg.sync();
  const refreshed = await handler.execute('codegraph_explore', args, session);
  expect(refreshed.content?.[0]?.text).toContain('feedbeef');
});

it('keeps a weak generated dependency ahead of unnamed helpers when the default budget has no owner/data alternative', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-generated-no-data-'));
  const files: Record<string, string> = {
    'game/main.tolk': [
      'import "compiled"', 'import "audit"', 'import "logs"', 'import "cleanup"',
      'fun onInternalMessage() {', '  playerStatisticsCompiledCode();',
      '  auditTrail();', '  appendLog();', '  cleanupRound();', '}',
    ].join('\n'),
    'game/compiled.tolk': '// Code generated by synthetic-fixture. DO NOT EDIT.\nfun playerStatisticsCompiledCode(): cell asm "x{1234abcd} PUSHREF";',
    'game/audit.tolk': 'fun auditTrail(): int { return 11; }',
    'game/logs.tolk': 'fun appendLog(): int { return 22; }',
    'game/cleanup.tolk': 'fun cleanupRound(): int { return 33; }',
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  const scope = pinnedTolkScope(cg, ['game/main.tolk'], ['onInternalMessage', 'statistics'], [])!;
  expect([...scope.nodes.values()].some(n => ['struct', 'union', 'enum', 'type_alias'].includes(n.kind))).toBe(false);
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'game/main.tolk onInternalMessage statistics' });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
  expect(out).toContain('5\tfun onInternalMessage() {');
  expect(out).toContain('**`game/compiled.tolk`');
  expect(out).toContain('2\tfun playerStatisticsCompiledCode(): cell asm "x{1234abcd} PUSHREF";');
});

it.each(['Storage.load', 'storage.load', 'Storage::load', 'storage::load', 'gen.Storage.load', 'gen.storage.load'])(
  'does not exempt OtherStorage.load from generated demotion for the partial qualifier %s', async request => {
    await indexGeneratedRankingContract([
      'struct OtherStorage { value: int }',
      'fun OtherStorage.load(): OtherStorage { return OtherStorage { value: 711 }; }',
    ]);
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: `${generatedRankingQuery} ${request}` });
    const out = result.content?.[0]?.text ?? '';
    expect(result.isError).not.toBe(true);
    expect(out).toContain('1\tstruct State { count: int }');
    expect(out).not.toContain(`**\`${generatedRankingFile}\``);
    expect(out).not.toContain('1234abcd1234abcd');
    expect(out).toContain(`- ${generatedRankingFile}: playerStatisticsCompiledCode:3`);
  },
);

it.each([
  'OtherStorage.load', 'other_storage.load', 'OtherStorage::load', 'other_storage::load',
  'gen.OtherStorage.load', 'gen.other_storage.load',
])(
  'preserves a generated file explicitly named through the complete receiver %s', async request => {
    await indexGeneratedRankingContract([
      'struct OtherStorage { value: int }',
      'fun OtherStorage.load(): OtherStorage { return OtherStorage { value: 711 }; }',
    ]);
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: `${generatedRankingQuery} ${request}` });
    const out = result.content?.[0]?.text ?? '';
    expect(result.isError).not.toBe(true);
    expect(out).toContain(`**\`${generatedRankingFile}\``);
    expect(out).toContain('3\tfun playerStatisticsCompiledCode(): cell asm');
    expect(out).toContain('1234abcd1234abcd');
  },
);

it.each([
  { count: 3, maxFiles: undefined, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'data.tolk'] },
  { count: 3, maxFiles: 4, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'data.tolk'] },
  { count: 3, maxFiles: 5, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'gen/third.tolk', 'data.tolk'] },
  { count: 4, maxFiles: undefined, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'data.tolk'] },
  { count: 4, maxFiles: 4, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'data.tolk'] },
  { count: 4, maxFiles: 5, want: ['main.tolk', 'helpers.tolk', 'gen/second.tolk', 'gen/fourth.tolk', 'data.tolk'] },
])('keeps generated dependencies in rank order when scoped data gains a saturated slot ($count generated, maxFiles=$maxFiles)', async ({ count, maxFiles, want }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-generated-order-'));
  const names = ['First', 'Second', 'Third', 'Fourth'].slice(0, count);
  const files: Record<string, string> = {
    'main.tolk': 'import "helpers"\nfun onInternalMessage() { finalizeRound(); }',
    'helpers.tolk': [
      'import "data"', ...names.map(name => `import "gen/${name.toLowerCase()}"`),
      `fun finalizeRound(): State { ${names.map(name => `playerStatistics${name}Code();`).join(' ')} return State { count: 42 }; }`,
    ].join('\n'),
    'data.tolk': 'struct State { count: int }',
  };
  for (const name of names) files[`gen/${name.toLowerCase()}.tolk`] =
    `// Code generated by synthetic-fixture. DO NOT EDIT.\nfun playerStatistics${name}Code(): cell asm "x{1234abcd} PUSHREF";`;
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
  expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  const handler = new ToolHandler(cg), query = 'main.tolk onInternalMessage finalizeRound statistics';
  const result = await handler.execute('codegraph_explore', { query, ...(maxFiles === undefined ? {} : { maxFiles }) });
  const out = result.content?.[0]?.text ?? '';
  expect(result.isError).not.toBe(true);
  expect([...out.matchAll(/^\*\*`([^`]+)`/gm)].map(m => m[1])).toEqual(want);
  expect(out).toContain('1\tstruct State { count: int }');
  const complete = await handler.execute('codegraph_explore', { query, maxFiles: 20 });
  expect(complete.isError).not.toBe(true);
  const all = complete.content?.[0]?.text ?? '';
  expect([...all.matchAll(/^\*\*`([^`]+)`/gm)].map(m => m[1]).filter(fp => fp!.startsWith('gen/'))).toEqual(
    count === 3 ? ['gen/second.tolk', 'gen/third.tolk', 'gen/first.tolk']
      : ['gen/second.tolk', 'gen/fourth.tolk', 'gen/third.tolk', 'gen/first.tolk'],
  );
});

it.each([undefined, 'gen/compiled.tolk', 'gen/compiled.tolk:2'])(
  'retains a displaced donor pointer beyond a long omitted tail and honors explicit override %s', async request => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-donor-pointer-'));
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    const files: Record<string, string> = {
      'main.tolk': [
        'import "helpers"', 'import "gen/compiled"',
        `fun onInternalMessage() { ${names.map(name => `statistics${name}();`).join(' ')} playerStatisticsCompiledCode(); finalizeRound(); }`,
        ...names.map(name => `fun statistics${name}(): int { return 1; }`),
      ].join('\n'),
      'helpers.tolk': [
        'import "data"', ...Array.from({ length: 16 }, (_, i) => `import "leaf${i}"`),
        `fun finalizeRound(): State { ${Array.from({ length: 16 }, (_, i) => `leaf${i}Entry();`).join(' ')} return State { count: 42 }; }`,
      ].join('\n'),
      'data.tolk': 'struct State { count: int }',
      'gen/compiled.tolk': '// Code generated by synthetic-fixture. DO NOT EDIT.\nfun playerStatisticsCompiledCode(): cell asm "x{1234abcd} PUSHREF";',
    };
    for (let i = 0; i < 16; i++) files[`leaf${i}.tolk`] =
      `fun leaf${i}Entry(): int { return leaf${i}Value(); }\nfun leaf${i}Value(): int { return ${i}; }`;
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();
    expect(cg.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: `main.tolk onInternalMessage statistics${request ? ` ${request}` : ''}`,
    });
    const out = result.content?.[0]?.text ?? '';
    expect(result.isError).not.toBe(true);
    expect([...out.matchAll(/^\*\*`[^`]+`/gm)]).toHaveLength(4);
    if (request) {
      expect(out).toContain('**`gen/compiled.tolk`');
      expect(out).toContain('2\tfun playerStatisticsCompiledCode(): cell asm "x{1234abcd} PUSHREF";');
    } else {
      expect(out).toContain('1\tstruct State { count: int }');
      expect(out).not.toContain('**`gen/compiled.tolk`');
      expect(out).not.toContain('x{1234abcd} PUSHREF');
      const pointers = [...out.matchAll(/^- [^\n]+\.tolk: [^\n]+/gm)].map(m => m[0]);
      expect(pointers[0]).toBe('- gen/compiled.tolk: playerStatisticsCompiledCode:2');
      expect(pointers).toHaveLength(10);
    }
    expect(out.length).toBeLessThan(19000);
  },
);
