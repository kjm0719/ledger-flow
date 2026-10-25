const $ = id => document.getElementById(id);
const names = { alice: '앨리스', bob: '밥', carol: '캐롤' };
const format = n => n.toLocaleString('ko-KR');
let offset = 0, lastRequest = null, busy = false, refreshVersion = 0;
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || '요청 실패');
    error.data = data; error.status = response.status; throw error;
  }
  return { data, status: response.status };
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function refresh() {
  const version = ++refreshVersion;
  const [{ data: wallets }, { data: audit }, { data: history }] = await Promise.all([
    api('/api/wallets'), api('/api/audit'),
    api('/api/transfers?limit=5&offset=' + offset + '&walletId=' + encodeURIComponent($('filter').value))
  ]);
  if (version !== refreshVersion) return;
  $('total').textContent = format(audit.total.current) + ' P';
  $('count').textContent = format(audit.transferCount);
  $('entries').textContent = format(audit.entryCount);
  $('audit-state').textContent = audit.ok ? '정상' : '불일치';
  $('audit-time').textContent = new Date(audit.checkedAt).toLocaleTimeString('ko-KR') + ' 검증 완료';
  $('integrity-badge').textContent = audit.ok ? 'VERIFIED' : 'MISMATCH';
  $('wallets').replaceChildren(...wallets.items.map(w => {
    const row = el('div', undefined, 'wallet');
    const info = el('div', undefined, 'wallet-info');
    info.append(el('strong', w.name), el('small', 'wallet / ' + w.id));
    const balance = el('div', format(w.balance), 'wallet-balance'); balance.append(el('span', 'P'));
    row.append(el('div', w.id[0].toUpperCase(), 'avatar'), info, balance); return row;
  }));
  const rows = history.items.map(t => {
    const row = el('tr'), description = el('td');
    description.append(el('strong', t.memo || '포인트 송금'), el('small', t.id.slice(0, 8) + '…'));
    const status = el('td'); status.append(el('span', '완료', 'status'));
    row.append(description, el('td', names[t.sender_id]), el('td', names[t.recipient_id]),
      el('td', format(t.amount) + ' P'), status,
      el('td', new Date(t.created_at).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })));
    return row;
  });
  if (!rows.length) { const row = el('tr'), cell = el('td', '아직 거래가 없습니다. 첫 포인트를 보내보세요.', 'empty'); cell.colSpan = 6; row.append(cell); rows.push(row); }
  $('transaction-rows').replaceChildren(...rows);
  $('page-label').textContent = history.total ? (offset + 1) + '–' + (offset + history.items.length) + ' / 총 ' + history.total + '건' : '총 0건';
  $('prev').disabled = offset === 0;
  $('next').disabled = offset + 5 >= history.total;
  $('global-status').textContent = '';
}
async function safeRefresh() {
  try { await refresh(); } catch { $('global-status').textContent = '데이터를 불러오지 못했습니다. 서버 실행 상태를 확인하고 새로고침하세요.'; }
}
async function send(request) {
  if (busy) return;
  busy = true; $('submit').disabled = true; $('replay').disabled = true;
  $('transfer-status').className = 'result'; $('transfer-status').textContent = '요청 처리 중…';
  try {
    const { data, status } = await api('/api/transfers', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'Idempotency-Key':request.key },
      body:JSON.stringify(request.body)
    });
    $('response').textContent = JSON.stringify({ httpStatus: status, ...data }, null, 2);
    $('transfer-status').className = 'result success';
    $('transfer-status').textContent = data.replayed ?
      '중복 요청 감지 · 기존 거래를 반환했습니다. 잔액은 다시 차감되지 않았습니다.' :
      format(data.transfer.amount) + ' P 송금 완료 · 출금과 입금 원장 2건이 함께 저장됐습니다.';
    offset = 0; await safeRefresh();
  } catch (e) {
    $('transfer-status').className = 'result error';
    $('transfer-status').textContent = e.data ? e.message :
      '응답을 확인할 수 없습니다. 같은 요청 재전송으로 처리 여부를 확인하세요.';
    $('response').textContent = JSON.stringify({ httpStatus:e.status || null, ...(e.data || { error: 'NETWORK_ERROR' }) }, null, 2);
  } finally { busy = false; $('submit').disabled = false; $('replay').disabled = !lastRequest; }
}
$('transfer-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  lastRequest = { key: crypto.randomUUID(), body: { senderId: $('sender').value,
    recipientId: $('recipient').value, amount: Number($('amount').value), memo: $('memo').value } };
  send(lastRequest);
});
$('replay').addEventListener('click', () => lastRequest && send(lastRequest));
$('refresh').addEventListener('click', safeRefresh);
$('filter').addEventListener('change', () => { offset = 0; safeRefresh(); });
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - 5); safeRefresh(); });
$('next').addEventListener('click', () => { offset += 5; safeRefresh(); });
safeRefresh();
