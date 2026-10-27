#!/usr/bin/env node
// Explicit build and project only. Existing indices are opened read-only unless --index is supplied.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--index') options.index = true;
  else if (['--build', '--project', '--expect', '--report'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
if (!options.build || !options.project || !options.expect) throw new Error('Usage: verify-tolk.mjs --build /absolute/dist --project /project --expect expectations.json [--report report.json] [--index]');

const build = fs.realpathSync(path.resolve(options.build));
const project = fs.realpathSync(path.resolve(options.project));
const expected = JSON.parse(fs.readFileSync(options.expect, 'utf8'));
if (!Array.isArray(expected.files) || !Array.isArray(expected.symbols)) throw new Error('Expectations require files and symbols arrays');
const require = createRequire(import.meta.url);
const { CodeGraph, isInitialized, getCodeGraphDir } = require(path.join(build, 'index.js'));
const { scanDirectory } = require(path.join(build, 'extraction', 'index.js'));
const { validatePathWithinRoot } = require(path.join(build, 'utils.js'));
const started = performance.now();
let graph;
let indexDurationMs = null;
let indexResult = null;
let report;
try {
  graph = isInitialized(project) ? await CodeGraph.open(project, { readOnly: !options.index })
    : options.index ? CodeGraph.initSync(project) : null;
  if (!graph) throw new Error('No index at the nominated project/CODEGRAPH_DIR; use --index only against an authorized test copy');
  if (options.index) {
    const t = performance.now();
    indexResult = await graph.indexAll();
    graph.resolveReferences();
    indexDurationMs = performance.now() - t;
  }
  const failures = [];
  const files = graph.getFiles();
  const indexed = files.filter(f => f.language === 'tolk').map(f => f.path).sort();
  const discovered = [];
  const pending = [''];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(path.join(project, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules' && !entry.name.startsWith('.codegraph')) pending.push(file);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tolk')) discovered.push(file);
    }
  }
  discovered.sort();
  const scanScope = scanDirectory(project).filter(f => f.toLowerCase().endsWith('.tolk')).sort();
  const missing = discovered.filter(f => !indexed.includes(f));
  for (const f of expected.files) if (!indexed.includes(f)) failures.push(`Missing indexed Tolk file: ${f}`);
  if (expected.exactFiles) for (const f of indexed) if (!expected.files.includes(f)) failures.push(`Unexpected indexed Tolk file: ${f}`);
  const nodes = files.flatMap(f => graph.getNodesInFile(f.path));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = nodes.flatMap(n => graph.getOutgoingEdges(n.id));
  const source = (node) => {
    const file = validatePathWithinRoot(project, node.filePath);
    if (file === null) throw new Error(`Refusing indexed source outside project: ${node.filePath}`);
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(node.startLine - 1, node.endLine).join('\n');
  };
  const symbols = [];
  for (const wanted of expected.symbols) {
    const matches = nodes.filter(n => n.filePath === wanted.file && n.name === wanted.name && n.language === 'tolk' &&
      (wanted.kind === undefined || n.kind === wanted.kind) && (wanted.line === undefined || n.startLine === wanted.line));
    if (matches.length !== 1) { failures.push(`Expected one symbol: ${JSON.stringify(wanted)}; found ${matches.length}`); continue; }
    const node = matches[0];
    const body = source(node);
    if (wanted.source !== undefined && !body.includes(wanted.source)) failures.push(`Source mismatch: ${wanted.file}:${wanted.name}`);
    symbols.push({ ...node, source: body });
  }
  const matchesEdge = (edge, wanted, kind) => {
    const from = byId.get(edge.source), to = byId.get(edge.target);
    return from && to && (!kind || edge.kind === kind) &&
      (wanted.fromFile === undefined || from.filePath === wanted.fromFile) &&
      (wanted.fromName === undefined || from.name === wanted.fromName) &&
      (wanted.toFile === undefined || to.filePath === wanted.toFile) &&
      (wanted.toName === undefined || to.name === wanted.toName) &&
      (wanted.toLanguage === undefined || to.language === wanted.toLanguage);
  };
  for (const [key, kind] of [['calls', 'calls'], ['imports', 'imports']]) {
    for (const wanted of expected[key] ?? []) {
      if (!edges.some(e => matchesEdge(e, wanted, kind))) failures.push(`Missing ${kind} edge: ${JSON.stringify(wanted)}`);
    }
  }
  for (const wanted of expected.forbidden ?? []) {
    if (edges.some(e => matchesEdge(e, wanted, wanted.kind ?? 'calls'))) failures.push(`Forbidden edge: ${JSON.stringify(wanted)}`);
  }
  const tolkRefs = indexed.flatMap(f => graph.getUnresolvedReferencesInFile(f, Number.MAX_SAFE_INTEGER));
  const unresolved = tolkRefs.map(r => ({ ...r, diagnostic: r.referenceKind === 'imports'
    ? 'Import unavailable, external, unsupported mapping syntax, or outside indexed project'
    : 'No unique eligible same-file/direct-import target with supported lexical receiver evidence' }));
  const resolved = edges.filter(e => byId.get(e.source)?.language === 'tolk' && e.kind !== 'contains').map(e => ({
    ...e, from: byId.get(e.source), to: byId.get(e.target),
  }));
  report = { success: failures.length === 0, build, project, indexDirectory: getCodeGraphDir(project),
    discovered, scanScope, indexed, missing, missingReasons: missing.map(file => ({ file, reason: files.find(f => f.path === file)?.errors ??
      (!scanScope.includes(file) ? 'Outside scan scope (ignore/default exclusion); symlinks, node_modules, .git and index directories are not traversed'
        : 'Not indexed; inspect configured includes/excludes, indexResult and file limits') })),
    parseIssues: files.filter(f => f.language === 'tolk' && f.errors?.length).map(f => ({ file: f.path, errors: f.errors })),
    symbols, resolved, unresolved, failures, indexDurationMs, indexResult, verificationDurationMs: performance.now() - started };
} finally { graph?.close(); }
const output = JSON.stringify(report, null, 2) + '\n';
if (options.report) fs.writeFileSync(path.resolve(options.report), output);
process.stdout.write(output);
process.exitCode = report.success ? 0 : 1;
