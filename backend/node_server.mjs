import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { pgSyncManager } from "./common/pg_sync.mjs";
import { syncNewsToDatabase, queryNewsList } from "./common/news_service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "auto_coin_trade.db");
const CONFIG_PATH = path.join(BASE_DIR, "config", "upbit_config.json");
const EXAMPLE_CONFIG_PATH = path.join(BASE_DIR, "config", "upbit_config.example.json");
const PORT = Number(process.env.PORT || 8001);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowKSTString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayDateString() {
  return nowKSTString().slice(0, 10);
}

// SQLite 세션 관리 (세션 단절 또는 날이 바뀐 경우 자동 재접속 - 요구사항 25)
let dbInstance = null;
let connectedDate = null;

function getDb() {
  const today = todayDateString();
  let needReconnect = false;
  if (!dbInstance || connectedDate !== today) {
    needReconnect = true;
  } else {
    try {
      dbInstance.prepare("SELECT 1").get();
    } catch {
      needReconnect = true;
    }
  }

  if (needReconnect) {
    if (dbInstance) {
      try {
        dbInstance.close();
      } catch {}
    }
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec("PRAGMA journal_mode=WAL;");
    dbInstance.exec("PRAGMA synchronous=NORMAL;");
    dbInstance.exec("PRAGMA busy_timeout=5000;");
    connectedDate = today;
  }
  return dbInstance;
}

