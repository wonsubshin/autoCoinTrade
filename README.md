# Upbit AutoCoinTrade (업비트 다중 전략 자동매매 & AI 마켓 브리핑)

> 업비트(Upbit) Open API를 기반으로 3가지 퀀트 전략 봇을 동시에 운용하고, Google Gemini 3.5 Flash를 통해 실시간 시장 체제 분석 및 봇 진단을 스트리밍으로 제공하는 통합 암호화폐 자동매매 웹 플랫폼입니다.

---

## 🚀 빠른 시작 (Quick Start for Developers & AI Agents)

다른 PC에서 프로젝트를 처음 내려받았거나, AI Agent가 새로운 환경에서 실행을 세팅할 때는 **[SETUP_GUIDE.md](SETUP_GUIDE.md)** 를 참조하세요.

### 1단계: 초기 환경 설정 (원클릭)
- **Linux / macOS**:
  ```bash
  ./setup.sh
  ```
- **Windows**:
  ```cmd
  .\setup.bat
  ```
*(Node.js >= 22.5.0 검증, logs/data 생성, config 파일 생성, frontend npm install 및 Python 가상환경을 자동으로 수행합니다.)*

### 2단계: 서비스 시작
- **Linux / macOS**:
  ```bash
  ./start_services.sh
  # 또는 ./start.sh
  ```
- **Windows**:
  ```cmd
  .\start_services.bat
  ```
