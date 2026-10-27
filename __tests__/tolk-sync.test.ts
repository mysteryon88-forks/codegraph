import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Tolk incremental convergence', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];
  afterEach(() => { for (const graph of graphs) graph.close(); for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); graphs.length = dirs.length = 0; });
  const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-sync-')); dirs.push(d); return d; };
  function write(dir: string, files: Record<string, string>) {
    for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  }
  const snapshot = (graph: CodeGraph) => {
    const nodes = graph.getFiles().flatMap(f => graph.getNodesInFile(f.path));
    const key = new Map(nodes.map(n => [n.id, [n.filePath, n.kind, n.name, n.qualifiedName, n.startLine, n.startColumn].join('|')]));
    return {
      nodes: nodes.map(({ updatedAt, id, ...n }) => JSON.stringify(n)).sort(),
      edges: nodes.flatMap(n => graph.getOutgoingEdges(n.id)).map(e => JSON.stringify([key.get(e.source), key.get(e.target), e.kind, e.line, e.column])).sort(),
    };
  };
  async function check(graph: CodeGraph, files: Record<string, string>) {
    const freshDir = temp(); write(freshDir, files);
    const fresh = CodeGraph.initSync(freshDir); graphs.push(fresh); await fresh.indexAll(); fresh.resolveReferences();
    await graph.sync();
    expect(snapshot(graph)).toEqual(snapshot(fresh));
  }
  it('converges after receiver, return, import and mapping edits plus add/rename/delete', async () => {
    const dir = temp();
    const files: Record<string, string> = {
      'Acton.toml': '[import-mappings]\nlib = "one"\n',
      'main.tolk': 'import "@lib/types"\nfun run() { make().save(); }',
      'one/types.tolk': 'struct A { x: int }\nstruct B { x: int }\nfun make(): A { return A { x: 0 }; }\nfun A.save(self) {}',
      'two/types.tolk': 'struct A { x: int }\nfun make(): A { return A { x: 0 }; }\nfun A.save(self) {}',
    };
    write(dir, files);
    const graph = CodeGraph.initSync(dir); graphs.push(graph); await graph.indexAll(); graph.resolveReferences();
    files['one/types.tolk'] = files['one/types.tolk']!.replace('fun make(): A', 'fun make(): B');
    write(dir, files); await check(graph, files);
    files['one/types.tolk'] = files['one/types.tolk']!.replace('fun A.save', 'fun B.save');
    write(dir, files); await check(graph, files);
    files['Acton.toml'] = '[import-mappings]\nlib = "two"\n';
    write(dir, files); await check(graph, files);
    files['main.tolk'] = 'import "two/types"\nfun run() { make().save(); }';
    write(dir, files); await check(graph, files);
    files['two/moved.tolk'] = files['two/types.tolk']!; delete files['two/types.tolk']; fs.unlinkSync(path.join(dir, 'two/types.tolk'));
    files['main.tolk'] = 'import "two/moved"\nfun run() { make().save(); }';
    write(dir, files); await check(graph, files);
    delete files['two/moved.tolk']; fs.unlinkSync(path.join(dir, 'two/moved.tolk')); await check(graph, files);
  }, 30000);

  it('replaces a narrowed match target after a pattern edit and converges with an independent index', async () => {
    const dir = temp();
    const files = {
      'main.tolk': 'import "types"\nfun run(msg: A | B) { match (msg) { A => { msg.handle(); } else => {} } }',
      'types.tolk': 'struct A { x: int }\nstruct B { x: int }\nfun A.handle(self) {}\nfun B.handle(self) {}',
    };
    write(dir, files);
    const graph = CodeGraph.initSync(dir); graphs.push(graph); await graph.indexAll(); graph.resolveReferences();
    const targets = () => {
      const run = graph.getNodesInFile('main.tolk').find(n => n.name === 'run')!;
      return graph.getCallees(run.id).map(c => c.node.qualifiedName);
    };
    expect(targets()).toEqual(['types.tolk::A::handle']);
    files['main.tolk'] = files['main.tolk'].replace('A =>', 'B =>');
    write(dir, files); await check(graph, files);
    expect(targets()).toEqual(['types.tolk::B::handle']);
  });

  it('removes a guarded target after a call gains a mutate argument and converges with a fresh index', async () => {
    const dir = temp();
    const files = {
      'main.tolk': 'struct A { x: int }\nstruct B { y: int }\ntype U = A | B;\nfun A.run(self) {}\nfun touch(value: U) {}\nfun probe(value: U) { match (value) { A => { touch(value); value.run(); } } }',
    };
    write(dir, files);
    const graph = CodeGraph.initSync(dir); graphs.push(graph); await graph.indexAll(); graph.resolveReferences();
    const targets = () => {
      const probe = graph.getNodesInFile('main.tolk').find(n => n.name === 'probe')!;
      return graph.getCallees(probe.id).map(c => c.node.qualifiedName).sort();
    };
    expect(targets()).toEqual(['main.tolk::A::run', 'touch']);
    files['main.tolk'] = files['main.tolk'].replace('touch(value: U)', 'touch(mutate value: U)').replace('touch(value);', 'touch(mutate value);');
    write(dir, files); await check(graph, files);
    expect(targets()).toEqual(['touch']);
  });

  it('drops and recovers guard proofs when an imported method changes receiver type', async () => {
    const dir = temp();
    const files = {
      'main.tolk': 'import "types"\nfun probe(value: U) { match (value) { A => { value.run(); value.touch(); value.run(); } } }',
      'types.tolk': 'struct A { x: int }\nstruct B { y: int }\ntype U = A | B;\nfun A.run(self) {}\nfun A.touch(self) {}',
    };
    write(dir, files);
    const graph = CodeGraph.initSync(dir); graphs.push(graph); await graph.indexAll(); graph.resolveReferences();
    const targets = () => {
      const probe = graph.getNodesInFile('main.tolk').find(n => n.name === 'probe')!;
      return graph.getOutgoingEdges(probe.id).filter(e => e.kind === 'calls').sort((a, b) => a.column! - b.column!)
        .map(e => graph.getNode(e.target)!.qualifiedName);
    };
    expect(targets()).toEqual(['types.tolk::A::run', 'types.tolk::A::touch', 'types.tolk::A::run']);
    files['types.tolk'] = files['types.tolk'].replace('fun A.touch(self)', 'fun U.touch(mutate self)');
    write(dir, files); await check(graph, files);
    expect(targets()).toEqual(['types.tolk::A::run']);
    files['types.tolk'] = files['types.tolk'].replace('fun U.touch(mutate self)', 'fun A.touch(self)');
    write(dir, files); await check(graph, files);
    expect(targets()).toEqual(['types.tolk::A::run', 'types.tolk::A::touch', 'types.tolk::A::run']);
  }, 30000);
});
