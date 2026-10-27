import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { ReferenceResolver } from '../src/resolution';
import { resolveTolkReference } from '../src/resolution/tolk';
import type { UnresolvedRef } from '../src/resolution/types';

let dir: string;
let graph: CodeGraph;
afterEach(() => { graph?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-proof-'));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  graph = CodeGraph.initSync(dir); await graph.indexAll(); graph.resolveReferences();
  expect(graph.getFiles().flatMap(f => f.errors ?? [])).toEqual([]);
}
function targets(name: string) {
  const node = graph.getNodesInFile('main.tolk').find(n => n.name === name && n.kind === 'function')!;
  return graph.getOutgoingEdges(node.id).filter(e => e.kind === 'calls').sort((a, b) => a.line! - b.line! || a.column! - b.column!)
    .map(e => graph.getNode(e.target)!.qualifiedName);
}
const types = 'struct A { x: int }\nstruct B { y: int }\ntype U = A | B;\nfun A.run(self): int { return 111; }\nfun B.run(self): int { return 222; }\nfun U.run(self): int { return 333; }';

it('retains earlier A and sibling B calls but does not guess a target after implicit union-self mutation', async () => {
  await index({ 'main.tolk': types + [
    '\nfun U.replace(mutate self) { self = B { y: 2 }; }',
    'fun probe(value: U) { match (value) {',
    '  A => { value.run(); value.replace(); value.run(); }',
    '  B => { value.run(); }', ' } }',
  ].join('\n') });
  expect(targets('probe')).toEqual(['main.tolk::A::run', 'main.tolk::B::run']);
});

it('preserves imported same-type immutable, mutate-self and generic method chains with receiver wrappers', async () => {
  await index({
    'main.tolk': 'import "types"\nimport "methods"\nfun probe(value: U) { match (value) { A => { (value).check(); (value)!.change(); value.generic<int>(); value.run(); } } }',
    'types.tolk': types,
    'methods.tolk': 'import "types"\nfun A.check(self) {}\nfun A.change(mutate self) { self = A { x: 1 }; }\nfun A.generic<T>(self) {}',
  });
  expect(targets('probe')).toEqual(['methods.tolk::A::check', 'methods.tolk::A::change', 'methods.tolk::A::generic', 'types.tolk::A::run']);
});

it.each(['missing', 'ambiguous', 'foreign'])('rejects subsequent guard evidence when the prior method is %s', async (mode) => {
  const files: Record<string, string> = {
    'main.tolk': `import "types"\n${mode === 'ambiguous' ? 'import "extra"\n' : ''}fun probe(value: U) { match (value) { A => { value.check(); value.run(); } } }`,
    'types.tolk': types + (mode === 'ambiguous' ? '\nfun A.check(self) {}' : ''),
    'extra.tolk': 'import "types"\nfun A.check(self) {}',
    'foreign.ts': 'export class A { check() {} }',
  };
  if (mode === 'missing') delete files['extra.tolk'];
  await index(files);
  expect(targets('probe')).toEqual([]);
});

it('propagates obligations only through the same narrowed origin and resets them at a fresh match', async () => {
  await index({ 'main.tolk': types + [
    '\nfun U.replace(mutate self) { self = B { y: 2 }; }', 'fun A.check(self) {}',
    'fun nested(value: U) { match (value) { A => { match (value) { A => { value.replace(); } } value.run(); match (value) { A => { value.run(); } } } } }',
    'fun shadow(value: U) { match (value) { A => { { val value: U = B { y: 0 }; match (value) { B => { value.replace(); } } } value.check(); value.run(); } } }',
    'fun outer(value: U) { match (value) { A => { value.replace(); } } value.run(); }',
  ].join('\n') });
  expect(targets('nested')).toEqual(['main.tolk::A::run']);
  expect(targets('shadow')).toEqual(['main.tolk::A::check', 'main.tolk::A::run']);
  expect(targets('outer')).toEqual(['main.tolk::U::run']);
});

it('adds obligations after the complete call and keeps explicit mutate invalidation dominant', async () => {
  await index({ 'main.tolk': types + [
    '\nfun U.replace(mutate self, n: int): int { self = B { y: n }; return 0; }',
    'fun A.check(self, n: int) {}', 'fun consume(a: int, b: int) {}',
    'fun ordered(value: U) { match (value) { A => { value.replace(value.run()); value.run(); } } }',
    'fun nested(value: U) { match (value) { A => { consume(value.replace(0), value.run()); } } }',
    'fun A.explicit(self, mutate other: U, n: int) {}',
    'fun explicit(value: U) { match (value) { A => { value.explicit(mutate value, value.run()); value.run(); } } }',
  ].join('\n') });
  expect(targets('ordered')).toEqual(['main.tolk::A::run']);
  expect(targets('nested')).toEqual(['consume']);
  expect(targets('explicit')).toEqual(['main.tolk::A::explicit', 'main.tolk::A::run']);
});

it('persists immutable flat return proofs and resolves each reference independently in either order', async () => {
  const source = types + [
    '\nfun A.check(self) {}', 'fun U.replace(mutate self) { self = B { y: 2 }; }',
    'fun good(value: U) { match (value) { A => { value.check(); return value; } else => { throw 1; } } }',
    'fun bad(value: U) { match (value) { A => { value.replace(); return value; } else => { throw 1; } } }',
    'fun probe(value: U) { good(value).run(); bad(value).run(); }',
  ].join('\n');
  await index({ 'main.tolk': source });
  expect(targets('probe')).toEqual(['good', 'main.tolk::A::run', 'bad']);
  const good = graph.getNodesInFile('main.tolk').find(n => n.name === 'good')!;
  const returned = JSON.parse(good.decorators!.find(d => d.startsWith('tolk:returns:'))!.slice('tolk:returns:'.length));
  expect(returned).toEqual([{ type: 'A', afterMethods: [{ type: 'A', name: 'check' }] }]);
  const refs = extractFromSource('main.tolk', source).unresolvedReferences as UnresolvedRef[];
  const context = new ReferenceResolver(dir, graph.queries).getResolutionContext();
  const forward = refs.map(r => resolveTolkReference(r, context)?.targetNodeId ?? null);
  const reverse = [...refs].reverse().map(r => resolveTolkReference(r, context)?.targetNodeId ?? null).reverse();
  expect(reverse).toEqual(forward);
});

it('deduplicates repeated obligations without altering earlier snapshots', async () => {
  const source = types + '\nfun A.check(self) {}\nfun probe(value: U) { match (value) { A => { ' + 'value.check(); '.repeat(40) + 'value.run(); } } }';
  await index({ 'main.tolk': source });
  const parsed = extractFromSource('main.tolk', source);
  const first = parsed.unresolvedReferences.find(r => r.referenceName === 'value.check')!;
  const last = parsed.unresolvedReferences.find(r => r.referenceName === 'value.run')!;
  expect(JSON.parse(first.candidates![0]!.slice(5)).receiver).toEqual({ type: 'A' });
  expect(JSON.parse(last.candidates![0]!.slice(5)).receiver).toEqual({ type: 'A', afterMethods: [{ type: 'A', name: 'check' }] });
  expect(targets('probe').at(-1)).toBe('main.tolk::A::run');
});

it.each(['count', 'encoded-size'])('degrades to UNKNOWN when the proof exceeds its %s bound', async (bound) => {
  const names = bound === 'count' ? Array.from({ length: 17 }, (_, i) => 'method' + i) : ['method' + 'x'.repeat(1010)];
  const source = types + '\n' + names.map(name => `fun A.${name}(self) {}`).join('\n') +
    '\nfun probe(value: U) { match (value) { A => { ' + names.map(name => `value.${name}();`).join(' ') + ' value.run(); } } }';
  await index({ 'main.tolk': source });
  const last = extractFromSource('main.tolk', source).unresolvedReferences.find(r => r.referenceName === 'value.run')!;
  expect(JSON.parse(last.candidates![0]!.slice(5)).receiver).toEqual({ unknown: true });
  expect(targets('probe')).not.toContain('main.tolk::A::run');
});

it('erases proof types that name generic parameters even when the current guard is concrete', async () => {
  const source = types + '\nfun A.check(self) {}\nfun probe<T>(value: U) { match (value) { A => { value.run(); match (value) { T => { value.check(); } } value.run(); } } }';
  await index({ 'main.tolk': source });
  expect(targets('probe')).toEqual(['main.tolk::A::run']);
  const refs = extractFromSource('main.tolk', source).unresolvedReferences.filter(r => r.referenceName === 'value.run');
  expect(JSON.parse(refs.at(-1)!.candidates![0]!.slice(5)).receiver).toEqual({ unknown: true });
});
