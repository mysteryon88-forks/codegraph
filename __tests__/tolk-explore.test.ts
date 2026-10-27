import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { resolveNamedTokens, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

let dir: string;
let cg: CodeGraph;
afterEach(() => { cg?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

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
