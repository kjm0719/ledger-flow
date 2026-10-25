import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLedger } from '../src/ledger.js';
import { createApp } from '../src/server.js';

const input = (amount = 1000) => ({ senderId:'alice', recipientId:'bob', amount, memo:'작품 구매' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-flow-test-'));
  const path = join(dir, 'test.sqlite');
  const ledger = createLedger(path);
  t.after(() => { ledger.close(); rmSync(dir, {recursive:true, force:true}); });
  return { ledger, path };
}
test('송금은 두 잔액과 출금·입금 원장을 함께 변경한다', t => {
  const { ledger } = fixture(t);
  const result = ledger.transfer(input(), 'transfer-001');
  assert.equal(result.replayed, false);
  assert.deepEqual(ledger.wallets().map(w => w.balance), [99000,51000,25000]);
  assert.equal(ledger.audit().entryCount, 2);
  assert.equal(ledger.audit().ok, true);
});
test('동일 키·내용 재전송은 기존 거래를 반환한다', t => {
  const { ledger } = fixture(t);
  const first = ledger.transfer(input(), 'transfer-001');
  const second = ledger.transfer(input(), 'transfer-001');
  assert.equal(second.replayed, true);
  assert.equal(second.transfer.id, first.transfer.id);
  assert.equal(ledger.audit().transferCount, 1);
  assert.equal(ledger.wallets()[0].balance, 99000);
});
test('사용한 키의 금액·메모·수취인 변경은 충돌로 거부한다', t => {
  const { ledger } = fixture(t);
  ledger.transfer(input(), 'transfer-001');
  for (const changed of [input(2), {...input(), memo:'변경'}, {...input(), recipientId:'carol'}])
    assert.throws(() => ledger.transfer(changed, 'transfer-001'), { code:'IDEMPOTENCY_CONFLICT' });
  assert.equal(ledger.audit().transferCount, 1);
});
test('잔액 부족은 잔액과 원장을 전혀 변경하지 않는다', t => {
  const { ledger } = fixture(t);
  assert.throws(() => ledger.transfer(input(100001), 'transfer-001'), {code:'INSUFFICIENT_BALANCE'});
  assert.deepEqual(ledger.wallets().map(w => w.balance), [100000,50000,25000]);
  assert.equal(ledger.audit().entryCount, 0);
});
test('금액 경계·자기 송금·존재하지 않는 지갑·잘못된 키를 거부한다', t => {
  const { ledger } = fixture(t);
  for (const amount of [0,-1,1.5,'10',true,null,1000001,NaN,Infinity])
    assert.throws(() => ledger.transfer(input(amount), 'transfer-001'), {code:'INVALID_AMOUNT'});
  assert.throws(() => ledger.transfer({...input(), recipientId:'alice'}, 'transfer-001'), {code:'SAME_WALLET'});
  assert.throws(() => ledger.transfer({...input(), recipientId:'missing'}, 'transfer-001'), {code:'WALLET_NOT_FOUND'});
  assert.throws(() => ledger.transfer(input(), 'bad'), {code:'INVALID_KEY'});
  assert.throws(() => ledger.transfer(null, 'transfer-001'), {code:'INVALID_BODY'});
  assert.throws(() => ledger.transfer({...input(), memo:'a'.repeat(101)}, 'transfer-001'), {code:'INVALID_MEMO'});
  assert.equal(ledger.audit().ok, true);
});
test('원장 두 번째 항목 저장 실패 시 전체 트랜잭션을 롤백한다', t => {
  const { ledger, path } = fixture(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON entries WHEN NEW.delta > 0
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
  assert.throws(() => ledger.transfer(input(), 'transfer-001'), /injected write failure/);
  assert.deepEqual(ledger.wallets().map(w => w.balance), [100000,50000,25000]);
  assert.equal(ledger.audit().transferCount, 0);
  assert.equal(ledger.audit().entryCount, 0);
  db.exec('DROP TRIGGER inject_failure');
  db.close();
  assert.equal(ledger.transfer(input(), 'transfer-001').replayed, false);
});
test('재시작 후 거래·잔액·중복 방지 키가 유지된다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-flow-persist-'));
  const path = join(dir, 'persist.sqlite');
  let ledger = createLedger(path);
  t.after(() => { ledger.close(); rmSync(dir, {recursive:true, force:true}); });
  const first = ledger.transfer(input(), 'persist-001');
  ledger.close(); ledger = createLedger(path);
  assert.equal(ledger.transfer(input(), 'persist-001').transfer.id, first.transfer.id);
  assert.equal(ledger.wallets()[0].balance, 99000);
  assert.equal(ledger.audit().ok, true);
});
test('원장 수정·삭제를 막고 잔액 변조를 검출한다', t => {
  const { ledger, path } = fixture(t);
  ledger.transfer(input(), 'transfer-001');
  const db = new DatabaseSync(path);
  assert.throws(() => db.exec('UPDATE entries SET delta = 20'), /immutable/);
  assert.throws(() => db.exec('DELETE FROM entries'), /immutable/);
  assert.throws(() => db.exec("UPDATE transfers SET memo = 'changed'"), /immutable/);
  assert.throws(() => db.exec('DELETE FROM transfers'), /immutable/);
  db.exec("UPDATE wallets SET balance = balance + 1 WHERE id = 'alice'");
  assert.equal(ledger.audit().ok, false); db.close();
});
test('지갑 필터와 페이지네이션이 적용된다', t => {
  const { ledger } = fixture(t);
  for (let i = 0; i < 7; i++) ledger.transfer(input(i + 1), 'page-key-' + i);
  assert.equal(ledger.list({limit:5}).items.length, 5);
  assert.equal(ledger.list({limit:5,offset:5}).items.length, 2);
  assert.equal(ledger.list({walletId:'carol'}).total, 0);
  assert.equal(ledger.list({walletId:'bob'}).total, 7);
  assert.throws(() => ledger.list({limit:0}), {code:'INVALID_PAGE'});
  assert.throws(() => ledger.list({offset:-1}), {code:'INVALID_PAGE'});
});
async function httpFixture(t) {
  const server = createApp(':memory:');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (body, key, extra = {}) => fetch(base + '/api/transfers', {
    method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':key,...extra},
    body:JSON.stringify(body)
  });
  return { base, post };
}
test('HTTP 동시 요청 20개가 동일 키로 와도 송금은 한 번만 처리한다', async t => {
  const { base, post } = await httpFixture(t);
  const responses = await Promise.all(Array.from({length:20}, () => post(input(), 'concurrent-same')));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 19);
  const audit = await fetch(base + '/api/audit').then(r => r.json());
  assert.equal(audit.transferCount, 1); assert.equal(audit.ok, true);
});
test('서로 다른 동시 요청이 잔액을 초과하면 초과분은 거부한다', async t => {
  const { base, post } = await httpFixture(t);
  const responses = await Promise.all(Array.from({length:20}, (_,i) => post(input(10000), 'concurrent-' + i)));
  assert.equal(responses.filter(r => r.status === 201).length, 10);
  assert.equal(responses.filter(r => r.status === 409).length, 10);
  const wallets = await fetch(base + '/api/wallets').then(r => r.json());
  assert.equal(wallets.items[0].balance, 0);
  const audit = await fetch(base + '/api/audit').then(r => r.json());
  assert.equal(audit.transferCount, 10); assert.equal(audit.ok, true);
});
test('HTTP 상태 코드·입력 검증·출처 검사·정적 화면을 확인한다', async t => {
  const { base, post } = await httpFixture(t);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/portfolio')).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/api/transfers?limit=NaN')).status, 400);
  assert.equal((await post(input(), 'valid-key-001', {Origin:'https://other.example'})).status, 403);
  assert.equal((await post(input(), 'valid-key-001', {'Content-Type':'text/plain'})).status, 415);
  const malformed = await fetch(base + '/api/transfers', {method:'POST', headers:{'Content-Type':'application/json'},body:'{bad'});
  assert.equal(malformed.status, 400);
  assert.equal((await post({...input(), memo:'x'.repeat(9000)}, 'valid-key-001')).status, 413);
  assert.equal((await post(input(), 'valid-key-001')).status, 201);
  assert.equal((await post(input(), 'valid-key-001')).status, 200);
  assert.equal((await post(input(2), 'valid-key-001')).status, 409);
});
