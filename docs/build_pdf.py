from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=root/'output'/'pdf'
out.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('Malgun','C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('MalgunBold','C:/Windows/Fonts/malgunbd.ttf'))
W,H=595.28,841.89
c=canvas.Canvas(str(out/'Ledger-Flow-Portfolio.pdf'),pagesize=(W,H))
c.setTitle('Ledger Flow - 백엔드 포트폴리오')
c.setAuthor('Ledger Flow')
green=HexColor('#12664e'); ink=HexColor('#213d31'); muted=HexColor('#6e8376')
style=ParagraphStyle('body',fontName='Malgun',fontSize=10,leading=17,textColor=ink,wordWrap='CJK')
def para(text,y,size=10,color=ink,bold=False):
    s=ParagraphStyle('p',parent=style,fontName='MalgunBold' if bold else 'Malgun',fontSize=size,leading=size*1.65,textColor=color)
    p=Paragraph(text,s); _,height=p.wrap(W-88,700);p.drawOn(c,44,y-height);return y-height-12
def text(x,y,s,size=10,color=ink,bold=False):
    c.setFillColor(color);c.setFont('MalgunBold' if bold else 'Malgun',size);c.drawString(x,y,s)
def begin(n,label,title,subtitle):
    c.setFillColor(HexColor('#f8faf7'));c.rect(0,0,W,H,fill=1,stroke=0)
    text(44,H-43,'LEDGER FLOW / BACKEND PORTFOLIO',9,green,True)
    c.setStrokeColor(HexColor('#d9e3da'));c.line(44,H-58,W-44,H-58)
    text(44,H-91,label,9,muted)
    text(44,H-128,title,26,ink,True)
    para(subtitle,H-145,10,muted)
    c.line(44,43,W-44,43)
    text(44,27,'2026-10-25  |  Node.js 24 + SQLite  |  Local demo',8,muted)
    text(W-73,27,f'{n} / 4',8,muted)
def section(title,y):
    text(44,y,title,14,green,True);return y-16

begin(1,'01 / OVERVIEW','모든 거래에, 정확한 기록.','가상 포인트 송금과 원장 정합성을 검증하는 백엔드 데모 프로젝트')
y=para('송금 재시도에 따른 중복 차감과 저장 중 부분 실패를 방지합니다. 성공 요청의 멱등성, DB 트랜잭션, 잔액과 원장 교차 검증을 실제로 동작하는 화면과 자동 테스트로 확인할 수 있습니다.',H-195)
img=ImageReader(str(root/'docs'/'preview-desktop.png'))
iw,ih=img.getSize();dw=452;dh=dw*ih/iw
c.drawImage(img, (W-dw)/2,y-dh,width=dw,height=dh,mask='auto')
para('실제 실행 화면: 데모 송금 3건, 원장 6개 항목, 총 포인트 175,000 P 보존.',y-dh-12,9,muted)
c.showPage()

begin(2,'02 / DESIGN','송금은 하나의 작업으로.','잔액 변경과 거래 기록이 함께 성공하거나 함께 취소되도록 설계했습니다.')
y=section('처리 순서',H-205)
for title,body in [
('1. 입력 검증','금액은 1~1,000,000 정수 포인트. 자기 송금, 존재하지 않는 지갑, 과도한 메모를 거부합니다.'),
('2. BEGIN IMMEDIATE + 요청 키 확인','쓰기 예약 후 성공한 요청 키를 조회합니다. 같은 키·내용이면 기존 거래를 반환하고, 내용이 다르면 409를 반환합니다.'),
('3. 잔액과 원장 변경','balance >= amount 조건으로 차감하고 수취인에게 입금합니다. 거래 1건과 음수 출금·양수 입금 원장 2개를 저장합니다.'),
('4. COMMIT 또는 ROLLBACK','모든 변경을 확정합니다. 중간에 오류가 발생하면 잔액과 원장 변경 전체를 되돌립니다.')]:
    y=para(title,y,11,ink,True);y=para(body,y,10)
y=section('데이터 구조와 불변 조건',y-8)
y=para('<b>지갑 wallets</b>: id, name, opening_balance, balance<br/><b>거래 transfers</b>: id, request_key(UNIQUE), sender_id, recipient_id, amount, memo, created_at<br/><b>원장 entries</b>: transfer_id, wallet_id, delta',y)
y=para('검증 조건: 현재 잔액 = 초기 잔액 + 원장 합계 / 거래별 원장 합계 = 0 / 송금 1건당 올바른 출금·입금 각 1개 / 총 포인트 = 초기 발급량',y,10,green)
para('실패 요청의 키는 저장하지 않습니다. 동일 키로 다시 시도하면 현재 상태를 기준으로 처리합니다. 거래와 원장 수정·삭제는 SQL 트리거로 제한합니다.',y,9,muted)
c.showPage()

begin(3,'03 / VALIDATION','실패 상황까지 검증합니다.','단일 Node.js 프로세스 환경에서 자동 테스트 12개 통과, 실패 0개.')
y=section('핵심 테스트 결과',H-205)
for title,body in [
('동일 키로 HTTP 요청 20개','201 신규 성공 1개 + 200 재전송 응답 19개. 잔액은 한 번만 변경됩니다.'),
('잔액을 초과하는 HTTP 요청 20개','초기 100,000 P에서 10,000 P씩 요청: 성공 10개, 잔액 부족 10개. 최종 잔액 0 P.'),
('저장 중 실패 주입','두 번째 원장 INSERT에서 오류를 발생시켜 잔액·거래·원장 전체가 롤백되는지 확인합니다.'),
('재시작 및 변경 감지','DB를 닫고 다시 열어 잔액과 요청 키의 지속성을 확인합니다. 원장 수정·삭제 차단과 잔액 불일치 검출을 검사합니다.')]:
    y=para(title,y,11,ink,True);y=para(body,y,10)
y=section('그 외 확인 항목',y-8)
y=para('정상 송금, 요청 키 충돌, 금액·지갑·메모 검증, 지갑 필터와 페이지네이션, HTTP 오류 코드 및 출처 제한을 검사했습니다. 프런트엔드·서버 구문 검사도 통과했습니다.',y)
y=section('브라우저 확인',y-8)
y=para('송금 → 동일 요청 재전송 → 잔액 부족 → 지갑 필터 → 새로고침을 실제 브라우저에서 실행했습니다. 390px 모바일 화면의 가로 넘침이 없고 JavaScript 실행 오류가 없는 것을 확인했습니다.',y)
y=para('재현 명령: npm test / npm run check<br/>테스트 코드: test/ledger.test.js<br/>실행 기록: docs/TEST-RESULTS.txt',y,10,green)
para('이 결과는 처리량 벤치마크나 다중 서버 환경 검증이 아닙니다. SQLite 동기식 호출은 이 프로세스에서 직렬로 실행됩니다.',y,9,muted)
c.showPage()

begin(4,'04 / SCOPE & DEMO','작게 만들고, 정확히 설명하기.','구현한 범위와 아직 구현하지 않은 범위를 분명하게 구분합니다.')
y=section('기술 선택',H-205)
y=para('설치 시간을 줄이고 핵심 코드를 읽기 쉽게 유지하기 위해 Node.js 내장 HTTP·SQLite와 순수 JavaScript를 사용했습니다. 외부 npm 패키지가 없으며 Node.js 24 이상에서 실행합니다.',y)
y=section('실행과 2분 시연',y-8)
y=para('1. 프로젝트 폴더에서 npm start 실행 후 http://127.0.0.1:3000 접속<br/>2. 앨리스 → 밥으로 1,000 P 송금<br/>3. 마지막 요청 재전송: 거래 수와 잔액이 그대로인지 확인<br/>4. 잔액 초과 금액 요청: 409 응답과 원장 미추가 확인<br/>5. 데이터 정합성 및 마지막 API 응답 확인',y)
y=section('명시적인 한계',y-8)
y=para('가상 포인트 로컬 데모입니다. 실제 돈·토큰·블록체인을 다루지 않습니다. 인증·인가, 공개 배포, 환불, 운영용 모니터링은 포함하지 않습니다. 원장 트리거는 DB 관리자의 우회를 막는 암호학적 위변조 방지가 아닙니다.',y)
y=para('확장 시에는 PostgreSQL 및 행 잠금, 사용자 권한, 정정 거래, 백업과 복구, 운영 로그를 검토해야 합니다. 현재 동시성 테스트로 분산 환경의 정확성을 주장하지 않습니다.',y)
y=section('AI 활용 공개',y-8)
y=para('초기 코드·테스트·문서는 AI 코딩 도구로 생성되었습니다. 제출자는 직접 이해·검토·재현한 범위와 실제 수정한 부분을 별도로 설명해야 합니다. 이 자료는 독자 구현 경험이나 운영 실적을 주장하지 않습니다.',y)
para('제출 전 안내: docs/INTERVIEW.md의 20분 확인 절차를 따라 직접 시연하고, 핵심 함수 transfer의 처리 흐름을 설명해 보세요.',y,10,green)
c.save()
print(out/'Ledger-Flow-Portfolio.pdf')
