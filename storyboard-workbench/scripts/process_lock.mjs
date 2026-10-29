import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const validOwner = value => typeof value === 'string' && value.trim() && value.length <= 500;
const ownerFile = owner => createHash('sha256').update(owner).digest('hex') + '.json';

// Only the owner-record removal winner may remove the empty directory; never reclaim an unverified lock.
export function createProcessLock(filename) {
  const lockPath = path.resolve(filename);
  let heldOwner = null;
  const inspect = () => {
    let stat;
    try { stat = fs.lstatSync(lockPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('旧格式或未知进程锁不能自动恢复', 'LOCK_UNVERIFIED');
    const names = fs.readdirSync(lockPath);
    if (names.length !== 1 || !/^[a-f0-9]{64}\.json$/.test(names[0])) fail('进程锁记录缺失或冲突；停止操作', 'LOCK_UNVERIFIED');
    const recordPath = path.join(lockPath, names[0]);
    if (fs.lstatSync(recordPath).isSymbolicLink()) fail('进程锁记录不能是链接', 'LOCK_UNVERIFIED');
    let value;
    try { value = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
    catch { fail('进程锁记录无法解析；停止操作', 'LOCK_UNVERIFIED'); }
    if (value?.schemaVersion !== 1 || !validOwner(value.owner) || ownerFile(value.owner) !== names[0] || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.hostname !== 'string' || !value.hostname.trim()) fail('进程锁身份无效', 'LOCK_UNVERIFIED');
    return value;
  };
  const removeOwner = owner => {
    // Each owner has a distinct filename, including across concurrent release/recovery attempts.
    try { fs.unlinkSync(path.join(lockPath, ownerFile(owner))); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try { fs.rmdirSync(lockPath); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    if (heldOwner === owner) heldOwner = null;
    return true;
  };
  const assertOwner = (context = {}) => {
    if (context.deadlineAt !== undefined && (!Number.isSafeInteger(context.deadlineAt) || Date.now() >= context.deadlineAt)) fail('进程锁操作期限已过；拒绝晚到回调', 'CALL_TIMEOUT');
    const current = inspect();
    if (!current && context.owner === undefined) return true;
    if (!validOwner(context.owner) || !current || current.owner !== context.owner) fail('进程锁 owner 已变化或缺失；拒绝旧回调', 'LOCK_OWNER_CHANGED');
    return true;
  };
  return {
    inspect,
    assertOwner,
    acquire(context = {}) {
      if (context.deadlineAt !== undefined && (!Number.isSafeInteger(context.deadlineAt) || Date.now() >= context.deadlineAt)) fail('进程锁认领期限已过', 'CALL_TIMEOUT');
      if (context.owner !== undefined && !validOwner(context.owner)) fail('进程锁 owner 无效', 'LOCK_OWNER_INVALID');
      // Caller request IDs may repeat; every acquired ownership token must be fresh.
      const owner = randomUUID();
      const recordPath = path.join(lockPath, ownerFile(owner));
      const record = { schemaVersion: 1, owner, ...(context.owner ? { requestOwner: context.owner } : {}), pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() };
      try { fs.mkdirSync(lockPath); }
      catch (error) { if (error.code === 'EEXIST') fail('原进程锁仍存在，不能重复执行', 'EEXIST'); throw error; }
      try {
        const fd = fs.openSync(recordPath, 'wx');
        try { fs.writeFileSync(fd, JSON.stringify(record) + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        heldOwner = owner;
        return record;
      } catch (error) {
        if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
        fs.rmdirSync(lockPath);
        throw error;
      }
    },
    release(context = {}) {
      const owner = context.owner ?? heldOwner;
      if (!validOwner(owner)) return false;
      const current = inspect();
      if (!current || current.owner !== owner) return false;
      return removeOwner(owner);
    },
    recover({ owner, reason } = {}) {
      if (!validOwner(owner) || typeof reason !== 'string' || !reason.trim()) fail('恢复进程锁须明确原 owner 和理由', 'LOCK_RECOVERY_INVALID');
      const current = inspect();
      if (!current || current.owner !== owner) fail('原进程锁 owner 已变化；不能恢复', 'LOCK_OWNER_CHANGED');
      if (current.hostname !== os.hostname()) fail('无法核实其他主机的进程状态', 'LOCK_UNVERIFIED');
      try { process.kill(current.pid, 0); fail('原进程仍存活；不能按等待时长抢锁', 'LOCK_OWNER_ALIVE'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Recovery never clears a live owner's record, and never unlinks the shared lock path.
      return removeOwner(owner);
    }
  };
}
