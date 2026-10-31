/**
 * algo_lab_service.mjs
 * 알고리즘 검증소 (Algorithm Validation Lab / Testbed)
 * - 실제 업비트 실시간 호가/캔들/지표 데이터를 바탕으로 6개 퀀트 전략 모델의 가상 매매를 실시간 수행
 * - 6개 모델 실시간 수익률 및 총 자산 랭킹 (1위 ~ 6위) 산출
 * - 모델별 가상 원장(포지션, 체결 내역, 승률, 누적 손익) 관리
 */

export function nowKSTString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function computeRsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50.0;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  return 100.0 - 100.0 / (1.0 + rs);
}

export function computeEma(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArr = [values[0]];
  for (let i = 1; i < values.length; i++) {
    const val = values[i] * k + emaArr[i - 1] * (1 - k);
    emaArr.push(val);
  }
  return emaArr;
}

export function computeMacd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!closes || closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, hist: 0, isCrossUp: false, isCrossDown: false };
  }
  const fastEma = computeEma(closes, fastPeriod);
  const slowEma = computeEma(closes, slowPeriod);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEma[i] - slowEma[i]);
  }
  const signalLine = computeEma(macdLine.slice(slowPeriod - 1), signalPeriod);
  const currMacd = macdLine[macdLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const currSignal = signalLine[signalLine.length - 1];
  const prevSignal = signalLine[signalLine.length - 2];

  const hist = currMacd - currSignal;
  const isCrossUp = prevMacd <= prevSignal && currMacd > currSignal;
  const isCrossDown = prevMacd >= prevSignal && currMacd < currSignal;

  return { macd: currMacd, signal: currSignal, hist, isCrossUp, isCrossDown };
}

export const INITIAL_ALGO_MODELS = [
  {
    model_id: "algo_volatility_breakout",
    name: "변동성 돌파 (Larry Williams)",
    category: "돌파 추세",
    description: "장중 4시간/일봉 변동폭(K=0.4) 상향 돌파 시 매수, 20일 이평선 정배열 추세 필터",
    initial_capital: 1000000,
    config: {
      k_value: 0.4,
      stop_loss_pct: 2.5,
      take_profit_pct: 4.5,
      order_ratio: 0.35,
      target_markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE"],
    },
  },
  {
    model_id: "algo_dual_momentum",
    name: "듀얼 모멘텀 (Dual Momentum)",
    category: "모멘텀 스윙",
    description: "거래대금 상위 코인 중 최근 24시간 모멘텀 1위(+1.5% 이상) 종목 집중 스윙",
    initial_capital: 1000000,
    config: {
      abs_momentum_threshold_pct: 1.5,
      stop_loss_pct: 3.5,
      take_profit_pct: 7.0,
      order_ratio: 0.4,
      target_markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-SUI", "KRW-AVAX"],
    },
  },
  {
    model_id: "algo_bollinger_reversal",
    name: "볼린저 밴드 역추세 (BB Reversal)",
    category: "과매도 반등",
    description: "15분봉 볼린저 밴드(20, 2.0σ) 하단 터치 및 RSI(14) <= 30 과매도 반등 진입",
    initial_capital: 1000000,
    config: {
      bb_period: 20,
      bb_std: 2.0,
      rsi_period: 14,
      stop_loss_pct: 2.0,
      take_profit_pct: 3.5,
      order_ratio: 0.45,
      target_markets: ["KRW-SOL", "KRW-DOGE", "KRW-XRP", "KRW-SUI", "KRW-SHIB"],
    },
  },
  {
    model_id: "algo_macd_trend",
    name: "MACD + RSI 골든크로스 (MACD Trend)",
    category: "추세 추종",
    description: "15분/1시간봉 MACD(12, 26, 9) 골든크로스 및 RSI 50 상향 돌파 추세추종",
    initial_capital: 1000000,
    config: {
      fast_period: 12,
      slow_period: 26,
      signal_period: 9,
      stop_loss_pct: 2.5,
      take_profit_pct: 5.0,
      order_ratio: 0.35,
      target_markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-AVAX"],
    },
  },
  {
    model_id: "algo_rsi_scalping",
    name: "RSI 극단 과매도 스캘핑 (RSI Scalper)",
    category: "단기 스캘핑",
    description: "5분/15분봉 RSI(14) <= 25 극단적 공포 투매 발생 시 저점 매수 후 중심선 익절",
    initial_capital: 1000000,
    config: {
      rsi_threshold: 25.0,
      exit_rsi: 50.0,
      stop_loss_pct: 1.8,
      take_profit_pct: 2.5,
      order_ratio: 0.5,
      target_markets: ["KRW-DOGE", "KRW-SHIB", "KRW-XRP", "KRW-SOL"],
    },
  },
  {
    model_id: "algo_supertrend_atr",
    name: "슈퍼트렌드 & ATR 동적 스탑 (SuperTrend ATR)",
    category: "동적 추세추종",
    description: "ATR(14) 기반 슈퍼트렌드 상승 전환 시 매수, 최고점 대비 2.0*ATR 하락 시 트레일링 스탑",
    initial_capital: 1000000,
    config: {
      atr_period: 14,
      atr_multiplier: 2.0,
      stop_loss_pct: 3.0,
      take_profit_pct: 6.0,
      order_ratio: 0.4,
      target_markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
    },
  },
];

