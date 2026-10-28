import type { Parser, Tree } from 'web-tree-sitter';
import type { Node } from '../types';
import type { ExploreLineRange } from './explore-session-state';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { MAX_PARSE_BYTES } from '../graph/branch-guards';

const CALLABLE_TYPES = ['function_declaration', 'method_declaration', 'get_method_declaration', 'lambda_expression'];

interface TolkArmEvidence {
  name: string;
  arm: ExploreLineRange;
  context: ExploreLineRange[];
}

/** Actual named arms inside selected callables; the caller has already checked source freshness. */
export async function namedTolkArmRanges(
  source: string,
  callables: readonly Pick<Node, 'name' | 'startLine' | 'endLine'>[],
  tokens: readonly string[],
): Promise<TolkArmEvidence[]> {
  const names = new Set(tokens.filter(t => /^[A-Za-z_]\w*$/.test(t)));
  if (names.size === 0 || callables.length === 0 || Buffer.byteLength(source, 'utf8') > MAX_PARSE_BYTES) return [];
  let parser: Parser | null = null;
  let tree: Tree | null = null;
  try {
    await loadGrammarsForLanguages(['tolk']);
    parser = getParser('tolk');
    if (!parser) return [];
    // Cached parsers otherwise resume a previous request's interrupted input.
    parser.reset();
    tree = parseWithinBudget(parser, source);
    if (!tree || tree.rootNode.hasError) return [];
    const evidence: TolkArmEvidence[] = [];
    for (const fn of tree.rootNode.descendantsOfType(CALLABLE_TYPES)) {
      if (!fn || fn.isMissing) continue;
      const start = fn.startPosition.row + 1, end = fn.endPosition.row + 1;
      const selected = callables.find(n => n.startLine === start && n.endLine === end && n.name === fn.childForFieldName('name')?.text);
      if (!selected) continue;
      for (const arm of fn.descendantsOfType('match_arm')) {
        const pattern = arm?.childForFieldName('pattern_type');
        if (!arm || !pattern || pattern.isMissing || !names.has(pattern.text)) continue;
        let host = arm.parent;
        while (host && !CALLABLE_TYPES.includes(host.type)) host = host.parent;
        if (host?.id !== fn.id) continue;
        evidence.push({
          name: pattern.text,
          arm: { start: Math.max(start, arm.startPosition.row + 1), end: Math.min(end, arm.endPosition.row + 1) },
          context: [
            { start, end: Math.min(end, start + 4) },
            { start: Math.max(start, end - 4), end },
          ],
        });
      }
    }
    return evidence;
  } catch {
    return [];
  } finally {
    try { tree?.delete(); } finally { parser?.reset(); }
  }
}
