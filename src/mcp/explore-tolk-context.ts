import type { Node as SyntaxNode, Parser, Tree } from 'web-tree-sitter';
import { closeSync, constants, fstatSync, openSync, readSync, statSync, type BigIntStats } from 'fs';
import { createHash } from 'crypto';
import type CodeGraph from '../index';
import type { Node } from '../types';
import type { ExploreLineRange } from './explore-session-state';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget, REQUEST_PARSE_BUDGET_MS } from '../extraction/parse-budget';
import { MAX_PARSE_BYTES } from '../graph/branch-guards';
import { validatePathWithinRoot } from '../utils';

const TYPE_KINDS: Record<string, string> = {
  struct_declaration: 'struct', enum_declaration: 'enum', type_alias_declaration: 'type_alias',
};
const MAX_FILES = 64, MAX_BYTES = 2 * 1024 * 1024, MAX_NODES = 10000, MAX_REFERENCES = 200, MAX_CONTEXT = 64;
const simpleName = (name: string) => /^[A-Za-z_]\w*$/.test(name);
const spans = (node: SyntaxNode): ExploreLineRange => ({ start: node.startPosition.row + 1, end: node.endPosition.row + 1 });

interface Inventory {
  tree: Tree;
  definitions: Node[];
  aliases: Array<{ node: Node; members: string[]; generic: boolean }>;
}

/** Read one validated, unchanged file through a single descriptor without exceeding the byte budget. */
export function readFreshTolkSource(projectRoot: string, file: string, maxBytes: number, contentHash: string): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PARSE_BYTES) return undefined;
  let fd: number | undefined;
  const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    const path = validatePathWithinRoot(projectRoot, file);
    if (!path) return undefined;
    const initial = statSync(path, { bigint: true });
    if (!initial.isFile() || initial.size > BigInt(maxBytes)) return undefined;
    // Match the existing trail reader: refuse a swapped symlink or a blocking FIFO where supported.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFile(initial, before)) return undefined;
    const buffer = Buffer.alloc(Number(before.size));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (validatePathWithinRoot(projectRoot, file) !== path) return undefined;
    const current = statSync(path, { bigint: true });
    const after = fstatSync(fd, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, current) || BigInt(bytes) !== after.size) return undefined;
    const source = buffer.subarray(0, bytes).toString('utf8');
    return createHash('sha256').update(source).digest('hex') === contentHash ? source : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One nonrecursive source-only pass; readFresh must enforce the project's path and index freshness checks. */
