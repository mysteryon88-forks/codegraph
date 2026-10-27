import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { NodeKind } from '../../types';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/** Persisted in ref candidates, so retries and resolver workers see the same lexical evidence. */
export type TolkExpression =
  | { type: string; afterMethods?: readonly { readonly type: string; readonly name: string }[] }
  | { name: string; receiver?: TolkExpression; blocked?: boolean }
  | { call: TolkExpression }
  | { field: string; receiver: TolkExpression }
  | { unknown: true };

const UNKNOWN: TolkExpression = { unknown: true };
const field = (node: SyntaxNode, name: string) => node.childForFieldName(name);
const text = (node: SyntaxNode | null | undefined) => node?.text ?? '';
const functionTypes = new Set(['function_declaration', 'method_declaration', 'get_method_declaration']);
const kinds: Record<string, NodeKind> = {
  struct_declaration: 'struct', struct_field_declaration: 'field',
  enum_declaration: 'enum', enum_member_declaration: 'enum_member',
  type_alias_declaration: 'type_alias', constant_declaration: 'constant',
  global_var_declaration: 'variable', contract_declaration: 'class', contract_field: 'field',
};

function expression(node: SyntaxNode | null, bindings: Map<string, TolkExpression>, depth = 0): TolkExpression {
  if (!node || depth > 24) return UNKNOWN;
  if (node.type === 'generic_instantiation') return expression(field(node, 'expr'), bindings, depth + 1);
  if (node.type === 'identifier') return bindings.get(node.text) ?? { type: node.text };
  if (node.type === 'object_literal') return field(node, 'type') ? { type: text(field(node, 'type')) } : UNKNOWN;
  if (node.type === 'function_call') return { call: callee(field(node, 'callee'), bindings, depth + 1) };
  if (node.type === 'dot_access') return { field: text(field(node, 'field')), receiver: expression(field(node, 'obj'), bindings, depth + 1) };
  if (node.type === 'parenthesized_expression' || node.type === 'not_null_operator') return expression(field(node, 'inner'), bindings, depth + 1);
  if (node.type === 'lazy_expression') return expression(field(node, 'argument'), bindings, depth + 1);
  return UNKNOWN;
}

function callee(node: SyntaxNode | null, bindings: Map<string, TolkExpression>, depth = 0): TolkExpression {
  if (!node || depth > 24) return UNKNOWN;
  if (node.type === 'generic_instantiation') return callee(field(node, 'expr'), bindings, depth + 1);
  if (node.type === 'identifier') return { name: node.text, blocked: bindings.has(node.text) };
  if (node.type === 'dot_access') return { name: text(field(node, 'field')), receiver: expression(field(node, 'obj'), bindings, depth + 1) };
  return UNKNOWN;
}

function callName(node: SyntaxNode | null): string {
  if (!node) return '<unknown>';
  if (node.type === 'generic_instantiation') return callName(field(node, 'expr'));
  return node.text;
}

function eraseTypeParameters(expr: TolkExpression, names: ReadonlySet<string>): TolkExpression {
  if ('type' in expr) return names.has(expr.type) || expr.afterMethods?.some(p => names.has(p.type)) ? UNKNOWN : expr;
  if ('name' in expr) return !expr.receiver && names.has(expr.name) ? UNKNOWN
    : { ...expr, ...(expr.receiver ? { receiver: eraseTypeParameters(expr.receiver, names) } : {}) };
  if ('call' in expr) return { call: eraseTypeParameters(expr.call, names) };
  if ('field' in expr) return { ...expr, receiver: eraseTypeParameters(expr.receiver, names) };
  return expr;
}

function invalidateBinding(name: string, scope: Map<string, TolkExpression>, ancestors: Map<string, TolkExpression>[], narrowingOrigins: WeakMap<TolkExpression, TolkExpression>): void {
  const previous = scope.get(name);
  if (!previous) return;
  const invalidated = { ...UNKNOWN };
  scope.set(name, invalidated);
  const origin = previous && (narrowingOrigins.get(previous) ?? previous);
  for (const parent of ancestors) {
    const inherited = parent.get(name);
    if (inherited && (narrowingOrigins.get(inherited) ?? inherited) === origin) parent.set(name, invalidated);
  }
}

function lvalueNames(node: SyntaxNode | null): Set<string> {
  const names = new Set<string>();
  const pending = node ? [node] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.type === 'identifier') names.add(current.text);
    else if (current.type === 'parenthesized_expression' || current.type === 'not_null_operator') {
      const inner = field(current, 'inner');
      if (inner) pending.push(inner);
    } else if (current.type === 'tensor_expression' || current.type === 'typed_tuple') {
      for (const child of current.namedChildren) pending.push(child);
    }
  }
  return names;
}

