# 업비트(Upbit) Open API 기반 다중 전략 코인 자동매매 & AI 퀀트 시스템 구축 프롬프트

당신은 시니어 풀스택 개발자이자 가상자산 퀀트 트레이딩 시스템 아키텍트입니다. 아래의 요구사항을 **하나도 빠짐없이 완벽하게** 반영하여, 업비트 Open API를 연동한 로컬 및 외부 웹 기반 코인 자동매매 & 실시간 AI 뉴스 인텔리전스 시스템(Backend + Frontend + Dual DB + AI Streaming + Network Tunnel)을 설계하고 구현해주세요.

---

## 1. 기술 스택 및 시스템 아키텍처

- **Backend**: Node.js (v20+ / ES Module, `node:http`, `node:sqlite` DatabaseSync 기반 고성능 경량 서버, Port `8001`)
  - 비동기 백그라운드 봇 전략 스케줄러 (8~10초 주기)
  - Gemini AI 실시간 스트리밍 (Server-Sent Events: SSE) 엔진
  - 뉴스 실시간 RSS 수집 및 감성 분석 백그라운드 워커 (30분 주기)
- **Frontend**: React 18+ & Vite (Port `9000`)
  - 프리미엄 다크 테마 UI (Pretendard 폰트 기반, `#0b0f19` 다크 배경, 2:8 화면 분할)
  - 상대 경로(`API_BASE = ""`) 및 Vite 프록시(`vite.config.js`)를 통한 로컬, 사내 LAN, 외부 도메인 무설정 동시 지원
- **Dual Database Architecture (SQLite + PostgreSQL 16)**:
  - **기본 실시간 DB**: SQLite (`data/auto_coin_trade.db`, WAL 저널 모드, 자동 재접속 지원)
  - **동기화 및 백업 DB**: PostgreSQL 16 (`coin_trader` 데이터베이스)
  - **환경별 동적 분기 (.env)**: `LOCATION=local` (로컬 `127.0.0.1:5432`) 또는 `LOCATION=outer` (외부 접속 주소 및 포트) 설정에 따라 자동 연결
  - **백그라운드 동기화 매니저 (`pg_sync.mjs`)**: SQLite에 저장되는 모든 테이블(`system_settings`, `bots`, `trades`, `bot_positions`, `crypto_news`)의 변경 내역을 PostgreSQL에 실시간 양방향/UPSERT 동기화
- **외부 접속 지원 (Cloudflare Tunnel & LAN)**:
  - 사내 LAN (`http://<내부IP>:9000`) 및 Cloudflare Quick Tunnel (`https://*.trycloudflare.com`)을 통한 안전한 외부 접속 지원
  - Vite `server.allowedHosts: true`, `host: "0.0.0.0"` 적용
- **형상 관리 및 보안 (Git & `.gitignore`)**:
  - 원격 저장소: `https://github.com/wonsubshin/autoCoinTrade.git`
  - 업비트 Access Key, Secret Key 및 Gemini API Key 등 민감 정보는 `.env` 및 `config/upbit_config.json`으로 분리하여 Git 추적에서 제외(`upbit_config.example.json` 템플릿 제공)
  - **Git 커밋 규칙**: 작업 완료 시 변경사항을 항상 커밋하되, 커밋 메시지에 개인정보나 계정 정보가 일절 포함되지 않도록 작성

---

## 2. 디렉토리 및 모듈 구조

