import type CodeGraph from '../index';
import type { Node, Subgraph } from '../types';
import type { QueryLineAnchor } from '../search/query-paths';
import { matchesSymbol } from '../graph/symbol-lookup';

const DEPENDENCIES = new Set(['calls', 'references', 'type_of', 'returns', 'instantiates']);
const TYPES = new Set(['struct', 'union', 'enum', 'type_alias']);
const isDeclaration = (n: Node) => !['file', 'import', 'export'].includes(n.kind);

/** A pinned Tolk contract reaches its dependencies, never other users of a shared helper. */
export function pinnedTolkScope(
  cg: CodeGraph,
  pins: readonly string[],
  tokens: readonly string[],
  anchors: readonly QueryLineAnchor[],
): Subgraph | undefined {
  if (pins.length === 0) return undefined;
  const files = new Map(pins.map(fp => [fp, cg.getNodesInFile(fp)]));
  if ([...files.values()].some(nodes => !nodes.some(n => n.language === 'tolk') || nodes.some(n => n.language !== 'tolk'))) return undefined;

  const nodes = new Map<string, Node>();
  const roots: string[] = [];
  const queue: Array<{ node: Node; depth: number }> = [];
  const rootsPerFile = Math.floor(200 / pins.length);
  const admit = (node: Node, depth: number) => {
    if (nodes.has(node.id) || nodes.size >= 200) return;
    nodes.set(node.id, node);
    queue.push({ node, depth });
  };
  for (const [fp, all] of files) {
    const declarations = all.filter(isDeclaration);
    if (declarations.length === 0) {
      const file = all.find(n => n.kind === 'file');
      if (file) admit(file, 0);
    }
    const spans = anchors.filter(a => a.file === fp);
    const focused = declarations.filter(n => tokens.some(t => matchesSymbol(n, t))
      || spans.some(a => n.startLine <= a.end && n.endLine >= a.start));
    for (const node of (focused.length > 0 ? focused : declarations).slice(0, rootsPerFile)) {
      admit(node, 0);
      if (nodes.has(node.id)) roots.push(node.id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const { node, depth } = queue[head]!;
    if (depth >= 3) continue;
    // Tolk records receiver identity in metadata rather than a type edge.
    const ownerNames = [node.decorators?.find(d => d.startsWith('tolk:receiver:'))?.slice('tolk:receiver:'.length), node.returnType];
    for (const name of new Set(ownerNames)) {
      if (node.language !== 'tolk' || !name || !/^[A-Za-z_]\w*$/.test(name) || node.typeParameters?.includes(name)) continue;
      const owners = cg.getNodesInFile(node.filePath).filter(n => TYPES.has(n.kind) && n.name === name);
      if (owners.length === 1) admit(owners[0]!, depth + 1);
    }
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (!DEPENDENCIES.has(edge.kind) && !(edge.kind === 'contains' && TYPES.has(node.kind))) continue;
      const target = cg.getNode(edge.target);
      if (target && isDeclaration(target)) admit(target, depth + 1);
    }
    for (const edge of cg.getIncomingEdges(node.id)) {
      if (edge.kind !== 'contains') continue;
      const owner = cg.getNode(edge.source);
      if (owner && TYPES.has(owner.kind)) admit(owner, depth + 1);
    }
  }
  // Imports explain the source's dependencies but do not expand their entire files.
  const scopedFiles = new Set([...pins, ...[...nodes.values()].map(n => n.filePath)]);
  for (const fp of scopedFiles) {
    for (const node of files.get(fp) ?? cg.getNodesInFile(fp)) {
      if (node.kind !== 'import' || nodes.size >= 200) continue;
      const targets = cg.getOutgoingEdges(node.id).filter(e => e.kind === 'imports');
      if (targets.length === 0 || targets.some(e => scopedFiles.has(cg.getNode(e.target)?.filePath ?? ''))) nodes.set(node.id, node);
    }
  }
  const edges = [...nodes.keys()].flatMap(id => cg.getOutgoingEdges(id))
    .filter(e => nodes.has(e.source) && nodes.has(e.target));
  return { nodes, roots, edges };
}