- **웹 대시보드 접속**: [http://localhost:9000](http://localhost:9000)
- **외부/스마트폰 접속 (동일 Wi-Fi)**: `http://<서버내부IP>:9000` (예: `http://192.168.0.217:9000`)
- **외부 인터넷 원클릭 터널 (LTE/외부망)**: `./start_tunnel.sh` (공개 HTTPS 보안 주소 자동 발급)
- **기본 입장 코드**: `stock`
- **백엔드 API**: `http://localhost:8001`

### 3단계: 서비스 중지
- **Linux / macOS**:
  ```bash
  ./stop_services.sh
  # 또는 ./stop.sh
  ```
- **Windows**:
  ```cmd
  .\stop_services.bat
  ```

---

## 📌 주요 핵심 기능

### 1. 3가지 독립 퀀트 자동매매 봇
- **[Bot 1] 돌파봇-알파 (변동성 돌파)**: 일봉 변동성 돌파(K=0.4) + 20일 이동평균선 추세 필터 결합 장중 단타 전략.
- **[Bot 2] 모멘텀봇-베타 (듀얼 모멘텀)**: 업비트 거래대금 상위 종목 중 상대 모멘텀 상위 2종목 및 절대 모멘텀 필터를 결합한 스윙 전략.
- **[Bot 3] 볼린저봇-감마 (볼린저 밴드 역추세)**: 고변동성 코인 대상 분봉 볼린저 밴드 하단 터치 및 RSI 과매도 구간 반등을 노리는 단기 역추세 전략.
- **독립 자금 분배 & 격리 원칙**: 각 봇별 가상 자금(`virtual_krw`) 격리, 트랜잭션 락, 분할 매도 안전 보장.

### 2. Google Gemini 3.5 Flash 실시간 AI 마켓 브리핑
- **시장 체제 진단**: 비트코인(BTC) 실시간 시세, 일봉 20MA, 4시간 60MA 이격도를 종합하여 `🔴 신규매수차단 (현금보유)` vs `🟢 정상거래 허용` 상태를 실시간 판별.
- **봇 행동 진단**: 현재 장세에서 각 봇들이 신규 매수를 진입하거나 대기하는 구체적인 이유를 AI가 명쾌하게 해설.
- **실시간 스트리밍 & 타이프라이터 효과**: Server-Sent Events(SSE) 스트리밍 기술과 타자기 애니메이션을 적용하여 실시간으로 생성되는 분석 리포트를 한 글자씩 부드럽게 출력.
- **접이식(Collapsible) UI**: 기본 상태는 대시보드를 넓게 볼 수 있도록 깔끔하게 접혀 있으며, `[⚡ AI 시황 분석 요청]` 클릭 시 자동으로 펼쳐지며 실시간 분석 진행.

### 3. 직관적인 다크 테마 웹 대시보드
- **실시간 업비트 API 통신 상태 표시기** (정상: 초록, 지연: 노랑, 오류: 빨강 + 응답속도 툴팁).
- **1줄(Row) 통합 거래 게시판**: 매수 체결부터 미매도 홀딩 상태(공란), 분할/전량 매도 체결 및 차익 업데이트를 한 행에서 추적.
- **누적 수익률 선 그래프 & 다빈도 거래 코인 순위 게시판**: 일간/주간/월간 누적 수익 곡선과 종목별 주간/월간/연간 손익 색상화(이익: 빨강, 손해: 파랑).
- **원금 및 봇별 자금 분배 설정**: 소수점 버림(`floor`) 및 자금 락 기능, JSON 백업 및 복원 지원.

---

## 📂 프로젝트 구조

```text
autoCoindTrade/
├── backend/
│   ├── node_server.mjs          # [메인 백엔드] Node.js 22 SQLite + Upbit API + Gemini AI + REST API
│   ├── main.py                  # (선택) 레거시 FastAPI 백엔드
│   └── common/                  # 공통 유틸리티
├── frontend/
│   ├── src/
│   │   ├── App.jsx              # 메인 React UI (AI 카드, 거래현황, 통계, 설정 등)
│   │   └── main.jsx
│   ├── package.json             # Vite + React 18 의존성
│   └── vite.config.js           # 프론트엔드 포트 9000 설정
├── agentBot/                    # 퀀트 전략 파이썬 알고리즘 모듈
├── config/
│   ├── upbit_config.example.json# 설정 템플릿 파일
│   └── upbit_config.json        # 실제 Upbit 및 Gemini API 키 설정 (.gitignore 추적 제외)
├── data/
│   └── auto_coin_trade.db       # SQLite WAL 모드 데이터베이스
├── logs/                        # 실행 로그 (backend.log, frontend.log)
├── scripts/
│   ├── run_backend.sh           # [Linux] 백엔드 단독 구동 스크립트
│   ├── run_frontend.sh          # [Linux] 프론트엔드 단독 구동 스크립트
│   ├── setup_postgresql.sh      # [PostgreSQL] 외부 접속 및 coin_trader 계정 자동 설정
│   ├── migrate_sqlite_to_pg.py  # [DB 마이그레이션] SQLite -> PostgreSQL 16 마이그레이션
│   ├── run_backend.bat          # [Windows] 백엔드 백그라운드 구동 스크립트
│   ├── run_frontend.bat         # [Windows] 프론트엔드 백그라운드 구동 스크립트
│   └── start_silent.vbs         # [Windows] 콘솔 창 없는 무음 백그라운드 런처
├── setup.sh                     # [초기 설정 - Linux] 원클릭 환경 검증 및 패키지 설치
├── start_services.sh            # [서비스 시작 - Linux] 백엔드 & 프론트엔드 동시 백그라운드 실행
├── stop_services.sh             # [서비스 중지 - Linux] 포트 8001 & 9000 안전 프로세스 종료
├── start_tunnel.sh              # [외부 접속 터널 - Linux] 스마트폰/외부 어디서나 접속 가능한 HTTPS 주소 생성
├── stop_tunnel.sh               # [외부 접속 터널 종료 - Linux]
├── run_orchestrator.sh          # [Python 오케스트레이터 - Linux]
├── setup.bat                    # [초기 설정 - Windows] 원클릭 환경 검증 및 npm 패키지 설치
├── start_services.bat           # [서비스 시작 - Windows] 백엔드 & 프론트엔드 동시 백그라운드 실행
├── stop_services.bat            # [서비스 중지 - Windows] 포트 8001 & 9000 안전 프로세스 종료
├── install_startup.bat          # 윈도우 부팅 시 자동 시작 등록
├── uninstall_startup.bat        # 윈도우 부팅 시 자동 시작 해제
├── README.md                    # 프로젝트 종합 안내서
├── SETUP_GUIDE.md               # [환경 세팅] 다른 PC 및 AI Agent 전용 실행 가이드
└── howtorun.md                  # 상세 사용자 가이드
```

---

## ⚙️ 설정 파일 (`config/upbit_config.json`)

```json
{
  "access_key": "업비트_OPEN_API_ACCESS_KEY",
  "secret_key": "업비트_OPEN_API_SECRET_KEY",
  "trade_mode": "paper",
  "request_timeout_sec": 5.0,
  "delay_threshold_ms": 800,
  "gemini_api_key": "GOOGLE_GEMINI_API_KEY"
}
```

- **`trade_mode`**: `"paper"` (모의투자 시뮬레이션 모드) 또는 `"live"` (실제 매매 모드)
- **`gemini_api_key`**: Google AI Studio에서 발급받은 Gemini API 키 (웹 화면 `[⚙️ API 키 등록]` 팝업에서도 입력 가능)

---

## 🛠️ 기술 스택 (Tech Stack)

- **Frontend**: React 18, Vite 5, CSS3 Custom Properties (Dark Theme)
- **Backend**: Node.js >= 22.5.0 (`node:http`, `node:sqlite` DatabaseSync WAL, `node:crypto`)
- **Database**: SQLite3 (Local File-based WAL mode)
- **AI Engine**: Google Gemini API (`gemini-3.5-flash` with SSE streaming)
- **Exchange API**: Upbit Open API v1.0 (JWT SHA-512 authentication)
- **Deployment**: Windows Batch & WScript Silent Background Automation