```text
autoCoinTrade/
├── backend/
│   ├── node_server.mjs          # 백엔드 코어 HTTP 서버, DB 초기화, REST API, SSE 스트리밍
│   └── common/
│       ├── news_service.mjs     # 구글 뉴스 & 토큰포스트 RSS 파싱, 감성 분석, 태그 추출
│       └── pg_sync.mjs          # PostgreSQL 16 실시간 데이터 동기화 매니저
├── config/
│   ├── upbit_config.json        # 업비트 및 Gemini API 키 설정 파일 (Git 제외)
│   └── upbit_config.example.json# 설정 파일 템플릿
├── data/
│   └── auto_coin_trade.db       # 로컬 SQLite 데이터베이스 (WAL 모드)
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # 프론트엔드 메인 컴포넌트 (4대 메뉴, AI 스트리밍, 페이지네이션)
│   │   ├── main.jsx             # React 엔트리포인트
│   │   └── styles.css           # 다크 테마, 2:8 레이아웃, 동일 Row 높이 테이블, 모달 스타일
│   ├── index.html
│   ├── package.json
│   └── vite.config.js           # 0.0.0.0 바인딩, allowedHosts, /api 프록시 설정
├── scripts/
│   ├── setup_postgresql.sh      # PostgreSQL 16 계정 및 데이터베이스 자동 설치/설정 스크립트
│   └── migrate_sqlite_to_pg.py  # SQLite -> PostgreSQL 전체 데이터 마이그레이션 스크립트
├── start_services.sh            # 백엔드(8001) 및 프론트엔드(9000) 백그라운드 원클릭 실행 스크립트
├── stop_services.sh             # 실행 중인 서비스 정상 종료 스크립트
└── .env                         # LOCATION=local|outer, PostgreSQL 접속 정보, Gemini API 키
```

---

## 3. 데이터베이스 스키마 요구사항

SQLite와 PostgreSQL 모두 동일한 스키마 구조를 유지하며, 다음 6개 테이블을 구성해야 합니다:

1. **`system_settings`**: `key`(PK, TEXT), `value`(TEXT), `updated_at`(TEXT)
2. **`bots`**: `bot_id`(PK, TEXT), `name`(TEXT), `nickname`(TEXT), `strategy_type`(TEXT), `description`(TEXT), `allocation_ratio`(REAL), `allocated_capital`(INTEGER), `virtual_krw`(INTEGER), `is_running`(INTEGER), `min_volume_krw`(INTEGER), `stop_loss_pct`(REAL), `take_profit_pct`(REAL), `config_json`(TEXT), `last_status_msg`(TEXT), `updated_at`(TEXT)
3. **`trades`**: `id`(PK, AUTOINCREMENT), `bot_id`(TEXT), `market`(TEXT), `buy_order_uuid`(TEXT), `sell_order_uuid`(TEXT), `buy_price`(REAL), `buy_volume`(TEXT), `buy_amount`(INTEGER), `buy_date`(TEXT), `sell_price`(REAL), `sell_volume`(TEXT), `sell_amount`(INTEGER), `sell_date`(TEXT), `profit_krw`(INTEGER), `profit_pct`(REAL), `status`(TEXT DEFAULT 'HOLDING')
4. **`bot_positions`**: `id`(PK, AUTOINCREMENT), `bot_id`(TEXT), `market`(TEXT), `order_uuid`(TEXT UNIQUE), `volume`(TEXT), `avg_buy_price`(REAL), `buy_amount`(INTEGER), `buy_fee`(REAL), `trade_id`(INTEGER), `status`(TEXT DEFAULT 'OPEN'), `created_at`(TEXT), `closed_at`(TEXT)
5. **`ai_market_briefings`**: `id`(PK, AUTOINCREMENT), `provider`(TEXT), `model`(TEXT), `btc_price`(REAL), `btc_daily_20ma`(REAL), `btc_4h_60ma`(REAL), `regime_status`(TEXT), `briefing_text`(TEXT), `created_at`(TEXT)
6. **`crypto_news`**: `id`(PK, AUTOINCREMENT), `title`(TEXT), `link`(TEXT UNIQUE), `source`(TEXT), `published_at`(TEXT), `summary`(TEXT), `sentiment`(TEXT DEFAULT 'NEUTRAL'), `keywords`(TEXT), `created_at`(TEXT)
   - 인덱스: `idx_crypto_news_pubdate` ON `crypto_news (published_at DESC)`
7. **`ai_news_briefings`**: `id`(PK, AUTOINCREMENT), `provider`(TEXT), `model`(TEXT), `news_count`(INTEGER), `bullish_count`(INTEGER), `bearish_count`(INTEGER), `neutral_count`(INTEGER), `briefing_text`(TEXT), `created_at`(TEXT)

---