function requireMethod(name: string, method: string, scope: Map<string, TolkExpression>, ancestors: Map<string, TolkExpression>[], narrowingOrigins: WeakMap<TolkExpression, TolkExpression>): void {
  const current = scope.get(name);
  if (!current || !('type' in current) || !narrowingOrigins.has(current)) return;
  const origin = narrowingOrigins.get(current)!;
  const proof = { type: current.type, name: method };
  const updates: [Map<string, TolkExpression>, TolkExpression][] = [];
  for (const bindings of [scope, ...ancestors]) {
    const inherited = bindings.get(name);
    if (!inherited || !('type' in inherited) || narrowingOrigins.get(inherited) !== origin) continue;
    const previous = inherited.afterMethods ?? [];
    const afterMethods = previous.some(p => p.type === proof.type && p.name === proof.name) ? previous : [...previous, proof];
    if (afterMethods.length > 16 || JSON.stringify(afterMethods).length > 1024) {
      invalidateBinding(name, scope, ancestors, narrowingOrigins);
      return;
    }
    updates.push([bindings, { ...inherited, afterMethods }]);
  }
  // Replace snapshots so later calls cannot alter evidence already persisted for earlier references or returns.
  for (const [bindings, updated] of updates) {
    narrowingOrigins.set(updated, origin);
    bindings.set(name, updated);
  }
}

function walkBody(node: SyntaxNode, ctx: ExtractorContext, owner: string, bindings: Map<string, TolkExpression>, returns: TolkExpression[] = [], parents: Map<string, TolkExpression>[] = [], typeParameters: ReadonlySet<string> = new Set(), narrowingOrigins = new WeakMap<TolkExpression, TolkExpression>()): void {
  if (functionTypes.has(node.type)) return;
  const scope = ['block_statement', 'match_expression', 'match_arm', 'catch_clause'].includes(node.type) ? new Map(bindings) : bindings;
  const ancestors = scope === bindings ? parents : [...parents, bindings];
  if (node.type === 'catch_clause') {
    const code = field(node, 'catch_var1'), value = field(node, 'catch_var2');
    if (code) scope.set(code.text, { type: 'int' });
    if (value) scope.set(value.text, { ...UNKNOWN });
  }
  if (node.type === 'match_arm') {
    const match = node.parent?.parent;
    const subject = match?.type === 'match_expression' ? field(match, 'expr') : null;
    const pattern = field(node, 'pattern_type');
    if (subject?.type === 'identifier' && scope.has(subject.text) && pattern?.type === 'type_identifier' && /^[A-Za-z_]\w*$/.test(pattern.text)) {
      const previous = scope.get(subject.text);
      const narrowed = { type: pattern.text };
      if (previous) narrowingOrigins.set(narrowed, narrowingOrigins.get(previous) ?? previous);
      scope.set(subject.text, narrowed);
    }
  }
  if (node.type === 'lambda_expression') {
    const local = new Map(scope);
    for (const param of field(node, 'parameters')?.namedChildren ?? []) {
      const name = field(param, 'name');
      if (name) local.set(name.text, field(param, 'type') ? { type: text(field(param, 'type')) } : { ...UNKNOWN });
    }
    const body = field(node, 'body');
    if (body) walkBody(body, ctx, owner, local, [], [...ancestors, scope], typeParameters, narrowingOrigins);
    return;
  }
  if (node.type === 'return_statement') returns.push(eraseTypeParameters(expression(field(node, 'body'), scope), typeParameters));
  if (node.type === 'function_call') {
    const target = field(node, 'callee');
    ctx.addUnresolvedReference({
      fromNodeId: owner, referenceName: callName(target), referenceKind: 'calls',
      filePath: ctx.filePath, language: 'tolk', line: node.startPosition.row + 1, column: node.startPosition.column,
      candidates: ['tolk:' + JSON.stringify(eraseTypeParameters(callee(target, scope), typeParameters))],
    });
  }
  if (node.type === 'var_declaration_lhs' || (node.type === 'assignment' && field(node, 'left')?.type === 'var_declaration_lhs')) {
    const lhs = (node.type === 'var_declaration_lhs' ? node : field(node, 'left'))?.namedChild(0);
    const value = node.type === 'assignment' ? field(node, 'right') : null;
    if (value) walkBody(value, ctx, owner, scope, returns, ancestors, typeParameters, narrowingOrigins);
    const bind = (decl: SyntaxNode): void => {
      if (decl.type === 'var_declaration') {
        const type = field(decl, 'type');
        // A shadow is a new binding even when its initializer names the outer binding.
        scope.set(text(field(decl, 'name')), type ? { type: type.text } : { ...(lhs?.type === 'var_declaration' ? expression(value, scope) : UNKNOWN) });
      } else for (const child of decl.namedChildren) bind(child);
    };
    if (lhs) bind(lhs);
    return;
  }
  if (node.type === 'assignment' || node.type === 'set_assignment') {
    // An assigned value may change in a conditional: discard inference rather than guess a later receiver.
    for (const name of lvalueNames(field(node, 'left'))) invalidateBinding(name, scope, ancestors, narrowingOrigins);
  }
  for (const child of node.namedChildren) walkBody(child, ctx, owner, scope, returns, ancestors, typeParameters, narrowingOrigins);
  if (node.type === 'function_call') {
    let target = field(node, 'callee');
    while (target?.type === 'generic_instantiation') target = field(target, 'expr');
    if (target?.type === 'dot_access') {
      let receiver = field(target, 'obj');
      while (receiver && (receiver.type === 'parenthesized_expression' || receiver.type === 'not_null_operator')) receiver = field(receiver, 'inner');
      if (receiver?.type === 'identifier') requireMethod(receiver.text, text(field(target, 'field')), scope, ancestors, narrowingOrigins);
    }
    // Explicit mutation may widen a guard, but only after this call's arguments are evaluated.
    for (const arg of field(node, 'arguments')?.namedChildren ?? []) {
      if (arg.type !== 'call_argument' || !arg.children.some(child => child.type === 'mutate')) continue;
      for (const name of lvalueNames(field(arg, 'expr'))) {
        const current = scope.get(name);
        if (current && narrowingOrigins.has(current)) invalidateBinding(name, scope, ancestors, narrowingOrigins);
      }
    }
  }
}

