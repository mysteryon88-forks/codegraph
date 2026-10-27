import * as path from 'path';
import { createHash } from 'crypto';
import type { Node } from '../types';
import type { TolkExpression } from '../extraction/languages/tolk';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { validatePathWithinRoot } from '../utils';

function readTolkConfig(config: string, context: ResolutionContext): string | null {
  return validatePathWithinRoot(context.getProjectRoot(), config) === null ? null : context.readFile(config);
}

export function tolkMappingFingerprint(files: string[], context: ResolutionContext): string {
  const configs = new Set<string>();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    for (;;) {
      configs.add(path.posix.join(dir, 'Acton.toml'));
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
  }
  const hash = createHash('sha256');
  for (const config of [...configs].sort()) hash.update(JSON.stringify([config, readTolkConfig(config, context)]));
  return hash.digest('hex');
}

/** Local, single-line TOML strings only; unsupported values never become guessed paths. */
function mappingValue(source: string, key: string): string | null {
  let active = false;
  let answer: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { active = /^\s*\[import-mappings\]\s*(?:#.*)?$/.test(line); continue; }
    if (!active || /^\s*(?:#|$)/.test(line)) continue;
    const pair = line.match(/^\s*(?:([\w-]+)|"([^"\\]+)"|'([^']+)')\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    // Unsupported syntax invalidates the table, including duplicates/escapes/inline tables.
    if (!pair) return null;
    const name = (pair[1] ?? pair[2] ?? pair[3] ?? '').replace(/^@/, '');
    if (name === key) {
      if (answer !== null) return null;
      answer = pair[4] ?? pair[5] ?? '';
    }
  }
  return answer;
}

export function resolveTolkImport(specifier: string, from: string, context: ResolutionContext): string | null {
  if (!specifier || specifier.startsWith('@stdlib/') || /[\x00-\x1f\\]/.test(specifier) || path.posix.isAbsolute(specifier) || /^[A-Za-z]:/.test(specifier)) return null;
  let base = path.posix.dirname(from);
  let relative = specifier;
  if (specifier.startsWith('@')) {
    const slash = specifier.indexOf('/');
    const key = specifier.slice(1, slash < 0 ? undefined : slash);
    let dir = base;
    let found = false;
    for (;;) {
      const config = path.posix.join(dir, 'Acton.toml');
      // Config need not be indexed, but its real path must remain inside the project.
      const source = readTolkConfig(config, context);
      if (source !== null) {
        const mapping = mappingValue(source, key);
        if (mapping === null || path.posix.isAbsolute(mapping) || /^[A-Za-z]:/.test(mapping) || /[\\\x00-\x1f]/.test(mapping)) return null;
        base = dir;
        relative = path.posix.join(mapping, slash < 0 ? '' : specifier.slice(slash + 1));
        found = true;
        break;
      }
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
    if (!found) return null;
  }
  const target = path.posix.normalize(path.posix.join(base, relative.replace(/\.tolk$/, '') + '.tolk'));
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) return null;
  return context.getNodesInFile(target).some(n => n.kind === 'file' && n.language === 'tolk') ? target : null;
}

function scope(file: string, context: ResolutionContext): Node[] {
  const own = context.getNodesInFile(file).filter(n => n.language === 'tolk');
  const files = new Set(own.filter(n => n.kind === 'import').map(n => resolveTolkImport(n.name, file, context)).filter((f): f is string => f !== null));
  return [...own, ...[...files].flatMap(f => context.getNodesInFile(f).filter(n => n.language === 'tolk' &&
    !n.decorators?.some(d => d === 'tolk:entrypoint' || d === 'tolk:getter')))];
}

const unique = <T>(nodes: T[]): T | null => nodes.length === 1 ? nodes[0]! : null;
const receiverOf = (node: Node) => node.decorators?.find(d => d.startsWith('tolk:receiver:'))?.slice('tolk:receiver:'.length);

function typeIdentity(type: string, file: string, context: ResolutionContext): string | null {
  // shortcut: composite/generic type inference is unresolved; add compiler-backed substitution before widening it.
  if (!/^[A-Za-z_][\w]*$/.test(type)) return null;
  if (/^(?:int|bool|cell|slice|builder|tuple|address|coins|bits\d+|bytes\d+|u?int\d+)$/.test(type)) return 'builtin:' + type;
  const defs = scope(file, context).filter(n => n.name === type && (n.kind === 'struct' || n.kind === 'enum' || n.kind === 'type_alias'));
  return unique(defs)?.id ?? null;
}

interface ReturnInference {
  active: Set<string>;
  memo: Map<string, string | null>;
  remaining: number;
}

function resultType(expr: TolkExpression, file: string, context: ResolutionContext, depth: number, inference: ReturnInference): string | null {
  if (depth > 24 || --inference.remaining < 0) return null;
  if ('type' in expr) {
    for (const proof of expr.afterMethods ?? []) {
      if (!target({ name: proof.name, receiver: { type: proof.type } }, file, context, depth + 1, inference)) return null;
    }
    return typeIdentity(expr.type, file, context);
  }
  if ('call' in expr) {
    const fn = target(expr.call, file, context, depth + 1, inference);
    if (fn?.returnType) return fn.typeParameters?.includes(fn.returnType) ? null : typeIdentity(fn.returnType, fn.filePath, context);
    if (fn) {
      if (inference.active.has(fn.id)) return null;
      if (inference.memo.has(fn.id)) return inference.memo.get(fn.id)!;
      const returns = fn.decorators?.find(d => d.startsWith('tolk:returns:'));
      if (!returns) return null;
      inference.active.add(fn.id);
      try {
        const expressions = JSON.parse(returns.slice('tolk:returns:'.length)) as TolkExpression[];
        const types = expressions.map(e => resultType(e, fn.filePath, context, depth + 1, inference));
        const type = types.length > 0 && types[0] !== null && types.every(t => t === types[0]) ? types[0]! : null;
        inference.memo.set(fn.id, type);
        return type;
      } catch { return null; }
      finally { inference.active.delete(fn.id); }
    }
    // Tolk's automatic deserializers return the named type; a user method suppresses this intrinsic.
    if ('name' in expr.call && !expr.call.blocked && ['fromCell', 'fromSlice'].includes(expr.call.name) &&
        expr.call.receiver && 'type' in expr.call.receiver) {
      const identity = resultType(expr.call.receiver, file, context, depth + 1, inference);
      if (identity && !identity.startsWith('builtin:') && !scope(file, context).some(n => n.kind === 'method' &&
          n.name === ('name' in expr.call ? expr.call.name : '') && receiverOf(n) !== undefined &&
          typeIdentity(receiverOf(n)!, n.filePath, context) === identity)) return identity;
    }
    return null;
  }
  if ('field' in expr) {
    const owner = resultType(expr.receiver, file, context, depth + 1, inference);
    const type = owner && context.getNodeById?.(owner);
    if (!type) return null;
    const member = unique(context.getNodesInFile(type.filePath).filter(n => n.kind === 'field' && n.name === expr.field &&
      n.qualifiedName === `${type.qualifiedName}::${expr.field}`));
    const declared = member?.signature?.match(/^[^:]+:\s*([A-Za-z_]\w*)\s*$/)?.[1];
    return declared ? typeIdentity(declared, type.filePath, context) : null;
  }
  return null;
}

function target(expr: TolkExpression, file: string, context: ResolutionContext, depth = 0,
  inference: ReturnInference = { active: new Set(), memo: new Map(), remaining: 256 }): Node | null {
  if (depth > 24 || --inference.remaining < 0 || !('name' in expr) || expr.blocked) return null;
  const visible = scope(file, context);
  if (!expr.receiver) return unique(visible.filter(n => n.name === expr.name && n.kind === 'function'));
  const type = resultType(expr.receiver, file, context, depth + 1, inference);
  if (!type) return null;
  return unique(visible.filter(n => n.name === expr.name && n.kind === 'method' &&
    receiverOf(n) !== undefined && typeIdentity(receiverOf(n)!, n.filePath, context) === type));
}

/** Terminal strategy: no Tolk ref reaches fuzzy lookup, framework fallbacks or deferred chains. */
export function resolveTolkReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let node: Node | null = null;
  if (ref.referenceKind === 'imports') {
    const file = resolveTolkImport(ref.referenceName, ref.filePath, context);
    if (file) node = context.getNodesInFile(file).find(n => n.kind === 'file' && n.language === 'tolk') ?? null;
  } else if (ref.referenceKind === 'calls') {
    const encoded = ref.candidates?.find(c => c.startsWith('tolk:'));
    if (!encoded) return null;
    try { node = target(JSON.parse(encoded.slice(5)) as TolkExpression, ref.filePath, context); }
    catch { return null; }
  }
  return node ? { original: ref, targetNodeId: node.id, confidence: 1,
    resolvedBy: ref.referenceKind === 'imports' ? 'file-path' : 'exact-match',
    metadata: { tolkCandidates: ref.candidates, tolkScope: 'same-file-or-direct-import' } } : null;
}