function initializeDatabase() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      description TEXT NOT NULL,
      allocation_ratio REAL NOT NULL DEFAULT 0,
      allocated_capital INTEGER NOT NULL DEFAULT 0,
      virtual_krw INTEGER NOT NULL DEFAULT 0,
      is_running INTEGER NOT NULL DEFAULT 0,
      min_volume_krw INTEGER NOT NULL DEFAULT 0,
      stop_loss_pct REAL NOT NULL DEFAULT 0,
      take_profit_pct REAL NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_status_msg TEXT NOT NULL DEFAULT '대기 중',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      buy_order_uuid TEXT NOT NULL,
      sell_order_uuid TEXT,
      buy_price REAL NOT NULL,
      buy_volume TEXT NOT NULL,
      buy_amount INTEGER NOT NULL,
      buy_date TEXT NOT NULL,
      sell_price REAL,
      sell_volume TEXT,
      sell_amount INTEGER,
      sell_date TEXT,
      profit_krw INTEGER,
      profit_pct REAL,
      status TEXT NOT NULL DEFAULT 'HOLDING'
    );
    CREATE TABLE IF NOT EXISTS bot_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      market TEXT NOT NULL,
      order_uuid TEXT NOT NULL UNIQUE,
      volume TEXT NOT NULL,
      avg_buy_price REAL NOT NULL,
      buy_amount INTEGER NOT NULL,
      buy_fee REAL NOT NULL DEFAULT 0,
      trade_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_market_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT 'gemini-1.5-flash',
      btc_price REAL,
      btc_daily_20ma REAL,
      btc_4h_60ma REAL,
      regime_status TEXT,
      briefing_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crypto_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      published_at TEXT NOT NULL,
      summary TEXT,
      sentiment TEXT NOT NULL DEFAULT 'NEUTRAL',
      keywords TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_news_pubdate ON crypto_news (published_at DESC);
    CREATE TABLE IF NOT EXISTS ai_news_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite',
      news_count INTEGER NOT NULL DEFAULT 0,
      bullish_count INTEGER NOT NULL DEFAULT 0,
      bearish_count INTEGER NOT NULL DEFAULT 0,
      neutral_count INTEGER NOT NULL DEFAULT 0,
      briefing_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // 기존에 들어가 있던 샘플(seed) 데이터 및 매수 테스트(order-bid-* / auto-bid-*) 가상 이력 제거
  db.exec("DELETE FROM bot_positions WHERE order_uuid LIKE 'seed-%' OR order_uuid LIKE 'order-bid-%' OR order_uuid LIKE 'auto-bid-%';");
  db.exec("DELETE FROM trades WHERE buy_order_uuid LIKE 'seed-%' OR buy_order_uuid LIKE 'order-bid-%' OR buy_order_uuid LIKE 'auto-bid-%';");

  // 실제 매도되지 않고 테스트 버튼(order-ask-*)으로 잘못 매도 완료 처리된 내역을 미매도(HOLDING / OPEN) 상태로 복구
  db.exec(`
    UPDATE bot_positions
    SET status = 'OPEN', closed_at = NULL
    WHERE trade_id IN (SELECT id FROM trades WHERE sell_order_uuid LIKE 'order-ask-%');
  `);
  db.exec(`
    UPDATE trades
    SET sell_order_uuid = NULL,
        sell_price = NULL,
        sell_volume = NULL,
        sell_amount = NULL,
        sell_date = NULL,
        profit_krw = NULL,
        profit_pct = NULL,
        status = 'HOLDING'
    WHERE sell_order_uuid LIKE 'order-ask-%';
  `);

  // 테스트 이력 정리 및 복구 후 각 봇의 virtual_krw를 (allocated_capital - 실제 OPEN 포지션 투자금액)으로 동기화
  const allBotsForSync = db.prepare("SELECT bot_id, allocated_capital FROM bots").all();
  for (const b of allBotsForSync) {
    const inv = db
      .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
      .get(b.bot_id);
    const syncVirtual = Math.max(0, Math.floor(Number(b.allocated_capital || 0) - Number(inv?.invested || 0)));
    db.prepare("UPDATE bots SET virtual_krw = ? WHERE bot_id = ?").run(syncVirtual, b.bot_id);
  }

  const recommendedBots = [
    {
      bot_id: "bot_volatility",
      name: "필터 결합형 변동성 돌파 봇",
      nickname: "돌파봇-알파",
      strategy_type: "VOLATILITY_BREAKOUT",
      description: "장중 단타 / 1일 보유 | 변동성 돌파(K=0.4) + 20일 이평선 추세 필터 전략",
      allocation_ratio: 40,
      min_volume_krw: 10000000000,
      stop_loss_pct: 2.5,
      take_profit_pct: 4.5,
      config_json: JSON.stringify({
        k_value: 0.4,
        ma_period: 20,
        volume_multiplier: 1.2,
        order_ratio: 0.3,
      }),
    },
    {
      bot_id: "bot_dual_momentum",
      name: "듀얼 모멘텀 스윙 봇",
      nickname: "모멘텀봇-베타",
      strategy_type: "DUAL_MOMENTUM",
      description: "상대 모멘텀(상위 2종목) + 절대 모멘텀(+1.5% 이상) 스윙 전략",
      allocation_ratio: 40,
      min_volume_krw: 15000000000,
      stop_loss_pct: 3.5,
      take_profit_pct: 7.0,
      config_json: JSON.stringify({
        lookback_days: 8,
        abs_momentum_threshold_pct: 1.5,
        top_n: 2,
        order_ratio: 0.35,
      }),
    },
    {
      bot_id: "bot_bollinger_reversal",
      name: "고변동성 볼린저 밴드 역추세 봇",
      nickname: "볼린저봇-감마",
      strategy_type: "BOLLINGER_REVERSAL",
      description: "고변동성 코인 볼린저 밴드(20, 2.0σ) 15분봉 단기 반등 전략",
      allocation_ratio: 20,
      min_volume_krw: 8000000000,
      stop_loss_pct: 2.0,
      take_profit_pct: 3.5,
      config_json: JSON.stringify({
        bb_period: 20,
        bb_std: 2.0,
        bb_stddev: 2.0,
        candle_unit: "minutes/15",
        order_krw: 15000,
      }),
    },
  ];

  const now = nowKSTString();
  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM bots").get();
  if (countRow && countRow.cnt > 0) {
    // 봇 설정이 비어 있는 경우(min_volume_krw = 0 또는 nickname = '') 추천값으로 업데이트 저장
    const updateRecommended = db.prepare(`
      UPDATE bots
      SET nickname = CASE WHEN nickname = '' THEN ? ELSE nickname END,
          description = ?,
          allocation_ratio = CASE WHEN allocation_ratio = 0 THEN ? ELSE allocation_ratio END,
          min_volume_krw = CASE WHEN min_volume_krw = 0 THEN ? ELSE min_volume_krw END,
          stop_loss_pct = CASE WHEN stop_loss_pct = 0 THEN ? ELSE stop_loss_pct END,
          take_profit_pct = CASE WHEN take_profit_pct = 0 THEN ? ELSE take_profit_pct END,
          config_json = CASE WHEN config_json = '{}' OR config_json = '' THEN ? ELSE config_json END,
          updated_at = ?
      WHERE bot_id = ?
    `);
    for (const rb of recommendedBots) {
      updateRecommended.run(
        rb.nickname,
        rb.description,
        rb.allocation_ratio,
        rb.min_volume_krw,
        rb.stop_loss_pct,
        rb.take_profit_pct,
        rb.config_json,
        now,
        rb.bot_id
      );
    }
    return;
  }

  const setSetting = db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  setSetting.run("total_capital", "0", now);
  setSetting.run("capital_configured", "0", now);
  setSetting.run("zero_balance_halted", "0", now);
  setSetting.run("zero_balance_reason", "", now);
  setSetting.run("stats_start_date", "2026-10-01", now);
  setSetting.run("entry_code", "sws@2129", now);

  const insertBot = db.prepare(`
    INSERT INTO bots (
      bot_id, name, nickname, strategy_type, description,
      allocation_ratio, allocated_capital, virtual_krw, is_running,
      min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
      last_status_msg, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const rb of recommendedBots) {
    insertBot.run(
      rb.bot_id,
      rb.name,
      rb.nickname,
      rb.strategy_type,
      rb.description,
      rb.allocation_ratio,
      0,
      0,
      0,
      rb.min_volume_krw,
      rb.stop_loss_pct,
      rb.take_profit_pct,
      rb.config_json,
      "대기 중",
      now
    );
  }
}

initializeDatabase();

function getSetting(key, defaultVal = "") {
  const db = getDb();
  const row = db.prepare("SELECT value FROM system_settings WHERE key = ?").get(key);
  return row ? row.value : defaultVal;
}

function getBots() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM bots ORDER BY bot_id ASC").all();
  return rows.map((r) => {
    let config = {};
    try {
      config = JSON.parse(r.config_json || "{}");
    } catch {}
    const openPositions = db
      .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC")
      .all(r.bot_id);
    const usedCapital = Math.floor(
      openPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0)
    );
    return { ...r, config, open_positions: openPositions, used_capital: usedCapital };
  });
}

function recalculateAndApplyBotAllocations(flooredTotal, ratiosMap = null) {
  const db = getDb();
  const now = nowKSTString();
  const bots = getBots();
  const items = bots.map((b) => {
    const used = Math.floor(Number(b.used_capital || 0));
    const ratio = Math.max(
      0,
      Number(ratiosMap && ratiosMap[b.bot_id] !== undefined ? ratiosMap[b.bot_id] : b.allocation_ratio || 0)
    );
    const pnlRow = db
      .prepare("SELECT COALESCE(SUM(profit_krw), 0) AS total_pnl FROM trades WHERE bot_id = ? AND status = 'COMPLETED'")
      .get(b.bot_id);
    const realizedPnl = Math.floor(Number(pnlRow?.total_pnl || 0));
    return {
      bot_id: b.bot_id,
      used,
      ratio,
      realizedPnl,
      allocated: 0,
      virtual_krw: 0,
      locked: false,
    };
  });

  const totalUsed = items.reduce((acc, it) => acc + it.used, 0);

  if (flooredTotal <= 0) {
    for (const it of items) {
      db.prepare(
        "UPDATE bots SET allocation_ratio = ?, allocated_capital = 0, virtual_krw = 0, updated_at = ? WHERE bot_id = ?"
      ).run(it.ratio, now, it.bot_id);
    }
    return { totalUsed, totalAllocated: 0, totalVirtual: 0 };
  }

  const totalRatio = Number(items.reduce((acc, it) => acc + it.ratio, 0).toFixed(4));
  const targetPool =
    totalRatio >= 99.99
      ? flooredTotal
      : Math.max(totalUsed, Math.floor(flooredTotal * (totalRatio / 100.0)));

  // 이미 사용된 투자금(used)을 우선 반영하고, 잔여(신규 투입 포함) 투자금을 비율대로 분배하여
  // 전체 투자금 총액과 각 봇별 배정 원금(이미 사용 + 가용 잔고)의 합계가 정확히 일치하도록 계산
  while (true) {
    const unlocked = items.filter((it) => !it.locked);
    if (unlocked.length === 0) break;

    const lockedAllocatedSum = items
      .filter((it) => it.locked)
      .reduce((acc, it) => acc + it.allocated, 0);
    const remainingPool = Math.max(0, targetPool - lockedAllocatedSum);
    const unlockedRatioSum = unlocked.reduce((acc, it) => acc + it.ratio, 0);

    let anyNewlyLocked = false;
    for (const it of unlocked) {
      const share =
        unlockedRatioSum > 0
          ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
          : Math.floor(remainingPool / unlocked.length);
      if (it.used > share) {
        it.allocated = it.used;
        it.virtual_krw = 0;
        it.locked = true;
        anyNewlyLocked = true;
      }
    }

    if (!anyNewlyLocked) {
      let distributed = 0;
      for (const it of unlocked) {
        const share =
          unlockedRatioSum > 0
            ? Math.floor((remainingPool * it.ratio) / unlockedRatioSum)
            : 0;
        it.allocated = share;
        distributed += share;
      }
      const remainder = remainingPool - distributed;
      if (remainder > 0 && unlockedRatioSum > 0) {
        const candidates = [...unlocked]
          .filter((it) => it.ratio > 0)
          .sort((a, b) => b.ratio - a.ratio);
        if (candidates.length > 0) {
          candidates[0].allocated += remainder;
        }
      }
      for (const it of unlocked) {
        it.virtual_krw = Math.max(0, it.allocated - it.used);
        it.locked = true;
      }
      break;
    }
  }

  for (const it of items) {
    db.prepare(
      "UPDATE bots SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ? WHERE bot_id = ?"
    ).run(it.ratio, it.allocated, it.virtual_krw, now, it.bot_id);
  }

  return {
    totalUsed,
    totalAllocated: items.reduce((acc, it) => acc + it.allocated, 0),
    totalVirtual: items.reduce((acc, it) => acc + it.virtual_krw, 0),
  };
}

function checkAndHaltIfZeroBalance() {
  const db = getDb();
  const configured = getSetting("capital_configured", "0") === "1";
  if (!configured) {
    return { halted: false, reason: "" };
  }
  const totalCapital = Math.floor(Number(getSetting("total_capital", "0")));
  const bots = getBots();
  const totalVirtual = bots.reduce((acc, b) => acc + Number(b.virtual_krw || 0), 0);
  const openPosCnt = db.prepare("SELECT COUNT(*) AS cnt FROM bot_positions WHERE status = 'OPEN'").get().cnt;

  let shouldHalt = false;
  let reason = "";
  if (totalCapital <= 0) {
    shouldHalt = true;
    reason = `설정된 운용 원금(${totalCapital.toLocaleString()}원)이 0원 이하이므로 모든 봇이 자동 거래 중지되었습니다.`;
  } else if (totalVirtual <= 0 && openPosCnt === 0) {
    shouldHalt = true;
    reason = `가용 가상 잔고(${totalVirtual.toLocaleString()}원)가 0원 이하로 떨어져 모든 봇이 자동 거래 중지되었습니다.`;
  }

  if (shouldHalt) {
    const now = nowKSTString();
    db.prepare("UPDATE bots SET is_running = 0, last_status_msg = ?, updated_at = ?").run(
      "잔고 0 이하 도달로 긴급 자동 중지됨",
      now
    );
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '1', ?)").run(now);
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', ?, ?)").run(reason, now);
    return { halted: true, reason };
  }
  return {
    halted: getSetting("zero_balance_halted", "0") === "1",
    reason: getSetting("zero_balance_reason", ""),
  };
}

function createUpbitJwt(accessKey, secretKey, queryParams = null) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadObj = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    payloadObj.query_hash = crypto.createHash("sha512").update(qs, "utf-8").digest("hex");
    payloadObj.query_hash_alg = "SHA512";
  }
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

let cachedValidKrwMarkets = new Set();

async function getValidKrwMarkets(timeoutMs = 5000) {
  if (cachedValidKrwMarkets.size > 0) {
    return cachedValidKrwMarkets;
  }
  try {
    await new Promise((r) => setTimeout(r, 120));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/market/all?isDetails=false", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 200) {
      const list = await resp.json();
      if (Array.isArray(list)) {
        cachedValidKrwMarkets = new Set(
          list.map((m) => m.market).filter((m) => typeof m === "string" && m.startsWith("KRW-"))
        );
      }
    }
  } catch {}
  return cachedValidKrwMarkets;
}

async function fetchUpbitAccountBalance() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

  const accessKey = String(cfg.access_key || "").trim();
  const secretKey = String(cfg.secret_key || "").trim();
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const checkedAt = nowKSTString();

  if (
    !accessKey ||
    !secretKey ||
    accessKey === "YOUR_UPBIT_ACCESS_KEY" ||
    secretKey === "YOUR_UPBIT_SECRET_KEY"
  ) {
    return {
      success: false,
      krw_balance: null,
      orderable_krw: null,
      total_buy_krw: null,
      total_eval_krw: null,
      eval_profit_krw: null,
      eval_profit_pct: null,
      krw_locked: null,
      krw_total: null,
      message: "업비트 Open API Key가 설정되지 않았습니다 (config/upbit_config.json 확인 필요)",
      checked_at: checkedAt,
    };
  }

  try {
    await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
    const token = createUpbitJwt(accessKey, secretKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/accounts", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.status === 200) {
      const accounts = await resp.json();
      const accList = Array.isArray(accounts) ? accounts : [];
      const krwAcc = accList.find((a) => a.currency === "KRW") || null;
      const available = Math.floor(Number(krwAcc?.balance || 0));
      const locked = Math.floor(Number(krwAcc?.locked || 0));
      const total = Math.floor(Number(krwAcc?.balance || 0) + Number(krwAcc?.locked || 0));

      const coinHoldings = accList.filter(
        (a) =>
          a.currency !== "KRW" &&
          Number(a.balance || 0) + Number(a.locked || 0) > 0
      );

      let totalBuySum = 0;
      let totalEvalSum = 0;

      if (coinHoldings.length > 0) {
        const validMarkets = await getValidKrwMarkets(timeoutMs);
        const targetMarkets = coinHoldings
          .map((a) => `KRW-${a.currency}`)
          .filter((m) => validMarkets.size === 0 || validMarkets.has(m));

        const priceMap = new Map();
        if (targetMarkets.length > 0) {
          try {
            await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
            const tCtrl = new AbortController();
            const tTimer = setTimeout(() => tCtrl.abort(), timeoutMs);
            const tResp = await fetch(
              `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(targetMarkets.join(","))}`,
              { signal: tCtrl.signal }
            );
            clearTimeout(tTimer);
            if (tResp.status === 200) {
              const tickers = await tResp.json();
              if (Array.isArray(tickers)) {
                for (const tk of tickers) {
                  priceMap.set(tk.market, Number(tk.trade_price || 0));
                }
              }
            }
          } catch {}
        }

        for (const c of coinHoldings) {
          const qty = Number(c.balance || 0) + Number(c.locked || 0);
          const avgBuyPrice = Number(c.avg_buy_price || 0);
          const buyAmt = qty * avgBuyPrice;
          const mkt = `KRW-${c.currency}`;
          const curPrice = priceMap.has(mkt) ? priceMap.get(mkt) : avgBuyPrice;
          const evalAmt = qty * curPrice;

          totalBuySum += buyAmt;
          totalEvalSum += evalAmt;
        }
      }

      const totalBuyKrw = Math.floor(totalBuySum);
      const totalEvalKrw = Math.floor(totalEvalSum);
      const totalAssetKrw = Math.floor(total + totalEvalSum);
      const evalProfitKrw = totalEvalKrw - totalBuyKrw;
      const evalProfitPct =
        totalBuyKrw > 0 ? Number(((evalProfitKrw / totalBuyKrw) * 100).toFixed(2)) : 0;

      return {
        success: true,
        krw_balance: available,
        orderable_krw: available,
        total_buy_krw: totalBuyKrw,
        total_eval_krw: totalEvalKrw,
        total_asset_krw: totalAssetKrw,
        eval_profit_krw: evalProfitKrw,
        eval_profit_pct: evalProfitPct,
        krw_locked: locked,
        krw_total: total,
        message: "업비트 실계좌 자산 및 잔고 조회 완료",
        checked_at: checkedAt,
      };
    } else {
      const errBody = await resp.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || errBody?.error?.name || `HTTP ${resp.status}`;
      return {
        success: false,
        krw_balance: null,
        orderable_krw: null,
        total_buy_krw: null,
        total_eval_krw: null,
        total_asset_krw: null,
        eval_profit_krw: null,
        eval_profit_pct: null,
        krw_locked: null,
        krw_total: null,
        message: `업비트 계좌 잔고 조회 실패: ${errMsg}`,
        checked_at: checkedAt,
      };
    }
  } catch (err) {
    return {
      success: false,
      krw_balance: null,
      orderable_krw: null,
      total_buy_krw: null,
      total_eval_krw: null,
      total_asset_krw: null,
      eval_profit_krw: null,
      eval_profit_pct: null,
      krw_locked: null,
      krw_total: null,
      message: `업비트 계좌 잔고 조회 통신 오류: ${err.message}`,
      checked_at: checkedAt,
    };
  }
}

async function checkUpbitStatus() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  const delayThreshold = Number(cfg.delay_threshold_ms || 800);
  const timeoutMs = Number(cfg.request_timeout_sec || 5) * 1000;
  const start = Date.now();
  const checkedAt = nowKSTString();

  try {
    await new Promise((r) => setTimeout(r, 120)); // Rate limit 0.12s
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://api.upbit.com/v1/market/all?isDetails=false", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;

    if (resp.status === 200) {
      if (elapsed >= delayThreshold) {
        return {
          status: "yellow",
          color: "yellow",
          label: "통신지연",
          latency_ms: elapsed,
          reason: `업비트 API 응답 지연 감지 (${elapsed}ms / 기준 ${delayThreshold}ms 초과)`,
          checked_at: checkedAt,
        };
      }
      return {
        status: "green",
        color: "green",
        label: "정상통신",
        latency_ms: elapsed,
        reason: `업비트 Open API 서버 정상 응답 (${elapsed}ms)`,
        checked_at: checkedAt,
      };
    }
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: elapsed,
      reason: `업비트 Open API 서버 오류 응답 (HTTP ${resp.status})`,
      checked_at: checkedAt,
    };
  } catch (err) {
    return {
      status: "red",
      color: "red",
      label: "통신불가",
      latency_ms: Date.now() - start,
      reason: `업비트 Open API 서버 연결 실패: ${err.message}`,
      checked_at: checkedAt,
    };
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function getGeminiApiKey() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  if (cfg.gemini_api_key && cfg.gemini_api_key !== "YOUR_GEMINI_API_KEY_HERE" && cfg.gemini_api_key.trim().length > 0) {
    return cfg.gemini_api_key.trim();
  }
  const dbKey = getSetting("gemini_api_key", "");
  if (dbKey && dbKey.trim().length > 0) {
    return dbKey.trim();
  }
  return (process.env.GEMINI_API_KEY || "").trim();
}

function saveGeminiApiKey(key) {
  const cleanKey = (key || "").trim();
  try {
    let cfg = {};
    if (fs.existsSync(CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
    cfg.gemini_api_key = cleanKey;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write to config/upbit_config.json:", err.message);
  }
  const now = nowKSTString();
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)").run(cleanKey, now);
  return cleanKey;
}

function getLatestAiBriefing() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ai_market_briefings ORDER BY id DESC LIMIT 1").get();
  const apiKey = getGeminiApiKey();
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "";
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: row || null,
  };
}

function getLatestAiNewsBriefing() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ai_news_briefings ORDER BY id DESC LIMIT 1").get();
  const apiKey = getGeminiApiKey();
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "";
  return {
    has_key: !!apiKey,
    masked_key: maskedKey,
    latest: row || null,
  };
}

async function generateAiMarketAnalysis() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: "NO_API_KEY",
      message: "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
    };
  }

  // 1. 시장 체제 데이터 (BTC 이평선 등)
  const regimeFilter = await checkMarketRegimeFilter();
  const btcPrice = Number(regimeFilter.btcPrice || 0);
  const btcDaily20Ma = Number(regimeFilter.ma20Day || 0);
  const btc4h60Ma = Number(regimeFilter.ma60_4h || 0);
  const isHoldCash = regimeFilter.allowBuy === false;
  const regimeReason = regimeFilter.reason || "";

  // 2. 업비트 실계좌 자산 데이터
  const accInfo = await fetchUpbitAccountBalance();
  const totalBuyKrw = Number(accInfo.total_buy_krw || 0);
  const totalEvalKrw = Number(accInfo.total_eval_krw || 0);
  const evalProfitPct = accInfo.eval_profit_pct !== null ? accInfo.eval_profit_pct : 0;
  const orderableKrw = Number(accInfo.orderable_krw || 0);

  // 3. 봇별 가동 및 보유 포지션 데이터
  const bots = getBots();
  const db = getDb();
  const botsData = bots.map((b) => {
    const openPositions = db
      .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC")
      .all(b.bot_id);
    return {
      id: b.bot_id,
      name: b.name,
      nickname: b.nickname,
      strategy_type: b.strategy_type,
      allocated_capital: b.allocated_capital,
      virtual_krw: b.virtual_krw,
      used_capital: b.used_capital,
      is_running: b.is_running === 1,
      last_status_msg: b.last_status_msg,
      open_positions: openPositions.map((p) => ({
        market: p.market,
        buy_amount: p.buy_amount,
        avg_buy_price: p.avg_buy_price,
        volume: p.volume,
        created_at: p.created_at,
      })),
    };
  });

  // 4. 주요 코인 실시간 시세 (BTC, ETH, SOL, DOGE, XRP)
  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-DOGE", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%, 24시간 거래대금 ${Math.floor(Number(t.acc_trade_price_24h) / 100000000).toLocaleString(
              "ko-KR"
            )}억원)`
        )
        .join("\n");
    }
  } catch (err) {
    tickerInfo = "- 주요 종목 시세 수신 일시 지연";
  }

  // 5. 종합 프롬프트 구성
  const nowStr = nowKSTString();
  const prompt = `당신은 대한민국 최고 수준의 가상자산 퀀트 트레이딩 시스템 'Upbit AutoCoinTrade'의 수석 AI 마켓 애널리스트입니다.
아래는 ${nowStr} 기준, 시스템이 업비트 실거래소와 3개 자동매매 봇 엔진에서 실시간으로 수집한 팩트 데이터입니다.

이 데이터를 바탕으로 사용자가 현재 코인 시장 상황과 봇들의 움직임(왜 매수를 멈추고 있는지, 왜 특정 코인을 보유 중인지)을 명확하게 납득할 수 있도록 전문적이면서도 친절하고 신뢰감 넘치는 마켓 브리핑을 작성해주세요.

### [실시간 수집 팩트 데이터]
1. 비트코인 시장 체제 지표:
- 비트코인(KRW-BTC) 현재가: ${btcPrice ? btcPrice.toLocaleString("ko-KR") + "원" : "데이터 수신 중"}
- 일봉 20일 이동평균선(20 MA): ${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"} (괴리율: ${
    btcPrice && btcDaily20Ma ? (((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100).toFixed(2) + "%" : "-"
  })
- 4시간봉 60선(60 MA): ${btc4h60Ma ? Math.floor(btc4h60Ma).toLocaleString("ko-KR") + "원" : "-"} (괴리율: ${
    btcPrice && btc4h60Ma ? (((btcPrice - btc4h60Ma) / btc4h60Ma) * 100).toFixed(2) + "%" : "-"
  })
- 시장 체제 필터(Regime Filter) 상태: ${
    isHoldCash ? "🔴 신규 매수 전면 차단 / 현금 보유(Hold Cash) 발동 중" : "🟢 정상 거래 허용 (상승 추세)"
  }
- 필터 사유: ${regimeReason}

2. 주요 코인 시세 현황:
${tickerInfo}

3. 업비트 계좌 현황:
- 총 매수금액: ${totalBuyKrw.toLocaleString("ko-KR")}원
- 총 평가금액: ${totalEvalKrw.toLocaleString("ko-KR")}원 (평가손익률: ${evalProfitPct}%)
- 주문가능 현금: ${orderableKrw.toLocaleString("ko-KR")}원

4. 3개 봇 실시간 상태:
${botsData
  .map(
    (b) => `[${b.nickname} (${b.name})]