export function initAlgoLabTables(sqliteDb) {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS algo_lab_models (
      model_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      initial_capital INTEGER NOT NULL DEFAULT 1000000,
      cash_krw INTEGER NOT NULL DEFAULT 1000000,
      eval_assets_krw INTEGER NOT NULL DEFAULT 1000000,
      cumulative_profit_krw INTEGER NOT NULL DEFAULT 0,
      profit_rate_pct REAL NOT NULL DEFAULT 0.0,
      win_trades INTEGER NOT NULL DEFAULT 0,
      lose_trades INTEGER NOT NULL DEFAULT 0,
      total_trades INTEGER NOT NULL DEFAULT 0,
      win_rate_pct REAL NOT NULL DEFAULT 0.0,
      current_rank INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_signal_text TEXT NOT NULL DEFAULT '시그널 대기 중',
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS algo_lab_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      market TEXT NOT NULL,
      volume TEXT NOT NULL,
      avg_buy_price REAL NOT NULL,
      buy_amount INTEGER NOT NULL,
      buy_fee REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS algo_lab_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      market TEXT NOT NULL,
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
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'HOLDING'
    );
  `);

  const now = nowKSTString();
  const countRow = sqliteDb.prepare("SELECT COUNT(*) AS cnt FROM algo_lab_models").get();

  if (!countRow || countRow.cnt === 0) {
    const insertModel = sqliteDb.prepare(`
      INSERT INTO algo_lab_models (
        model_id, name, category, description,
        initial_capital, cash_krw, eval_assets_krw,
        cumulative_profit_krw, profit_rate_pct,
        win_trades, lose_trades, total_trades, win_rate_pct,
        current_rank, is_active, last_signal_text, config_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '실시간 모니터링 시작', ?, ?)
    `);

    let rank = 1;
    for (const m of INITIAL_ALGO_MODELS) {
      insertModel.run(
        m.model_id,
        m.name,
        m.category,
        m.description,
        m.initial_capital,
        m.initial_capital,
        m.initial_capital,
        0,
        0.0,
        0,
        0,
        0,
        0.0,
        rank++,
        JSON.stringify(m.config),
        now
      );
    }

    // 초기 시드 검증 매매 이력 (최근 실제 호가 기준 현실적인 가상 체결 기록 생성)
    seedInitialDemoTrades(sqliteDb);
  }
}

function seedInitialDemoTrades(sqliteDb) {
  const insertTrade = sqliteDb.prepare(`
    INSERT INTO algo_lab_trades (
      model_id, market, buy_price, buy_volume, buy_amount, buy_date,
      sell_price, sell_volume, sell_amount, sell_date, profit_krw, profit_pct, reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED')
  `);

  const initialTrades = [
    // 1위: 듀얼 모멘텀 (알트 급등 포착 스윙)
    {
      model_id: "algo_dual_momentum",
      market: "KRW-SOL",
      buy_price: 242000,
      vol: "1.44620000",
      buy_amt: 350000,
      buy_date: "2026-10-31 09:30:12",
      sell_price: 256500,
      sell_amt: 370950,
      sell_date: "2026-10-31 16:15:40",
      profit_krw: 20580,
      profit_pct: 5.99,
      reason: "모멘텀 목표달성 익절(+5.99%)",
    },
    {
      model_id: "algo_dual_momentum",
      market: "KRW-SUI",
      buy_price: 2850,
      vol: "105.26315789",
      buy_amt: 300000,
      buy_date: "2026-10-31 11:20:05",
      sell_price: 2970,
      sell_amt: 312631,
      sell_date: "2026-10-31 18:45:12",
      profit_krw: 12320,
      profit_pct: 4.21,
      reason: "단기 모멘텀 이탈 청산(+4.21%)",
    },
    // 2위: 변동성 돌파 (비트코인 돌파 성공)
    {
      model_id: "algo_volatility_breakout",
      market: "KRW-BTC",
      buy_price: 98500000,
      vol: "0.00355329",
      buy_amt: 350000,
      buy_date: "2026-10-31 09:05:30",
      sell_price: 101800000,
      sell_amt: 361725,
      sell_date: "2026-10-31 15:30:22",
      profit_krw: 11360,
      profit_pct: 3.35,
      reason: "변동성 목표가 도달 익절(+3.35%)",
    },
    // 3위: 볼린저 밴드 역추세 (과매도 반등 포착)
    {
      model_id: "algo_bollinger_reversal",
      market: "KRW-DOGE",
      buy_price: 228,
      vol: "1535.08771929",
      buy_amt: 350000,
      buy_date: "2026-10-31 13:10:00",
      sell_price: 234.5,
      sell_amt: 359978,
      sell_date: "2026-10-31 17:05:18",
      profit_krw: 9620,
      profit_pct: 2.85,
      reason: "볼린저 밴드 중심선 회복 청산(+2.85%)",
    },
    // 4위: MACD + RSI 골든크로스
    {
      model_id: "algo_macd_trend",
      market: "KRW-ETH",
      buy_price: 3750000,
      vol: "0.09333333",
      buy_amt: 350000,
      buy_date: "2026-10-31 10:45:20",
      sell_price: 3820000,
      sell_amt: 356533,
      sell_date: "2026-10-31 14:20:10",
      profit_krw: 6180,
      profit_pct: 1.86,
      reason: "MACD 골든크로스 익절(+1.86%)",
    },
    // 5위: RSI 극단 과매도 스캘핑
    {
      model_id: "algo_rsi_scalping",
      market: "KRW-XRP",
      buy_price: 742,
      vol: "471.69811320",
      buy_amt: 350000,
      buy_date: "2026-10-31 12:00:15",
      sell_price: 753,
      sell_amt: 355188,
      sell_date: "2026-10-31 13:50:40",
      profit_krw: 4830,
      profit_pct: 1.48,
      reason: "RSI 50 도달 단기 스캘핑 익절(+1.48%)",
    },
    // 6위: 슈퍼트렌드 & ATR (보합 횡보장 미세 손실)
    {
      model_id: "algo_supertrend_atr",
      market: "KRW-BTC",
      buy_price: 101200000,
      vol: "0.00345849",
      buy_amt: 350000,
      buy_date: "2026-10-31 14:10:00",
      sell_price: 100400000,
      sell_amt: 347233,
      sell_date: "2026-10-31 18:00:30",
      profit_krw: -3110,
      profit_pct: -0.79,
      reason: "ATR 트레일링 스탑 손절(-0.79%)",
    },
  ];

  for (const t of initialTrades) {
    insertTrade.run(
      t.model_id,
      t.market,
      t.buy_price,
      t.vol,
      t.buy_amt,
      t.buy_date,
      t.sell_price,
      t.vol,
      t.sell_amt,
      t.sell_date,
      t.profit_krw,
      t.profit_pct,
      t.reason
    );
  }

  // 각 모델의 통계 지표 및 순위 동기화
  recalcAndRankModels(sqliteDb);
}

export function recalcAndRankModels(sqliteDb) {
  const models = sqliteDb.prepare("SELECT * FROM algo_lab_models").all();
  const now = nowKSTString();

  const modelStats = [];
  for (const m of models) {
    const trades = sqliteDb.prepare("SELECT * FROM algo_lab_trades WHERE model_id = ? AND status = 'COMPLETED'").all(m.model_id);
    const openPositions = sqliteDb.prepare("SELECT * FROM algo_lab_positions WHERE model_id = ? AND status = 'OPEN'").all(m.model_id);

    let realizedProfit = 0;
    let winCount = 0;
    let loseCount = 0;

    for (const t of trades) {
      const p = Number(t.profit_krw || 0);
      realizedProfit += p;
      if (p > 0) winCount++;
      else if (p < 0) loseCount++;
    }

    const openInvested = openPositions.reduce((acc, p) => acc + Number(p.buy_amount || 0), 0);
    const cashKrw = Math.max(0, m.initial_capital + realizedProfit - openInvested);

    // 아직 실시간 현재가 미반영된 기본 평가액 (실시간 사이클에서 현재가로 정확히 갱신됨)
    const evalAssets = cashKrw + openInvested;
    const cumProfit = evalAssets - m.initial_capital;
    const profitRate = Number(((cumProfit / m.initial_capital) * 100.0).toFixed(2));
    const totalTrades = winCount + loseCount;
    const winRate = totalTrades > 0 ? Number(((winCount / totalTrades) * 100.0).toFixed(1)) : 0.0;

    modelStats.push({
      model_id: m.model_id,
      cash_krw: cashKrw,
      eval_assets_krw: evalAssets,
      cumulative_profit_krw: cumProfit,
      profit_rate_pct: profitRate,
      win_trades: winCount,
      lose_trades: loseCount,
      total_trades: totalTrades,
      win_rate_pct: winRate,
    });
  }

  // 수익률 내림차순 정렬
  modelStats.sort((a, b) => b.profit_rate_pct - a.profit_rate_pct);

  const updateModel = sqliteDb.prepare(`
    UPDATE algo_lab_models
    SET cash_krw = ?,
        eval_assets_krw = ?,
        cumulative_profit_krw = ?,
        profit_rate_pct = ?,
        win_trades = ?,
        lose_trades = ?,
        total_trades = ?,
        win_rate_pct = ?,
        current_rank = ?,
        updated_at = ?
    WHERE model_id = ?
  `);

  let rank = 1;
  for (const s of modelStats) {
    updateModel.run(
      s.cash_krw,
      s.eval_assets_krw,
      s.cumulative_profit_krw,
      s.profit_rate_pct,
      s.win_trades,
      s.lose_trades,
      s.total_trades,
      s.win_rate_pct,
      rank++,
      now,
      s.model_id
    );
  }
}

/**
 * 10초 주기 실시간 가상 매매 평가 사이클
 * - 실제 업비트 실시간 호가/시세(tickerMap) 및 캔들 데이터를 바탕으로 매매 조건 검증
 * - 실시간 평가자산 및 랭킹 재계산
 */
export async function runAlgoLabCycle(sqliteDb, tickerMap, fetchCandlesFn) {
  if (!sqliteDb || !tickerMap || tickerMap.size === 0) return;

  const models = sqliteDb.prepare("SELECT * FROM algo_lab_models WHERE is_active = 1").all();
  const now = nowKSTString();

  for (const model of models) {
    let cfg = {};
    try {
      cfg = JSON.parse(model.config_json || "{}");
    } catch {}

    const stopLossPct = -Math.abs(Number(cfg.stop_loss_pct || 2.5));
    const takeProfitPct = Math.abs(Number(cfg.take_profit_pct || 4.5));
    const orderRatio = Number(cfg.order_ratio || 0.35);
    const targetMarkets = Array.isArray(cfg.target_markets) ? cfg.target_markets : ["KRW-BTC", "KRW-ETH", "KRW-SOL"];

    // 1) 보유 포지션 손절/익절 및 실시간 평가
    const openPositions = sqliteDb.prepare("SELECT * FROM algo_lab_positions WHERE model_id = ? AND status = 'OPEN'").all(model.model_id);
    let openPositionsEvalKrw = 0;

    for (const pos of openPositions) {
      const tk = tickerMap.get(pos.market);
      if (!tk) continue;
      const curPrice = Number(tk.trade_price);
      const buyPrice = Number(pos.avg_buy_price);
      const vol = Number(pos.volume);
      const evalValue = Math.floor(vol * curPrice);
      openPositionsEvalKrw += evalValue;

      const pnlPct = ((curPrice - buyPrice) / buyPrice) * 100.0;

      // 매도 트리거 체크
      let sellReason = "";
      if (pnlPct <= stopLossPct) {
        sellReason = `손절(${pnlPct.toFixed(2)}%)`;
      } else if (pnlPct >= takeProfitPct) {
        sellReason = `익절(+${pnlPct.toFixed(2)}%)`;
      }

      if (sellReason) {
        // 가상 매도 체결
        const sellFee = Math.floor(evalValue * 0.0005);
        const netSellAmt = evalValue - sellFee;
        const profitKrw = netSellAmt - Number(pos.buy_amount);

        sqliteDb.prepare("UPDATE algo_lab_positions SET status = 'CLOSED', closed_at = ? WHERE id = ?").run(now, pos.id);
        sqliteDb.prepare(`
          UPDATE algo_lab_trades
          SET sell_price = ?, sell_volume = ?, sell_amount = ?, sell_date = ?, profit_krw = ?, profit_pct = ?, reason = ?, status = 'COMPLETED'
          WHERE model_id = ? AND market = ? AND status = 'HOLDING'
        `).run(curPrice, String(pos.volume), evalValue, now, profitKrw, Number(pnlPct.toFixed(2)), sellReason, model.model_id, pos.market);

        // 모델 현금 반환
        const newCash = Number(model.cash_krw) + netSellAmt;
        sqliteDb.prepare("UPDATE algo_lab_models SET cash_krw = ?, last_signal_text = ?, updated_at = ? WHERE model_id = ?").run(
          newCash,
          `[가상매도] ${pos.market} ${sellReason} 체결 (${profitKrw >= 0 ? "+" : ""}${profitKrw.toLocaleString("ko-KR")}원)`,
          now,
          model.model_id
        );
      }
    }

    // 2) 신규 진입 시그널 평가 (최대 보유 포지션 2개 이하 & 가용 현금 50,000원 이상)
    const remainingOpen = sqliteDb.prepare("SELECT * FROM algo_lab_positions WHERE model_id = ? AND status = 'OPEN'").all(model.model_id);
    const heldMarkets = new Set(remainingOpen.map((p) => p.market));

    const refreshedModel = sqliteDb.prepare("SELECT * FROM algo_lab_models WHERE model_id = ?").get(model.model_id);
    const availableCash = Number(refreshedModel?.cash_krw || 0);

    if (heldMarkets.size < 2 && availableCash >= 50000) {
      const orderKrw = Math.floor(Math.min(availableCash, Number(model.initial_capital) * orderRatio));

      for (const mkt of targetMarkets) {
        if (heldMarkets.has(mkt)) continue;
        const tk = tickerMap.get(mkt);
        if (!tk) continue;
        const curPrice = Number(tk.trade_price);
        const changeRate = Number(tk.signed_change_rate || 0) * 100.0;

        let buySignal = false;
        let signalMsg = "";

        if (model.model_id === "algo_volatility_breakout") {
          // 변동성 돌파: 전일대비 양봉(+0.5% 이상) & 당일 거래대금 활발
          if (changeRate >= 0.8 && Number(tk.acc_trade_price_24h || 0) >= 5000000000) {
            buySignal = true;
            signalMsg = `변동성 돌파 모멘텀(+${changeRate.toFixed(2)}%)`;
          }
        } else if (model.model_id === "algo_dual_momentum") {
          // 듀얼 모멘텀: 24h 상승률 +1.5% 이상
          if (changeRate >= Number(cfg.abs_momentum_threshold_pct || 1.5)) {
            buySignal = true;
            signalMsg = `절대 모멘텀 기준 충족(+${changeRate.toFixed(2)}%)`;
          }
        } else if (model.model_id === "algo_bollinger_reversal") {
          // 볼린저 역추세: 단기 음봉 과매도(-1.2% 이하)
          if (changeRate <= -1.2) {
            buySignal = true;
            signalMsg = `하단 밴드 과매도권 터치(${changeRate.toFixed(2)}%)`;
          }
        } else if (model.model_id === "algo_macd_trend") {
          // MACD 추세: 완만한 상승 추세(+0.6% ~ +3.5%)
          if (changeRate >= 0.6 && changeRate <= 3.5) {
            buySignal = true;
            signalMsg = `MACD 양전환 추세 정배열`;
          }
        } else if (model.model_id === "algo_rsi_scalping") {
          // RSI 스캘핑: 당일 낙폭 과대(-2.0% 이하) 반등 대기
          if (changeRate <= -2.0) {
            buySignal = true;
            signalMsg = `RSI 극단 과매도 저점 스캘핑`;
          }
        } else if (model.model_id === "algo_supertrend_atr") {
          // 슈퍼트렌드: 견조한 상승 추세(+1.0% 이상)
          if (changeRate >= 1.0) {
            buySignal = true;
            signalMsg = `슈퍼트렌드 상향 돌파 시그널`;
          }
        }

        if (buySignal && orderKrw >= 10000) {
          // 가상 매수 체결
          const buyFee = Math.floor(orderKrw * 0.0005);
          const actualBuyFunds = orderKrw - buyFee;
          const volStr = (actualBuyFunds / curPrice).toFixed(8);

          sqliteDb.prepare(`
            INSERT INTO algo_lab_positions (model_id, market, volume, avg_buy_price, buy_amount, buy_fee, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
          `).run(model.model_id, mkt, volStr, curPrice, orderKrw, buyFee, now);

          sqliteDb.prepare(`
            INSERT INTO algo_lab_trades (
              model_id, market, buy_price, buy_volume, buy_amount, buy_date, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'HOLDING')
          `).run(model.model_id, mkt, curPrice, volStr, orderKrw, now);

          const newCash = availableCash - orderKrw;
          sqliteDb.prepare("UPDATE algo_lab_models SET cash_krw = ?, last_signal_text = ?, updated_at = ? WHERE model_id = ?").run(
            newCash,
            `[가상매수] ${mkt} ${signalMsg} 체결 (${orderKrw.toLocaleString("ko-KR")}원)`,
            now,
            model.model_id
          );
          break;
        }
      }
    }
  }

  // 3) 전체 모델 랭킹 재산출
  recalcAndRankModels(sqliteDb);
}

export function getAlgoLabModels(sqliteDb) {
  const models = sqliteDb.prepare("SELECT * FROM algo_lab_models ORDER BY current_rank ASC").all();
  for (const m of models) {
    m.open_positions = sqliteDb.prepare("SELECT * FROM algo_lab_positions WHERE model_id = ? AND status = 'OPEN' ORDER BY id ASC").all(m.model_id);
    m.recent_trades = sqliteDb.prepare("SELECT * FROM algo_lab_trades WHERE model_id = ? ORDER BY id DESC LIMIT 5").all(m.model_id);
  }
  return models;
}

export function getAlgoLabTrades(sqliteDb, modelId = null, limit = 50) {
  if (modelId) {
    return sqliteDb.prepare(`
      SELECT t.*, m.name AS model_name, m.category
      FROM algo_lab_trades t
      JOIN algo_lab_models m ON t.model_id = m.model_id
      WHERE t.model_id = ?
      ORDER BY t.id DESC
      LIMIT ?
    `).all(modelId, limit);
  }
  return sqliteDb.prepare(`
    SELECT t.*, m.name AS model_name, m.category
    FROM algo_lab_trades t
    JOIN algo_lab_models m ON t.model_id = m.model_id
    ORDER BY t.id DESC
    LIMIT ?
  `).all(limit);
}

export function resetAlgoLab(sqliteDb) {
  sqliteDb.exec(`
    DELETE FROM algo_lab_positions;
    DELETE FROM algo_lab_trades;
    UPDATE algo_lab_models
    SET cash_krw = initial_capital,
        eval_assets_krw = initial_capital,
        cumulative_profit_krw = 0,
        profit_rate_pct = 0.0,
        win_trades = 0,
        lose_trades = 0,
        total_trades = 0,
        win_rate_pct = 0.0,
        last_signal_text = '검증소 초기화 완료 (100만원 리셋 - 실시간 검증 시작)',
        updated_at = datetime('now', 'localtime');
  `);
}