## 4. 봇 매매 전략 및 퀀트 안전 격리 아키텍처

### 4.1 3가지 독립 매매 전략 봇
1. **변동성 돌파 봇 (`bot_volatility`)**: 전일 변동폭(High - Low) * K(0.5) 돌파 시 매수, 당일 종가 또는 익일 시가 매도 (장중 단타/1일 보유)
2. **듀얼 모멘텀 봇 (`bot_dual_momentum`)**: 상대 모멘텀(수익률 상위 종목) + 절대 모멘텀(현금 보유 필터) 결합 스윙 전략
3. **볼린저 밴드 역추세 봇 (`bot_bollinger_reversal`)**: 볼린저 밴드 하단 이탈 후 반등 시 분할 매수, 중심선/상단선 도달 시 익절 (+3.5% 익절 / -2.0% 손절)

### 4.2 상호 간섭 방지 및 자금 격리 규칙 (절대 준수)
- **전량 조회 함수(`get_balance`) 직접 매도 금지**:
  - 매도 시 반드시 본인 `bot_id`의 `bot_positions`에 기록된 `volume` 수량만 지정하여 매도.
- **동일 종목 동시 진입 격리**:
  - 복수 봇이 동일 코인(예: KRW-BTC)을 매수하더라도 개별 `order_uuid`로 지분을 분리하여 관리.
- **가상 잔고(`virtual_krw`) 트랜잭션 락**:
  - 각 봇은 DB에 할당된 `virtual_krw` 예산 범위 내에서만 주문을 발행.
- **자금 분배 시 소수점 버림 처리**:
  - 총 원금에 배분 비율(%)을 곱할 때 발생하는 소수점은 무조건 내림(`Math.floor`)하여 정수 원화로 계산.
- **잔고 0 이하 시 전체 봇 자동 중지 및 모달 알림**:
  - 잔고가 0 이하가 되면 모든 봇을 즉시 비활성화(`is_running = 0`)하고, 사용자가 거래현황 화면 진입 시 안내 Modal Popup 표기.
- **비트코인 시장 체제 필터 (Regime Filter)**:
  - 비트코인 현재가가 일봉 20일 이동평균선(20 MA) 및 4시간봉 60선(60 MA) 아래에 있을 경우 신규 매수를 전면 차단하고 현금 보유(`HOLD_CASH`) 모드로 전환.
- **업비트 API 안정성 규칙**:
  - 초당 요청 제한 방어를 위한 `120ms` 호출 간격 방어.
  - 최소 주문 금액(5,000원) 및 매수 수수료(0.05%) 사전 반영(`floor(예산 / 1.0005)`).
  - 수량 계산 시 8자리 절삭을 통한 부동소수점 오차 방지.
  - 주문 체결 확인(Order Reconciliation)을 통한 실제 체결가 및 수수료 동기화.

---

## 5. 프론트엔드 (React) UI/UX 상세 요구사항

### 5.1 공통 레이아웃 및 보안 게이트
- **다크 테마 & 2:8 레이아웃**:
  - 좌측 20% 메뉴 영역 + 우측 80% 상세 콘텐츠 영역 (모바일 화면 접근 시 1열 전환 및 상단 스티키 헤더 반응형 지원).
- **입장 코드(Gate) 화면**:
  - 별도 회원가입 없이 개인용 입장 코드 `sws@2129` 입력 시 메인 화면 진입 (새로고침 시 세션 유지).
- **업비트 통신 상태 인디케이터**:
  - 좌측 메뉴 상단에 초록(정상) / 노랑(지연) / 빨강(통신불가) 실시간 표시.
  - 마우스 오버 시 툴팁으로 응답 속도(ms) 및 최근 확인 시각 표시.