export async function referencedTolkContext(
  cg: CodeGraph,
  emitted: ReadonlyMap<string, { ranges: readonly ExploreLineRange[] }>,
  readFresh: (file: string, maxBytes: number) => string | undefined,
): Promise<Map<string, Node[]>> {
  const result = new Map<string, Node[]>();
  const inventories = new Map<string, Inventory | null>();
  const visibility = new Map<string, string[] | null>();
  const generated = cg.generatedFilePredicate(emitted.keys());
  const deadline = Date.now() + REQUEST_PARSE_BUDGET_MS;
  let parser: Parser | null = null, bytes = 0, astNodes = 0, contextCount = 0;
  const visibleFiles = (file: string): string[] | null => {
    if (visibility.has(file)) return visibility.get(file)!;
    const files = new Set([file]);
    for (const imp of cg.getNodesInFile(file).filter(n => n.kind === 'import')) {
      const targets = cg.getOutgoingEdges(imp.id).filter(e => e.kind === 'imports')
        .map(e => cg.getNode(e.target)).filter((n): n is Node => n?.language === 'tolk');
      if (targets.length === 0) { visibility.set(file, null); return null; }
      for (const target of targets) files.add(target.filePath);
      if (files.size > MAX_FILES || Date.now() >= deadline) { visibility.set(file, null); return null; }
    }
    const all = [...files];
    visibility.set(file, all);
    return all;
  };
  const inventory = (file: string): Inventory | null => {
    if (inventories.has(file)) return inventories.get(file)!;
    const record = cg.getFile(file);
    if (Date.now() >= deadline || inventories.size >= MAX_FILES || record?.language !== 'tolk'
        || record.size > MAX_PARSE_BYTES || bytes + record.size > MAX_BYTES) return null;
    inventories.set(file, null);
    const maxBytes = Math.min(MAX_PARSE_BYTES, MAX_BYTES - bytes);
    // Failed freshness reads still spend their possible bytes; they cannot bypass the total cap.
    bytes += maxBytes;
    const source = readFresh(file, maxBytes);
    if (source === undefined) return null;
    const size = Buffer.byteLength(source, 'utf8');
    if (size > maxBytes) return null;
    bytes -= maxBytes - size;
    parser!.reset();
    const tree = parseWithinBudget(parser!, source, Math.max(0, deadline - Date.now()));
    if (!tree) return null;
    const data: Inventory = { tree, definitions: [], aliases: [] };
    inventories.set(file, data);
    const declarations = tree.rootNode.descendantsOfType(Object.keys(TYPE_KINDS));
    const identifiers = tree.rootNode.descendantsOfType('type_identifier');
    astNodes += declarations.length + identifiers.length;
    if (tree.rootNode.hasError || astNodes > MAX_NODES || Date.now() >= deadline) {
      tree.delete(); inventories.set(file, null); return null;
    }
    const indexed = cg.getNodesInFile(file);
    for (const declaration of declarations) {
      if (!declaration) continue;
      if (Date.now() >= deadline) { tree.delete(); inventories.set(file, null); return null; }
      const name = declaration.childForFieldName('name')?.text;
      const range = spans(declaration);
      const matches = indexed.filter(n => n.kind === TYPE_KINDS[declaration.type] && n.name === name
        && n.startLine === range.start && n.endLine === range.end);
      // An incomplete inventory cannot establish that an alias is unique.
      if (matches.length !== 1) { tree.delete(); inventories.set(file, null); return null; }
      const node = matches[0]!;
      data.definitions.push(node);
      if (declaration.type !== 'type_alias_declaration') continue;
      const rhs = declaration.childForFieldName('underlying_type');
      const members: string[] = [];
      const visitUnion = (part: SyntaxNode): boolean => {
        if (part.type === 'type_identifier' && simpleName(part.text)) { members.push(part.text); return true; }
        return part.type === 'union_type' && part.namedChildren.length === 2 && part.namedChildren.every(visitUnion);
      };
      if (rhs?.type === 'union_type' && visitUnion(rhs)) {
        const parameters = declaration.childForFieldName('type_parameters');
        const shadowed = new Set(parameters?.namedChildren.map(p => p.childForFieldName('name')?.text));
        data.aliases.push({ node, members: members.filter(m => !shadowed.has(m)), generic: !!parameters });
      }
    }
    inventories.set(file, data);
    return data;
  };
  const resolve = (file: string, name: string): Node | undefined => {
    const local = inventory(file);
    if (!local) return undefined;
    const own = local.definitions.filter(n => n.name === name);
    if (own.length > 0) return own.length === 1 ? own[0] : undefined;
    const files = visibleFiles(file);
    if (!files) return undefined;
    const imported: Node[] = [];
    for (const fp of files.slice(1)) {
      const data = inventory(fp);
      if (!data) return undefined;
      imported.push(...data.definitions.filter(n => n.name === name));
    }
    return imported.length === 1 ? imported[0] : undefined;
  };
  const admit = (node: Node) => {
    if (!emitted.has(node.filePath) || generated(node.filePath) || contextCount >= MAX_CONTEXT) return;
    const previous = result.get(node.filePath) ?? [];
    if (previous.some(n => n.id === node.id)) return;
    previous.push(node); result.set(node.filePath, previous); contextCount++;
  };
  try {
    await loadGrammarsForLanguages(['tolk']);
    parser = getParser('tolk');
    if (!parser) return result;
    // Evidence is frozen before admission: added declarations never seed another pass.
    const references: Array<{ file: string; name: string }> = [];
    for (const [file, emission] of emitted) {
      if (generated(file)) continue;
      const data = inventory(file);
      if (!data) continue;
      for (const identifier of data.tree.rootNode.descendantsOfType('type_identifier')) {
        if (!identifier || !simpleName(identifier.text)) continue;
        const range = spans(identifier);
        if (!emission.ranges.some(r => r.start <= range.start && r.end >= range.end)) continue;
        let shadowed = false;
        for (let owner = identifier.parent; owner; owner = owner.parent) {
          if (owner.childForFieldName('type_parameters')?.namedChildren.some(p =>
            p.childForFieldName('name')?.text === identifier.text)) { shadowed = true; break; }
        }
        if (!shadowed && !references.some(r => r.file === file && r.name === identifier.text)) {
          if (references.length >= MAX_REFERENCES) return new Map();
          references.push({ file, name: identifier.text });
        }
      }
    }
    for (const reference of references) {
      if (Date.now() >= deadline) return new Map();
      const target = resolve(reference.file, reference.name);
      if (!target) continue;
      admit(target);
      if (target.kind !== 'struct' && target.kind !== 'enum') continue;
      const visible = visibleFiles(reference.file);
      if (!visible) continue;
      // Inventory every visible file BEFORE allocation and candidate filtering.
      const all = visible.map(inventory);
      if (all.some(data => !data)) continue;
      const ownNames = new Set(all[0]!.definitions.map(n => n.name));
      const aliases = all.flatMap((data, i) => data!.aliases.filter(a => i === 0 || !ownNames.has(a.node.name)));
      const matching = aliases.filter(alias => alias.members.some(member =>
        resolve(alias.node.filePath, member)?.id === target.id));
      if (matching.length === 1 && !matching[0]!.generic
          && resolve(reference.file, matching[0]!.node.name)?.id === matching[0]!.node.id) admit(matching[0]!.node);
    }
    return Date.now() < deadline ? result : new Map();
  } catch {
    return new Map();
  } finally {
    try { for (const data of inventories.values()) data?.tree.delete(); } finally { parser?.reset(); }
  }
}
