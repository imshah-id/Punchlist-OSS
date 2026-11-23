// A file another program holds for a moment is tried again before a write is reported as failed. The lock is a
// stand-in: the fs call on the held file throws what Windows answers for a file another program has open.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeFolder, BUSY_WAITS } from '../../src/backend/nodeFolder';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-busy-')); dirs.push(d); return d; };
const held = (code: string, call: string) => Object.assign(new Error(`${code}: resource busy or locked, ${call}`), { code });
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** Make `call` on a path ending in `name` throw `code` while `locked()` says so; returns how often it was refused. */
function lock(call: 'openSync' | 'renameSync' | 'writeFileSync' | 'writeSync', name: string, code: string, locked: () => boolean) {
  const real = (fs as any)[call].bind(fs); const count = { refused: 0, tried: 0 };
  vi.spyOn(fs, call as any).mockImplementation((...a: any[]) => {
    const on = call === 'renameSync' ? a[1] : a[0];
    if (call === 'writeSync' || String(on).endsWith(name)) { count.tried++; if (locked()) { count.refused++; throw held(code, call); } }
    return real(...a);
  });
  return count;
}

describe('a folder on disk, when a file is held by another program', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) it(`appends once the change file is let go (${code}): the line is written once`, () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1, 1, 1]); let left = 3;
    const n = lock('openSync', 'changes.jsonl', code, () => left-- > 0);
    f.append('changes.jsonl', 'one\n');
    expect(n.refused).toBe(3); expect(fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8')).toBe('one\n');
  });

  it('a change file held for 300 ms is appended to at the first save, with the waits the app ships with', () => {
    const dir = tmp(); const f = nodeFolder(dir); const until = Date.now() + 300;
    const n = lock('openSync', 'changes.jsonl', 'EBUSY', () => Date.now() < until);
    f.append('changes.jsonl', 'one\n');
    expect(n.refused).toBeGreaterThan(0); expect(fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8')).toBe('one\n');
    expect(BUSY_WAITS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);            // "over a second or so"
    expect(BUSY_WAITS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500);
  });

  it('gives up on a file that stays held, having tried once per wait and once more, and nothing is written', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1, 1]);
    const n = lock('openSync', 'changes.jsonl', 'EBUSY', () => true);
    expect(() => f.append('changes.jsonl', 'one\n')).toThrow(/EBUSY/);
    expect(n.tried).toBe(4); expect(fs.existsSync(path.join(dir, 'changes.jsonl'))).toBe(false);
  });

  it('replaces the journal once it is let go: the rename refused once (EPERM), then the new text is there whole', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1]); f.write('ops.json', '{"old":1}'); let left = 1;
    const n = lock('renameSync', 'ops.json', 'EPERM', () => left-- > 0);
    f.write('ops.json', '{"new":2}');
    expect(n.refused).toBe(1); expect(f.read('ops.json')).toBe('{"new":2}'); expect(fs.readdirSync(dir)).toEqual(['ops.json']);
  });

  it('shares one retry budget between writing and renaming the working copy', () => {
    const dir = tmp();
    const folder = nodeFolder(dir, [10, 20, 30]);
    folder.write('ops.json', '{"old":1}');
    let writesToRefuse = 2;
    const writes = lock('writeFileSync', 'ops.json.tmp', 'EBUSY', () => writesToRefuse-- > 0);
    const renames = lock('renameSync', 'ops.json', 'EPERM', () => true);
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');

    expect(() => folder.write('ops.json', '{"new":2}')).toThrow(/EPERM/);
    expect(writes.tried).toBe(3);
    expect(renames.tried).toBe(2);
    expect(wait.mock.calls.map(([, , , timeout]) => timeout)).toEqual([10, 20, 30]);
  });

  it('a file written whole is forced to the disk before it replaces the old one, so a power cut leaves one or the other', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1]); f.write('ops.json', '{"old":1}');
    // a disk that keeps only what was flushed: at the rename, the new text must already be on it
    const steps: string[] = []; const sync = fs.fsyncSync.bind(fs), rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { steps.push('flush'); return sync(fd); });
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => { steps.push('rename'); return rename(a, b); });
    f.write('ops.json', '{"new":2}');
    expect(steps).toEqual(['flush', 'rename']); expect(f.read('ops.json')).toBe('{"new":2}');
  });

  it('a journal that stays held keeps its old text and removes the working copy (#213)', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1]); f.write('ops.json', '{"old":1}');
    lock('renameSync', 'ops.json', 'EPERM', () => true);
    expect(() => f.write('ops.json', '{"new":2}')).toThrow(/EPERM/);
    expect(f.read('ops.json')).toBe('{"old":1}');
    expect(fs.readdirSync(dir)).toEqual(['ops.json']);
  });

  it('reports the original replacement error when its working copy cannot be removed (#213)', () => {
    const dir = tmp();
    const folder = nodeFolder(dir, [1]);
    folder.write('ops.json', '{"old":1}');
    lock('renameSync', 'ops.json', 'EPERM', () => true);
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw held('EACCES', 'rmSync');
    });
    expect(() => folder.write('ops.json', '{"new":2}')).toThrow('EPERM: resource busy or locked, renameSync');
    expect(remove).toHaveBeenCalledOnce();
    expect(folder.read('ops.json')).toBe('{"old":1}');
    expect(folder.read('ops.json.tmp')).toBe('{"new":2}');
  });

  it('leaves an earlier working copy when staging its own write fails (#213)', () => {
    const dir = tmp();
    const folder = nodeFolder(dir, [1]);
    folder.write('ops.json', '{"old":1}');
    fs.writeFileSync(path.join(dir, 'ops.json.tmp'), 'earlier working text');
    lock('writeFileSync', 'ops.json.tmp', 'EBUSY', () => true);
    expect(() => folder.write('ops.json', '{"new":2}')).toThrow(/EBUSY/);
    expect(folder.read('ops.json')).toBe('{"old":1}');
    expect(folder.read('ops.json.tmp')).toBe('earlier working text');
  });

  it('the working copy beside the journal held (a scanner on the .tmp) is also waited for', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1]); let left = 2;
    lock('writeFileSync', 'ops.json.tmp', 'EBUSY', () => left-- > 0);
    f.write('ops.json', '{"new":2}'); expect(f.read('ops.json')).toBe('{"new":2}');
  });

  it('a folder that stays refused (read-only for good) is waited for once, then tried once per write for a while', () => {
    const dir = tmp(); const f = nodeFolder(dir, [20, 20, 20]); const n = lock('openSync', 'changes.jsonl', 'EACCES', () => true);
    let at = Date.now(); expect(() => f.append('changes.jsonl', 'one\n')).toThrow(/EACCES/); expect(n.tried).toBe(4); expect(Date.now() - at).toBeGreaterThanOrEqual(55);
    at = Date.now(); expect(() => f.append('changes.jsonl', 'two\n')).toThrow(/EACCES/); expect(n.tried).toBe(5); expect(Date.now() - at).toBeLessThan(20);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);                            // 11 seconds on, it is waited for again
    expect(() => f.append('changes.jsonl', 'three\n')).toThrow(/EACCES/); expect(n.tried).toBe(9);
  });

  it('a folder that is gone is not waited for: it fails at once, tried once', () => {
    const dir = tmp(); const f = nodeFolder(dir); const n = lock('openSync', 'changes.jsonl', 'ENOENT', () => true);
    const at = Date.now(); expect(() => f.append('changes.jsonl', 'one\n')).toThrow(/ENOENT/);
    expect(n.tried).toBe(1); expect(Date.now() - at).toBeLessThan(200);
  });

  it('a write that fails after the file was opened is not made again, so no line is written twice', () => {
    const dir = tmp(); const f = nodeFolder(dir, [1, 1]); const n = lock('writeSync', '', 'EBUSY', () => true);
    expect(() => f.append('changes.jsonl', 'one\n')).toThrow(/EBUSY/); expect(n.tried).toBe(1);
  });
});
