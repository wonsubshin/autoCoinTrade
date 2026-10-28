import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
      allocation_ratio REAL NOT NULL DEFAULT 33.33,
      allocated_capital INTEGER NOT NULL DEFAULT 0,
      virtual_krw INTEGER NOT NULL DEFAULT 0,
      is_running INTEGER NOT NULL DEFAULT 0,
      min_volume_krw INTEGER NOT NULL DEFAULT 5000000000,
      stop_loss_pct REAL NOT NULL DEFAULT 3.0,
      take_profit_pct REAL NOT NULL DEFAULT 5.0,
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
  `);

  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM bots").get();
  if (countRow && countRow.cnt > 0) return;

  const now = nowKSTString();
  const totalCapital = 10000000;
  const setSetting = db.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  setSetting.run("total_capital", String(totalCapital), now);
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

  insertBot.run(
    "bot_volatility",
    "필터 결합형 변동성 돌파 봇",
    "변동성돌파 알파봇",
    "VOLATILITY_BREAKOUT",
    "장중 단타 / 1일 보유 | 전일 변동폭(k) 돌파 + 거래대금 및 추세 필터 결합 (count=8, iloc[-8])",
    40.0,
    4000000,
    3200000,
    0,
    10000000000,
    2.5,
    4.5,
    JSON.stringify({ k_value: 0.5, candle_count: 8, base_index_offset: -8 }),
    "대기 중 (수동 시작 가능)",
    now
  );
  insertBot.run(
    "bot_dual_momentum",
    "듀얼 모멘텀 스윙 봇",
    "듀얼모멘텀 스윙봇",
    "DUAL_MOMENTUM",
    "상대 모멘텀 + 절대 모멘텀 결합 스윙 | iloc[-8] 대비 수익률 상위 종목 선별 진입",
    40.0,
    4000000,
    4000000,
    0,
    8000000000,
    3.5,
    7.0,
    JSON.stringify({ abs_momentum_threshold_pct: 1.2, candle_count: 8, base_index_offset: -8 }),
    "대기 중 (수동 시작 가능)",
    now
  );
  insertBot.run(
    "bot_bollinger_reversal",
    "고변동성 볼린저 밴드 역추세 봇",
    "볼린저 단기반등봇",
    "BOLLINGER_REVERSAL",
    "분봉 단기 반등 매매 | 고변동성 코인 볼린저 밴드 하단 이탈 후 반등 진입 (count=8, iloc[-8])",
    20.0,
    2000000,
    2000000,
    0,
    5000000000,
    2.0,
    3.2,
    JSON.stringify({ bb_std: 2.0, rsi_oversold: 32.0, candle_count: 8, base_index_offset: -8 }),
    "대기 중 (수동 시작 가능)",
    now
  );

  const insertTrade = db.prepare(`
    INSERT INTO trades (
      bot_id, market, buy_order_uuid, sell_order_uuid,
      buy_price, buy_volume, buy_amount, buy_date,
      sell_price, sell_volume, sell_amount, sell_date,
      profit_krw, profit_pct, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedTrades = [
    ["bot_volatility", "KRW-BTC", "seed-vol-001-buy", "seed-vol-001-sell", 94500000, "0.01058201", 1000000, "2026-10-02 09:15:00", 96200000, "0.01058201", 1017989, "2026-10-03 08:59:10", 16980, 1.70, "COMPLETED"],
    ["bot_volatility", "KRW-SOL", "seed-vol-002-buy", "seed-vol-002-sell", 215000, "4.65116279", 1000000, "2026-10-06 11:20:00", 211500, "4.65116279", 983720, "2026-10-07 08:59:30", -17272, -1.73, "COMPLETED"],
    ["bot_volatility", "KRW-BTC", "seed-vol-003-buy", "seed-vol-003-sell", 95800000, "0.01252609", 1200000, "2026-10-12 10:05:00", 98100000, "0.01252609", 1228809, "2026-10-13 08:59:00", 27595, 2.30, "COMPLETED"],
    ["bot_dual_momentum", "KRW-ETH", "seed-mom-001-buy", "seed-mom-001-sell", 3420000, "0.35087719", 1200000, "2026-10-04 12:00:00", 3550000, "0.35087719", 1245614, "2026-10-08 16:00:00", 44391, 3.70, "COMPLETED"],
    ["bot_dual_momentum", "KRW-XRP", "seed-mom-002-buy", "seed-mom-002-sell", 780, "1282.05128205", 1000000, "2026-10-15 09:00:00", 768, "1282.05128205", 984615, "2026-10-18 13:00:00", -16377, -1.64, "COMPLETED"],
    ["bot_bollinger_reversal", "KRW-DOGE", "seed-bb-001-buy", "seed-bb-001-sell", 195, "4102.56410256", 800000, "2026-10-19 14:30:00", 201, "4102.56410256", 824615, "2026-10-19 18:45:00", 23803, 2.98, "COMPLETED"],
    ["bot_bollinger_reversal", "KRW-SUI", "seed-bb-002-buy", "seed-bb-002-sell", 2800, "250.00000000", 700000, "2026-10-22 10:15:00", 2800, "250.00000000", 700000, "2026-10-22 15:00:00", 0, 0.0, "COMPLETED"],
    ["bot_volatility", "KRW-BTC", "seed-vol-004-buy", "seed-vol-004-sell", 97200000, "0.01028806", 1000000, "2026-10-25 09:30:00", 99150000, "0.01028806", 1020061, "2026-10-26 08:58:00", 19051, 1.91, "COMPLETED"],
    ["bot_volatility", "KRW-ETH", "seed-vol-open-005", null, 3510000, "0.22792022", 800000, "2026-10-28 09:12:00", null, null, null, null, null, null, "HOLDING"],
  ];

  for (const t of seedTrades) {
    const res = insertTrade.run(...t);
    if (t[14] === "HOLDING") {
      db.prepare(`
        INSERT INTO bot_positions (
          bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
      `).run(t[0], t[1], t[2], t[5], t[4], t[6], 400, res.lastInsertRowid, t[7]);
    }
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
    return { ...r, config, open_positions: openPositions };
  });
}