- 전략: ${b.strategy_type}
- 가동 상태: ${b.is_running ? "가동 중 (ON)" : "중지됨 (OFF)"}
- 배정 원금: ${b.allocated_capital.toLocaleString("ko-KR")}원 / 사용 중인 금액: ${b.used_capital.toLocaleString(
      "ko-KR"
    )}원 / 가용 잔고: ${b.virtual_krw.toLocaleString("ko-KR")}원
- 최신 상태 메시지: ${b.last_status_msg}
- 보유 포지션 수: ${b.open_positions.length}건
${b.open_positions
  .map(
    (p) =>
      `  * 종목: ${p.market}, 매수금액: ${p.buy_amount.toLocaleString("ko-KR")}원, 매수가: ${Number(
        p.avg_buy_price
      ).toLocaleString("ko-KR")}원, 매수시각: ${p.created_at}`
  )
  .join("\n")}`
  )
  .join("\n\n")}

---

### [작성 요청 가이드라인 및 필수 준수사항]
반드시 다음 3개 섹션 구조와 마크다운(Markdown) 서식으로 작성하세요:
절대로 중간에 생략하거나 끊기지 말고, 3개 섹션을 모두 끝까지 완벽하게 완결하여 작성해야 합니다.

## 1. 📊 시장 체제(Regime) 종합 진단
- 비트코인의 현재가와 일봉 20MA / 4시간 60MA 위치를 근거로 현재 시장이 하락/조정 장세인지, 횡보/관망 장세인지, 상승장인지 명확히 진단해주세요.
- 왜 전 봇에 '신규 매수 차단(Hold Cash)'이 내려졌는지, 이것이 계좌 보호에 왜 중요한지 설명해주세요.

## 2. 🤖 봇별 행동 및 움직임 상세 분석 (3개 봇 모두 반드시 개별 서술)
- **돌파봇-알파 (변동성 돌파)**: 현재 가동 상태, 보유 포지션 수, 왜 신규 매수를 진입하지 않고 현금을 보존하고 있는지 상세 원인 분석
- **모멘텀봇-베타 (듀얼 모멘텀)**: 현재 가동 상태, 보유 포지션 수, 모멘텀 조건 미달 사유 및 관망 이유 상세 분석
- **볼린저봇-감마 (볼린저 역추세)**: 현재 가동 상태, 보유 중인 종목(예: SOL, DOGE 등)의 진입가, 현재가, 평가 손익 현황과 향후 익절(+3.5%)/손절(-2.0%) 감시 대응 전략을 빠짐없이 상세 분석

## 3. 💡 향후 체크포인트 & 운용 가이드
- 비트코인이 대략 어느 가격대(일봉 20MA 등)를 넘어서야 봇들이 다시 적극적으로 매수를 재개하는지 구체적 가격 제시
- 사용자에게 당부하는 리스크 관리 및 심리적 조언 한마디

이모지와 깔끔한 불릿포인트, 굵은 글씨를 활용하여 가독성을 극대화해주세요.`;

  // 6. Gemini API 호출 (최신 사용 가능 모델 자동 탐색 & 폴백)
  const candidateModels = [
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
  ];

  let chosenModel = "gemini-3.5-flash";
  let analysisText = "";
  let lastErrorMsg = "";

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`;
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 35000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });
      clearTimeout(timeoutTimer);

      if (response.ok) {
        const resJson = await response.json();
        const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          chosenModel = model;
          analysisText = text;
          break;
        }
      } else {
        const errText = await response.text();
        console.warn(`[Gemini API] Model ${model} failed (HTTP ${response.status}):`, errText);
        try {
          const errJson = JSON.parse(errText);
          lastErrorMsg = errJson?.error?.message || `HTTP ${response.status}`;
        } catch {
          lastErrorMsg = `HTTP ${response.status}: ${errText}`;
        }
      }
    } catch (reqErr) {
      console.warn(`[Gemini API] Request exception for model ${model}:`, reqErr.message);
      lastErrorMsg = reqErr.message;
    }
  }

  if (!analysisText) {
    return {
      success: false,
      error: "API_CALL_FAILED",
      message: `Gemini API 호출 실패: ${lastErrorMsg || "응답 텍스트를 생성하지 못했습니다."}`,
    };
  }

  // 7. DB 저장
  const insertStmt = db.prepare(`
    INSERT INTO ai_market_briefings (
      provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertStmt.run(
    "gemini",
    chosenModel,
    btcPrice,
    btcDaily20Ma,
    btc4h60Ma,
    isHoldCash ? "HOLD_CASH" : "NORMAL",
    analysisText,
    nowStr
  );

  return {
    success: true,
    briefing: {
      id: info.lastInsertRowid,
      provider: "gemini",
      model: chosenModel,
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: isHoldCash ? "HOLD_CASH" : "NORMAL",
      briefing_text: analysisText,
      created_at: nowStr,
    },
  };
}

async function generateAiMarketAnalysisStream(req, res) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "NO_API_KEY",
        message: "Gemini API 키가 등록되지 않았습니다. config/upbit_config.json 파일의 gemini_api_key 항목에 키를 입력하시거나 웹 화면에서 등록해주세요.",
      })
    );
    return;
  }

  // 1. 시장 체제 데이터
  const regimeFilter = await checkMarketRegimeFilter();
  const btcPrice = Number(regimeFilter.btcPrice || 0);
  const btcDaily20Ma = Number(regimeFilter.ma20Day || 0);
  const btc4h60Ma = Number(regimeFilter.ma60_4h || 0);
  const isHoldCash = regimeFilter.allowBuy === false;
  const regimeReason = regimeFilter.reason || "";

  // 2. 업비트 실계좌 자산 데이터
  const accInfo = await fetchUpbitAccountBalance();
  const totalBuyKrw = Number(accInfo.total_buy_krw || 0);
  const totalEvalKrw = Number(accInfo.total_eval_krw || 0);
  const evalProfitPct = accInfo.eval_profit_pct !== null ? accInfo.eval_profit_pct : 0;
  const orderableKrw = Number(accInfo.orderable_krw || 0);

  // 3. 봇별 가동 및 보유 포지션 데이터
  const bots = getBots();
  const db = getDb();
  const botsData = bots.map((b) => {
    const openPositions = db
      .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN' ORDER BY id DESC")
      .all(b.bot_id);
    return {
      id: b.bot_id,
      name: b.name,
      nickname: b.nickname,
      strategy_type: b.strategy_type,
      allocated_capital: b.allocated_capital,
      virtual_krw: b.virtual_krw,
      used_capital: b.used_capital,
      is_running: b.is_running === 1,
      last_status_msg: b.last_status_msg,
      open_positions: openPositions.map((p) => ({
        market: p.market,
        buy_amount: p.buy_amount,
        avg_buy_price: p.avg_buy_price,
        volume: p.volume,
        created_at: p.created_at,
      })),
    };
  });

  // 4. 주요 코인 실시간 시세
  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-DOGE", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%, 24시간 거래대금 ${Math.floor(Number(t.acc_trade_price_24h) / 100000000).toLocaleString(
              "ko-KR"
            )}억원)`
        )
        .join("\n");
    }
  } catch (err) {
    tickerInfo = "- 주요 종목 시세 수신 일시 지연";
  }

  // 5. 프롬프트 구성
  const nowStr = nowKSTString();
  const prompt = `당신은 대한민국 최고 수준의 가상자산 퀀트 트레이딩 시스템 'Upbit AutoCoinTrade'의 수석 AI 마켓 애널리스트입니다.
아래는 ${nowStr} 기준, 시스템이 업비트 실거래소와 3개 자동매매 봇 엔진에서 실시간으로 수집한 팩트 데이터입니다.

이 데이터를 바탕으로 사용자가 현재 코인 시장 상황과 봇들의 움직임(왜 매수를 멈추고 있는지, 왜 특정 코인을 보유 중인지)을 명확하게 납득할 수 있도록 전문적이면서도 친절하고 신뢰감 넘치는 마켓 브리핑을 작성해주세요.

### [실시간 수집 팩트 데이터]
1. 비트코인 시장 체제 지표:
- 비트코인(KRW-BTC) 현재가: ${btcPrice ? btcPrice.toLocaleString("ko-KR") + "원" : "데이터 수신 중"}
- 일봉 20일 이동평균선(20 MA): ${btcDaily20Ma ? Math.floor(btcDaily20Ma).toLocaleString("ko-KR") + "원" : "-"} (괴리율: ${
    btcPrice && btcDaily20Ma ? (((btcPrice - btcDaily20Ma) / btcDaily20Ma) * 100).toFixed(2) + "%" : "-"
  })
- 4시간봉 60선(60 MA): ${btc4h60Ma ? Math.floor(btc4h60Ma).toLocaleString("ko-KR") + "원" : "-"} (괴리율: ${
    btcPrice && btc4h60Ma ? (((btcPrice - btc4h60Ma) / btc4h60Ma) * 100).toFixed(2) + "%" : "-"
  })
- 시장 체제 필터(Regime Filter) 상태: ${
    isHoldCash ? "🔴 신규 매수 전면 차단 / 현금 보유(Hold Cash) 발동 중" : "🟢 정상 거래 허용 (상승 추세)"
  }
- 필터 사유: ${regimeReason}

2. 주요 코인 시세 현황:
${tickerInfo}

3. 업비트 계좌 현황:
- 총 매수금액: ${totalBuyKrw.toLocaleString("ko-KR")}원
- 총 평가금액: ${totalEvalKrw.toLocaleString("ko-KR")}원 (평가손익률: ${evalProfitPct}%)
- 주문가능 현금: ${orderableKrw.toLocaleString("ko-KR")}원

4. 3개 봇 실시간 상태:
${botsData
  .map(
    (b) => `[${b.nickname} (${b.name})]
- 전략: ${b.strategy_type}
- 가동 상태: ${b.is_running ? "가동 중 (ON)" : "중지됨 (OFF)"}
- 배정 원금: ${b.allocated_capital.toLocaleString("ko-KR")}원 / 사용 중인 금액: ${b.used_capital.toLocaleString(
      "ko-KR"
    )}원 / 가용 잔고: ${b.virtual_krw.toLocaleString("ko-KR")}원
- 최신 상태 메시지: ${b.last_status_msg}
- 보유 포지션 수: ${b.open_positions.length}건
${b.open_positions
  .map(
    (p) =>
      `  * 종목: ${p.market}, 매수금액: ${p.buy_amount.toLocaleString("ko-KR")}원, 매수가: ${Number(
        p.avg_buy_price
      ).toLocaleString("ko-KR")}원, 매수시각: ${p.created_at}`
  )
  .join("\n")}`
  )
  .join("\n\n")}

