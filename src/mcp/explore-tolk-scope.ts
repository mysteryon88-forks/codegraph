import type CodeGraph from '../index';
import type { Node, Subgraph } from '../types';
import type { QueryLineAnchor } from '../search/query-paths';
import { isQualifiedSymbol, matchesSymbol } from '../graph/symbol-lookup';
import { isDistinctiveIdentifier, normalizeNameToken } from '../search/query-utils';

const DEPENDENCIES = new Set(['calls', 'references', 'type_of', 'returns', 'instantiates']);
const TYPES = new Set(['struct', 'union', 'enum', 'type_alias']);
const isDeclaration = (n: Node) => !['file', 'import', 'export'].includes(n.kind);
const isCallable = (n: Node) => n.kind === 'function' || n.kind === 'method';

/** A pinned Tolk contract reaches dependencies and owned receiver callers, never other contracts. */
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
  const depths = new Map<string, number>();
  const callerContexts = new Map<string, Node>();
  const typeCandidates = new Map<string, { local: Node[]; imported: Node[] }>();
  const typesForFile = (fp: string) => {
    const cached = typeCandidates.get(fp);
    if (cached) return cached;
    const all = files.get(fp) ?? cg.getNodesInFile(fp);
    const imported = new Map<string, Node>();
    const importedFiles = new Set<string>();
    for (const imp of all.filter(n => n.kind === 'import')) for (const edge of cg.getOutgoingEdges(imp.id)) {
      if (edge.kind !== 'imports') continue;
      const target = cg.getNode(edge.target);
      if (target?.language !== 'tolk' || importedFiles.has(target.filePath)) continue;
      importedFiles.add(target.filePath);
      for (const node of cg.getNodesInFile(target.filePath)) {
        if (node.language === 'tolk' && TYPES.has(node.kind)) imported.set(node.id, node);
      }
    }
    const candidates = { local: all.filter(n => TYPES.has(n.kind)), imported: [...imported.values()] };
    typeCandidates.set(fp, candidates);
    return candidates;
  };
  const rootsPerFile = Math.floor(200 / pins.length);
  const admit = (node: Node, depth: number) => {
    if ((depths.get(node.id) ?? Infinity) <= depth || (!nodes.has(node.id) && nodes.size >= 200)) return;
    nodes.set(node.id, node);
    depths.set(node.id, depth);
    queue.push({ node, depth });
  };
  for (const [fp, all] of files) {
    const declarations = all.filter(isDeclaration);
    if (declarations.length === 0) {
      const file = all.find(n => n.kind === 'file');
      if (file) admit(file, 0);
    }
    const spans = anchors.filter(a => a.file === fp);
    const matches = (n: Node, t: string) => {
      if (isQualifiedSymbol(t) && n.decorators?.some(d => d.startsWith('tolk:receiver:'))) {
        const name = n.qualifiedName.replace(/::|\//g, '.');
        const query = t.replace(/::|\//g, '.');
        return name === query || name.endsWith(`.${query}`);
      }
      return matchesSymbol(n, t)
        || (isDistinctiveIdentifier(t) && !isQualifiedSymbol(t) && normalizeNameToken(n.name) === normalizeNameToken(t));
    };
    const anchored = declarations.filter(n => spans.some(a => n.startLine <= a.end && n.endLine >= a.start));
    // Message spelling can name a receiver (AddPoints -> addPoints), ahead of prose like "score".
    const namedCallables = declarations.filter(n => isCallable(n) && !n.decorators?.includes('tolk:getter')
      && tokens.some(t => isDistinctiveIdentifier(t) && matches(n, t)));
    const focused = namedCallables.length > 0 ? [...anchored, ...namedCallables]
      : declarations.filter(n => tokens.some(t => matches(n, t)) || anchored.includes(n));
    const selected = focused.length > 0 ? focused : declarations;
    // Named message types are source context even when parameter types have no graph edge.
    const types = tokens.length > 0 ? typesForFile(fp) : { local: [], imported: [] };
    const typeContext = [...types.local, ...types.imported].filter(n => tokens.some(t => matchesSymbol(n, t)));
    const callers = new Map<string, Node>();
    if (spans.length === 0 && namedCallables.length > 0
      && namedCallables.every(n => n.decorators?.some(d => d.startsWith('tolk:receiver:')))) {
      // Only direct, resolved callers in this pinned file; never walk reverse dependencies.
      for (const receiver of namedCallables) for (const edge of cg.getIncomingEdges(receiver.id)) {
        if (edge.kind !== 'calls') continue;
        const caller = cg.getNode(edge.source);
        if (caller?.filePath === fp && caller.language === 'tolk' && isCallable(caller)) callers.set(caller.id, caller);
      }
    }
    const candidates = new Map([...selected, ...typeContext].map(n => [n.id, n]));
    const primaryRoots = [...candidates.values()].slice(0, rootsPerFile);
    for (const node of primaryRoots) {
      admit(node, 0);
      if (nodes.has(node.id)) roots.push(node.id);
    }
    for (const caller of [...callers.values()].filter(n => !candidates.has(n.id)).slice(0, rootsPerFile - primaryRoots.length)) {
      callerContexts.set(caller.id, caller);
    }
  }
  let head = 0;
  const expandDependencies = () => {
    for (; head < queue.length; head++) {
      const { node, depth } = queue[head]!;
      if (depth >= 3) continue;
      // Tolk records receiver identity in metadata rather than a type edge.
      const ownerNames = [node.decorators?.find(d => d.startsWith('tolk:receiver:'))?.slice('tolk:receiver:'.length), node.returnType];
      const outgoing = cg.getOutgoingEdges(node.id);
      if (isCallable(node)) for (const edge of outgoing) {
        if (edge.kind !== 'contains') continue;
        const parameter = cg.getNode(edge.target);
        if (parameter?.kind === 'parameter') ownerNames.push(/^(?:mutate\s+)?[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)$/.exec(parameter.signature ?? '')?.[1]);
      }
      for (const name of new Set(ownerNames)) {
        if (node.language !== 'tolk' || !name || !/^[A-Za-z_]\w*$/.test(name) || node.typeParameters?.includes(name)) continue;
        const types = typesForFile(node.filePath);
        const local = types.local.filter(n => n.name === name);
        const owners = local.length > 0 ? local : types.imported.filter(n => n.name === name);
        if (owners.length === 1) admit(owners[0]!, depth + 1);
      }
      for (const edge of outgoing) {
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
  };
  expandDependencies();
  // Selected roots and their forward evidence take priority over reverse caller context.
  for (const caller of callerContexts.values()) {
    if (nodes.size >= 200) break;
    admit(caller, 0);
    roots.push(caller.id);
    expandDependencies();
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