function checkAndHaltIfZeroBalance() {
  const db = getDb();
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

    if (pathname === "/api/system/overview" && req.method === "GET") {
      const haltInfo = checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        total_capital: Math.floor(Number(getSetting("total_capital", "10000000"))),
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

    const startStopMatch = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop)$/);
    if (startStopMatch && req.method === "POST") {
      const botId = startStopMatch[1];
      const isStart = startStopMatch[2] === "start";
      if (isStart) {
        const haltInfo = checkAndHaltIfZeroBalance();
        if (haltInfo.halted) {
          return sendJson(res, 200, {
            success: false,
            bot: getBots().find((b) => b.bot_id === botId),
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
        const orderKrw = Math.min(Math.floor(Number(bot.virtual_krw) * 0.25), 500000);
        if (orderKrw < 5000) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname}] 최소 주문 금액(5,000원) 이상의 가용 잔고(virtual_krw)가 부족합니다.`,
          });
        }
        const price = 98500000;
        const volume = (orderKrw / price).toFixed(8);
        const orderUuid = `order-bid-${crypto.randomUUID().slice(0, 8)}`;
        const fee = Math.floor(orderKrw * 0.0005);
        const newVirtual = Math.max(0, Number(bot.virtual_krw) - orderKrw - fee);

        db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          newVirtual,
          `${market} 매수 완료 (${orderKrw.toLocaleString()}원)`,
          now,
          botId
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
          .run(botId, market, orderUuid, price, volume, orderKrw, now);

        db.prepare(`
          INSERT INTO bot_positions (
            bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
        `).run(botId, market, orderUuid, volume, price, orderKrw, fee, trRes.lastInsertRowid, now);

        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname}] ${market} 매수 체결 완료 (${orderKrw.toLocaleString()}원, 수량 ${volume})`,
        });
      } else {
        const pos = bot.open_positions?.[0];
        if (!pos) {
          return sendJson(res, 200, {
            success: false,
            message: `[${bot.nickname}] 현재 보유 중인 미매도 포지션이 없습니다.`,
          });
        }
        const sellPrice = Math.floor(Number(pos.avg_buy_price) * 1.018);
        const sellAmount = Math.floor(Number(pos.volume) * sellPrice);
        const sellFee = Math.floor(sellAmount * 0.0005);
        const netProceeds = sellAmount - sellFee;
        const profitKrw = Math.floor(netProceeds - Number(pos.buy_amount) - Number(pos.buy_fee));
        const profitPct = Number(((profitKrw / Number(pos.buy_amount)) * 100).toFixed(2));
        const sellUuid = `order-ask-${crypto.randomUUID().slice(0, 8)}`;

        db.prepare("UPDATE bot_positions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND bot_id = ?").run(
          now,
          pos.id,
          botId
        );
        db.prepare(`
          UPDATE trades
          SET sell_order_uuid = ?, sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, status = 'COMPLETED'
          WHERE id = ? AND bot_id = ?
        `).run(sellUuid, sellPrice, pos.volume, sellAmount, now, profitKrw, profitPct, pos.trade_id, botId);

        const newVirtual = Math.floor(Number(bot.virtual_krw) + netProceeds);
        db.prepare("UPDATE bots SET virtual_krw = ?, last_status_msg = ?, updated_at = ? WHERE bot_id = ?").run(
          newVirtual,
          `${pos.market} 매도 완료 (차익 ${profitKrw.toLocaleString()}원)`,
          now,
          botId
        );

        return sendJson(res, 200, {
          success: true,
          message: `[${bot.nickname}] ${pos.market} 본인 지분(${pos.volume}) 분할 매도 완료 (차익: ${profitKrw.toLocaleString()}원 / ${profitPct}%)`,
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
          detail: `봇별 자금 분배 비율의 합계(${ratioSum}%)는 100%를 초과할 수 없습니다.`,
        });
      }
      const flooredTotal = Math.floor(Number(body.total_capital || 0));
      const now = nowKSTString();
      db.prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('total_capital', ?, ?)").run(
        String(flooredTotal),
        now
      );

      for (const [botId, ratio] of Object.entries(ratios)) {
        const rVal = Number(ratio);
        const allocated = Math.floor(flooredTotal * (rVal / 100.0));
        const invRow = db
          .prepare("SELECT COALESCE(SUM(buy_amount), 0) AS invested FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'")
          .get(botId);
        const invested = Number(invRow?.invested || 0);
        const newVirtual = flooredTotal > 0 ? Math.max(0, allocated - invested) : 0;
        db.prepare(
          "UPDATE bots SET allocation_ratio = ?, allocated_capital = ?, virtual_krw = ?, updated_at = ? WHERE bot_id = ?"
        ).run(rVal, allocated, newVirtual, now, botId);
      }

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
      for (const p of payload.bot_positions || []) {
        db.prepare(`
          INSERT INTO bot_positions (
            id, bot_id, market, order_uuid, volume, avg_buy_price, buy_amount, buy_fee, trade_id, status, created_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          p.id,
          p.bot_id,
          p.order_uuid,
          String(p.volume),
          Number(p.avg_buy_price),
          Math.floor(Number(p.buy_amount)),
          Number(p.buy_fee || 0),
          Number(p.trade_id),
          p.status || "OPEN",
          p.created_at,
          p.closed_at ?? null
        );
      }
      checkAndHaltIfZeroBalance();
      return sendJson(res, 200, {
        success: true,
        message: `데이터 복원이 완료되었습니다 (봇 ${payload.bots.length}개, 거래내역 ${payload.trades.length}건).`,
      });
    }

    return sendJson(res, 404, { detail: "Not Found" });
  } catch (err) {
    return sendJson(res, 500, { detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`AutoCoinTrade SQLite Backend listening on http://localhost:${PORT}`);
});

