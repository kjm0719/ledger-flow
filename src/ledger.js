import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new AppError(status, code, message); };
export function createLedger(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      opening_balance INTEGER NOT NULL CHECK(opening_balance >= 0),
      balance INTEGER NOT NULL CHECK(balance >= 0)
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      sender_id TEXT NOT NULL REFERENCES wallets(id),
      recipient_id TEXT NOT NULL REFERENCES wallets(id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      memo TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(sender_id <> recipient_id)
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      transfer_id TEXT NOT NULL REFERENCES transfers(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      delta INTEGER NOT NULL CHECK(delta <> 0),
      UNIQUE(transfer_id, wallet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers(recipient_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_time ON transfers(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_wallet ON entries(wallet_id);
    CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN
      SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN
      SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS transfers_no_update BEFORE UPDATE ON transfers BEGIN
      SELECT RAISE(ABORT, 'transfers are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS transfers_no_delete BEFORE DELETE ON transfers BEGIN
      SELECT RAISE(ABORT, 'transfers are immutable'); END;
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const seed = db.prepare('INSERT OR IGNORE INTO wallets VALUES (?, ?, ?, ?)');
    seed.run('alice', '앨리스 · 구매자', 100000, 100000);
    seed.run('bob', '밥 · 판매자', 50000, 50000);
    seed.run('carol', '캐롤 · 파트너', 25000, 25000);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  function transfer(input, key) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail(400, 'INVALID_BODY', 'JSON 객체가 필요합니다.');
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      fail(400, 'INVALID_KEY', 'Idempotency-Key는 영문·숫자·밑줄·하이픈 8~100자여야 합니다.');
    const { senderId, recipientId, amount, memo = '' } = input;
    if (typeof senderId !== 'string' || typeof recipientId !== 'string')
      fail(400, 'INVALID_WALLET', '보내는 지갑과 받는 지갑을 지정하세요.');
    if (senderId === recipientId) fail(400, 'SAME_WALLET', '같은 지갑으로 송금할 수 없습니다.');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000)
      fail(400, 'INVALID_AMOUNT', '금액은 1~1,000,000 사이의 정수 포인트여야 합니다.');
    if (typeof memo !== 'string' || memo.length > 100)
      fail(400, 'INVALID_MEMO', '메모는 100자 이하여야 합니다.');

    // The write reservation covers replay lookup, balances, transfer and both entries.
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM transfers WHERE request_key = ?').get(key);
      if (previous) {
        if (previous.sender_id !== senderId || previous.recipient_id !== recipientId ||
            previous.amount !== amount || previous.memo !== memo)
          fail(409, 'IDEMPOTENCY_CONFLICT', '이미 사용한 요청 키의 내용과 다릅니다. 새 요청 키를 사용하세요.');
        db.exec('COMMIT');
        return { transfer: previous, replayed: true };
      }
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?');
      if (!wallet.get(senderId) || !wallet.get(recipientId))
        fail(404, 'WALLET_NOT_FOUND', '지갑을 찾을 수 없습니다.');
      const changed = db.prepare(
        'UPDATE wallets SET balance = balance - ? WHERE id = ? AND balance >= ?'
      ).run(amount, senderId, amount);
      if (changed.changes !== 1) fail(409, 'INSUFFICIENT_BALANCE', '잔액이 부족합니다.');
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE id = ?').run(amount, recipientId);
      const id = randomUUID();
      db.prepare('INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, key, senderId, recipientId, amount, memo, new Date().toISOString());
      const entry = db.prepare('INSERT INTO entries(transfer_id, wallet_id, delta) VALUES (?, ?, ?)');
      entry.run(id, senderId, -amount);
      entry.run(id, recipientId, amount);
      const result = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
      db.exec('COMMIT');
      return { transfer: result, replayed: false };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function wallets() { return db.prepare('SELECT * FROM wallets ORDER BY id').all(); }
  function list({ walletId = '', limit = 10, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 1000000)
      fail(400, 'INVALID_PAGE', 'limit은 1~100, offset은 0~1,000,000 정수여야 합니다.');
    if (walletId && !db.prepare('SELECT id FROM wallets WHERE id = ?').get(walletId))
      fail(404, 'WALLET_NOT_FOUND', '지갑을 찾을 수 없습니다.');
    const where = walletId ? 'WHERE sender_id = ? OR recipient_id = ?' : '';
    const params = walletId ? [walletId, walletId] : [];
    return {
      items: db.prepare(`SELECT * FROM transfers ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset),
      total: db.prepare(`SELECT count(*) AS n FROM transfers ${where}`).get(...params).n,
      limit, offset
    };
  }
  function audit() {
    db.exec('BEGIN');
    try {
      const balances = db.prepare(`SELECT w.id, w.balance,
        w.opening_balance + COALESCE(SUM(e.delta), 0) AS expected
        FROM wallets w LEFT JOIN entries e ON e.wallet_id = w.id GROUP BY w.id`).all();
      const malformed = db.prepare(`SELECT t.id FROM transfers t LEFT JOIN entries e ON e.transfer_id = t.id
        GROUP BY t.id HAVING COUNT(e.id) <> 2 OR COALESCE(SUM(e.delta), 0) <> 0
        OR SUM(CASE WHEN e.wallet_id = t.sender_id AND e.delta = -t.amount THEN 1 ELSE 0 END) <> 1
        OR SUM(CASE WHEN e.wallet_id = t.recipient_id AND e.delta = t.amount THEN 1 ELSE 0 END) <> 1`).all();
      const total = db.prepare('SELECT SUM(balance) AS current, SUM(opening_balance) AS initial FROM wallets').get();
      const transferCount = db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n;
      const entryCount = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
      db.exec('COMMIT');
      return { ok: balances.every(w => w.balance === w.expected) && !malformed.length && total.current === total.initial,
        wallets: balances, malformedTransfers: malformed, total, transferCount, entryCount, checkedAt: new Date().toISOString() };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { transfer, wallets, list, audit, close: () => db.close() };
}