---

### [작성 요청 가이드라인 및 필수 준수사항]
반드시 다음 3개 섹션 구조와 마크다운(Markdown) 서식으로 작성하세요:
절대로 중간에 생략하거나 끊기지 말고, 3개 섹션을 모두 끝까지 완벽하게 완결하여 작성해야 합니다.

## 1. 📊 시장 체제(Regime) 종합 진단
- 비트코인의 현재가와 일봉 20MA / 4시간 60MA 위치를 근거로 현재 시장이 하락/조정 장세인지, 횡보/관망 장세인지, 상승장인지 명확히 진단해주세요.
- 왜 전 봇에 '신규 매수 차단(Hold Cash)'이 내려졌는지, 이것이 계좌 보호에 왜 중요한지 설명해주세요.

## 2. 🤖 봇별 행동 및 움직임 상세 분석 (3개 봇 모두 반드시 개별 서술)
- **돌파봇-알파 (변동성 돌파)**: 현재 가동 상태, 보유 포지션 수, 왜 신규 매수를 진입하지 않고 현금을 보존하고 있는지 상세 원인 분석
- **모멘텀봇-베타 (듀얼 모멘텀)**: 현재 가동 상태, 보유 포지션 수, 왜 진입하지 않고 대기 중인지 상세 원인 분석
- **볼린저봇-감마 (볼린저 역추세)**: 현재 가동 상태, 보유 중인 종목(예: SOL, DOGE 등)의 진입가, 현재가, 평가 손익 현황과 향후 익절(+3.5%)/손절(-2.0%) 감시 대응 전략을 빠짐없이 상세 분석

## 3. 💡 향후 체크포인트 & 운용 가이드
- 비트코인이 대략 어느 가격대(일봉 20MA 등)를 넘어서야 봇들이 다시 적극적으로 매수를 재개하는지 구체적 가격 제시
- 사용자에게 당부하는 리스크 관리 및 심리적 조언 한마디

이모지와 깔끔한 불릿포인트, 굵은 글씨를 활용하여 가독성을 극대화해주세요.`;

  const candidateModels = [
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
  ];

  let geminiResp = null;
  let chosenModel = candidateModels[0];

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
        apiKey
      )}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });
      if (resp.ok) {
        geminiResp = resp;
        chosenModel = model;
        break;
      } else {
        const errTxt = await resp.text();
        console.warn(`[Gemini Stream] Model ${model} failed (HTTP ${resp.status}):`, errTxt);
      }
    } catch (e) {
      console.warn(`[Gemini Stream] Exception with model ${model}:`, e.message);
    }
  }

  if (!geminiResp) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "API_CALL_FAILED",
        message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패했습니다.",
      })
    );
    return;
  }

  // SSE 헤더 전송
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // 메타데이터 이벤트 전송
  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      btc_price: btcPrice,
      btc_daily_20ma: btcDaily20Ma,
      btc_4h_60ma: btc4h60Ma,
      regime_status: isHoldCash ? "HOLD_CASH" : "NORMAL",
      model: chosenModel,
      created_at: nowStr,
    })}\n\n`
  );

  const reader = geminiResp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop(); // keep partial line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (delta) {
              fullText += delta;
              res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
            }
          } catch {}
        }
      }
    }

    // Flush any remaining buffer
    if (sseBuffer.trim().startsWith("data:")) {
      const jsonStr = sseBuffer.trim().slice(5).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
        }
      } catch {}
    }

    // DB 저장
    const insertStmt = db.prepare(`
      INSERT INTO ai_market_briefings (
        provider, model, btc_price, btc_daily_20ma, btc_4h_60ma, regime_status, briefing_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insertStmt.run(
      "gemini",
      chosenModel,
      btcPrice,
      btcDaily20Ma,
      btc4h60Ma,
      isHoldCash ? "HOLD_CASH" : "NORMAL",
      fullText,
      nowStr
    );

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: info.lastInsertRowid,
        model: chosenModel,
        full_text: fullText,
        created_at: nowStr,
      })}\n\n`
    );
    res.end();
  } catch (streamErr) {
    console.error("Error during streaming Gemini response:", streamErr);
    res.write(`data: ${JSON.stringify({ type: "error", message: streamErr.message })}\n\n`);
    res.end();
  }
}