function visitDeclaration(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = field(node, 'name');
  if (node.type === 'import_directive') {
    const path = text(field(node, 'path')).slice(1, -1);
    const imported = ctx.createNode('import', path, node, { signature: node.text });
    if (imported) ctx.addUnresolvedReference({ fromNodeId: imported.id, referenceName: path, referenceKind: 'imports',
      filePath: ctx.filePath, language: 'tolk', line: node.startPosition.row + 1, column: node.startPosition.column });
    return;
  }
  if (!name || (!functionTypes.has(node.type) && !kinds[node.type])) {
    for (const child of node.namedChildren) visitDeclaration(child, ctx);
    return;
  }
  const body = field(node, 'body') ?? field(node, 'asm_body');
  const receiver = text(field(field(node, 'receiver') ?? node, 'receiver_type'));
  const decorators = field(node, 'annotations')?.namedChildren.map(a => a.text) ?? [];
  if (node.type === 'get_method_declaration') decorators.push('tolk:getter');
  if (node.type === 'contract_declaration') decorators.push('tolk:contract');
  if (receiver) decorators.push('tolk:receiver:' + receiver);
  if (/^on(?:InternalMessage|ExternalMessage|BouncedMessage|RunTickTock|SplitPrepare|SplitInstall)$/.test(name.text)) decorators.push('tolk:entrypoint');
  const symbol = ctx.createNode(functionTypes.has(node.type) ? receiver ? 'method' : 'function' : kinds[node.type]!, name.text, node, {
    signature: ctx.source.slice(node.startIndex, body?.startIndex ?? node.endIndex).trim(),
    returnType: text(field(node, 'return_type')) || undefined,
    typeParameters: field(node, 'type_parameters')?.namedChildren.map(p => text(field(p, 'name'))),
    decorators: decorators.length ? decorators : undefined,
    ...(receiver ? { qualifiedName: `${ctx.filePath}::${receiver}::${name.text}` } : {}),
  });
  if (!symbol) return;
  ctx.pushScope(symbol.id);
  if (functionTypes.has(node.type)) {
    const bindings = new Map<string, TolkExpression>();
    for (const param of field(node, 'parameters')?.namedChildren ?? []) {
      const paramName = field(param, 'name');
      if (!paramName) continue;
      const type = text(field(param, 'type')) || (paramName.text === 'self' ? receiver : '');
      bindings.set(paramName.text, type ? { type } : { ...UNKNOWN });
      ctx.createNode('parameter', paramName.text, param, { signature: param.text });
    }
    const returns: TolkExpression[] = [];
    if (body) walkBody(body, ctx, symbol.id, bindings, returns, [], new Set(symbol.typeParameters));
    if (!symbol.returnType && returns.length > 0) {
      (symbol.decorators ??= []).push('tolk:returns:' + JSON.stringify(returns.length <= 16 ? returns : [UNKNOWN]));
    }
  } else if (body) for (const child of body.namedChildren) visitDeclaration(child, ctx);
  ctx.popScope();
}

export const tolkExtractor: LanguageExtractor = {
  functionTypes: [], classTypes: [], methodTypes: [], interfaceTypes: [], structTypes: [], enumTypes: [],
  typeAliasTypes: [], importTypes: [], callTypes: [], variableTypes: [],
  nameField: 'name', bodyField: 'body', paramsField: 'parameters',
  visitNode(node, ctx) {
    if (node.type !== 'source_file') return false;
    for (const child of node.namedChildren) visitDeclaration(child, ctx);
    return true;
  },
};
