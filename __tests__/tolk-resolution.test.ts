import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { extractFromSource } from '../src/extraction';
import { resolveTolkReference } from '../src/resolution/tolk';
import type { UnresolvedRef } from '../src/resolution/types';

describe('Tolk resolution boundaries', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  afterEach(() => { cg?.close(); cg = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  async function index(files: Record<string, string>) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-'));
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();
    return cg;
  }
  function calls(file: string, name: string) {
    const node = cg!.getNodesInFile(file).find(n => n.name === name)!;
    return cg!.getCallees(node.id).map(c => `${c.node.filePath}:${c.node.name}`).sort();
  }

  it('links only local and directly imported eligible Tolk functions', async () => {
    await index({
      'main.tolk': 'import "lib/util.tolk"\nfun local(): int { return 1; }\nfun run() { local(); util(); hidden(); onInternalMessage(null); getter(); wrapped(); }',
      'lib/util.tolk': 'import "transitive"\nfun util(): int { return 2; }\nfun onInternalMessage(in: InMessage) {}\nget fun getter(): int { return 0; }',
      'lib/transitive.tolk': 'fun hidden() {}',
      'other.tolk': 'fun wrapped() {}',
      'wrapper.ts': 'export function wrapped() {}',
    });
    expect(calls('main.tolk', 'run')).toEqual(['lib/util.tolk:util', 'main.tolk:local']);
    const imp = cg!.getNodesInFile('main.tolk').find(n => n.kind === 'import')!;
    const edges = cg!.getOutgoingEdges(imp.id).filter(e => e.kind === 'imports');
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ kind: 'file', language: 'tolk', filePath: 'lib/util.tolk' });
    expect(cg!.getUnresolvedReferencesInFile('main.tolk').map(r => r.referenceName)).toEqual(expect.arrayContaining(['hidden', 'getter', 'wrapped']));
  });

  it('requires receiver identity and respects parameter and block shadowing', async () => {
    await index({
      'main.tolk': ['import "types"', 'fun run(s: Storage, unknown: int) { s.save(); unknown.save(); Storage.load().save(); }',
        'fun shadow(save: int) { save(); { val s = 1; s.save(); } }',
        'fun block(s: Storage) { s.save(); { val s = 1; s.save(); } s.save(); }'].join('\n'),
      'types.tolk': 'struct Storage { count: int }\nfun Storage.save(mutate self) {}\nfun Storage.load(): Storage { return Storage { count: 0 }; }\nfun save() {}',
      'noise.tolk': 'struct Storage { x: int }\nfun Storage.save(self) {}\nfun int.save(self) {}',
    });
    expect(calls('main.tolk', 'run')).toEqual(['types.tolk:load', 'types.tolk:save']);
    expect(calls('main.tolk', 'shadow')).toEqual([]);
    expect(calls('main.tolk', 'block')).toEqual(['types.tolk:save']);
    const node = cg!.getNodesInFile('main.tolk').find(n => n.name === 'block')!;
    expect(cg!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls').map(e => e.column).sort((a, b) => a! - b!)).toEqual([24, 59]);
  });

  it('uses nearest Acton import-mappings, leaves stdlib external and isolates TypeScript', async () => {
    await index({
      'Acton.toml': '[import-mappings]\ncontracts = "contracts"\n',
      'main.tolk': 'import "@contracts/util"\nimport "@stdlib/common"\nfun run() { util(); beginCell(); }',
      'contracts/util.tolk': 'fun util() {}',
      'fake/common.tolk': 'fun beginCell() {}',
      'wrapper.ts': 'export function runTs() { util(); beginCell(); }',
      'nested/Acton.toml': "[import-mappings]\n'@contracts' = 'local'\n",
      'nested/main.tolk': 'import "@contracts/util"\nfun nested() { util(); }',
      'nested/local/util.tolk': 'fun util() {}',
    });
    expect(calls('main.tolk', 'run')).toEqual(['contracts/util.tolk:util']);
    expect(calls('nested/main.tolk', 'nested')).toEqual(['nested/local/util.tolk:util']);
    expect(calls('wrapper.ts', 'runTs')).toEqual([]);
  });

  it('leaves ambiguous imported names and types unresolved', async () => {
    await index({
      'main.tolk': 'import "a"\nimport "b"\nfun run(s: Storage) { util(); s.save(); }',
      'a.tolk': 'struct Storage { count: int }\nfun util() {}\nfun Storage.save(self) {}',
      'b.tolk': 'struct Storage { count: int }\nfun util() {}\nfun Storage.save(self) {}',
    });
    expect(calls('main.tolk', 'run')).toEqual([]);
  });

  it('tracks lazy factories with inferred serialization return types', async () => {
    await index({
      'main.tolk': 'struct Storage { count: int }\nfun Storage.load() { return Storage.fromCell(contract.getData()); }\nfun Storage.save(self) {}\nfun run() { var storage = lazy Storage.load(); storage.save(); }',
    });
    expect(calls('main.tolk', 'run')).toEqual(['main.tolk:load', 'main.tolk:save']);
  });

  it('binds typed and inferred declarations after initializers and keeps destructured receivers unknown', async () => {
    await index({ 'main.tolk': [
      'struct Storage { x: int }', 'fun Storage.save(self) {}', 'fun int.save(self) {}',
      'fun Storage.load(): Storage { return Storage { x: 0 }; }',
      'fun typed() { val s: Storage = Storage.load(); s.save(); }',
      'fun inferred() { val first = Storage.load(); var second = lazy Storage.load(); first.save(); second.save(); }',
      'fun initializer(s: Storage) { { val s = s.save(); s.save(); } s.save(); }',
      'fun destructured() { val (s, t) = (Storage.load(), Storage.load()); s.save(); t.save(); val [a, b] = [Storage.load(), Storage.load()]; a.save(); b.save(); }',
      'fun shadow(s: Storage) { { val s: int = 7; s.save(); } s.save(); }',
      'fun reassigned() { var s = Storage.load(); { s = unknown(); } s.save(); }',
      'fun declarationOnly() { var s: Storage; s.save(); }',
    ].join('\n') });
    for (const name of ['typed', 'inferred']) expect(calls('main.tolk', name)).toEqual(['main.tolk:load', 'main.tolk:save']);
    expect(calls('main.tolk', 'destructured')).toEqual(['main.tolk:load']);
    expect(calls('main.tolk', 'reassigned')).toEqual(['main.tolk:load']);
    expect(calls('main.tolk', 'declarationOnly')).toEqual(['main.tolk:save']);
    const storageSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::Storage::save')!;
    const intSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::int::save')!;
    const edges = (name: string) => {
      const node = cg!.getNodesInFile('main.tolk').find(n => n.name === name)!;
      return cg!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls').sort((a, b) => a.column! - b.column!).map(e => e.target);
    };
    expect(edges('initializer')).toEqual([storageSave.id, storageSave.id]);
    expect(edges('shadow')).toEqual([intSave.id, storageSave.id]);
    expect(cg!.getFiles().find(f => f.path === 'main.tolk')!.errors ?? []).toEqual([]);
  });

  it('does not leak bare or typed receiver names through lambda parameters', async () => {
    await index({
      'main.tolk': ['struct Storage { count: int }', 'fun helper() {}', 'fun Storage.save(self) {}',
        'fun run(s: Storage) { val cb = fun(helper: int, s: int) { helper(); s.save(); }; }',
        'fun reassigned(s: Storage) { s = unknown(); s.save(); }'].join('\n'),
    });
    expect(calls('main.tolk', 'run')).toEqual([]);
    expect(calls('main.tolk', 'reassigned')).toEqual([]);
  });

  it('keeps catch variables local and distinguishes their receiver types', async () => {
    await index({ 'main.tolk': [
      'struct Storage { x: int }', 'fun Storage.save(self) {}', 'fun int.save(self) {}',
      'fun run(s: Storage) { try {} catch (s) { s.save(); } s.save(); }',
      'fun second(s: Storage) { try {} catch (code, s) { s.save(); } s.save(); }',
    ].join('\n') });
    const storageSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::Storage::save')!;
    const intSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::int::save')!;
    const run = cg!.getNodesInFile('main.tolk').find(n => n.name === 'run')!;
    const edges = cg!.getOutgoingEdges(run.id).filter(e => e.kind === 'calls').sort((a, b) => a.column! - b.column!);
    expect(edges.map(e => e.target)).toEqual([intSave.id, storageSave.id]);
    const second = cg!.getNodesInFile('main.tolk').find(n => n.name === 'second')!;
    expect(cg!.getOutgoingEdges(second.id).filter(e => e.kind === 'calls').map(e => e.target)).toEqual([storageSave.id]);
    expect(cg!.getUnresolvedReferencesFrom(second.id).map(r => r.referenceName)).toContain('s.save');
  });

  it('limits match-local declarations to the match and preserves outer return evidence', async () => {
    await index({ 'main.tolk': [
      'struct Storage { x: int }', 'fun Storage.save(self) {}', 'fun int.save(self) {}',
      'fun factory(s: int) { match (val s = Storage { x: 0 }) { Storage => { s.save(); } } s.save(); return s; }',
      'fun run() { factory(7).save(); }',
    ].join('\n') });
    const storageSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::Storage::save')!;
    const intSave = cg!.getNodesInFile('main.tolk').find(n => n.qualifiedName === 'main.tolk::int::save')!;
    const factory = cg!.getNodesInFile('main.tolk').find(n => n.name === 'factory')!;
    expect(cg!.getOutgoingEdges(factory.id).filter(e => e.kind === 'calls').sort((a, b) => a.column! - b.column!).map(e => e.target))
      .toEqual([storageSave.id, intSave.id]);
    const run = cg!.getNodesInFile('main.tolk').find(n => n.name === 'run')!;
    const targets = cg!.getOutgoingEdges(run.id).filter(e => e.kind === 'calls').map(e => e.target);
    expect(targets).toContain(intSave.id);
    expect(targets).not.toContain(storageSave.id);
  });

  it('does not interpret generic parameter names as concrete receiver or return types', async () => {
    await index({ 'main.tolk': [
      'struct Storage { x: int }', 'fun Storage.save(self): int { return self.x; }', 'fun int.save(self): int { return self; }',
      'fun generic<Storage>(s: Storage): int { return s.save(); }',
      'fun inferred<Storage>(s: Storage) { return s; }',
      'fun explicit<Storage>(s: Storage): Storage { return s; }',
      'fun local<Storage>(s: Storage) { val value: Storage = s; value.save(); Storage.save(s); }',
      'fun run() { generic<int>(7); inferred<int>(7).save(); explicit<int>(7).save(); }',
    ].join('\n') });
    expect(calls('main.tolk', 'generic')).toEqual([]);
    expect(calls('main.tolk', 'local')).toEqual([]);
    expect(calls('main.tolk', 'run')).toEqual(['main.tolk:explicit', 'main.tolk:generic', 'main.tolk:inferred']);
  });

  it('narrows imported message types only within their matching arms', async () => {
    await index({
      'main.tolk': [
        'import "request"', 'import "reply"', 'type Incoming = Request | Reply;',
        'fun run(raw: slice) {', '  val msg = lazy Incoming.fromSlice(raw);', '  match (msg) {',
        '    Request => { msg.header.validateRequest(); msg.items.parseArrayAndSend(); msg.other.parseArrayAndSend(); msg.handle(); }',
        '    Reply => { msg.other.parseArrayAndSend(); msg.header.validateRequest(); msg.handle(); }',
        '    else => { msg.handle(); msg.header.validateRequest(); }',
        '  }', '  msg.handle(); msg.header.validateRequest();', '}',
      ].join('\n'),
      'request.tolk': [
        'struct Request { header: Header, items: Items }', 'struct Header { seqno: int }', 'struct Items { count: int }',
        'fun Header.validateRequest(self) {}', 'fun Items.parseArrayAndSend(self) {}', 'fun Request.handle(self) {}',
      ].join('\n'),
      'reply.tolk': 'struct Reply { other: Other }\nstruct Other { count: int }\nfun Other.parseArrayAndSend(self) {}\nfun Reply.handle(self) {}',
      'hidden.tolk': 'struct Header { seqno: int }\nfun Header.validateRequest(self) {}',
    });
    const run = cg!.getNodesInFile('main.tolk').find(n => n.name === 'run')!;
    const targets = cg!.getOutgoingEdges(run.id).filter(e => e.kind === 'calls')
      .sort((a, b) => a.line! - b.line! || a.column! - b.column!)
      .map(e => [e.line, cg!.getNode(e.target)!.qualifiedName]);
    expect(targets).toEqual([
      [7, 'request.tolk::Header::validateRequest'], [7, 'request.tolk::Items::parseArrayAndSend'], [7, 'request.tolk::Request::handle'],
      [8, 'reply.tolk::Other::parseArrayAndSend'], [8, 'reply.tolk::Reply::handle'],
    ]);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('does not guess match receivers from unsupported patterns, subjects, types or generic intrinsics', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { x: int }', 'fun A.handle(self) {}', 'fun B.handle(self) {}',
      'fun patterns(msg: A | B) { match (msg) { 1 => { msg.handle(); } A<int> => { msg.handle(); } (A | B) => { msg.handle(); } Missing => { msg.handle(); } else => { msg.handle(); } } msg.handle(); }',
      'fun subject(msg: A | B) { match (msg.x) { A => { msg.handle(); } } }',
      'fun generic<A>(msg: A | B) { match (msg) { A => { msg.handle(); } } }',
      'fun intrinsic(s: slice) { val msg = s.loadAny<A>(); msg.handle(); }',
    ].join('\n') });
    for (const name of ['patterns', 'subject', 'generic', 'intrinsic']) expect(calls('main.tolk', name)).toEqual([]);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('invalidates narrowed binding origins through nested matches and captured assignments without touching local shadows', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { x: int }', 'fun A.handle(self) {}', 'fun B.handle(self) {}',
      'fun nested(msg: A) { match (msg) { B => { msg.handle(); match (msg) { A => { msg = unknown(); msg.handle(); } } msg.handle(); } } msg.handle(); }',
      'fun captured(msg: A) { match (msg) { B => { val cb = fun() { msg = unknown(); }; msg.handle(); } } msg.handle(); }',
      'fun shadow(msg: A | B) { match (msg) { A => { { val msg = msg; msg = unknown(); msg.handle(); } msg.handle(); val cb = fun(msg: B) { match (msg) { A => { msg = unknown(); msg.handle(); } } }; msg.handle(); } } msg.handle(); }',
    ].join('\n') });
    const targets = (name: string) => {
      const node = cg!.getNodesInFile('main.tolk').find(n => n.name === name)!;
      return cg!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls').sort((a, b) => a.column! - b.column!)
        .map(e => cg!.getNode(e.target)!.qualifiedName);
    };
    expect(targets('nested')).toEqual(['main.tolk::B::handle']);
    expect(targets('captured')).toEqual([]);
    expect(targets('shadow')).toEqual(['main.tolk::A::handle', 'main.tolk::A::handle']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('keeps reassigned unknown shadows distinct when both bindings are subsequently narrowed', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { x: int }', 'fun A.handle(self) {}', 'fun B.handle(self) {}',
      'fun run(msg: A | B) { msg = unknown(); match (msg) { A => { { var msg = unknown(); msg = unknown(); match (msg) { B => { msg = unknown(); msg.handle(); } } } msg.handle(); } } msg.handle(); }',
    ].join('\n') });
    const run = cg!.getNodesInFile('main.tolk').find(n => n.name === 'run')!;
    expect(cg!.getOutgoingEdges(run.id).filter(e => e.kind === 'calls').map(e => cg!.getNode(e.target)!.qualifiedName))
      .toEqual(['main.tolk::A::handle']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it.each(['value', '((value))', '(value)!'])('drops an active guard after passing mutate %s', async (lvalue) => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;',
      'fun A.run(self): int { return self.x; }', 'fun U.run(self): int { return 0; }',
      'fun replace(mutate value: U) { value = B { y: 2 }; }',
      `fun probe(value: U) { match (value) { A => { value.run(); replace(mutate ${lvalue}); value.run(); } } value.run(); }`,
    ].join('\n') });
    const probe = cg!.getNodesInFile('main.tolk').find(n => n.name === 'probe')!;
    const runs = cg!.getOutgoingEdges(probe.id).filter(e => e.kind === 'calls' && cg!.getNode(e.target)!.name === 'run');
    expect(runs.map(e => cg!.getNode(e.target)!.qualifiedName)).toEqual(['main.tolk::A::run']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('evaluates mutate arguments before clearing guards and clears nested calls before later outer arguments', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;', 'fun A.run(self): int { return self.x; }',
      'fun replace(mutate value: U): int { value = B { y: 2 }; return 0; }', 'fun consume(mutate a: U, b: int) {}', 'fun combine(a: int, b: int) {}',
      'fun ordered(value: U) { match (value) { A => { consume(mutate value, value.run()); value.run(); } } }',
      'fun nested(value: U) { match (value) { A => { combine(replace(mutate value), value.run()); value.run(); } } }',
      'fun scopes(value: U) { match (value) { A => { match (value) { A => { replace(mutate value); } } value.run(); } } value.run(); }',
    ].join('\n') });
    const runs = (name: string) => {
      const node = cg!.getNodesInFile('main.tolk').find(n => n.name === name)!;
      return cg!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls' && cg!.getNode(e.target)!.name === 'run')
        .map(e => cg!.getNode(e.target)!.qualifiedName);
    };
    expect(runs('ordered')).toEqual(['main.tolk::A::run']);
    expect(runs('nested')).toEqual([]);
    expect(runs('scopes')).toEqual([]);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('preserves normal typed receivers and owner guards for member mutation or mutate text', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;',
      'fun A.run(self): int { return self.x; }', 'fun A.mutate(self) {}',
      'fun touch(mutate value: A) {}', 'fun edit(mutate value: int) {}', 'fun consume(value: U, text: slice) {}',
      'fun ordinary(storage: A) { touch(mutate storage); storage.run(); }',
      'fun member(value: U) { match (value) { A => { edit(mutate value.x); value.run(); } } }',
      'fun literal(value: U) { match (value) { A => { consume(/* mutate value */ value, "mutate value"); value.mutate(); value.run(); } } }',
    ].join('\n') });
    for (const name of ['ordinary', 'member', 'literal']) {
      expect(calls('main.tolk', name)).toContain('main.tolk:run');
    }
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('does not establish guards for globals whose writes through calls are untracked', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;', 'global value: U;',
      'fun A.run(self): int { return self.x; }', 'fun U.run(self): int { return 0; }',
      'fun replaceGlobal() { value = B { y: 2 }; }',
      'fun probe() { match (value) { A => { replaceGlobal(); value.run(); } } }',
    ].join('\n') });
    expect(calls('main.tolk', 'probe')).toEqual(['main.tolk:replaceGlobal']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('does not turn assignment to a global into a lexical binding eligible for narrowing', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;', 'global value: U;',
      'fun A.run(self): int { return self.x; }', 'fun U.run(self): int { return 0; }',
      'fun replaceGlobal() { value = B { y: 2 }; }',
      'fun probe() { value = A { x: 1 }; match (value) { A => { replaceGlobal(); value.run(); } } }',
    ].join('\n') });
    expect(calls('main.tolk', 'probe')).toEqual(['main.tolk:replaceGlobal']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it.each(['(value) = B { y: 2 };', '(value, other) = (B { y: 2 }, 0);', '[value, other] = [B { y: 2 }, 0];'])(
    'discards guarded receivers assigned through the lvalue pattern %s', async (assignment) => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;',
      'fun A.run(self): int { return self.x; }', 'fun U.run(self): int { return 0; }',
      `fun probe(value: U) { var other = 0; match (value) { A => { { ${assignment} } value.run(); } } }`,
    ].join('\n') });
    expect(calls('main.tolk', 'probe')).toEqual([]);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('preserves guarded owners and unrelated shadows in wrapped and multiple assignments', async () => {
    await index({ 'main.tolk': [
      'struct A { x: int }', 'struct B { y: int }', 'type U = A | B;', 'fun A.run(self): int { return self.x; }',
      'fun member(value: U) { var other = 0; match (value) { A => { (value.x, other) = (7, 0); value.run(); } } }',
      'fun shadow(value: U) { match (value) { A => { { var value: U = A { x: 1 }; (value) = B { y: 2 }; } value.run(); } } }',
    ].join('\n') });
    expect(calls('main.tolk', 'member')).toEqual(['main.tolk:run']);
    expect(calls('main.tolk', 'shadow')).toEqual(['main.tolk:run']);
    expect(cg!.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
  });

  it('bounds recursive return inference while retaining repeated acyclic factories', async () => {
    await index({ 'main.tolk': 'fun placeholder() {}' });
    const parsed = extractFromSource('main.tolk', [
      'struct Storage { x: int }', 'fun Storage.save(self) {}',
      'fun leaf() { return Storage { x: 0 }; }',
      'fun repeated(x: int) { if (x > 0) { return leaf(); } return leaf(); }',
      'fun make(x: int) { if (x > 0) { return make(x - 1); } return make(x + 1); }',
      'fun run() { make(1).save(); repeated(1).save(); }',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    let reads = 0;
    const base = new ReferenceResolver(dir, cg!.queries).getResolutionContext();
    const context = { ...base, getNodesInFile: () => {
      if (++reads > 1000) throw new Error('Test context work limit exceeded');
      return parsed.nodes;
    } };
    const recursive = parsed.unresolvedReferences.find(r => r.referenceName === 'make(1).save')!;
    expect(resolveTolkReference(recursive as UnresolvedRef, context)).toBeNull();
    expect(reads).toBeLessThan(50);
    reads = 0;
    const repeated = parsed.unresolvedReferences.find(r => r.referenceName === 'repeated(1).save')!;
    const result = resolveTolkReference(repeated as UnresolvedRef, context);
    expect(parsed.nodes.find(n => n.id === result?.targetNodeId)?.qualifiedName).toBe('main.tolk::Storage::save');
    expect(reads).toBeLessThan(50);
  });

  it('preserves lexical candidates through resolver-worker batch admission', async () => {
    const source = 'struct Storage { x: int }\nfun Storage.save(self) {}\nfun run(s: Storage) { s.save(); }';
    await index({ 'main.tolk': source });
    const refs = extractFromSource('main.tolk', source).unresolvedReferences;
    const result = new ReferenceResolver(dir, cg!.queries).resolveListForAdmission(refs);
    expect(result.unresolved).toEqual([]);
    expect(result.deferredChain).toEqual([]);
    expect(result.resolved.map(r => cg!.getNode(r.targetNodeId)?.name)).toEqual(['save']);
  });

  it.each(['lib = { path = "lib" }', 'lib = "/lib"', "lib = 'C:\\lib'"])(
    'never substitutes tsconfig aliases, unsupported mapping %s or escaping imports', async (mapping) => {
    await index({
      'Acton.toml': '[import-mappings]\n' + mapping + '\n',
      'tsconfig.json': '{"compilerOptions":{"paths":{"@lib/*":["lib/*"]}}}',
      'main.tolk': 'import "@lib/util"\nimport "../../util"\nfun run() { util(); }',
      'lib/util.tolk': 'fun util() {}',
    });
    expect(calls('main.tolk', 'run')).toEqual([]);
    expect(cg!.getNodesInFile('main.tolk').flatMap(n => cg!.getOutgoingEdges(n.id)).filter(e => e.kind === 'imports')).toEqual([]);
    expect(cg!.getUnresolvedReferencesInFile('main.tolk')).toHaveLength(3);
  });
});