async function generateAiNewsAnalysisStream(req, res) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "NO_API_KEY",
        message: "Gemini API 키가 등록되지 않았습니다. 설정 화면에서 API 키를 등록해주세요.",
      })
    );
    return;
  }

  const db = getDb();
  const topNews = db
    .prepare(
      "SELECT title, source, published_at, sentiment, keywords, summary FROM crypto_news ORDER BY published_at DESC, id DESC LIMIT 25"
    )
    .all();

  const countRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sentiment = 'BULLISH' THEN 1 ELSE 0 END) AS bull,
      SUM(CASE WHEN sentiment = 'BEARISH' THEN 1 ELSE 0 END) AS bear,
      SUM(CASE WHEN sentiment = 'NEUTRAL' THEN 1 ELSE 0 END) AS neut
    FROM crypto_news
  `).get();

  const totalNews = Number(countRow?.total || 0);
  const bullCount = Number(countRow?.bull || 0);
  const bearCount = Number(countRow?.bear || 0);
  const neutCount = Number(countRow?.neut || 0);

  // 주요 코인 실시간 시세
  let tickerInfo = "";
  try {
    const targetMarkets = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"];
    const tResp = await fetch(`https://api.upbit.com/v1/ticker?markets=${targetMarkets.join(",")}`);
    if (tResp.ok) {
      const tickers = await tResp.json();
      tickerInfo = tickers
        .map(
          (t) =>
            `- ${t.market}: 현재가 ${Number(t.trade_price).toLocaleString("ko-KR")}원 (전일대비 ${(
              Number(t.signed_change_rate) * 100
            ).toFixed(2)}%)`
        )
        .join("\n");
    }
  } catch {}

  const newsSummaryList = topNews
    .map(
      (n, i) =>
        `${i + 1}. [${n.sentiment}] ${n.title} (출처: ${n.source}, 일시: ${n.published_at})${
          n.keywords ? ` [태그: ${n.keywords}]` : ""
        }`
    )
    .join("\n");

  const nowStr = nowKSTString();
  const prompt = `당신은 대한민국 최고 수준의 가상자산 퀀트 투자 시스템 'Upbit AutoCoinTrade'의 수석 AI 뉴스 & 센티먼트 애널리스트입니다.
아래는 ${nowStr} 기준, 시스템이 국내외 주요 암호화폐 언론사(Google News, TokenPost 등)로부터 실시간 수집한 최신 뉴스 및 시장 통계 데이터입니다.

### [실시간 수집 뉴스 데이터 및 시장 통계]
1. 뉴스 감성 통계:
- 총 수집 뉴스: ${totalNews}건
- 호재(상승) 감성: ${bullCount}건 (${totalNews > 0 ? ((bullCount / totalNews) * 100).toFixed(1) : 0}%)
- 악재(하락) 감성: ${bearCount}건 (${totalNews > 0 ? ((bearCount / totalNews) * 100).toFixed(1) : 0}%)
- 중립(시황) 감성: ${neutCount}건 (${totalNews > 0 ? ((neutCount / totalNews) * 100).toFixed(1) : 0}%)

2. 주요 코인 실시간 시세:
${tickerInfo || "- 시세 수신 중"}

3. 최근 주요 뉴스 헤드라인 (상위 25건):
${newsSummaryList}

---

### [작성 요청 가이드라인]
위 수집된 실시간 뉴스와 감성 데이터를 정밀 분석하여, 투자자가 현재 시장의 핵심 쟁점과 향후 가격 방향성을 한눈에 파악할 수 있도록 마크다운(Markdown) 서식으로 다음 3개 섹션을 명확하고 전문적으로 작성해주세요:

## 1. 📰 실시간 뉴스 핵심 쟁점 및 센티먼트 종합 진단
- 현재 수집된 뉴스에서 가장 지배적인 이슈(예: 특정 거래소 이슈, 규제/정책, ETF 동향 등)를 명확히 짚어주세요.
- 호재와 악재의 비중 및 시장 참여자들의 심리(탐욕 vs 공포) 상태를 분석해주세요.

## 2. ⚖️ 시장 충격도 & 단기 시황 전망
- 수집된 뉴스가 비트코인(BTC) 및 메이저 알트코인에 미치는 실제 파급력(일시적 노이즈 vs 중장기 추세 영향)을 진단해주세요.
- 단기적으로 주목해야 할 지지선 및 변동성 확대 가능성을 제시해주세요.

## 3. 🎯 퀀트 트레이딩 봇 운용 및 리스크 관리 전략
- 현재와 같은 뉴스 환경에서 3개 자동매매 봇(변동성 돌파, 듀얼 모멘텀, 볼린저 역추세)이 어떤 포지션을 취해야 하는지 구체적인 가이드를 제공해주세요.
- 무리한 추격 매수를 자제하고 리스크를 방어해야 하는 이유와 실전 투자 조언을 전달해주세요.

문장은 신뢰감 있고 가독성 높게, 적절한 불릿포인트와 이모지를 활용해주세요.`;

  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-flash-latest",
  ];

  let geminiResp = null;
  let chosenModel = candidateModels[0];

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
        apiKey
      )}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });
      if (resp.ok) {
        geminiResp = resp;
        chosenModel = model;
        break;
      } else {
        const errTxt = await resp.text();
        console.warn(`[Gemini News Stream] Model ${model} failed (HTTP ${resp.status}):`, errTxt);
      }
    } catch (e) {
      console.warn(`[Gemini News Stream] Exception with model ${model}:`, e.message);
    }
  }

  if (!geminiResp) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify({
        success: false,
        error: "API_CALL_FAILED",
        message: "사용 가능한 Gemini 스트리밍 모델 연결에 실패했습니다.",
      })
    );
    return;
  }

  // SSE 헤더 전송
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // 메타데이터 이벤트 전송
  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      model: chosenModel,
      news_count: totalNews,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: neutCount,
      created_at: nowStr,
    })}\n\n`
  );

  const reader = geminiResp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (delta) {
              fullText += delta;
              res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
            }
          } catch {}
        }
      }
    }

    if (sseBuffer.trim().startsWith("data:")) {
      const jsonStr = sseBuffer.trim().slice(5).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: delta })}\n\n`);
        }
      } catch {}
    }

    // DB 저장
    const insertStmt = db.prepare(`
      INSERT INTO ai_news_briefings (
        provider, model, news_count, bullish_count, bearish_count, neutral_count, briefing_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insertStmt.run(
      "gemini",
      chosenModel,
      totalNews,
      bullCount,
      bearCount,
      neutCount,
      fullText,
      nowStr
    );

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        id: info.lastInsertRowid,
        model: chosenModel,
        news_count: totalNews,
        bullish_count: bullCount,
        bearish_count: bearCount,
        neutral_count: neutCount,
        full_text: fullText,
        created_at: nowStr,
      })}\n\n`
    );
    res.end();
  } catch (streamErr) {
    console.error("Error during streaming Gemini news response:", streamErr);
    res.write(`data: ${JSON.stringify({ type: "error", message: streamErr.message })}\n\n`);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;
  const db = getDb();

  try {
    if (pathname === "/api/auth/verify" && req.method === "POST") {
      const body = await readJsonBody(req);
      const expected = getSetting("entry_code", "sws@2129");
      if (body.code === expected) {
        return sendJson(res, 200, { authenticated: true, message: "인증 성공" });
      }
      return sendJson(res, 401, { authenticated: false, message: "입장 코드가 일치하지 않습니다." });
    }

    if (pathname === "/api/upbit/status" && req.method === "GET") {
      const status = await checkUpbitStatus();
      return sendJson(res, 200, status);
    }

    if (pathname === "/api/upbit/account" && req.method === "GET") {
      const accountInfo = await fetchUpbitAccountBalance();
      return sendJson(res, 200, accountInfo);
    }

    if (pathname === "/api/system/overview" && req.method === "GET") {
      const haltInfo = checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        total_capital: Math.floor(Number(getSetting("total_capital", "0"))),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
        stats_start_date: getSetting("stats_start_date", "2026-10-01"),
        bots: getBots(),
      });
    }

    if (pathname === "/api/bots" && req.method === "GET") {
      const haltInfo = checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        bots: getBots(),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
      });
    }

    if (pathname === "/api/ai/briefing" && req.method === "GET") {
      const data = getLatestAiBriefing();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/ai/save-key" && req.method === "POST") {
      const body = await readJsonBody(req);
      const key = (body?.gemini_api_key || "").trim();
      saveGeminiApiKey(key);
      return sendJson(res, 200, {
        success: true,
        has_key: !!key,
        masked_key: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "",
      });
    }

    if (pathname === "/api/ai/analyze" && req.method === "POST") {
      const result = await generateAiMarketAnalysis();
      return sendJson(res, result.success ? 200 : 400, result);
    }

    if (pathname === "/api/ai/stream-analyze" && (req.method === "POST" || req.method === "GET")) {
      return generateAiMarketAnalysisStream(req, res);
    }

    if (pathname === "/api/ai/news-briefing" && req.method === "GET") {
      const data = getLatestAiNewsBriefing();
      return sendJson(res, 200, data);
    }

    if (pathname === "/api/ai/stream-news-analyze" && (req.method === "POST" || req.method === "GET")) {
      return generateAiNewsAnalysisStream(req, res);
    }

    const startStopMatch = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop)$/);
    if (startStopMatch && req.method === "POST") {
      const botId = startStopMatch[1];
      const isStart = startStopMatch[2] === "start";
      if (isStart) {
        const targetBot = getBots().find((b) => b.bot_id === botId);
        if (!targetBot || Number(targetBot.allocated_capital || 0) <= 0) {
          return sendJson(res, 200, {
            success: false,
            bot: targetBot,
            message: `[${targetBot?.nickname || targetBot?.name || botId}] 할당 원금이 0원이므로 거래를 시작할 수 없습니다. 설정에서 원금 및 자금 분배 비율을 먼저 설정해주세요.`,
          });
        }
        const haltInfo = checkAndHaltIfZeroBalance();
        if (haltInfo.halted) {
          return sendJson(res, 200, {
            success: false,
            bot: targetBot,
            message: haltInfo.reason,
          });
        }
      }
      const now = nowKSTString();
      const msg = isStart ? "자동매매 실행 중" : "사용자에 의해 거래 중지됨";
      db.prepare("UPDATE bots SET is_running = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        isStart ? 1 : 0,
        msg,
        now,
        botId
      );
      const updated = getBots().find((b) => b.bot_id === botId);
      return sendJson(res, 200, {
        success: true,
        bot: updated,
        message: `[${updated?.nickname || botId}] ${isStart ? "거래 시작" : "거래 중지"} 명령이 정상적으로 처리되었습니다.`,
      });
    }

    const manualTradeMatch = pathname.match(/^\/api\/bots\/([^/]+)\/manual-trade$/);
    if (manualTradeMatch && req.method === "POST") {
      const botId = manualTradeMatch[1];
      const body = await readJsonBody(req);
      const action = body.action || "buy";
      const market = body.market || "KRW-BTC";
      const bot = getBots().find((b) => b.bot_id === botId);
      if (!bot) return sendJson(res, 404, { success: false, message: "봇을 찾을 수 없습니다." });

      const now = nowKSTString();
      if (action === "buy") {
        const haltInfo = checkAndHaltIfZeroBalance();
        if (haltInfo.halted) return sendJson(res, 200, { success: false, message: haltInfo.reason });
        const availableKrw = Number(bot.virtual_krw || 0);
        if (availableKrw < 5000) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname || bot.name}] 최소 주문 금액(5,000원) 이상의 가용 가상잔고(현재 ${availableKrw.toLocaleString("ko-KR")}원)가 부족합니다.`,
          });
        }
        let orderKrw = Math.min(Math.floor(availableKrw * 0.25), 500000);
        if (orderKrw < 5000) {
          orderKrw = 5000;
        }
        const price = 98500000;
        const volume = (orderKrw / price).toFixed(8);

        // 매수 테스트는 실주문을 전송하거나 거래 내역(trades/bot_positions) 이력을 남기지 않음
        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname || bot.name}] 매수 테스트 정상 확인 (가용 잔고: ${availableKrw.toLocaleString("ko-KR")}원 / 1회 주문 가능 금액: ${orderKrw.toLocaleString("ko-KR")}원 / 실매수 및 이력 저장은 수행하지 않습니다)`,
        });
      } else {
        const pos = bot.open_positions?.[0];
        if (!pos) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname || bot.name}] 현재 보유 중인 미매도 포지션이 없습니다.`,
          });
        }
        // 매도 테스트 역시 DB 상태를 변경하거나 가짜 매도 기록을 남기지 않음
        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname || bot.name}] 보유 포지션(${pos.market}, 수량 ${pos.volume}) 확인 완료 (실제 매도가 아니므로 매도 완료로 기록하지 않습니다)`,
        });
      }
    }

    const updateBotMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
    if (updateBotMatch && req.method === "PUT") {
      const botId = updateBotMatch[1];
      const body = await readJsonBody(req);
      const now = nowKSTString();
      db.prepare(`
        UPDATE bots
        SET nickname = ?, min_volume_krw = ?, stop_loss_pct = ?, take_profit_pct = ?, config_json = ?, updated_at = ?
        WHERE bot_id = ?
      `).run(
        String(body.nickname || "").trim(),
        Math.floor(Number(body.min_volume_krw || 0)),
        Number(body.stop_loss_pct || 3.0),
        Number(body.take_profit_pct || 5.0),
        JSON.stringify(body.config || {}),
        now,
        botId
      );
      const updated = getBots().find((b) => b.bot_id === botId);
      return sendJson(res, 200, {
        success: true,
        message: `[${updated?.nickname || botId}] 봇 설정 및 별명이 저장되었습니다.`,
        bot: updated,
      });
    }

    if (pathname === "/api/trades" && req.method === "GET") {
      const botId = parsedUrl.searchParams.get("bot_id");
      const haltInfo = checkAndHaltIfZeroBalance();
      const trades = botId
        ? db.prepare("SELECT * FROM trades WHERE bot_id = ? ORDER BY buy_date DESC, id DESC").all(botId)
        : db.prepare("SELECT * FROM trades ORDER BY buy_date DESC, id DESC").all();
      return sendJson(res, 200, {
        trades,
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
      });
    }

    if (pathname === "/api/statistics" && req.method === "GET") {
      const startDate = "2026-10-01";
      const trades = db
        .prepare("SELECT * FROM trades WHERE substr(buy_date, 1, 10) >= ? ORDER BY COALESCE(sell_date, buy_date) ASC")
        .all(startDate);
      const dailyMap = { "2026-10-01": 0 };
      const weeklyMap = {};
      const monthlyMap = { "2026-10": 0 };
      const coinStats = {};

      for (const t of trades) {
        if (!coinStats[t.market]) {
          coinStats[t.market] = {
            market: t.market,
            trade_count: 0,
            completed_count: 0,
            holding_count: 0,
            weekly_profit: 0,
            monthly_profit: 0,
            yearly_profit: 0,
            total_profit: 0,
          };
        }
        coinStats[t.market].trade_count += 1;
        if (t.status === "COMPLETED" && t.profit_krw !== null) {
          coinStats[t.market].completed_count += 1;
          const p = Math.floor(Number(t.profit_krw));
          const dStr = String(t.sell_date || t.buy_date).slice(0, 10);
          dailyMap[dStr] = (dailyMap[dStr] || 0) + p;
          const mKey = dStr.slice(0, 7);
          monthlyMap[mKey] = (monthlyMap[mKey] || 0) + p;
          const dayNum = Number(dStr.slice(8, 10));
          const wKey = `${dStr.slice(0, 4)}-W${String(40 + Math.floor(dayNum / 7)).padStart(2, "0")}`;
          weeklyMap[wKey] = (weeklyMap[wKey] || 0) + p;

          coinStats[t.market].weekly_profit += p;
          coinStats[t.market].monthly_profit += p;
          coinStats[t.market].yearly_profit += p;
          coinStats[t.market].total_profit += p;
        } else {
          coinStats[t.market].holding_count += 1;
        }
      }

      const buildSeries = (mapObj) => {
        let cum = 0;
        return Object.keys(mapObj)
          .sort()
          .map((label) => {
            cum += mapObj[label];
            return { label, profit: mapObj[label], cumulative_profit: cum };
          });
      };

      const coinRanking = Object.values(coinStats).sort(
        (a, b) => b.trade_count - a.trade_count || b.yearly_profit - a.yearly_profit
      );

      return sendJson(res, 200, {
        start_date: "2026.10.01",
        daily: buildSeries(dailyMap),
        weekly: buildSeries(weeklyMap),
        monthly: buildSeries(monthlyMap),
        coin_ranking: coinRanking,
      });
    }

    if (pathname === "/api/settings/allocation" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const ratios = body.ratios || {};
      const ratioSum = Number(
        Object.values(ratios)
          .reduce((acc, v) => acc + Number(v || 0), 0)
          .toFixed(2)
      );
      if (ratioSum > 100.0) {
        return sendJson(res, 400, {
          success: false,
          detail: `봇별 자금 분배 비율의 합계(${ratioSum}%)는 100%를 초과할 수 없습니다.`,
        });
      }
      const flooredTotal = Math.floor(Number(body.total_capital || 0));
      const totalUsed = getBots().reduce((acc, b) => acc + Math.floor(Number(b.used_capital || 0)), 0);
      if (flooredTotal > 0 && flooredTotal < totalUsed) {
        return sendJson(res, 400, {
          success: false,
          detail: `설정하려는 전체 운용 원금(${flooredTotal.toLocaleString("ko-KR")}원)이 현재 이미 매수에 사용된 투자금(${totalUsed.toLocaleString("ko-KR")}원)보다 적습니다. 최소 ${totalUsed.toLocaleString("ko-KR")}원 이상으로 설정해주세요.`,
        });
      }
      const accountInfo = await fetchUpbitAccountBalance();
      const maxAssetLimit = Number(accountInfo.total_asset_krw ?? accountInfo.krw_balance ?? 0);
      if (!accountInfo.success || accountInfo.total_asset_krw === null) {
        return sendJson(res, 400, {
          success: false,
          detail: `업비트 총 보유 자산을 조회할 수 없어 전체 운용 원금을 저장할 수 없습니다. (${accountInfo.message || "실계좌 조회 실패"})`,
        });
      }
      if (flooredTotal > maxAssetLimit) {
        return sendJson(res, 400, {
          success: false,
          detail: `설정하려는 전체 운용 원금(${flooredTotal.toLocaleString("ko-KR")}원)이 업비트 총 보유 자산(${maxAssetLimit.toLocaleString("ko-KR")}원)의 한도를 초과하여 저장할 수 없습니다.`,
        });
      }
      const now = nowKSTString();
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(
        String(flooredTotal),
        now
      );
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('capital_configured', '1', ?)").run(
        now
      );

      recalculateAndApplyBotAllocations(flooredTotal, ratios);

      if (flooredTotal > 0) {
        db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_halted', '0', ?)").run(now);
        db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('zero_balance_reason', '', ?)").run(now);
      }

      const haltInfo = checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: "자금 분배 비율 및 원금 설정이 저장되었습니다 (소수점 이하 버림 적용).",
        total_capital: flooredTotal,
        bots: getBots(),
        zero_balance_halted: haltInfo.halted,
        zero_balance_reason: haltInfo.reason,
      });
    }

    if (pathname === "/api/settings/export" && req.method === "GET") {
      const payload = {
        schema_version: "1.0",
        exported_at: nowKSTString(),
        system_settings: db.prepare("SELECT * FROM system_settings").all(),
        bots: db.prepare("SELECT * FROM bots").all(),
        trades: db.prepare("SELECT * FROM trades").all(),
        bot_positions: db.prepare("SELECT * FROM bot_positions").all(),
      };
      return sendJson(res, 200, payload);
    }

    if (pathname === "/api/settings/import-json" && req.method === "POST") {
      const payload = await readJsonBody(req);
      if (!payload || !Array.isArray(payload.bots) || !Array.isArray(payload.trades)) {
        return sendJson(res, 400, { detail: "유효하지 않은 마이그레이션 JSON 형식입니다." });
      }
      db.exec("DELETE FROM bot_positions; DELETE FROM trades; DELETE FROM bots; DELETE FROM system_settings;");
      const now = nowKSTString();
      for (const s of payload.system_settings || []) {
        db.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
          s.key,
          String(s.value),
          s.updated_at || now
        );
      }
      for (const b of payload.bots || []) {
        db.prepare(`
          INSERT INTO bots (
            bot_id, name, nickname, strategy_type, description,
            allocation_ratio, allocated_capital, virtual_krw, is_running,
            min_volume_krw, stop_loss_pct, take_profit_pct, config_json,
            last_status_msg, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          b.bot_id,
          b.name,
          b.nickname,
          b.strategy_type,
          b.description || "",
          Number(b.allocation_ratio || 33.33),
          Math.floor(Number(b.allocated_capital || 0)),
          Math.floor(Number(b.virtual_krw || 0)),
          Number(b.is_running || 0),
          Math.floor(Number(b.min_volume_krw || 5000000000)),
          Number(b.stop_loss_pct || 3.0),
          Number(b.take_profit_pct || 5.0),
          b.config_json || "{}",
          b.last_status_msg || "복원 완료",
          b.updated_at || now
        );
      }
      for (const t of payload.trades || []) {
        db.prepare(`
          INSERT INTO trades (
            id, bot_id, market, buy_order_uuid, sell_order_uuid,
            buy_price, buy_volume, buy_amount, buy_date,
            sell_price, sell_volume, sell_amount, sell_date,
            profit_krw, profit_pct, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          t.id,
          t.bot_id,
          t.market,
          t.buy_order_uuid,
          t.sell_order_uuid ?? null,
          Number(t.buy_price),
          String(t.buy_volume),
          Math.floor(Number(t.buy_amount)),
          t.buy_date,
          t.sell_price ?? null,
          t.sell_volume ?? null,
          t.sell_amount !== null && t.sell_amount !== undefined ? Math.floor(Number(t.sell_amount)) : null,
          t.sell_date ?? null,
          t.profit_krw !== null && t.profit_krw !== undefined ? Math.floor(Number(t.profit_krw)) : null,
          t.profit_pct ?? null,
          t.status || "HOLDING"
        );
      }
      const seenPositionOrderUuids = new Set();
      const seenPositionIds = new Set();
      for (let idx = 0; idx < (payload.bot_positions || []).length; idx++) {
        const p = payload.bot_positions[idx];

        // order_uuid 고유성 보장 (null/빈값 처리 및 중복 발생 시 접미사 부여로 UNIQUE constraint 위반 방어)
        let safeOrderUuid = (p.order_uuid !== null && p.order_uuid !== undefined) ? String(p.order_uuid).trim() : "";
        if (!safeOrderUuid) {
          safeOrderUuid = `restored-pos-${p.id || (idx + 1)}-${Date.now()}`;
        }
        if (seenPositionOrderUuids.has(safeOrderUuid)) {
          safeOrderUuid = `${safeOrderUuid}-dup-${p.id || (idx + 1)}`;
        }
        seenPositionOrderUuids.add(safeOrderUuid);

        let posId = p.id !== null && p.id !== undefined ? Number(p.id) : null;
        if (posId !== null && seenPositionIds.has(posId)) {
          posId = null;
        }
        if (posId !== null) {
          seenPositionIds.add(posId);
          db.prepare(`
            INSERT OR REPLACE INTO bot_positions (
              id, bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            posId,
            p.bot_id,
            p.market,
            safeOrderUuid,
            String(p.volume),
            Number(p.avg_buy_price),
            Math.floor(Number(p.buy_amount)),
            Number(p.buy_fee || 0),
            Number(p.trade_id),
            p.status || "OPEN",
            p.created_at || now,
            p.closed_at ?? null
          );
        } else {
          db.prepare(`
            INSERT INTO bot_positions (
              bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            p.bot_id,
            p.market,
            safeOrderUuid,
            String(p.volume),
            Number(p.avg_buy_price),
            Math.floor(Number(p.buy_amount)),
            Number(p.buy_fee || 0),
            Number(p.trade_id),
            p.status || "OPEN",
            p.created_at || now,
            p.closed_at ?? null
          );
        }
      }
      checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: `데이터 복원이 완료되었습니다 (봇 ${payload.bots.length}개, 거래내역 ${payload.trades.length}건).`,
      });
    }

    if (pathname === "/api/news" && req.method === "GET") {
      const page = Number(parsedUrl.searchParams.get("page") || 1);
      const limit = Number(parsedUrl.searchParams.get("limit") || 50);
      const keyword = parsedUrl.searchParams.get("keyword") || "";
      const startDate = parsedUrl.searchParams.get("start_date") || "";
      const endDate = parsedUrl.searchParams.get("end_date") || "";

      const result = queryNewsList(db, { page, limit, keyword, startDate, endDate });
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/news/refresh" && req.method === "POST") {
      try {
        const count = await syncNewsToDatabase(db);
        return sendJson(res, 200, { success: true, newly_inserted: count });
      } catch (err) {
        return sendJson(res, 500, { detail: `뉴스 수집 실패: ${err.message}` });
      }
    }

    return sendJson(res, 404, { detail: "Not Found" });
  } catch (err) {
    return sendJson(res, 500, { detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`AutoCoinTrade SQLite Backend listening on http://localhost:${PORT}`);
});