- **실시간 거래 실행 모드 토글 (가상거래 모의투자 ↔ 업비트 실거래)**:
  - 좌측 사이드바 상단 칩, 거래현황 안내 배너, 설정 화면에서 원클릭으로 모드 전환.
  - **가상거래(Paper Trading) 모드**: 실제 업비트 실시간 호가/시세 및 캔들 지표를 그대로 조회하여 매수/매도 조건을 평가하되, 실제 업비트 주문 API를 호출하지 않고 가상 체결(`paper-bid-*`, `paper-ask-*`, 수수료 0.05% 반영)로 안전하게 모의투자 실행. 실제 계좌 자금은 1원도 소진되지 않음.
  - **실거래(Live Trading) 모드**: 실제 업비트 API 키로 실제 원화/코인 주문을 거래소에 직접 전송하여 체결.
- **5대 네비게이션 메뉴 구성**:
  1. `📊 거래현황`
  2. `📈 통계`
  3. `🧪 검증소` (알고리즘 검증소 / 가상 모델 실시간 랭킹 보드)
  4. `📰 뉴스` (실시간 뉴스 피드 & AI 종합 분석)
  5. `⚙️ 설정`

---

### 5.2 [메뉴 1] 거래현황 화면
- **거래 모드 안내 배너**: 현재 운용 중인 모드(가상거래 모의투자 vs 업비트 실거래) 및 모드 원클릭 전환 버튼 표기.
- **봇별 탭(Tab)**: 봇별 별명과 전략이 표시되는 개별 탭.
- **봇 제어 버튼**: `거래 시작`, `거래 중지`, `매수 테스트`, `매도 테스트` 버튼 제공 및 동작 결과 Modal Popup 안내.
- **거래 정보 게시판**:
  - 1행 매칭 방식: 매수단가/수량/금액, 매도단가/수량/금액, 매수일시, 매도일시, 실현손익 표기.
  - 미체결 보유 포지션은 매도 영역 공란 유지.
- **상단 AI 실시간 마켓 브리핑**:
  - Gemini AI 기반 시황 분석 및 한 글자씩 스트리밍 타이핑(Typewriter) 출력.

---

### 5.3 [메뉴 2] 통계 화면
- **기간별 탭**: `일별 통계` / `주별 통계` / `월별 통계` (새로고침 시 선택 탭 유지).
- **통계 시작 기준일**: `2026.10.01`부터 누적 집계.
- **손익 색상 구분 규칙 (필수)**:
  - **이익(> 0)**: 빨간색 (`#ef4444`)
  - **손해(< 0)**: 파란색 (`#3b82f6`)
  - **0원(= 0)**: 검은색/회색 뱃지
- **코인별 수익 기여도 순위 테이블**: 누적 실현 손익 및 승률 순위 표기.

---

### 5.4 [메뉴 3] 알고리즘 검증소 (Algorithm Validation Lab / Testbed)

#### ① 6대 퀀트 알고리즘 모델 병렬 구동 (각 초기 가상 자본 1,000,000 KRW)
1. **변동성 돌파 (Larry Williams)**: 전일 변동폭 K=0.4 돌파 + 20일 이동평균선 상회 시 매수.
2. **듀얼 모멘텀 (Dual Momentum)**: 상대 모멘텀 상위 + 7일 절대 모멘텀 > +1.5% 돌파 시 스윙 매수.
3. **볼린저 밴드 역추세 (BB Reversal)**: 15분봉 볼린저 밴드 하단선 터치(-2σ) & RSI <= 30 극단 과매도 반등 매수.
4. **MACD + RSI 골든크로스 (MACD Trend)**: 15분봉 MACD 시그널선 상향 돌파 & RSI 45~65 추세 확장 시 매수.
5. **RSI 극단 과매도 스캘핑 (RSI Scalper)**: 15분봉 RSI <= 25 패닉셀 구간 진입 매수, RSI 50 도달 또는 +1.5% 시 즉시 청산.
6. **슈퍼트렌드 & ATR 동적 스탑 (SuperTrend ATR)**: 14일 ATR 1.8배 동적 트레일링 스탑 적용 추세추종.

#### ② 실시간 지표 기반 평가 및 랭킹 산출
- 실제 업비트 실시간 호가/시세(`fetchUpbitTickersMap`) 및 캔들 지표를 10초 주기로 수신하여 신호 평가 및 가상 체결(수수료 0.05% 차감/반영).
- 실시간 수익률(`profit_rate_pct = ((eval_assets_krw - initial_capital) / initial_capital) * 100`)을 기준으로 1위부터 6위까지 실시간 랭킹 자동 재계산.

