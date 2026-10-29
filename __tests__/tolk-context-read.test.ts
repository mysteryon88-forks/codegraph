import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import * as tolkContext from '../src/mcp/explore-tolk-context';
import { MAX_PARSE_BYTES } from '../src/graph/branch-guards';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

let dir: string;
let cg: CodeGraph | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  cg?.close(); cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it('bounds the actual inventory read when a generated import grows after stat', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-read-race-'));
  fs.mkdirSync(path.join(dir, 'gen'));
  fs.writeFileSync(path.join(dir, 'main.tolk'), 'import "messages"\nimport "gen/Protocol.code"\nfun run(message: Selected) { marker(); }');
  fs.writeFileSync(path.join(dir, 'messages.tolk'), 'struct Selected {}\nfun marker() {}');
  const generated = path.join(dir, 'gen/Protocol.code.tolk');
  fs.writeFileSync(generated, '// @generated\nimport "../messages"\nstruct GeneratedNote { value: int }\n');
  cg = CodeGraph.initSync(dir); await cg.indexAll(); cg.resolveReferences();

  const realStat = fs.statSync, realRead = fs.readFileSync, realReadSync = fs.readSync;
  let active = false, grew = false, bytesRead = 0, callbackRan = false;
  vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    const stat = realStat(...args);
    if (active && String(args[0]) === generated && !grew) {
      fs.appendFileSync(generated, '\n// ' + 'x'.repeat(2 * 1024 * 1024));
      grew = true;
    }
    return stat;
  }) as typeof fs.statSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const data = realRead(...args);
    if (active && String(args[0]) === generated) bytesRead += Buffer.byteLength(data);
    return data;
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = realReadSync(...args);
    if (active) bytesRead += count;
    return count;
  }) as typeof fs.readSync);
  vi.spyOn(tolkContext, 'referencedTolkContext').mockImplementation(async (_graph, _emitted, readFresh) => {
    callbackRan = true; active = true;
    try { expect(readFresh('gen/Protocol.code.tolk', MAX_PARSE_BYTES)).toBeUndefined(); }
    finally { active = false; }
    return new Map();
  });
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'main.tolk run', maxFiles: 2 });
  expect(result.isError).not.toBe(true);
  expect(callbackRan).toBe(true);
  expect(grew).toBe(true);
  expect(bytesRead).toBeLessThanOrEqual(MAX_PARSE_BYTES + 1);
});

function sourceFixture(source = 'struct Payload { value: int }\n') {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tolk-fd-read-'));
  const file = path.join(dir, 'messages.tolk');
  fs.writeFileSync(file, source);
  return { file, source, hash: createHash('sha256').update(source).digest('hex') };
}

it.each(['growth', 'rewrite', 'replacement', 'read error'])(
  'refuses an inventory %s during the descriptor read and closes that descriptor', state => {
    const { file, source, hash } = sourceFixture();
    const realOpen = fs.openSync, realRead = fs.readSync, realFstat = fs.fstatSync;
    let ownedFd: number | undefined, changed = false, bytesRead = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      if (String(args[0]) === file && (args[1] === 'r' || typeof args[1] === 'number')) ownedFd = fd;
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = realFstat(...args);
      if (args[0] === ownedFd && state === 'growth' && !changed) {
        fs.appendFileSync(file, '// ' + 'x'.repeat(2 * 1024 * 1024)); changed = true;
      }
      return stat;
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] === ownedFd && state === 'read error') { changed = true; throw new Error('Read failed'); }
      const count = realRead(...args);
      if (args[0] === ownedFd) {
        bytesRead += count;
        if (!changed && state === 'rewrite') { fs.writeFileSync(file, 'x' + source.slice(1)); changed = true; }
        if (!changed && state === 'replacement') {
          fs.renameSync(file, file + '.old'); fs.writeFileSync(file, source); changed = true;
        }
      }
      return count;
    }) as typeof fs.readSync);
    expect(tolkContext.readFreshTolkSource(dir, 'messages.tolk', MAX_PARSE_BYTES, hash)).toBeUndefined();
    expect(changed).toBe(true);
    expect(ownedFd).toBeDefined();
    expect(bytesRead).toBeLessThanOrEqual(MAX_PARSE_BYTES);
    if (state !== 'read error') expect(bytesRead).toBeGreaterThan(0);
    expect(() => realFstat(ownedFd!)).toThrow();
  },
);

it('reads fresh UTF-8 source through short reads at the byte limit and closes the descriptor', () => {
  const { file, source, hash } = sourceFixture('val label = "Бонус 🌍";\n');
  const size = Buffer.byteLength(source), realRead = fs.readSync, realFstat = fs.fstatSync;
  let fd: number | undefined, bytesRead = 0;
  vi.spyOn(fs, 'readSync').mockImplementation(((descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
    fd = descriptor;
    const count = realRead(descriptor, buffer, offset, Math.min(length, 3), position);
    bytesRead += count;
    return count;
  }) as typeof fs.readSync);
  expect(tolkContext.readFreshTolkSource(dir, path.basename(file), size, hash)).toBe(source);
  expect(bytesRead).toBe(size);
  expect(() => realFstat(fd!)).toThrow();
  bytesRead = 0;
  expect(tolkContext.readFreshTolkSource(dir, 'messages.tolk', size - 1, hash)).toBeUndefined();
  expect(bytesRead).toBe(0);
});

it('fails closed on stale hashes and refuses escaped paths and directories before opening a descriptor', () => {
  const { source, hash } = sourceFixture();
  expect(tolkContext.readFreshTolkSource(dir, 'messages.tolk', MAX_PARSE_BYTES, 'wrong-hash')).toBeUndefined();
  fs.mkdirSync(path.join(dir, 'project'));
  const open = vi.spyOn(fs, 'openSync');
  expect(tolkContext.readFreshTolkSource(path.join(dir, 'project'), '../messages.tolk', MAX_PARSE_BYTES, hash)).toBeUndefined();
  expect(tolkContext.readFreshTolkSource(dir, 'project', MAX_PARSE_BYTES, hash)).toBeUndefined();
  expect(tolkContext.readFreshTolkSource(dir, 'missing.tolk', MAX_PARSE_BYTES, hash)).toBeUndefined();
  expect(tolkContext.readFreshTolkSource(dir, 'messages.tolk', Infinity, hash)).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(dir, 'messages.tolk'), 'utf8')).toBe(source);
});