// ============================================================================
// 백그라운드 3종 전략 봇 자동매매 스케줄러 워커 (8초 주기)
// ============================================================================
let isStrategyCycleRunning = false;

async function fetchUpbitTickersMap(markets) {
  const map = new Map();
  if (!markets || markets.length === 0) return map;
  try {
    await new Promise((r) => setTimeout(r, 120));
    const resp = await fetch(
      `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(markets.join(","))}`
    );
    if (resp.status === 200) {
      const data = await resp.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          map.set(item.market, item);
        }
      }
    }
  } catch {}
  return map;
}

async function fetchUpbitCandlesSorted(market, unit = "days", count = 8) {
  try {
    await new Promise((r) => setTimeout(r, 120));
    const resp = await fetch(
      `https://api.upbit.com/v1/candles/${unit}?market=${encodeURIComponent(market)}&count=${Math.max(count, 8)}`
    );
    if (resp.status === 200) {
      const rows = await resp.json();
      if (Array.isArray(rows) && rows.length >= 8) {
        return rows.slice().reverse(); // 과거 -> 최신 오름차순 (index 0이 iloc[-8] 기준 시점)
      }
    }
  } catch {}
  return [];
}

function computeRsi(closes, period = 7) {
  if (!Array.isArray(closes) || closes.length < 2) return 50.0;
  let gainSum = 0;
  let lossSum = 0;
  const startIdx = Math.max(1, closes.length - period);
  let cnt = 0;
  for (let i = startIdx; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
    cnt++;
  }
  if (cnt === 0 || lossSum === 0) return lossSum === 0 ? 100.0 : 50.0;
  const rs = (gainSum / cnt) / (lossSum / cnt);
  return 100.0 - 100.0 / (1.0 + rs);
}

function getSafeOrderKrw(bot, ratio = 0.35) {
  const virtualKrw = Math.floor(Number(bot.virtual_krw || 0));
  if (virtualKrw < 5000) return 0;
  const cfgOrderKrw = Number(bot.config?.order_krw || 0);
  const rawRatio = Number(bot.config?.order_ratio ?? ratio ?? 0.35);
  const normRatio = Math.min(1.0, Math.max(0.05, rawRatio > 1 ? rawRatio / 100.0 : rawRatio));
  const baseCapital = Math.max(virtualKrw, Math.floor(Number(bot.allocated_capital || 0)));
  const targetKrw = cfgOrderKrw >= 5000 ? cfgOrderKrw : Math.floor(baseCapital * normRatio);
  const maxAffordable = Math.floor(virtualKrw / 1.0005);
  let safeKrw = Math.min(targetKrw, maxAffordable);
  if (safeKrw < 5000) {
    safeKrw = maxAffordable >= 5000 ? 5000 : 0;
  }
  return safeKrw;
}

// ------------------------------------------------------------------
// [손실 방어 패치 1] 전체 봇 공통 시장 체제 필터 (BTC Regime Filter)
// 대장주 KRW-BTC 현재가가 일봉 20일 이동평균선 또는 4시간봉 60 이동평균선 아래이면
// Bot 1, 2, 3 모두 신규 매수를 전면 중단(Hold Cash)합니다.
// ------------------------------------------------------------------
let cachedRegimeState = {
  checkedAtMs: 0,
  allowBuy: true,
  btcPrice: 0,
  ma20Day: 0,
  ma60_4h: 0,
  reason: "BTC 시장 체제 확인 중",
};

async function checkMarketRegimeFilter(tickerMap = null) {
  const nowMs = Date.now();
  if (nowMs - cachedRegimeState.checkedAtMs < 20000 && cachedRegimeState.btcPrice > 0) {
    return cachedRegimeState;
  }

  try {
    const dayCandles = await fetchUpbitCandlesSorted("KRW-BTC", "days", 20);
    const h4Candles = await fetchUpbitCandlesSorted("KRW-BTC", "minutes/240", 60);

    if (dayCandles.length < 20 || h4Candles.length < 20) {
      return cachedRegimeState;
    }

    const tkBtc = tickerMap ? tickerMap.get("KRW-BTC") : null;
    const btcPrice = Number(tkBtc?.trade_price || dayCandles[dayCandles.length - 1].trade_price || 0);
    const dayCloses = dayCandles.slice(-20).map((c) => Number(c.trade_price));
    const h4Closes = h4Candles.slice(-60).map((c) => Number(c.trade_price));

    const ma20Day = dayCloses.reduce((a, b) => a + b, 0) / dayCloses.length;
    const ma60_4h = h4Closes.reduce((a, b) => a + b, 0) / h4Closes.length;

    const belowMa20Day = btcPrice < ma20Day;
    const belowMa60_4h = btcPrice < ma60_4h;

    if (belowMa20Day || belowMa60_4h) {
      const reasons = [];
      if (belowMa20Day) reasons.push(`일봉20MA(${Math.floor(ma20Day).toLocaleString("ko-KR")}) 하회`);
      if (belowMa60_4h) reasons.push(`4시간60MA(${Math.floor(ma60_4h).toLocaleString("ko-KR")}) 하회`);
      cachedRegimeState = {
        checkedAtMs: nowMs,
        allowBuy: false,
        btcPrice,
        ma20Day,
        ma60_4h,
        reason: `[시장체제 필터: 현금보유(Hold Cash)] BTC 현재가(${Math.floor(btcPrice).toLocaleString(
          "ko-KR"
        )}원)가 ${reasons.join(" · ")} 중으로 신규 매수 중단`,
      };
      return cachedRegimeState;
    }

    cachedRegimeState = {
      checkedAtMs: nowMs,
      allowBuy: true,
      btcPrice,
      ma20Day,
      ma60_4h,
      reason: `상승 체제 확인 (BTC ${Math.floor(btcPrice).toLocaleString("ko-KR")}원 >= 일봉20MA ${Math.floor(
        ma20Day
      ).toLocaleString("ko-KR")}원 & 4시간60MA ${Math.floor(ma60_4h).toLocaleString("ko-KR")}원)`,
    };
    return cachedRegimeState;
  } catch {
    return cachedRegimeState;
  }
}

// ------------------------------------------------------------------
// [손실 방어 패치 2] 시장가 주문 -> 최유리 지정가 주문(매수 1호가) 전환 및 미체결 취소(cancel_order)
// ------------------------------------------------------------------
function normalizeUpbitKrwTick(price) {
  const p = Number(price || 0);
  if (p >= 2000000) return Math.floor(p / 1000) * 1000;
  if (p >= 1000000) return Math.floor(p / 500) * 500;
  if (p >= 500000) return Math.floor(p / 100) * 100;
  if (p >= 100000) return Math.floor(p / 50) * 50;
  if (p >= 10000) return Math.floor(p / 10) * 10;
  if (p >= 1000) return Math.floor(p);
  if (p >= 100) return Number((Math.floor(p * 10) / 10).toFixed(1));
  if (p >= 10) return Number((Math.floor(p * 100) / 100).toFixed(2));
  if (p >= 1) return Number((Math.floor(p * 1000) / 1000).toFixed(3));
  return Number((Math.floor(p * 10000) / 10000).toFixed(4));
}

async function fetchUpbitBestBidPrice(market, fallbackPrice = 0) {
  try {
    await new Promise((r) => setTimeout(r, 120));
    const resp = await fetch(`https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(market)}`);
    if (resp.status === 200) {
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        const units = data[0]?.orderbook_units;
        if (Array.isArray(units) && units.length > 0 && Number(units[0]?.bid_price) > 0) {
          return Number(units[0].bid_price);
        }
      }
    }
  } catch {}
  return normalizeUpbitKrwTick(fallbackPrice);
}

async function cancelUpbitOrder(orderUuid, cfg) {
  if (!orderUuid) return false;
  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = { uuid: orderUuid };
    const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
    const resp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    return resp.status === 200 || resp.status === 201;
  } catch {
    return false;
  }
}

