import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { openLibTVCanvasBridge } from '../scripts/libtv_canvas_bridge.mjs';

test('one framed process saves concurrent receipts, drains large responses and preserves failed PUTs', async t => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'storyboard-workbench/tests/canvas-bridge-'));
  const args = { nodeExecutable: process.execPath, assetsScript: path.resolve('storyboard-workbench/scripts/libtv_assets.mjs'), directory };
  let child, lines, drains = 0;
  const nextFrame = async () => {
    let output = '';
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error('CLI exited before end of frame');
      output += value + '\n';
      if (value === '~END' || value === '~MORE') return { output, session_id: 1 };
    }
  };
  const execCommand = async () => {
    child = spawn(args.nodeExecutable, [args.assetsScript, 'receipts', '--canvas-stdio', directory, directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    return nextFrame();
  };
  const writeStdin = async ({ chars }) => {
    if (chars.includes('"drain"')) drains++;
    child.stdin.write(chars);
    return nextFrame();
  };
  t.after(() => {
    if (child && child.exitCode === null) child.kill();
    for (const name of ['A.ticket.json', 'B.ticket.json']) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  const local = await openLibTVCanvasBridge({ ...args, execCommand, writeStdin });
  const exit = once(child, 'exit');
  try {
    const value = { status: 'completed', text: '双空格  与正文🎬'.repeat(512) };
    const [a, b] = await Promise.all(['A', 'B'].map(id => local.bridge({ operation: 'write', key: id + '.ticket', value, exclusive: true })));
    const snapshot = await local.bridge({ operation: 'snapshot' });
    assert.deepEqual(snapshot.receipts, { 'A.ticket': a.receipt, 'B.ticket': b.receipt });
    assert.ok(drains > 1);
    await assert.rejects(local.transfer({ id: 'A' }, {}), /文件身份/);
    assert.deepEqual(await local.bridge({ operation: 'read', key: 'A.ticket' }), a.receipt);
  } finally {
    await local.close();
    assert.deepEqual(await exit, [0, null]);
  }
});