#### ③ TOP 3 랭킹 포디움 (Podium) & 랭킹 보드
- **상단 TOP 3 포디움**: 🥇 1위(챔피언, Gold), 🥈 2위(Silver), 🥉 3위(Bronze) 카드 3단 강조 뷰 (수익률, 평가자산, 승률, 최근 시그널).
- **실시간 랭킹 테이블**: 전체 6개 모델 순위, 모델명, 분류, 실시간 수익률, 총 평가자산, 가용 현금, 승률(전적), 보유 포지션 표시. 행 클릭 시 해당 모델의 매매 이력만 필터링.
- **가상 매매 체결 이력 (Paper Trade History)**: 모델별 가상 체결 내역(체결가, 체결수량, 체결금액, 실현손익, 진입/청산 사유) 실시간 출력.
- **제어 버튼**:
  - **[🔄 실시간 검증 실행]**: 10초 대기 없이 즉시 전체 모델 시뮬레이션 및 랭킹 갱신 트리거.
  - **[초기화 (100만원 리셋)]**: 모든 모델의 가상 자본을 1,000,000 KRW, 보유 포지션 0, 매매 이력을 초기화.

---

### 5.5 [메뉴 4] 뉴스 화면

#### ① 뉴스 수집 및 감성 분석 엔진 (`news_service.mjs`)
- Google News(국내/글로벌) 및 TokenPost RSS를 실시간 파싱하여 주요 가상자산 뉴스 수집 (중복 링크 방어).
- 제목 및 본문 기반 감성 분석: `▲ 호재(BULLISH)`, `▼ 악재(BEARISH)`, `● 중립(NEUTRAL)`.
- 키워드 자동 태깅: `#비트코인`, `#이더리움`, `#업비트`, `#바이낸스`, `#리플`, `#솔라나`, `#ETF`, `#규제/정책`, `#시황/전망`, `#해킹/보안`.
- 서버 기동 시 최초 수집 및 **30분 주기 백그라운드 자동 갱신**.
- 상단 **[🔄 최신 뉴스 즉시 수집]** 버튼 제공.

#### ② 검색 및 필터링 기능
- **날짜 범위 검색**: 시작일(`startDate`) 및 종료일(`endDate`) 캘린더 입력.
- **통합 키워드 검색**: 기사 제목, 요약, 언론사, 해시태그 대상 실시간 검색.
- **인기 태그 뱃지**: 원클릭으로 검색어에 태그 자동 입력 및 즉시 조회.
- **초기화 버튼**: 검색 조건 초기화.

#### ③ 50건 단위 목록 뷰 및 행(Row) 높이 동일화 (필수 준수)
- **한 화면 50건 노출**: `limit=50`, 전체 페이지네이션(`« 처음`, `‹ 이전`, 페이지 번호 7개, `다음 ›`, `마지막 »`).
- **Row 높이 동일화 (`.news-board-table`)**:
  - 테이블에 `table-layout: fixed; width: 100%;` 적용.
  - 모든 행(`tr`) 및 셀(`td`)에 고정 높이(`height: 48px; max-height: 48px; line-height: 48px; vertical-align: middle;`) 적용.
  - 제목이 길어도 줄바꿈되지 않고 1줄 말줄임표(`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`)로 표시되어 **모든 행의 높이가 완벽히 동일**해야 함.
  - 마우스 호버 시 기사 전체 제목과 요약문이 툴팁(`title`)으로 노출되어 언제든 원문 확인 가능.
  - 기사 제목 클릭 시 새 탭(`target="_blank"`)에서 원문 기사 오픈.

#### ④ 뉴스 기반 AI 종합 판단 및 시황 분석 (Gemini SSE 스트리밍)
- **접을 수 있는 아코디언 영역 (Collapsible Box)**:
  - 상단 **[▲ 접기] / [▼ 펼치기]** 토글 버튼 및 카드 헤더 클릭으로 영역을 자유롭게 열고 닫을 수 있음.
  - 접힌 상태에서도 최근 분석 시각, 사용 모델, 호재/악재 통계 배지 노출.