async function executeBotBuyOrder(bot, market, orderKrw, currentPrice) {
  const db = getDb();

  // 공통 시장 체제 필터(Regime Filter) 재확인
  const regimeInfo = await checkMarketRegimeFilter();
  if (!regimeInfo.allowBuy) {
    db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      regimeInfo.reason,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const latestBot = getBots().find((b) => b.bot_id === bot.bot_id);
  if (!latestBot || Number(latestBot.virtual_krw || 0) < orderKrw) return false;

  // 현재 OPEN 포지션 투자 합계가 할당 원금(allocated_capital)을 초과하지 않도록 엄격 검증
  const invRow = db
    .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
    .get(bot.bot_id);
  const currentInvested = Number(invRow?.invested || 0);
  if (currentInvested + orderKrw > Number(latestBot.allocated_capital || 0)) {
    return false;
  }

  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  const isLive =
    String(cfg.trade_mode || "").toLowerCase() === "live" &&
    cfg.access_key &&
    cfg.secret_key &&
    cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY";

  if (!isLive) {
    db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${market} 매수 신호 포착 (주문예정 ${orderKrw.toLocaleString("ko-KR")}원 / 현재 모의모드 'paper' 설정으로 실주문 대기 중)`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  // 매수 1호가(Best Bid) 조회 후 최유리 지정가 주문(ord_type: 'limit') 생성
  const bestBidPrice = await fetchUpbitBestBidPrice(market, currentPrice);
  if (!bestBidPrice || bestBidPrice <= 0) {
    return false;
  }

  let rawVol = Math.floor(orderKrw) / bestBidPrice;
  let limitVolNum = Number(rawVol.toFixed(8));
  if (limitVolNum * bestBidPrice < 5000) {
    limitVolNum = Number((limitVolNum + 0.00000001).toFixed(8));
  }
  const limitVolumeStr = limitVolNum.toFixed(8);
  const limitPriceStr = String(bestBidPrice);

  let orderUuid = "";
  let execPrice = Number(bestBidPrice);
  let execVolume = limitVolumeStr;
  let actualBuyAmount = Math.floor(limitVolNum * bestBidPrice);
  let fee = Math.floor(actualBuyAmount * 0.0005);

  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = {
      market,
      side: "bid",
      volume: limitVolumeStr,
      price: limitPriceStr,
      ord_type: "limit",
    };
    const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
    const resp = await fetch("https://api.upbit.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
    });
    if (resp.status !== 200 && resp.status !== 201) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${market} 지정가 매수 주문 실패: ${errMsg}`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
    const orderData = await resp.json();
    orderUuid = orderData?.uuid || "";
    if (!orderUuid) return false;

    db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${market} 매수 1호가(${bestBidPrice.toLocaleString("ko-KR")}원) 지정가 주문 접수 — 체결 대기 중(최대 40초)`,
      nowKSTString(),
      bot.bot_id
    );

    // 30초~1분(40초) 동안 체결 확인 후 미체결 시 주문 취소(cancel_order) 실행
    let isOrderDone = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const qParams = { uuid: orderUuid };
        const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
        const oResp = await fetch(
          `https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`,
          {
            headers: {
              Authorization: `Bearer ${qToken}`,
              Accept: "application/json",
            },
          }
        );
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          const state = String(oDetail?.state || "");
          const filledVol = Number(oDetail?.executed_volume || 0);
          if (state === "done" || state === "cancel") {
            isOrderDone = true;
            if (filledVol > 0) {
              execVolume = String(oDetail.executed_volume);
              const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
              const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
              if (totalFunds > 0) {
                actualBuyAmount = Math.floor(totalFunds);
                execPrice = Math.floor(totalFunds / filledVol);
              }
              if (oDetail.paid_fee !== undefined) {
                fee = Math.ceil(Number(oDetail.paid_fee || fee));
              }
            } else {
              execVolume = "0";
            }
            break;
          }
        }
      } catch {}
    }

    // 40초 내 미체결 시 지정가 주문 취소 (cancel_order)
    if (!isOrderDone) {
      await cancelUpbitOrder(orderUuid, cfg);
      await new Promise((r) => setTimeout(r, 500));
      let filledAfterCancel = 0;
      try {
        const qParams = { uuid: orderUuid };
        const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
        const oResp = await fetch(
          `https://api.upbit.com/v1/order?uuid=${encodeURIComponent(orderUuid)}`,
          {
            headers: {
              Authorization: `Bearer ${qToken}`,
              Accept: "application/json",
            },
          }
        );
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          filledAfterCancel = Number(oDetail?.executed_volume || 0);
          if (filledAfterCancel > 0) {
            execVolume = String(oDetail.executed_volume);
            const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
            const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
            if (totalFunds > 0) {
              actualBuyAmount = Math.floor(totalFunds);
              execPrice = Math.floor(totalFunds / filledAfterCancel);
            }
            if (oDetail.paid_fee !== undefined) {
              fee = Math.ceil(Number(oDetail.paid_fee || fee));
            }
          }
        }
      } catch {}

      if (filledAfterCancel <= 0) {
        db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          `${market} 지정가 매수(1호가 ${bestBidPrice.toLocaleString("ko-KR")}원) 40초 미체결로 자동 취소됨 (슬리피지 방어)`,
          nowKSTString(),
          bot.bot_id
        );
        return false;
      }
    }

    if (Number(execVolume) <= 0) {
      db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${market} 지정가 매수 주문이 미체결 취소되었습니다.`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
  } catch (err) {
    db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${market} 지정가 매수 API 통신 오류: ${err.message}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const now = nowKSTString();
  const newVirtual = Math.max(0, Math.floor(Number(latestBot.virtual_krw) - actualBuyAmount - fee));
  db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
    newVirtual,
    `${market} 최유리 지정가(1호가 ${execPrice.toLocaleString("ko-KR")}원) 매수 체결 (${actualBuyAmount.toLocaleString("ko-KR")}원)`,
    now,
    bot.bot_id
  );
  const trRes = db
    .prepare(`
      INSERT INTO trades (
        bot_id, market, buy_order_uuid, sell_order_uuid,
        buy_price, buy_volume, buy_amount, buy_date,
        sell_price, sell_volume, sell_amount, sell_date,
        profit_krw, profit_pct, status
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'HOLDING')
    `)
    .run(bot.bot_id, market, orderUuid, execPrice, execVolume, actualBuyAmount, now);

  db.prepare(`
    INSERT INTO bot_positions (
      bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(bot.bot_id, market, orderUuid, execVolume, execPrice, actualBuyAmount, fee, trRes.lastInsertRowid, now);
  return true;
}

async function executeBotSellOrder(bot, pos, sellPrice, reasonLabel) {
  const db = getDb();
  // 이미 이전 루프(동일 코인 통합 매도 등)에서 CLOSED 처리된 포지션이면 스킵
  const currentPos = db
    .prepare("SELECT * FROM bot_positions WHERE id = ? AND bot_id = ? AND status = 'OPEN'")
    .get(pos.id, bot.bot_id);
  if (!currentPos) {
    return false;
  }

  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  const isLive =
    String(cfg.trade_mode || "").toLowerCase() === "live" &&
    cfg.access_key &&
    cfg.secret_key &&
    cfg.access_key !== "YOUR_UPBIT_ACCESS_KEY";

  if (!isLive) {
    return false;
  }

  // 동일 봇·동일 마켓의 OPEN 포지션 조회
  // 개별 포지션이 최소주문금액(5,000원) 부근(<= 5,500원)이거나 동일 마켓 복수 분할 포지션이 있을 때
  // 손절 시 5,000원 미달 거부 및 소수점 잔량 불일치 방지를 위해 동일 마켓 OPEN 포지션을 통합 매도
  const sameMarketOpenPositions = db
    .prepare("SELECT * FROM bot_positions WHERE bot_id = ? AND market = ? AND status = 'OPEN' ORDER BY id ASC")
    .all(bot.bot_id, currentPos.market);

  const singleEvalKrw = Number(currentPos.volume || 0) * Number(sellPrice || 0);
  const targetPositions =
    sameMarketOpenPositions.length > 1 && (singleEvalKrw < 5500 || sameMarketOpenPositions.length >= 2)
      ? sameMarketOpenPositions
      : [currentPos];

  const dbSumVolume = targetPositions.reduce((acc, p) => acc + Number(p.volume || 0), 0);
  if (dbSumVolume <= 0) {
    return false;
  }

  // 업비트 실계좌 보유 수량 조회 (소수점 8자리 미세 오차로 인한 insufficient_funds_ask 방지)
  const currency = String(currentPos.market || "").split("-")[1] || "";
  let sellVolumeStr = dbSumVolume.toFixed(8);

  try {
    await new Promise((r) => setTimeout(r, 120));
    const acctToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim());
    const acctResp = await fetch("https://api.upbit.com/v1/accounts", {
      headers: {
        Authorization: `Bearer ${acctToken}`,
        Accept: "application/json",
      },
    });
    if (acctResp.status === 200) {
      const accounts = await acctResp.json();
      const coinAcct = Array.isArray(accounts)
        ? accounts.find((a) => String(a.currency || "").toUpperCase() === currency.toUpperCase())
        : null;
      const actualCoinBalance = Number(coinAcct?.balance || 0);
      if (actualCoinBalance > 0) {
        const otherBotsRow = db
          .prepare(
            "SELECT COALESCE(SUM(volume), 0) AS other_vol FROM bot_positions WHERE bot_id != ? AND market = ? AND status = 'OPEN'"
          )
          .get(bot.bot_id, currentPos.market);
        const otherBotsVol = Number(otherBotsRow?.other_vol || 0);

        if (otherBotsVol <= 0 && targetPositions.length === sameMarketOpenPositions.length) {
          // 다른 봇이 보유하지 않은 코인이고 현재 봇의 해당 코인 전량 청산이면 업비트 실보유 수량 전체를 매도
          sellVolumeStr = String(coinAcct.balance);
        } else {
          const safeVol = Math.min(dbSumVolume, Math.max(0, actualCoinBalance - otherBotsVol));
          if (safeVol > 0) {
            sellVolumeStr = safeVol.toFixed(8);
          }
        }
      }
    }
  } catch {}

  let sellUuid = "";
  let actualTotalFunds = Math.floor(Number(sellVolumeStr) * Number(sellPrice));
  let actualTotalFee = Math.floor(actualTotalFunds * 0.0005);

  try {
    await new Promise((r) => setTimeout(r, 120));
    const params = {
      market: currentPos.market,
      side: "ask",
      volume: sellVolumeStr,
      ord_type: "market",
    };
    const token = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), params);
    const resp = await fetch("https://api.upbit.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
    });
    if (resp.status !== 200 && resp.status !== 201) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${resp.status}`;
      db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
        `${currentPos.market} 매도 주문 실패: ${errMsg}`,
        nowKSTString(),
        bot.bot_id
      );
      return false;
    }
    const orderData = await resp.json();
    if (!orderData?.uuid) return false;
    sellUuid = orderData.uuid;

    // 매도 주문 체결 상세 조회 (GET /v1/order?uuid=...)
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const qParams = { uuid: sellUuid };
        const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
        const oResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(sellUuid)}`, {
          headers: {
            Authorization: `Bearer ${qToken}`,
            Accept: "application/json",
          },
        });
        if (oResp.status === 200) {
          const oDetail = await oResp.json();
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const fundsSum = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          if (fundsSum > 0) {
            actualTotalFunds = Math.floor(fundsSum);
            if (oDetail.paid_fee !== undefined) {
              actualTotalFee = Math.ceil(Number(oDetail.paid_fee || actualTotalFee));
            }
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
      `${currentPos.market} 매도 통신 오류: ${err.message}`,
      nowKSTString(),
      bot.bot_id
    );
    return false;
  }

  const now = nowKSTString();
  const totalBuyAmount = targetPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0) || 1;
  let totalProfitKrw = 0;

  for (const p of targetPositions) {
    const weight = Number(p.buy_amount || 0) / totalBuyAmount;
    const posSellAmount = Math.floor(actualTotalFunds * weight);
    const posSellFee = Math.floor(actualTotalFee * weight);
    const posNetProceeds = posSellAmount - posSellFee;
    const posProfitKrw = Math.floor(posNetProceeds - Number(p.buy_amount) - Number(p.buy_fee || 0));
    const posProfitPct = Number(((posProfitKrw / Number(p.buy_amount)) * 100).toFixed(2));
    totalProfitKrw += posProfitKrw;

    db.prepare("UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?").run(
      now,
      p.id,
      bot.bot_id
    );
    db.prepare(`
      UPDATE trades
      SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED'
      WHERE id = ? AND bot_id = ?
    `).run(sellUuid, sellPrice, p.volume, posSellAmount, now, posProfitKrw, posProfitPct, p.trade_id, bot.bot_id);
  }

  // 매도 후 전체 운용 원금 대비 이미 사용된 투자금을 재계산하여 봇별 배정 원금 및 가용 잔고(virtual_krw) 재분배
  const currentTotalCap = Math.floor(Number(getSetting("total_capital", "0")));
  recalculateAndApplyBotAllocations(currentTotalCap);

  db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
    `${currentPos.market} ${reasonLabel} 매도 완료 (${targetPositions.length}건 통합 / ${
      totalProfitKrw >= 0 ? "+" : ""
    }${totalProfitKrw.toLocaleString("ko-KR")}원)`,
    now,
    bot.bot_id
  );
  checkAndHaltIfZeroBalance();
  return true;
}

