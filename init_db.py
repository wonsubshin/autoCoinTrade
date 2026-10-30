"""
init_db.py - SQLite 데이터베이스 스키마 정의 및 초기화 모듈
- SQLite3 WAL 모드 및 busy_timeout=5000 필수 적용
- 가상 원장 테이블 (bot_accounts, bot_positions)
- LLM 시장 체제 & 감성 필터 상태 테이블 (market_regime_filter, id=1 단일 행)
"""

import logging
import os
import sqlite3
from pathlib import Path
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("init_db")

DEFAULT_DB_PATH = os.getenv("DB_PATH", "trading_ledger.db")


def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    """
    WAL 모드 및 busy_timeout이 설정된 SQLite 커넥션을 생성하여 반환합니다.
    """
    target_path = db_path or os.getenv("DB_PATH", DEFAULT_DB_PATH)
    Path(target_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        target_path,
        timeout=10.0,
        check_same_thread=False,
        isolation_level=None,  # 자동 커밋 모드 (명시적 트랜잭션 사용)
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_database(db_path: Optional[str] = None) -> None:
    """
    전체 테이블 스키마를 초기화하고 기본 데이터를 시딩합니다.
    """
    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")

        # 1. 봇 가상 원장 계좌 테이블 (bot_accounts)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_accounts (
                bot_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                allocation_ratio REAL NOT NULL,
                allocated_capital REAL NOT NULL DEFAULT 0.0,
                virtual_krw REAL NOT NULL DEFAULT 0.0,
                total_realized_pnl REAL NOT NULL DEFAULT 0.0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # 2. 봇별 독립 포지션 테이블 (bot_positions)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id TEXT NOT NULL,
                ticker TEXT NOT NULL,
                order_uuid TEXT NOT NULL UNIQUE,
                volume REAL NOT NULL,
                avg_buy_price REAL NOT NULL,
                buy_amount REAL NOT NULL,
                buy_fee REAL DEFAULT 0.0,
                highest_price REAL DEFAULT 0.0,
                step_level INTEGER DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'OPEN',
                sell_order_uuid TEXT,
                sell_price REAL,
                sell_amount REAL,
                sell_fee REAL DEFAULT 0.0,
                realized_pnl REAL,
                pnl_pct REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP,
                FOREIGN KEY (bot_id) REFERENCES bot_accounts(bot_id)
            );
            """
        )

        # 3. LLM 시장 체제 & 뉴스 감성 필터 테이블 (market_regime_filter - Single-row id=1)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS market_regime_filter (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                sentiment_score REAL DEFAULT 0.0,
                market_regime TEXT DEFAULT 'SIDEWAYS',
                risk_alert INTEGER DEFAULT 0,
                recommended_action TEXT DEFAULT 'NORMAL',
                position_size_multiplier REAL DEFAULT 1.0,
                bot_overrides_json TEXT DEFAULT '{"bot_vb":"ALLOW","bot_momentum":"ALLOW","bot_bb":"ALLOW"}',
                blacklist_tickers_json TEXT DEFAULT '[]',
                reason TEXT DEFAULT 'Initial default state',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # 4. market_regime_filter 단일 행(id=1) 기본값 시딩 (INSERT OR IGNORE)
        conn.execute(
            """
            INSERT OR IGNORE INTO market_regime_filter (
                id,
                sentiment_score,
                market_regime,
                risk_alert,
                recommended_action,
                position_size_multiplier,
                bot_overrides_json,
                blacklist_tickers_json,
                reason,
                updated_at
            ) VALUES (
                1,
                0.0,
                'SIDEWAYS',
                0,
                'NORMAL',
                1.0,
                '{"bot_vb":"ALLOW","bot_momentum":"ALLOW","bot_bb":"ALLOW"}',
                '[]',
                'Initial default state',
                CURRENT_TIMESTAMP
            );
            """
        )

        # 5. 기본 3개 봇 자금 비율 (4:4:2) 시딩
        initial_capital = float(os.getenv("INITIAL_TOTAL_CAPITAL", "1000000"))
        default_bots = [
            ("bot_vb", "슈퍼트렌드 변동성 돌파 봇", 0.40, initial_capital * 0.40),
            ("bot_momentum", "볼린저 밴드 스퀴즈 모멘텀 봇", 0.40, initial_capital * 0.40),
            ("bot_bb", "다단계 분할 매수 볼린저 역추세 봇", 0.20, initial_capital * 0.20),
        ]

        for bot_id, name, ratio, cap in default_bots:
            conn.execute(
                """
                INSERT OR IGNORE INTO bot_accounts (
                    bot_id,
                    name,
                    allocation_ratio,
                    allocated_capital,
                    virtual_krw,
                    total_realized_pnl,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, 0.0, CURRENT_TIMESTAMP);
                """,
                (bot_id, name, ratio, cap, cap),
            )

        conn.execute("COMMIT;")
        logger.info("Database schema & default seeds initialized successfully at: %s", conn.execute("PRAGMA database_list;").fetchall())
    except Exception as exc:
        conn.execute("ROLLBACK;")
        logger.error("Database initialization failed: %s", exc)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    init_database()