- **'AI 분석하기' 버튼 클릭 시 실시간 스트리밍 한 글자씩 타이핑**:
  - **[🤖 AI 분석하기]** 버튼 클릭 시 백엔드 `/api/ai/stream-news-analyze` 엔드포인트(SSE) 호출.
  - 수집된 250+ 뉴스와 호재/악재 비율, 주요 코인 시세를 Gemini AI(`gemini-3.5-flash-lite`)가 분석.
  - 수신된 청크 토큰을 큐(Queue)에 담아 **18ms 간격으로 한 글자씩 부드럽게 화면에 타이핑(Typewriter Effect)** 출력.
  - 타이핑 진행 중 깜빡이는 보라색 커서(`|`) 애니메이션 표시.
  - 분석 완료 후 `ai_news_briefings` 테이블에 영구 저장되어 새로고침 시에도 유지.

---

### 5.6 [메뉴 5] 설정 화면
- **거래 실행 모드 설정**: 가상거래(모의투자) 모드 ↔ 업비트 실거래 모드 전환 및 현재 상태 설명.
- **업비트 실계좌 자산 확인**: 읽기 전용으로 실제 보유 원화, 매수금액, 총 평가금액, 평가손익률 표시.
- **자금 분배 비율 및 원금 설정**: 전체 운용 원금 및 봇별 배분 비율(%) 설정 시 소수점 버림 처리.
- **봇 파라미터 및 별명 수정**: 손절율, 익절율, 최소 거래대금, 전략별 계수(K값, 표준편차 배수) 저장.
- **Gemini API 키 등록/수정**: 웹 UI에서 Gemini API 키 직접 입력 및 저장 (`sk-...` 마스킹 처리).
- **JSON 데이터 마이그레이션(백업) 및 복원**:
  - SQLite의 전체 데이터(봇, 거래내역, 포지션, 설정)를 단일 JSON 파일로 Export.
  - JSON 파일을 업로드하여 기존 DB를 무결성 검증과 함께 완벽 복원 (UNIQUE 충돌 방어 처리 포함).

---

## 6. 외부 네트워크 및 배포/운영 구성

- **실행 및 중지 스크립트**:
  - `./start_services.sh`: 백엔드(8001) 및 프론트엔드(9000)를 백그라운드 구동하고 헬스체크 수행.
  - `./stop_services.sh`: 구동 중인 프로세스를 안전하게 종료.
- **Cloudflare Tunnel 연동**:
  - `cloudflared tunnel --url http://127.0.0.1:9000`을 통해 HTTPS 외부 주소 생성.
  - IPv6 충돌 방지를 위해 반드시 `http://127.0.0.1:9000`으로 바인딩.
- **Vite Same-Origin Proxy**:
  - 프론트엔드에서 `/api`를 호출하면 `vite.config.js`의 proxy가 내부 백엔드(`http://127.0.0.1:8001`)로 무중단 포워딩하여 브라우저 환경에 구애받지 않고 동작.

---

## 7. 작업 수행 및 형상관리(Git) 지침

1. **국소 수정 원칙 (사이드 이펙트 방지)**:
   - 추가 요청 사항 작업 시 반드시 요청받은 범위만 수정하며, 기존에 정상 작동 중인 매매 봇 로직, 통계 집계, DB 동기화 코드에 절대 영향을 주지 않도록 합니다.
2. **React TDZ(Temporal Dead Zone) 방어**:
   - `useCallback` 및 함수 선언이 `useEffect`보다 반드시 앞에 위치하도록 선언 순서를 엄격히 준수합니다.
3. **작업 완료 후 자동 Git 반영**:
   - 모든 수정 작업 완료 후 `git add` 및 `git commit`을 반드시 수행합니다.
   - 커밋 메시지에는 API 키, 계정명, 비밀번호 등 민감 정보를 일절 포함하지 않고 기능 단위(`feat`, `fix`, `refactor`)로 명확히 작성합니다.