async function runBotStrategiesCycle() {
  if (isStrategyCycleRunning) return;
  isStrategyCycleRunning = true;
  try {
    const haltInfo = checkAndHaltIfZeroBalance();
    if (haltInfo.halted) return;

    const db = getDb();
    const runningBots = getBots().filter((b) => Number(b.is_running) === 1 && Number(b.allocated_capital) > 0);
    if (runningBots.length === 0) return;

    const allMarkets = [
      "KRW-BTC",
      "KRW-ETH",
      "KRW-SOL",
      "KRW-XRP",
      "KRW-DOGE",
      "KRW-SUI",
      "KRW-AVAX",
      "KRW-SHIB",
    ];
    const tickerMap = await fetchUpbitTickersMap(allMarkets);
    if (tickerMap.size === 0) return;

    for (const bot of runningBots) {
      const now = nowKSTString();
      const todayStr = todayDateString();
      const stopLossPct = -Math.abs(Number(bot.stop_loss_pct || 2.5));
      const takeProfitPct = Math.abs(Number(bot.take_profit_pct || 4.5));
      const minVol = Number(bot.min_volume_krw || 0);

      // 1) 공통 손절/익절 및 1일 만기 청산 체크
      for (const pos of bot.open_positions || []) {
        const tk = tickerMap.get(pos.market);
        if (!tk) continue;
        const curPrice = Number(tk.trade_price);
        const avgBuy = Number(pos.avg_buy_price);
        const pnlPct = ((curPrice - avgBuy) / avgBuy) * 100.0;

        if (pnlPct <= stopLossPct) {
          await executeBotSellOrder(bot, pos, curPrice, `손절(${pnlPct.toFixed(2)}%)`);
          continue;
        }
        if (pnlPct >= takeProfitPct) {
          await executeBotSellOrder(bot, pos, curPrice, `익절(+${pnlPct.toFixed(2)}%)`);
          continue;
        }
        if (bot.bot_id === "bot_volatility" && String(pos.created_at || "").slice(0, 10) < todayStr) {
          await executeBotSellOrder(bot, pos, curPrice, "1일 보유 만기");
          continue;
        }
      }

      const refreshedBot = getBots().find((b) => b.bot_id === bot.bot_id);
      if (!refreshedBot || Number(refreshedBot.is_running) !== 1) continue;
      const heldSet = new Set((refreshedBot.open_positions || []).map((p) => p.market));

      // [손실 방어 패치 1] 시장 체제 필터 (BTC Regime Filter):
      // 대장주 KRW-BTC가 일봉 20MA 또는 4시간봉 60MA 하회 시 Bot 1, 2, 3 신규 매수 전면 중단 (Hold Cash)
      const regimeInfo = await checkMarketRegimeFilter(tickerMap);
      if (!regimeInfo.allowBuy) {
        const holdingCount = (refreshedBot.open_positions || []).length;
        const msg = holdingCount > 0
          ? `${regimeInfo.reason} (기존 ${holdingCount}건 보유 포지션 익절/손절 감시 지속)`
          : regimeInfo.reason;
        db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          msg,
          now,
          bot.bot_id
        );
        continue;
      }

      // 2) 봇별 전략 평가 (상승 체제 시에만 진입)
      if (bot.bot_id === "bot_volatility") {
        const candidates = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE"].filter((m) => {
          const tk = tickerMap.get(m);
          return tk && Number(tk.acc_trade_price_24h || 0) >= minVol;
        });
        const kVal = Number(refreshedBot.config?.k_value || 0.4);
        let summaryText = "";

        for (const mkt of candidates) {
          if (heldSet.has(mkt)) continue;
          const candles = await fetchUpbitCandlesSorted(mkt, "days", 8);
          if (candles.length < 8) continue;
          const baseClose = Number(candles[0].trade_price); // iloc[-8]
          const prevCandle = candles[candles.length - 2];
          const currCandle = candles[candles.length - 1];
          const targetPrice =
            Number(currCandle.opening_price) +
            (Number(prevCandle.high_price) - Number(prevCandle.low_price)) * kVal;
          const curPrice = Number(currCandle.trade_price);

          if (!summaryText) {
            summaryText = `${mkt} 현재가 ${curPrice.toLocaleString("ko-KR")} / 돌파목표 ${Math.floor(targetPrice).toLocaleString("ko-KR")} (K=${kVal})`;
          }

          if (curPrice > baseClose && curPrice >= targetPrice && heldSet.size < 2) {
            const orderKrw = getSafeOrderKrw(refreshedBot, Number(refreshedBot.config?.order_ratio || 0.3));
            if (orderKrw >= 5000) {
              await executeBotBuyOrder(refreshedBot, mkt, orderKrw, curPrice);
              summaryText = `${mkt} 변동성 돌파 매수 체결 (${orderKrw.toLocaleString("ko-KR")}원)`;
              break;
            }
          }
        }
        db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          summaryText ? `실시간 감시 중: ${summaryText}` : `변동성 돌파(K=${kVal}) 대상 탐색 중`,
          now,
          bot.bot_id
        );
      } else if (bot.bot_id === "bot_dual_momentum") {
        const candidates = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-SUI", "KRW-AVAX"].filter((m) => {
          const tk = tickerMap.get(m);
          return tk && Number(tk.acc_trade_price_24h || 0) >= minVol;
        });
        const absThreshold = Number(refreshedBot.config?.abs_momentum_threshold_pct || 1.5);
        const scores = [];

        for (const mkt of candidates) {
          const candles = await fetchUpbitCandlesSorted(mkt, "minutes/240", 8);
          if (candles.length < 8) continue;
          const basePrice = Number(candles[0].trade_price); // iloc[-8]
          const curPrice = Number(candles[candles.length - 1].trade_price);
          if (basePrice <= 0) continue;
          const momPct = ((curPrice - basePrice) / basePrice) * 100.0;
          scores.push({ market: mkt, momPct, curPrice });
        }
        scores.sort((a, b) => b.momPct - a.momPct);

        // 보유 종목 모멘텀 음수 전환 시 매도
        for (const pos of refreshedBot.open_positions || []) {
          const sc = scores.find((s) => s.market === pos.market);
          if (sc && sc.momPct < 0) {
            await executeBotSellOrder(refreshedBot, pos, sc.curPrice, "모멘텀 이탈");
          }
        }

        let signalHandled = false;
        if (heldSet.size < 2 && scores.length > 0) {
          for (const cand of scores) {
            if (heldSet.has(cand.market)) continue;
            if (cand.momPct >= absThreshold) {
              const orderKrw = getSafeOrderKrw(refreshedBot, Number(refreshedBot.config?.order_ratio || 0.35));
              if (orderKrw >= 5000) {
                signalHandled = true;
                const ok = await executeBotBuyOrder(refreshedBot, cand.market, orderKrw, cand.curPrice);
                if (ok) {
                  db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
                    `${cand.market} 듀얼 모멘텀(+${cand.momPct.toFixed(2)}%) 매수 체결 (${orderKrw.toLocaleString("ko-KR")}원)`,
                    now,
                    bot.bot_id
                  );
                }
                break;
              }
            }
          }
        }

        if (!signalHandled) {
          const topText =
            scores.length > 0
              ? `1위 ${scores[0].market}(${scores[0].momPct >= 0 ? "+" : ""}${scores[0].momPct.toFixed(2)}% / 진입기준 +${absThreshold}%)`
              : "유동성 필터 통과 종목 대기";
          db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
            `실시간 감시 중: ${topText}`,
            now,
            bot.bot_id
          );
        }
      } else if (bot.bot_id === "bot_bollinger_reversal") {
        const candidates = ["KRW-SOL", "KRW-DOGE", "KRW-XRP", "KRW-SUI", "KRW-SHIB"].filter((m) => {
          const tk = tickerMap.get(m);
          return tk && Number(tk.acc_trade_price_24h || 0) >= minVol;
        });
        const bbStd = Number(refreshedBot.config?.bb_std || 2.0);
        const bbPeriod = Math.max(Number(refreshedBot.config?.bb_period || 20), 8);
        let summaryText = "";

        for (const mkt of candidates) {
          const candles = await fetchUpbitCandlesSorted(mkt, "minutes/15", bbPeriod);
          if (candles.length < 8) continue;
          const closes = candles.map((c) => Number(c.trade_price));
          const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
          const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length;
          const std = Math.sqrt(variance);
          const lowerBand = mean - bbStd * std;
          const curr = candles[candles.length - 1];
          const curClose = Number(curr.trade_price);
          const curLow = Number(curr.low_price);
          const curOpen = Number(curr.opening_price);
          const baseClose = Number(candles[candles.length - 8].trade_price); // iloc[-8]
          const rsi = computeRsi(closes, 14);

          // 보유 포지션 중심선 반등 시 익절
          const heldPos = (refreshedBot.open_positions || []).find((p) => p.market === mkt);
          if (heldPos && curClose >= mean && curClose > Number(heldPos.avg_buy_price) * 1.004) {
            await executeBotSellOrder(refreshedBot, heldPos, curClose, "볼린저 중심선 회복");
            continue;
          }

          if (!summaryText) {
            summaryText = `${mkt} 현재가 ${curClose.toLocaleString("ko-KR")} / 하단밴드 ${Math.floor(lowerBand).toLocaleString("ko-KR")} (RSI ${rsi.toFixed(1)})`;
          }

          if (!heldSet.has(mkt) && heldSet.size < 2) {
            const touchedLower = curLow <= lowerBand && curClose >= curOpen && rsi <= 40.0;
            const oversold = rsi <= 30.0 && curClose < baseClose;
            if (touchedLower || oversold) {
              const orderKrw = getSafeOrderKrw(refreshedBot, Number(refreshedBot.config?.order_ratio || 0.45));
              if (orderKrw >= 5000) {
                const ok = await executeBotBuyOrder(refreshedBot, mkt, orderKrw, curClose);
                if (ok) {
                  summaryText = `${mkt} 볼린저 하단/과매도(RSI ${rsi.toFixed(1)}) 반등 매수 체결`;
                  break;
                }
              }
            }
          }
        }

        db.prepare("UPDATE bots SET last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          summaryText ? `실시간 감시 중: ${summaryText}` : `볼린저 밴드(${bbStd}σ) 반등 탐색 중`,
          now,
          bot.bot_id
        );
      }
    }
  } catch (err) {
    console.error("Strategy cycle error:", err.message);
  } finally {
    isStrategyCycleRunning = false;
  }
}

async function reconcileOpenPositionsWithUpbit() {
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  if (!cfg.access_key || !cfg.secret_key || cfg.access_key === "YOUR_UPBIT_ACCESS_KEY") {
    return;
  }

  const db = getDb();
  const openPositions = db
    .prepare("SELECT * FROM bot_positions WHERE status = 'OPEN' ORDER BY id ASC")
    .all();

  for (const pos of openPositions) {
    const uuid = String(pos.order_uuid || "").trim();
    if (!uuid || uuid.startsWith("upbit-bid-") || uuid.startsWith("order-bid-")) continue;
    try {
      await new Promise((r) => setTimeout(r, 150));
      const qParams = { uuid };
      const qToken = createUpbitJwt(String(cfg.access_key).trim(), String(cfg.secret_key).trim(), qParams);
      const oResp = await fetch(`https://api.upbit.com/v1/order?uuid=${encodeURIComponent(uuid)}`, {
        headers: {
          Authorization: `Bearer ${qToken}`,
          Accept: "application/json",
        },
      });
      if (oResp.status === 200) {
        const oDetail = await oResp.json();
        const filledVol = Number(oDetail?.executed_volume || 0);
        if (filledVol > 0) {
          const exactVolStr = String(oDetail.executed_volume);
          const tradesArr = Array.isArray(oDetail.trades) ? oDetail.trades : [];
          const totalFunds = tradesArr.reduce((acc, t) => acc + Number(t.funds || 0), 0);
          const exactAvgPrice = totalFunds > 0 ? Math.floor(totalFunds / filledVol) : Number(pos.avg_buy_price);
          const exactFee =
            oDetail.paid_fee !== undefined ? Math.ceil(Number(oDetail.paid_fee || pos.buy_fee || 0)) : Number(pos.buy_fee || 0);

          db.prepare(
            "UPDATE bot_positions SET volume = ?, avg_buy_price = ?, buy_fee = ? WHERE id = ?"
          ).run(exactVolStr, exactAvgPrice, exactFee, pos.id);

          if (pos.trade_id) {
            db.prepare(
              "UPDATE trades SET buy_price = ?, buy_volume = ? WHERE id = ?"
            ).run(exactAvgPrice, exactVolStr, pos.trade_id);
          }
        }
      }
    } catch {}
  }

  if (getSetting("capital_configured", "0") === "1") {
    const currentTotalCap = Math.floor(Number(getSetting("total_capital", "0")));
    recalculateAndApplyBotAllocations(currentTotalCap);
  }
}

setTimeout(async () => {
  try {
    await pgSyncManager.connect();
    await pgSyncManager.syncAll(getDb());
    pgSyncManager.startAutoSync(getDb, 10000);
  } catch (err) {
    console.warn("[PgSync] Background sync init error:", err.message);
  }

  // 초기 암호화폐 뉴스 실시간 수집 및 감성 분석
  try {
    syncNewsToDatabase(getDb()).catch((err) => console.warn("[News] Initial sync error:", err.message));
  } catch {}

  await reconcileOpenPositionsWithUpbit();
  await runBotStrategiesCycle();
}, 1000);
setInterval(runBotStrategiesCycle, 10000);

// 30분 간격 암호화폐 뉴스 백그라운드 자동 수집
setInterval(() => {
  try {
    const db = getDb();
    if (db) {
      syncNewsToDatabase(db).catch((err) => console.warn("[News] Periodic sync error:", err.message));
    }
  } catch {}
}, 30 * 60 * 1000);


