import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

const API_BASE = "";

function formatKRW(val) {
  if (val === null || val === undefined || val === "") return "";
  const cleaned = String(val).replace(/,/g, "");
  const num = Number(cleaned);
  if (Number.isNaN(num)) return "";
  return `${Math.floor(num).toLocaleString("ko-KR")}원`;
}

function formatWithCommas(val) {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val).replace(/,/g, "").trim();
  if (str === "" || str === "-") return str;
  const num = Number(str);
  if (Number.isNaN(num)) return "";
  return Math.floor(num).toLocaleString("ko-KR");
}

function parseNumericInput(val) {
  if (val === null || val === undefined) return "";
  const cleaned = String(val).replace(/[^0-9-]/g, "");
  if (cleaned === "" || cleaned === "-") return "";
  const num = Number(cleaned);
  return Number.isNaN(num) ? "" : Math.floor(num);
}

function computeAllocationPreview(rawTotalCapital, botsList, ratiosMap) {
  const flooredTotal = Math.max(0, Math.floor(Number(rawTotalCapital || 0)));
  const items = (botsList || []).map((b) => {
    const used = Math.floor(
      Number(
        b.used_capital !== undefined
          ? b.used_capital
          : (b.open_positions || []).reduce((acc, p) => acc + Number(p.buy_amount || 0), 0)
      )
    );
    const ratio = Math.max(
      0,
      Number(ratiosMap && ratiosMap[b.bot_id] !== undefined ? ratiosMap[b.bot_id] || 0 : b.allocation_ratio || 0)
    );
    return {
      bot_id: b.bot_id,
      used,
      ratio,
      allocated: 0,
      virtual_krw: 0,
      locked: false,
    };
  });

  const totalUsed = items.reduce((acc, it) => acc + it.used, 0);
  if (flooredTotal <= 0) {
    const byBot = {};
    for (const it of items) {
      byBot[it.bot_id] = { used: it.used, allocated: 0, virtual_krw: 0, ratio: it.ratio };
    }
    return { flooredTotal: 0, totalUsed, totalAllocated: 0, totalVirtual: 0, byBot };
  }

  const totalRatio = Number(items.reduce((acc, it) => acc + it.ratio, 0).toFixed(4));
  const targetPool =
    totalRatio >= 99.99
      ? flooredTotal
      : Math.max(totalUsed, Math.floor(flooredTotal * (totalRatio / 100.0)));

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

  const byBot = {};
  for (const it of items) {
    byBot[it.bot_id] = {
      used: it.used,
      allocated: it.allocated,
      virtual_krw: it.virtual_krw,
      ratio: it.ratio,
    };
  }

  return {
    flooredTotal,
    totalUsed,
    totalAllocated: items.reduce((acc, it) => acc + it.allocated, 0),
    totalVirtual: items.reduce((acc, it) => acc + it.virtual_krw, 0),
    byBot,
  };
}

function renderColoredProfit(val) {
  const num = Number(val || 0);
  if (num > 0) {
    return <span className="pnl-profit">+{Math.floor(num).toLocaleString("ko-KR")}원</span>;
  }
  if (num < 0) {
    return <span className="pnl-loss">{Math.floor(num).toLocaleString("ko-KR")}원</span>;
  }
  return <span className="pnl-Zero">0원</span>;
}

/**
 * 통계 선 그래프 컴포넌트 (요구사항 10, 11)
 * 2026.10.01부터의 일간/주간/월간 차익 이력을 꺾은선 그래프로 표기
 */
function ProfitLineChart({ series, periodLabel }) {
  if (!series || series.length === 0) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
        2026.10.01 이후 집계된 차익 데이터가 없습니다.
      </div>
    );
  }

  const width = 860;
  const height = 270;
  const padLeft = 75;
  const padRight = 30;
  const padTop = 28;
  const padBottom = 45;

  const values = series.map((d) => Number(d.cumulative_profit || 0));
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const isAllZero = maxVal === 0 && minVal === 0;
  const range = isAllZero ? 1 : maxVal - minVal;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const points = series.map((item, idx) => {
    const x =
      series.length === 1
        ? padLeft + plotW / 2
        : padLeft + (idx / (series.length - 1)) * plotW;
    const y = isAllZero
      ? padTop + plotH / 2
      : padTop + plotH - ((Number(item.cumulative_profit || 0) - minVal) / range) * plotH;
    return { x, y, ...item };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = isAllZero
    ? padTop + plotH / 2
    : padTop + plotH - ((0 - minVal) / range) * plotH;
  const showMaxLabel = maxVal > 0 && Math.abs(zeroY - padTop) >= 18;
  const showMinLabel = minVal < 0 && Math.abs(padTop + plotH - zeroY) >= 18;

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", minWidth: "560px" }}
      >
        {/* 기준선 (0원) */}
        <line
          x1={padLeft}
          y1={zeroY}
          x2={width - padRight}
          y2={zeroY}
          stroke="#334155"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <text
          x={padLeft - 12}
          y={zeroY + 4}
          textAnchor="end"
          fill="#94a3b8"
          fontSize="11"
        >
          0원
        </text>
        {showMaxLabel && (
          <text
            x={padLeft - 12}
            y={padTop + 4}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="11"
          >
            +{Math.floor(maxVal).toLocaleString()}원
          </text>
        )}
        {showMinLabel && (
          <text
            x={padLeft - 12}
            y={padTop + plotH + 4}
            textAnchor="end"
            fill="#94a3b8"
            fontSize="11"
          >
            {Math.floor(minVal).toLocaleString()}원
          </text>
        )}

        {/* 선 그래프 */}
        <polyline
          fill="none"
          stroke="#6366f1"
          strokeWidth="3"
          points={polylinePoints}
        />

        {/* 데이터 포인트 및 라벨 */}
        {points.map((pt, i) => {
          const isPositive = pt.cumulative_profit > 0;
          const isNegative = pt.cumulative_profit < 0;
          const dotColor = isPositive ? "#ef4444" : isNegative ? "#3b82f6" : "#e2e8f0";
          return (
            <g key={pt.label + i}>
              <circle cx={pt.x} cy={pt.y} r="5" fill={dotColor} stroke="#0b0f19" strokeWidth="2" />
              <text
                x={pt.x}
                y={pt.y - 10}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize="11"
                fontWeight="600"
              >
                {Math.floor(pt.cumulative_profit).toLocaleString()}원
              </text>
              <text
                x={pt.x}
                y={height - 14}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize="11"
              >
                {pt.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "6px", textAlign: "right" }}>
        * 통계 시작 기준일: 2026.10.01 ({periodLabel} 누적 차익 추이)
      </div>
    </div>
  );
}

function MarkdownViewer({ content, isStreaming = false }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements = [];
  let currentList = [];

  const flushList = () => {
    if (currentList.length > 0) {
      elements.push(
        <ul key={`ul-${elements.length}`} style={{ margin: "8px 0 12px 20px", paddingLeft: "10px", lineHeight: "1.7" }}>
          {currentList.map((item, idx) => (
            <li key={idx} style={{ marginBottom: "4px", color: "#e2e8f0" }}>{renderFormattedText(item)}</li>
          ))}
        </ul>
      );
      currentList = [];
    }
  };

  const renderFormattedText = (text) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i} style={{ color: "#38bdf8", fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      currentList.push(line.slice(2));
      return;
    }
    flushList();

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={index} style={{ fontSize: "15px", fontWeight: 700, color: "#cbd5e1", margin: "14px 0 6px" }}>
          {renderFormattedText(line.slice(4))}
        </h4>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3 key={index} style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc", margin: "18px 0 8px", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "6px" }}>
          {renderFormattedText(line.slice(3))}
        </h3>
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h2 key={index} style={{ fontSize: "18px", fontWeight: 800, color: "#38bdf8", margin: "20px 0 10px" }}>
          {renderFormattedText(line.slice(2))}
        </h2>
      );
    } else if (line.trim().length === 0) {
      elements.push(<div key={index} style={{ height: "6px" }} />);
    } else {
      elements.push(
        <p key={index} style={{ margin: "4px 0", lineHeight: "1.65", color: "#cbd5e1" }}>
          {renderFormattedText(line)}
        </p>
      );
    }
  });

  flushList();
  return (
    <div style={{ fontSize: "13.5px", color: "#e2e8f0" }}>
      {elements}
      {isStreaming && (
        <span
          style={{
            display: "inline-block",
            width: "3px",
            height: "14px",
            backgroundColor: "#38bdf8",
            marginLeft: "4px",
            verticalAlign: "middle",
            animation: "cursorBlink 0.8s infinite",
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  // 1) 입장 코드 인증 상태 (요구사항 6: sws@2129, 새로고침 시 인증 및 현재 페이지 유지)
  const [authenticated, setAuthenticated] = useState(() => {
    return (
      sessionStorage.getItem("autoCoinTrade_auth") === "true" ||
      localStorage.getItem("autoCoinTrade_auth") === "true"
    );
  });
  const [entryCodeInput, setEntryCodeInput] = useState("");
  const [gateError, setGateError] = useState("");

  // 2) 좌측 메뉴 상태 (거래현황 | 통계 | 설정 - 새로고침 시 현재 메뉴 유지)
  const [activeMenu, setActiveMenu] = useState(() => {
    return (
      sessionStorage.getItem("autoCoinTrade_menu") ||
      localStorage.getItem("autoCoinTrade_menu") ||
      "trades"
    );
  });

  // 3) 업비트 통신 상태 (요구사항 19: 정상 초록 / 지연 노랑 / 불가 빨강 + 이유 툴팁)
  const [upbitStatus, setUpbitStatus] = useState({
    status: "green",
    label: "정상통신",
    latency_ms: 45,
    reason: "업비트 Open API 통신 상태 확인 중...",
    checked_at: "",
  });

  // 4) 봇 목록, 거래 내역, 통계, 자금 분배 상태
  const [bots, setBots] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState(() => {
    return (
      sessionStorage.getItem("autoCoinTrade_bot") ||
      localStorage.getItem("autoCoinTrade_bot") ||
      "bot_volatility"
    );
  });
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState({
    start_date: "2026.10.01",
    daily: [],
    weekly: [],
    monthly: [],
    coin_ranking: [],
  });
  const [statsPeriodTab, setStatsPeriodTab] = useState(() => {
    return (
      sessionStorage.getItem("autoCoinTrade_statsTab") ||
      localStorage.getItem("autoCoinTrade_statsTab") ||
      "daily"
    );
  });

  // 5) 설정 화면용 상태 (기본값 없음)
  const [totalCapitalInput, setTotalCapitalInput] = useState("");
  const [ratioInputs, setRatioInputs] = useState({});
  const [botEditForms, setBotEditForms] = useState({});
  const [upbitAccount, setUpbitAccount] = useState({
    loading: false,
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
    message: "",
    checked_at: "",
  });
  const fileInputRef = useRef(null);

  // 6) Modal Popup 상태 (요구사항 20: 거래 시작/중지 모달, 요구사항 21: 잔고 0 이하 중지 알림 모달)
  const [modalInfo, setModalInfo] = useState({
    open: false,
    title: "",
    message: "",
    type: "info",
  });
  const [zeroBalanceAlerted, setZeroBalanceAlerted] = useState(false);

  // 7) AI 실시간 마켓 브리핑 상태 (Gemini 3.5 Flash)
  const [aiBriefing, setAiBriefing] = useState({
    has_key: false,
    masked_key: "",
    latest: null,
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [showAiKeyConfig, setShowAiKeyConfig] = useState(false);
  const [isAiBriefingExpanded, setIsAiBriefingExpanded] = useState(false);

  // 실시간 스트리밍 & 한 글자씩 타이핑(Typewriter) 상태
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingMeta, setStreamingMeta] = useState(null);
  const typewriterQueueRef = useRef("");
  const typingTimerRef = useRef(null);
  const isStreamDoneRef = useRef(false);

  // 8) 뉴스 피드 상태 (요구사항: 50건 페이지네이션, 날짜/키워드 검색)
  const [newsList, setNewsList] = useState([]);
  const [newsTotal, setNewsTotal] = useState(0);
  const [newsPage, setNewsPage] = useState(1);
  const [newsTotalPages, setNewsTotalPages] = useState(1);
  const [newsKeyword, setNewsKeyword] = useState("");
  const [newsStartDate, setNewsStartDate] = useState("");
  const [newsEndDate, setNewsEndDate] = useState("");
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
  const [newsNotice, setNewsNotice] = useState("");

  // 9) 뉴스 기반 AI 종합 판단 및 실시간 스트리밍 상태 (요구사항: 접을 수 있는 영역, 한 글자씩 스트리밍 타이핑)
  const [isNewsAiExpanded, setIsNewsAiExpanded] = useState(true);
  const [newsAiLoading, setNewsAiLoading] = useState(false);
  const [isNewsStreaming, setIsNewsStreaming] = useState(false);
  const [newsStreamingText, setNewsStreamingText] = useState("");
  const [newsStreamingMeta, setNewsStreamingMeta] = useState(null);
  const [newsAiBriefing, setNewsAiBriefing] = useState({
    has_key: false,
    masked_key: "",
    latest: null,
  });
  const newsTypewriterQueueRef = useRef("");
  const newsTypingTimerRef = useRef(null);
  const isNewsStreamDoneRef = useRef(false);

  // 뉴스 AI 한 글자씩 부드럽게 화면에 타이핑해주는 이펙트
  useEffect(() => {
    if (!isNewsStreaming) {
      if (newsTypingTimerRef.current) clearInterval(newsTypingTimerRef.current);
      return;
    }

    newsTypingTimerRef.current = setInterval(() => {
      if (newsTypewriterQueueRef.current.length > 0) {
        const qLen = newsTypewriterQueueRef.current.length;
        const take = qLen > 80 ? 4 : qLen > 30 ? 2 : 1;
        const nextChars = newsTypewriterQueueRef.current.slice(0, take);
        newsTypewriterQueueRef.current = newsTypewriterQueueRef.current.slice(take);
        setNewsStreamingText((prev) => prev + nextChars);
      } else if (isNewsStreamDoneRef.current) {
        clearInterval(newsTypingTimerRef.current);
        setIsNewsStreaming(false);
      }
    }, 18);

    return () => {
      if (newsTypingTimerRef.current) clearInterval(newsTypingTimerRef.current);
    };
  }, [isNewsStreaming]);

  // 한 글자씩 부드럽게 화면에 타이핑해주는 이펙트
  useEffect(() => {
    if (!isStreaming) {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
      return;
    }

    typingTimerRef.current = setInterval(() => {
      if (typewriterQueueRef.current.length > 0) {
        const qLen = typewriterQueueRef.current.length;
        // 큐 크기에 따라 1~4글자씩 꺼내어 지연 없이 부드럽게 한 글자씩 타이핑
        const take = qLen > 80 ? 4 : qLen > 30 ? 2 : 1;
        const nextChars = typewriterQueueRef.current.slice(0, take);
        typewriterQueueRef.current = typewriterQueueRef.current.slice(take);
        setStreamingText((prev) => prev + nextChars);
      } else if (isStreamDoneRef.current) {
        clearInterval(typingTimerRef.current);
        setIsStreaming(false);
      }
    }, 18);

    return () => {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
    };
  }, [isStreaming]);

  const showModal = (title, message, type = "info") => {
    setModalInfo({ open: true, title, message, type });
  };

  const closeModal = () => {
    setModalInfo((prev) => ({ ...prev, open: false }));
  };

  // 10) 거래 모드 상태 (가상거래 모의투자 'paper' vs 실거래 'live')
  const [tradeMode, setTradeMode] = useState({
    mode: "live",
    is_live: true,
    has_keys: true,
    loading: false,
    message: "",
  });

  const fetchTradeMode = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/trade-mode`);
      if (!resp.ok) return;
      const data = await resp.json();
      setTradeMode((prev) => ({
        ...prev,
        mode: data.mode || "live",
        is_live: !!data.is_live,
        has_keys: !!data.has_keys,
        message: data.message || "",
      }));
    } catch {}
  }, []);

  const handleToggleTradeMode = async (targetMode) => {
    const nextMode = targetMode || (tradeMode.mode === "live" ? "paper" : "live");
    const confirmMsg =
      nextMode === "live"
        ? "⚠️ [실거래 모드]로 전환하시겠습니까?\n실제 업비트 계좌의 자금으로 실제 매수/매도 주문이 전송됩니다."
        : "🧪 [가상거래(모의투자) 모드]로 전환하시겠습니까?\n실제 코인 시세와 호가를 바탕으로 모의 체결이 이루어지며, 실제 계좌 잔고는 소진되지 않습니다.";
    if (!window.confirm(confirmMsg)) return;

    setTradeMode((prev) => ({ ...prev, loading: true }));
    try {
      const resp = await fetch(`${API_BASE}/api/trade-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setTradeMode((prev) => ({
          ...prev,
          mode: data.mode,
          is_live: data.mode === "live" && prev.has_keys,
          loading: false,
          message: data.message,
        }));
        showModal(
          data.mode === "live" ? "⚡ 실거래 모드 전환 완료" : "🧪 가상거래 모드 전환 완료",
          data.message,
          data.mode === "live" ? "warning" : "info"
        );
        fetchOverviewAndBots(false);
      } else {
        alert(data.message || "모드 변경에 실패했습니다.");
        setTradeMode((prev) => ({ ...prev, loading: false }));
      }
    } catch (err) {
      alert("모드 변경 중 통신 오류가 발생했습니다: " + err.message);
      setTradeMode((prev) => ({ ...prev, loading: false }));
    }
  };

  // 11) 알고리즘 검증소 (Algorithm Validation Lab) 상태
  const [algoModels, setAlgoModels] = useState([]);
  const [algoTrades, setAlgoTrades] = useState([]);
  const [selectedAlgoModelId, setSelectedAlgoModelId] = useState("all");
  const [algoLabLoading, setAlgoLabLoading] = useState(false);
  const [algoLabCycleRunning, setAlgoLabCycleRunning] = useState(false);
  const [algoLabLastUpdated, setAlgoLabLastUpdated] = useState("");

  const fetchAlgoLabModels = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/algo-lab/models`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success && Array.isArray(data.models)) {
        setAlgoModels(data.models);
        setAlgoLabLastUpdated(data.updated_at || "");
      }
    } catch {}
  }, []);

  const fetchAlgoLabTrades = useCallback(async (modelId = null) => {
    try {
      const targetId = modelId !== undefined && modelId !== null ? modelId : selectedAlgoModelId;
      const url =
        targetId && targetId !== "all"
          ? `${API_BASE}/api/algo-lab/trades?model_id=${encodeURIComponent(targetId)}&limit=50`
          : `${API_BASE}/api/algo-lab/trades?limit=50`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success && Array.isArray(data.trades)) {
        setAlgoTrades(data.trades);
      }
    } catch {}
  }, [selectedAlgoModelId]);

  const handleResetAlgoLab = async () => {
    if (!window.confirm("알고리즘 검증소의 모든 모델 자본을 1,000,000원으로 초기화하고 가상 거래 기록을 리셋하시겠습니까?")) {
      return;
    }
    setAlgoLabLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/algo-lab/reset`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAlgoModels(data.models || []);
        fetchAlgoLabTrades(selectedAlgoModelId);
        showModal("알고리즘 검증소 초기화", data.message, "info");
      }
    } catch (err) {
      alert("검증소 초기화 실패: " + err.message);
    } finally {
      setAlgoLabLoading(false);
    }
  };

  const handleRunAlgoLabCycle = async () => {
    setAlgoLabCycleRunning(true);
    try {
      const resp = await fetch(`${API_BASE}/api/algo-lab/run-cycle`, { method: "POST" });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAlgoModels(data.models || []);
        fetchAlgoLabTrades(selectedAlgoModelId);
      }
    } catch (err) {
      console.warn("Run cycle error:", err);
    } finally {
      setAlgoLabCycleRunning(false);
    }
  };

  const fetchAiBriefing = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/ai/briefing`);
      if (resp.ok) {
        const data = await resp.json();
        setAiBriefing(data);
      }
    } catch (err) {
      console.error("Failed to fetch AI briefing:", err);
    }
  };

  const triggerAiAnalysis = async () => {
    setIsAiBriefingExpanded(true);
    setAiLoading(true);
    setAiError("");
    setStreamingText("");
    setStreamingMeta(null);
    typewriterQueueRef.current = "";
    isStreamDoneRef.current = false;

    try {
      const resp = await fetch(`${API_BASE}/api/ai/stream-analyze`, {
        method: "POST",
      });

      if (!resp.ok) {
        let errMsg = `분석 요청 실패 (HTTP ${resp.status})`;
        try {
          const errData = await resp.json();
          errMsg = errData.message || errMsg;
          if (errData.error === "NO_API_KEY") {
            setShowAiKeyConfig(true);
          }
        } catch {}
        setAiError(errMsg);
        setAiLoading(false);
        return;
      }

      setIsStreaming(true);
      setAiLoading(false);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let capturedMeta = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const blocks = sseBuffer.split("\n\n");
        sseBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const data = JSON.parse(jsonStr);
              if (data.type === "meta") {
                capturedMeta = data;
                setStreamingMeta(data);
              } else if (data.type === "chunk" && data.text) {
                typewriterQueueRef.current += data.text;
              } else if (data.type === "done") {
                isStreamDoneRef.current = true;
                setAiBriefing((prev) => ({
                  ...prev,
                  latest: {
                    id: data.id,
                    provider: "gemini",
                    model: data.model,
                    btc_price: capturedMeta?.btc_price,
                    btc_daily_20ma: capturedMeta?.btc_daily_20ma,
                    btc_4h_60ma: capturedMeta?.btc_4h_60ma,
                    regime_status: capturedMeta?.regime_status,
                    briefing_text: data.full_text,
                    created_at: data.created_at,
                  },
                }));
              } else if (data.type === "error") {
                setAiError(data.message || "스트리밍 중 오류가 발생했습니다.");
                isStreamDoneRef.current = true;
              }
            } catch {}
          }
        }
      }

      isStreamDoneRef.current = true;
    } catch (err) {
      setAiError(`서버 연결 오류: ${err.message}`);
      setIsStreaming(false);
      setAiLoading(false);
    }
  };

  const handleSaveAiKey = async () => {
    if (!aiKeyInput.trim()) {
      setAiError("Gemini API 키를 입력해주세요.");
      return;
    }
    setAiLoading(true);
    setAiError("");
    try {
      const resp = await fetch(`${API_BASE}/api/ai/save-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gemini_api_key: aiKeyInput.trim() }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAiBriefing((prev) => ({
          ...prev,
          has_key: data.has_key,
          masked_key: data.masked_key,
        }));
        setAiKeyInput("");
        setShowAiKeyConfig(false);
        showModal(
          "Gemini API 키 저장 완료",
          "Gemini API 키가 config/upbit_config.json에 성공적으로 저장되었습니다. 이제 [AI 시황 분석 요청]을 실행하실 수 있습니다.",
          "success"
        );
      } else {
        setAiError("API 키 저장에 실패했습니다.");
      }
    } catch (err) {
      setAiError(`저장 중 오류: ${err.message}`);
    } finally {
      setAiLoading(false);
    }
  };

  // 입장 코드 검증 (sws@2129)
  const handleVerifyEntryCode = async (e) => {
    e.preventDefault();
    setGateError("");
    const trimmed = entryCodeInput.trim();
    // 한글 자판 상태에서 sws@2129를 입력한 경우(ㄴㅈㄴ@2129)도 허용
    const normalized = trimmed.replace(/^ㄴㅈㄴ/, "sws");

    if (normalized === "sws@2129") {
      sessionStorage.setItem("autoCoinTrade_auth", "true");
      localStorage.setItem("autoCoinTrade_auth", "true");
      setAuthenticated(true);
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      if (resp.ok) {
        sessionStorage.setItem("autoCoinTrade_auth", "true");
        localStorage.setItem("autoCoinTrade_auth", "true");
        setAuthenticated(true);
      } else {
        const err = await resp.json().catch(() => ({}));
        setGateError(err.message || "입장 코드가 일치하지 않습니다.");
      }
    } catch {
      setGateError("입장 코드가 일치하지 않습니다.");
    }
  };

  // 업비트 통신 상태 주기적 조회
  const fetchUpbitStatus = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/upbit/status`);
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.status) {
          setUpbitStatus(data);
        } else {
          setUpbitStatus({
            status: "red",
            label: "통신불가",
            latency_ms: 0,
            reason: "업비트 통신 상태 응답 형식이 올바르지 않습니다.",
            checked_at: new Date().toLocaleTimeString(),
          });
        }
      } else {
        setUpbitStatus({
          status: "red",
          label: "통신불가",
          latency_ms: 0,
          reason: `업비트/백엔드 API 통신 오류 (HTTP ${resp.status})`,
          checked_at: new Date().toLocaleTimeString(),
        });
      }
    } catch (err) {
      setUpbitStatus({
        status: "red",
        label: "통신불가",
        latency_ms: 0,
        reason: `백엔드 서버(Port 8000) 연결 불가: ${err.message}`,
        checked_at: new Date().toLocaleTimeString(),
      });
    }
  };

  // 시스템 개요 및 봇 정보 조회
  const fetchOverviewAndBots = async (triggerZeroModalOnTrades = false) => {
    try {
      const resp = await fetch(`${API_BASE}/api/system/overview`);
      if (!resp.ok) return;
      const data = await resp.json();
      setBots(data.bots || []);
      setTotalCapitalInput(
        data.total_capital !== null && data.total_capital !== undefined && data.total_capital !== 0
          ? data.total_capital
          : ""
      );

      const newRatios = {};
      const newEditForms = {};
      (data.bots || []).forEach((b) => {
        newRatios[b.bot_id] = b.allocation_ratio ? b.allocation_ratio : "";
        newEditForms[b.bot_id] = {
          nickname: b.nickname || "",
          min_volume_krw: b.min_volume_krw ? b.min_volume_krw : "",
          stop_loss_pct: b.stop_loss_pct ? b.stop_loss_pct : "",
          take_profit_pct: b.take_profit_pct ? b.take_profit_pct : "",
          config: b.config || {},
        };
      });
      setRatioInputs(newRatios);
      setBotEditForms(newEditForms);

      // 요구사항 21: 설정된 잔고가 0 이하로 떨어져 모든 봇이 거래 중지된 경우 거래현황 진입 시 Modal Popup 표시
      if (data.zero_balance_halted && (triggerZeroModalOnTrades || !zeroBalanceAlerted)) {
        setZeroBalanceAlerted(true);
        showModal(
          "잔고 0원 이하 도달 - 전체 봇 자동 거래 중지",
          data.zero_balance_reason ||
            "설정된 잔고가 0원 이하로 떨어져 모든 봇이 자동으로 거래 중지되었습니다. 설정 메뉴에서 원금 및 자금 분배 비율을 재설정해주세요.",
          "danger"
        );
      }
    } catch (err) {
      console.error("Failed to fetch overview:", err);
    }
  };

  const fetchTrades = async (botId) => {
    try {
      const targetBot = botId || selectedBotId;
      const resp = await fetch(`${API_BASE}/api/trades?bot_id=${encodeURIComponent(targetBot)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      setTrades(data.trades || []);
      if (data.zero_balance_halted && activeMenu === "trades" && !zeroBalanceAlerted) {
        setZeroBalanceAlerted(true);
        showModal(
          "잔고 0원 이하 도달 - 전체 봇 자동 거래 중지",
          data.zero_balance_reason ||
            "설정된 잔고가 0원 이하로 떨어져 모든 봇이 거래 중지 상태입니다.",
          "danger"
        );
      }
    } catch (err) {
      console.error("Failed to fetch trades:", err);
    }
  };

  const fetchStatistics = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/statistics`);
      if (!resp.ok) return;
      const data = await resp.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to fetch statistics:", err);
    }
  };

  const fetchUpbitAccount = async () => {
    setUpbitAccount((prev) => ({ ...prev, loading: true }));
    try {
      const resp = await fetch(`${API_BASE}/api/upbit/account`);
      if (resp.ok) {
        const data = await resp.json();
        const krwTotal = data.krw_total ?? data.krw_balance ?? null;
        const evalKrw = data.total_eval_krw ?? 0;
        const computedTotalAsset =
          data.total_asset_krw ??
          (krwTotal !== null ? Math.floor(Number(krwTotal) + Number(evalKrw)) : null);
        setUpbitAccount({
          loading: false,
          success: Boolean(data.success),
          krw_balance: data.krw_balance ?? null,
          orderable_krw: data.orderable_krw ?? data.krw_balance ?? null,
          total_buy_krw: data.total_buy_krw ?? null,
          total_eval_krw: data.total_eval_krw ?? null,
          total_asset_krw: computedTotalAsset,
          eval_profit_krw: data.eval_profit_krw ?? null,
          eval_profit_pct: data.eval_profit_pct ?? null,
          krw_locked: data.krw_locked ?? null,
          krw_total: krwTotal,
          message: data.message || "",
          checked_at: data.checked_at || "",
        });
      } else {
        setUpbitAccount({
          loading: false,
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
          message: `업비트 계좌 잔고 조회 실패 (HTTP ${resp.status})`,
          checked_at: "",
        });
      }
    } catch (err) {
      setUpbitAccount({
        loading: false,
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
        message: `백엔드 서버 연결 실패: ${err.message}`,
        checked_at: "",
      });
    }
  };

  const refreshBotsStatusOnly = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/bots`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.bots)) {
        setBots(data.bots);
      }
    } catch {}
  };

  useEffect(() => {
    if (!authenticated) return;
    fetchUpbitStatus();
    fetchUpbitAccount();
    fetchOverviewAndBots(true);
    fetchTrades(selectedBotId);
    fetchStatistics();
    fetchAiBriefing();
    fetchTradeMode();
    fetchAlgoLabModels();

    const timer = setInterval(() => {
      fetchUpbitStatus();
      fetchUpbitAccount();
      refreshBotsStatusOnly();
      fetchTrades(selectedBotId);
      fetchTradeMode();
    }, 6000);
    return () => clearInterval(timer);
  }, [authenticated, selectedBotId, fetchTradeMode, fetchAlgoLabModels]);

  // 알고리즘 검증소 활성화 시 5초 주기 실시간 모델 랭킹 및 체결 일지 자동 갱신
  useEffect(() => {
    if (!authenticated || activeMenu !== "algo-lab") return;
    fetchAlgoLabModels();
    fetchAlgoLabTrades(selectedAlgoModelId);

    const timer = setInterval(() => {
      fetchAlgoLabModels();
      fetchAlgoLabTrades(selectedAlgoModelId);
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, activeMenu, selectedAlgoModelId, fetchAlgoLabModels, fetchAlgoLabTrades]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_menu", activeMenu);
    localStorage.setItem("autoCoinTrade_menu", activeMenu);
  }, [activeMenu]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_bot", selectedBotId);
    localStorage.setItem("autoCoinTrade_bot", selectedBotId);
  }, [selectedBotId]);

  useEffect(() => {
    sessionStorage.setItem("autoCoinTrade_statsTab", statsPeriodTab);
    localStorage.setItem("autoCoinTrade_statsTab", statsPeriodTab);
  }, [statsPeriodTab]);

  // 뉴스 목록 조회 (한 페이지 50건, 날짜/키워드 검색)
  const fetchNews = useCallback(
    async (page = 1, options = {}) => {
      setNewsLoading(true);
      try {
        const kw = options.keyword !== undefined ? options.keyword : newsKeyword;
        const sDate = options.startDate !== undefined ? options.startDate : newsStartDate;
        const eDate = options.endDate !== undefined ? options.endDate : newsEndDate;

        const params = new URLSearchParams();
        params.append("page", String(page));
        params.append("limit", "50");
        if (kw && kw.trim()) params.append("keyword", kw.trim());
        if (sDate) params.append("start_date", sDate);
        if (eDate) params.append("end_date", eDate);

        const resp = await fetch(`${API_BASE}/api/news?${params.toString()}`);
        if (resp.ok) {
          const data = await resp.json();
          setNewsList(data.items || []);
          setNewsTotal(data.total || 0);
          setNewsPage(data.page || 1);
          setNewsTotalPages(data.total_pages || 1);
        }
      } catch (err) {
        console.warn("Failed to fetch news:", err);
      } finally {
        setNewsLoading(false);
      }
    },
    [newsKeyword, newsStartDate, newsEndDate]
  );

  const fetchNewsAiBriefing = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/ai/news-briefing`);
      if (resp.ok) {
        const data = await resp.json();
        setNewsAiBriefing(data);
      }
    } catch (err) {
      console.warn("Failed to fetch news AI briefing:", err);
    }
  };

  const triggerNewsAiAnalysis = async () => {
    setIsNewsAiExpanded(true);
    setNewsAiLoading(true);
    setNewsStreamingText("");
    setNewsStreamingMeta(null);
    newsTypewriterQueueRef.current = "";
    isNewsStreamDoneRef.current = false;

    try {
      const resp = await fetch(`${API_BASE}/api/ai/stream-news-analyze`, {
        method: "POST",
      });

      if (!resp.ok) {
        let errMsg = `AI 분석 요청 실패 (HTTP ${resp.status})`;
        try {
          const errData = await resp.json();
          errMsg = errData.message || errMsg;
          if (errData.error === "NO_API_KEY") {
            setShowAiKeyConfig(true);
          }
        } catch {}
        setNewsStreamingText(`⚠️ ${errMsg}`);
        setNewsAiLoading(false);
        return;
      }

      setIsNewsStreaming(true);
      setNewsAiLoading(false);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const blocks = sseBuffer.split("\n\n");
        sseBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const data = JSON.parse(jsonStr);
              if (data.type === "meta") {
                setNewsStreamingMeta(data);
              } else if (data.type === "chunk" && data.text) {
                newsTypewriterQueueRef.current += data.text;
              } else if (data.type === "done") {
                isNewsStreamDoneRef.current = true;
                setNewsAiBriefing((prev) => ({
                  ...prev,
                  latest: {
                    id: data.id,
                    provider: "gemini",
                    model: data.model,
                    news_count: data.news_count,
                    bullish_count: data.bullish_count,
                    bearish_count: data.bearish_count,
                    neutral_count: data.neutral_count,
                    briefing_text: data.full_text,
                    created_at: data.created_at,
                  },
                }));
              } else if (data.type === "error") {
                setNewsStreamingText((prev) => prev + `\n\n[오류] ${data.message || "스트리밍 중단"}`);
                isNewsStreamDoneRef.current = true;
              }
            } catch {}
          }
        }
      }
      isNewsStreamDoneRef.current = true;
    } catch (err) {
      setNewsStreamingText(`⚠️ 서버 연결 오류: ${err.message}`);
      setIsNewsStreaming(false);
      setNewsAiLoading(false);
    }
  };

  useEffect(() => {
    if (activeMenu === "news") {
      fetchNews(1);
      fetchNewsAiBriefing();
    }
  }, [activeMenu, fetchNews]);

  const handleSearchNews = (e) => {
    if (e) e.preventDefault();
    fetchNews(1);
  };

  const handleResetNewsFilter = () => {
    setNewsKeyword("");
    setNewsStartDate("");
    setNewsEndDate("");
    fetchNews(1, { keyword: "", startDate: "", endDate: "" });
  };

  const handleQuickTagClick = (tag) => {
    const cleanTag = tag.replace(/^#/, "");
    setNewsKeyword(cleanTag);
    fetchNews(1, { keyword: cleanTag });
  };

  const handleRefreshNews = async () => {
    setNewsRefreshing(true);
    setNewsNotice("최신 뉴스를 실시간 수집 및 감성 분석 중입니다...");
    try {
      const resp = await fetch(`${API_BASE}/api/news/refresh`, { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        setNewsNotice(`뉴스 수집 완료: 신규 ${data.newly_inserted || 0}건 추가`);
        await fetchNews(1);
      } else {
        setNewsNotice("뉴스 수집 요청 중 오류가 발생했습니다.");
      }
    } catch (err) {
      setNewsNotice(`뉴스 수집 중 오류: ${err.message}`);
    } finally {
      setNewsRefreshing(false);
      setTimeout(() => setNewsNotice(""), 6000);
    }
  };

  // 메뉴 전환 시 처리 (거래현황 진입 시 잔고 0 이하 여부 즉시 체크하여 모달 표기)
  const handleMenuChange = (menuKey) => {
    setActiveMenu(menuKey);
    sessionStorage.setItem("autoCoinTrade_menu", menuKey);
    localStorage.setItem("autoCoinTrade_menu", menuKey);
    if (menuKey === "trades") {
      fetchOverviewAndBots(true);
      fetchUpbitAccount();
      fetchTrades(selectedBotId);
      fetchTradeMode();
    } else if (menuKey === "stats") {
      fetchStatistics();
    } else if (menuKey === "algo-lab") {
      fetchAlgoLabModels();
      fetchAlgoLabTrades(selectedAlgoModelId);
    } else if (menuKey === "news") {
      fetchNews(1);
      fetchNewsAiBriefing();
    } else if (menuKey === "settings") {
      fetchOverviewAndBots(false);
      fetchUpbitAccount();
      fetchTradeMode();
    }
  };

  // 요구사항 20: 거래 시작 / 중단 수동 제어 및 정상 동작 확인 Modal Popup 표기
  const handleBotStartStop = async (botId, start) => {
    const endpoint = start ? "start" : "stop";
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}/${endpoint}`, {
        method: "POST",
      });
      const data = await resp.json();
      await fetchOverviewAndBots(false);
      await fetchTrades(botId);

      if (data.success) {
        showModal(
          start ? "거래 시작 완료" : "거래 중지 완료",
          data.message ||
            (start
              ? "선택한 봇의 자동매매 거래가 정상적으로 시작되었습니다."
              : "선택한 봇의 자동매매 거래가 정상적으로 중지되었습니다."),
          start ? "success" : "info"
        );
      } else {
        showModal("거래 상태 변경 실패", data.message || "요청을 처리할 수 없습니다.", "danger");
      }
    } catch (err) {
      showModal("통신 오류", `봇 제어 요청 중 오류가 발생했습니다: ${err.message}`, "danger");
    }
  };

  // 수동 매수 / 보유 지분 분할 매도 테스트 (한 줄 업데이트 및 포지션 격리 확인용)
  const handleManualTradeTest = async (botId, action) => {
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}/manual-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, market: "KRW-BTC" }),
      });
      const data = await resp.json();
      await fetchOverviewAndBots(false);
      await fetchTrades(botId);
      await fetchStatistics();
      showModal(
        action === "buy" ? "즉시 매수 실행 결과" : "보유 지분 분할 매도 결과",
        data.message,
        data.success ? "success" : "danger"
      );
    } catch (err) {
      showModal("오류", err.message, "danger");
    }
  };

  // 요구사항 22: 자금 분배 비율 저장 (소수점 버림 적용)
  const handleSaveAllocation = async (e) => {
    e.preventDefault();
    const numericCapital = Math.floor(parseNumericInput(totalCapitalInput));
    const ratioSum = Number(
      Object.values(ratioInputs)
        .reduce((acc, v) => acc + Number(v || 0), 0)
        .toFixed(2)
    );

    if (ratioSum > 100) {
      showModal(
        "자금 분배 설정 오류",
        `봇별 자금 분배 비율의 합계(${ratioSum}%)는 100%를 초과할 수 없습니다.`,
        "danger"
      );
      return;
    }

    const maxAssetLimit = Number(upbitAccount.total_asset_krw ?? upbitAccount.krw_balance ?? 0);
    if (!upbitAccount.success || upbitAccount.total_asset_krw === null) {
      showModal(
        "운용 원금 저장 불가",
        `업비트 실계좌 및 총 보유 자산이 조회되지 않아 전체 운용 원금을 저장할 수 없습니다.\n(${upbitAccount.message || "업비트 실계좌 조회 필요"})`,
        "danger"
      );
      return;
    }

    if (numericCapital > maxAssetLimit) {
      showModal(
        "운용 원금 설정 오류 — 총 보유 자산 한도 초과",
        `입력한 전체 운용 원금(${numericCapital.toLocaleString("ko-KR")}원)이 업비트 총 보유 자산(${maxAssetLimit.toLocaleString(
          "ko-KR"
        )}원)의 한도를 초과합니다.\n전체 운용 원금은 총 보유 자산 이하로만 저장할 수 있습니다.`,
        "danger"
      );
      return;
    }

    const previewPlan = computeAllocationPreview(numericCapital, bots, ratioInputs);
    if (numericCapital > 0 && numericCapital < previewPlan.totalUsed) {
      showModal(
        "운용 원금 설정 오류 — 이미 사용된 투자금 미달",
        `입력한 전체 운용 원금(${numericCapital.toLocaleString("ko-KR")}원)이 현재 이미 매수에 사용된 투자금(${previewPlan.totalUsed.toLocaleString(
          "ko-KR"
        )}원)보다 적습니다.\n최소 ${previewPlan.totalUsed.toLocaleString("ko-KR")}원 이상으로 설정해주세요.`,
        "danger"
      );
      return;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/settings/allocation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total_capital: numericCapital,
          ratios: ratioInputs,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.success) {
        const errMsg =
          data?.detail ||
          data?.message ||
          `운용 원금 설정 저장 중 서버 오류가 발생했습니다 (HTTP ${resp.status}).`;
        showModal("운용 원금 및 자금 분배 저장 오류", errMsg, "danger");
        return;
      }
      setZeroBalanceAlerted(false);
      await fetchOverviewAndBots(true);
      showModal(
        "자금 분배 비율 설정 완료",
        data.zero_balance_halted
          ? data.zero_balance_reason
          : `${data.message}\n총 운용 원금: ${numericCapital.toLocaleString("ko-KR")}원`,
        data.zero_balance_halted ? "danger" : "success"
      );
    } catch (err) {
      showModal(
        "운용 원금 및 자금 분배 저장 오류",
        `백엔드 서버(${API_BASE})와 통신할 수 없어 운용 원금 설정이 저장되지 않았습니다.\n사유: ${err.message}`,
        "danger"
      );
    }
  };

  // 요구사항 15: 봇 수정 및 별명(Nickname) 저장
  const handleSaveBotConfig = async (botId) => {
    const form = botEditForms[botId];
    if (!form) return;
    try {
      const resp = await fetch(`${API_BASE}/api/bots/${botId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showModal("봇 설정 저장 실패", data.detail || "입력값을 확인해주세요.", "danger");
        return;
      }
      await fetchOverviewAndBots(false);
      showModal("봇 설정 저장 완료", data.message, "success");
    } catch (err) {
      showModal("오류", err.message, "danger");
    }
  };

  // 요구사항 13: JSON 파일 마이그레이션 (내보내기)
  const handleExportJson = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/settings/export`);
      if (!resp.ok) throw new Error("데이터 내보내기 실패");
      const data = await resp.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `autoCoinTrade_migration_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showModal(
        "데이터 마이그레이션(JSON) 완료",
        "현재 DB의 모든 봇 설정, 거래 내역, 포지션 정보가 JSON 파일로 저장되었습니다.",
        "success"
      );
    } catch (err) {
      showModal("마이그레이션 오류", err.message, "danger");
    }
  };

  // 요구사항 13: JSON 파일 읽어서 DB 복원
  const handleImportJsonFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const resp = await fetch(`${API_BASE}/api/settings/import-json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showModal("데이터 복원 실패", data.detail || "유효하지 않은 파일입니다.", "danger");
        return;
      }
      setBotEditForms({});
      await fetchOverviewAndBots(false);
      await fetchTrades(selectedBotId);
      await fetchStatistics();
      showModal("데이터 복원 완료", data.message, "success");
    } catch (err) {
      showModal("JSON 파일 읽기 오류", `파일 복원 중 오류가 발생했습니다: ${err.message}`, "danger");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const currentBot = useMemo(
    () => bots.find((b) => b.bot_id === selectedBotId) || bots[0] || null,
    [bots, selectedBotId]
  );

  // ------------------------------------------------------------------
  // 입장 코드 화면 (요구사항 6: sws@2129)
  // ------------------------------------------------------------------
  if (!authenticated) {
    return (
      <div className="gate-wrapper">
        <div className="gate-card">
          <span className="gate-badge">UPBIT QUANT AUTO TRADER</span>
          <h1 className="gate-title">코인 자동매매 시스템</h1>
          <p className="gate-subtitle">
            개인 전용 보안 화면입니다. 진입을 위해 입장 코드를 입력해주세요.
          </p>
          <form onSubmit={handleVerifyEntryCode}>
            <input
              type="password"
              className="gate-input"
              placeholder="입장 코드 입력"
              value={entryCodeInput}
              onChange={(e) => setEntryCodeInput(e.target.value)}
              autoFocus
            />
            {gateError && <div className="gate-error">{gateError}</div>}
            <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
              입장하기
            </button>
          </form>
        </div>
      </div>
    );
  }

  const chartSeries =
    statsPeriodTab === "daily"
      ? stats.daily
      : statsPeriodTab === "weekly"
      ? stats.weekly
      : stats.monthly;

  const periodLabel =
    statsPeriodTab === "daily" ? "일간" : statsPeriodTab === "weekly" ? "주간" : "월간";

  // ------------------------------------------------------------------
  // 내부 메인 화면 (요구사항 7: 좌측 메뉴 2 : 우측 상세 화면 8 비율)
  // ------------------------------------------------------------------
  return (
    <div className="app-layout">
      {/* 좌측 메뉴 영역 (20%) */}
      <aside className="left-sidebar">
        <div className="sidebar-top-section">
          <div className="brand-header">Upbit AutoTrade</div>

          {/* 요구사항 19: 메뉴 상단 업비트 통신 상태 식별 영역 (초록/노랑/빨강 + 마우스 오버 사유 표기) */}
          <div className="upbit-status-box">
            <div className="status-header-row">
              <span className="status-title">업비트 Open API 통신 상태</span>
              <div className="status-indicator-wrap">
                <span className={`status-dot ${upbitStatus.status || "green"}`} />
                <span className={`status-label-text ${upbitStatus.status || "green"}`}>
                  {upbitStatus.label || "정상통신"}
                </span>
              </div>
            </div>
            <div className="status-help-hint" style={{ fontSize: "11.5px", color: "#94a3b8" }}>
              마우스를 올리면 상세 통신 사유를 확인합니다.
            </div>

            {/* 마우스 오버 시 나타나는 상세 이유 툴팁 */}
            <div className="status-Tooltip">
              <div style={{ fontWeight: 700, marginBottom: "6px", color: "#fff" }}>
                [통신 상태 상세 사유]
              </div>
              <div>• 상태: {upbitStatus.label}</div>
              <div>• 사유: {upbitStatus.reason}</div>
              <div>• 응답속도: {upbitStatus.latency_ms ?? 0} ms</div>
              <div>• 최근확인: {upbitStatus.checked_at || "-"}</div>
            </div>
          </div>

          {/* 실시간 거래 모드 전환 버튼 (가상거래 모의투자 ↔ 실거래) */}
          <div className="trade-mode-chip-container">
            <button
              type="button"
              className={`mode-toggle-chip ${tradeMode.mode === "paper" ? "chip-paper" : "chip-live"}`}
              onClick={() => handleToggleTradeMode()}
              disabled={tradeMode.loading}
              title="클릭하여 실거래 / 가상거래(모의투자) 모드를 전환합니다."
            >
              <span className={`mode-dot ${tradeMode.mode === "paper" ? "paper" : "live"}`} />
              <span className="mode-text">
                {tradeMode.mode === "paper" ? "🧪 가상거래(모의)" : "⚡ 업비트 실거래"}
              </span>
              <span className="mode-switch-hint">전환 ⇄</span>
            </button>
          </div>
        </div>

        {/* 메뉴 구성 (거래현황, 통계, 알고리즘 검증소, 뉴스, 설정) */}
        <nav className="menu-list">
          <button
            className={`menu-btn ${activeMenu === "trades" ? "active" : ""}`}
            onClick={() => handleMenuChange("trades")}
          >
            <span>📊</span>
            <span>거래현황</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "stats" ? "active" : ""}`}
            onClick={() => handleMenuChange("stats")}
          >
            <span>📈</span>
            <span>통계</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "algo-lab" ? "active" : ""}`}
            onClick={() => handleMenuChange("algo-lab")}
          >
            <span>🧪</span>
            <span>검증소</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "news" ? "active" : ""}`}
            onClick={() => handleMenuChange("news")}
          >
            <span>📰</span>
            <span>뉴스</span>
          </button>
          <button
            className={`menu-btn ${activeMenu === "settings" ? "active" : ""}`}
            onClick={() => handleMenuChange("settings")}
          >
            <span>⚙️</span>
            <span>설정</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <span>모드:</span>
            <span
              style={{
                fontWeight: 700,
                color: tradeMode.mode === "paper" ? "#a5b4fc" : "#ef4444",
                cursor: "pointer",
              }}
              onClick={() => handleToggleTradeMode()}
              title="클릭하여 모드 전환"
            >
              {tradeMode.mode === "paper" ? "🧪 가상거래(모의)" : "⚡ 업비트 실거래"}
            </span>
          </div>
          <div>DB: SQLite (WAL / 자동 재접속)</div>
          <div style={{ marginTop: "4px" }}>Rate Limit: 0.12s 방어 적용</div>
        </div>
      </aside>

      {/* 우측 상세 화면 영역 (80%) */}
      <main className="right-content">
        {/* ============================================================
            [메뉴 1] 거래현황 (요구사항 9, 20, 21)
           ============================================================ */}
        {activeMenu === "trades" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">거래현황</h2>
                <p className="page-desc">
                  봇별 탭으로 거래 내역을 확인하고 수동으로 거래 시작 및 중단을 제어합니다.
                </p>
              </div>
            </div>

            {/* 가상거래 / 실거래 모드 상태 안내 카드 */}
            <div
              className="card"
              style={{
                marginBottom: "16px",
                padding: "12px 18px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
                background:
                  tradeMode.mode === "paper"
                    ? "linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(30, 27, 75, 0.35) 100%)"
                    : "linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(69, 10, 10, 0.25) 100%)",
                borderColor: tradeMode.mode === "paper" ? "rgba(99, 102, 241, 0.45)" : "rgba(239, 68, 68, 0.45)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "22px" }}>{tradeMode.mode === "paper" ? "🧪" : "⚡"}</span>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <strong style={{ fontSize: "15px", color: tradeMode.mode === "paper" ? "#c7d2fe" : "#fca5a5" }}>
                      {tradeMode.mode === "paper" ? "현재 [가상거래 모의투자] 모드 동작 중" : "현재 [업비트 실거래] 모드 동작 중"}
                    </strong>
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        fontWeight: 700,
                        background: tradeMode.mode === "paper" ? "#4338ca" : "#b91c1c",
                        color: "#ffffff",
                      }}
                    >
                      {tradeMode.mode === "paper" ? "PAPER" : "LIVE"}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "3px" }}>
                    {tradeMode.mode === "paper"
                      ? "실제 코인 실시간 지표(호가/캔들)를 사용하여 매수/매도 조건을 평가하고, 가상 원장으로 안전하게 모의 체결합니다."
                      : "업비트 실계좌 API 키를 통해 실제 원화 잔고로 매수/매도 주문이 거래소에 직접 전송됩니다."}
                  </div>
                </div>
              </div>

              <button
                type="button"
                className={`btn ${tradeMode.mode === "paper" ? "btn-primary" : "btn-stop"}`}
                onClick={() => handleToggleTradeMode()}
                disabled={tradeMode.loading}
                style={{ padding: "8px 16px", fontSize: "12.5px" }}
              >
                {tradeMode.loading ? "모드 전환 중..." : tradeMode.mode === "paper" ? "⚡ 실거래 모드로 전환" : "🧪 가상거래 모드로 전환"}
              </button>
            </div>

            {/* 거래현황 상단: 업비트 실계좌 조회 요약 (총 매수금액 / 총 평가금액 / 주문 가능 금액) */}
            <div className="card" style={{ marginBottom: "18px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#f8fafc" }}>
                  업비트 실계좌 자산 현황{" "}
                  {upbitAccount.checked_at && (
                    <span style={{ fontSize: "12px", fontWeight: 400, color: "#94a3b8", marginLeft: "8px" }}>
                      (조회 시각: {upbitAccount.checked_at})
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: "5px 12px", fontSize: "12px" }}
                  onClick={fetchUpbitAccount}
                  disabled={upbitAccount.loading}
                >
                  {upbitAccount.loading ? "조회 중..." : "업비트 자산 새로고침"}
                </button>
              </div>

              {!upbitAccount.success && (
                <div
                  style={{
                    fontSize: "12.5px",
                    color: "#f87171",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    borderRadius: "8px",
                    padding: "8px 12px",
                    marginBottom: "12px",
                  }}
                >
                  {upbitAccount.message || "업비트 실계좌 정보를 불러오지 못했습니다."}
                </div>
              )}

              <div
                className="bot-meta-grid"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
              >
                <div className="meta-item">
                  <span className="meta-label">총 매수금액</span>
                  <span className="meta-value" style={{ fontSize: "18px", color: "#f8fafc" }}>
                    {upbitAccount.success && upbitAccount.total_buy_krw !== null
                      ? `${Number(upbitAccount.total_buy_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                  </span>
                </div>

                <div className="meta-item">
                  <span className="meta-label">총 평가금액</span>
                  <span
                    className="meta-value"
                    style={{
                      fontSize: "18px",
                      color:
                        upbitAccount.success && upbitAccount.eval_profit_krw > 0
                          ? "#ef4444"
                          : upbitAccount.success && upbitAccount.eval_profit_krw < 0
                          ? "#3b82f6"
                          : "#f8fafc",
                    }}
                  >
                    {upbitAccount.success && upbitAccount.total_eval_krw !== null
                      ? `${Number(upbitAccount.total_eval_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                    {upbitAccount.success && upbitAccount.eval_profit_krw !== null && (
                      <span style={{ fontSize: "12.5px", marginLeft: "6px", fontWeight: 600 }}>
                        ({upbitAccount.eval_profit_krw > 0 ? "+" : ""}
                        {Number(upbitAccount.eval_profit_krw).toLocaleString("ko-KR")}원 /{" "}
                        {upbitAccount.eval_profit_pct > 0 ? "+" : ""}
                        {upbitAccount.eval_profit_pct}%)
                      </span>
                    )}
                  </span>
                </div>

                <div className="meta-item">
                  <span className="meta-label">주문 가능 금액</span>
                  <span className="meta-value" style={{ fontSize: "18px", color: "#38bdf8" }}>
                    {upbitAccount.success && upbitAccount.orderable_krw !== null
                      ? `${Number(upbitAccount.orderable_krw).toLocaleString("ko-KR")}원`
                      : "-"}
                  </span>
                </div>
              </div>
            </div>

            {/* AI 실시간 시장 분석 및 봇 진단 카드 (Gemini 3.5 Flash) */}
            <div
              className="card"
              style={{
                marginBottom: "18px",
                background: "linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.85) 100%)",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                boxShadow: "0 8px 24px -4px rgba(99, 102, 241, 0.12)",
                borderRadius: "12px",
                padding: isAiBriefingExpanded ? "18px 20px" : "12px 18px",
                transition: "all 0.25s ease-in-out",
              }}
            >
              {/* 상단 헤더: 타이틀 + 뱃지 + 간략정보 + 액션 버튼 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                  borderBottom: isAiBriefingExpanded ? "1px solid rgba(255, 255, 255, 0.08)" : "none",
                  paddingBottom: isAiBriefingExpanded ? "12px" : "0",
                  marginBottom: isAiBriefingExpanded ? "14px" : "0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "32px",
                      height: "32px",
                      borderRadius: "8px",
                      background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                      fontSize: "16px",
                      cursor: "pointer",
                    }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    🤖
                  </div>
                  <div
                    style={{ cursor: "pointer" }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc" }}>
                      AI 실시간 시장 분석 & 봇 진단
                    </span>
                    <span
                      style={{
                        marginLeft: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "rgba(99, 102, 241, 0.2)",
                        color: "#a5b4fc",
                        border: "1px solid rgba(99, 102, 241, 0.4)",
                      }}
                    >
                      {aiBriefing?.latest?.model ? aiBriefing.latest.model.replace("models/", "") : "Gemini 3.5 Flash"}
                    </span>
                  </div>
                  {aiBriefing?.latest && (
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                      (분석 시각: {aiBriefing.latest.created_at})
                    </span>
                  )}
                  {/* 접혀있을 때 간략 요약 뱃지 표시 */}
                  {!isAiBriefingExpanded && aiBriefing?.latest && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginLeft: "4px" }}>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "6px",
                          background:
                            aiBriefing.latest.regime_status === "HOLD_CASH"
                              ? "rgba(239, 68, 68, 0.2)"
                              : "rgba(34, 197, 94, 0.2)",
                          color:
                            aiBriefing.latest.regime_status === "HOLD_CASH" ? "#f87171" : "#4ade80",
                          border: `1px solid ${
                            aiBriefing.latest.regime_status === "HOLD_CASH"
                              ? "rgba(239, 68, 68, 0.4)"
                              : "rgba(34, 197, 94, 0.4)"
                          }`,
                        }}
                      >
                        {aiBriefing.latest.regime_status === "HOLD_CASH" ? "🔴 신규매수차단" : "🟢 정상거래 허용"}
                      </span>
                      {aiBriefing.latest.btc_price && (
                        <span style={{ fontSize: "12px", color: "#cbd5e1" }}>
                          BTC {Number(aiBriefing.latest.btc_price).toLocaleString("ko-KR")}원
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="ai-briefing-action-btns">
                  <button
                    type="button"
                    className="btn"
                    style={{
                      background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
                      color: "#fff",
                      border: "none",
                      padding: "6px 14px",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      borderRadius: "8px",
                      cursor: aiLoading || isStreaming ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
                      opacity: aiLoading || isStreaming ? 0.75 : 1,
                    }}
                    onClick={triggerAiAnalysis}
                    disabled={aiLoading || isStreaming}
                  >
                    {isStreaming ? (
                      <>
                        <span className="spinner" style={{ width: "13px", height: "13px" }} />
                        실시간 스트리밍 중...
                      </>
                    ) : aiLoading ? (
                      <>
                        <span className="spinner" style={{ width: "13px", height: "13px" }} />
                        Gemini 연결 중...
                      </>
                    ) : (
                      <>⚡ AI 시황 분석 요청</>
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      background: "rgba(51, 65, 85, 0.6)",
                      border: "1px solid rgba(148, 163, 184, 0.2)",
                    }}
                    onClick={() => {
                      setShowAiKeyConfig((prev) => {
                        const next = !prev;
                        if (next) setIsAiBriefingExpanded(true);
                        return next;
                      });
                    }}
                  >
                    ⚙️ {aiBriefing?.has_key ? "API 키 설정됨" : "API 키 등록"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{
                      padding: "6px 12px",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      background: isAiBriefingExpanded
                        ? "rgba(99, 102, 241, 0.25)"
                        : "rgba(51, 65, 85, 0.7)",
                      color: isAiBriefingExpanded ? "#c7d2fe" : "#f1f5f9",
                      border: isAiBriefingExpanded
                        ? "1px solid rgba(129, 140, 248, 0.5)"
                        : "1px solid rgba(148, 163, 184, 0.3)",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      cursor: "pointer",
                    }}
                    onClick={() => setIsAiBriefingExpanded((prev) => !prev)}
                    title={isAiBriefingExpanded ? "분석 영역 접기" : "분석 영역 펼치기"}
                  >
                    {isAiBriefingExpanded ? "▲ 분석 접기" : "▼ 분석 펼치기"}
                  </button>
                </div>
              </div>

              {/* 분석 영역 본문 (접힘/펼침 제어) */}
              {isAiBriefingExpanded && (
                <div>
                  {/* API 키 설정 패널 (접힘/펼침) */}
                  {showAiKeyConfig && (
                    <div
                      style={{
                        background: "rgba(15, 23, 42, 0.6)",
                        border: "1px solid rgba(148, 163, 184, 0.15)",
                        borderRadius: "8px",
                        padding: "14px 16px",
                        marginBottom: "14px",
                      }}
                    >
                      <div style={{ fontSize: "13px", fontWeight: 600, color: "#f8fafc", marginBottom: "6px" }}>
                        Google Gemini API 키 설정 (Method A)
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "10px", lineHeight: "1.5" }}>
                        Google AI Studio에서 발급받으신 Gemini API 키를 입력하세요. 저장을 누르시면 프로젝트 내{" "}
                        <code style={{ color: "#38bdf8" }}>config/upbit_config.json</code>의{" "}
                        <code style={{ color: "#38bdf8" }}>gemini_api_key</code> 항목에 안전하게 저장됩니다.
                        {aiBriefing?.has_key && (
                          <span style={{ color: "#4ade80", marginLeft: "6px", fontWeight: 600 }}>
                            (현재 등록된 키: {aiBriefing.masked_key})
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: "8px", maxWidth: "600px" }}>
                        <input
                          type="password"
                          placeholder="AIzaSy로 시작하는 Gemini API Key 입력..."
                          value={aiKeyInput}
                          onChange={(e) => setAiKeyInput(e.target.value)}
                          style={{
                            flex: 1,
                            padding: "7px 12px",
                            fontSize: "13px",
                            background: "#0f172a",
                            border: "1px solid rgba(148, 163, 184, 0.3)",
                            borderRadius: "6px",
                            color: "#fff",
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: "7px 16px", fontSize: "13px" }}
                          onClick={handleSaveAiKey}
                        >
                          저장
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "7px 12px", fontSize: "13px" }}
                          onClick={() => setShowAiKeyConfig(false)}
                        >
                          닫기
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 에러 메시지 알림 */}
                  {aiError && (
                    <div
                      style={{
                        fontSize: "12.5px",
                        color: "#f87171",
                        background: "rgba(239, 68, 68, 0.12)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: "8px",
                        padding: "10px 14px",
                        marginBottom: "14px",
                        lineHeight: "1.5",
                      }}
                    >
                      ⚠️ {aiError}
                    </div>
                  )}

                  {/* 아직 API 키가 없고 분석 기록도 없을 때의 안내 */}
                  {!aiBriefing?.has_key && !aiBriefing?.latest && !aiLoading && !isStreaming && (
                    <div
                      style={{
                        padding: "20px",
                        textAlign: "center",
                        background: "rgba(15, 23, 42, 0.4)",
                        borderRadius: "8px",
                        border: "1px dashed rgba(99, 102, 241, 0.3)",
                      }}
                    >
                      <div style={{ fontSize: "24px", marginBottom: "8px" }}>💡</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#f8fafc", marginBottom: "4px" }}>
                        Gemini API 키를 등록하고 AI 마켓 브리핑을 시작하세요
                      </div>
                      <div style={{ fontSize: "12.5px", color: "#94a3b8", maxWidth: "600px", margin: "0 auto 14px", lineHeight: "1.5" }}>
                        비트코인 일봉 20MA, 4시간 60MA 수급 현황과 3개 자동매매 봇들의 진입/대기 이유를 Gemini 3.5 Flash가 실시간으로 분석해 드립니다.
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: "6px 16px", fontSize: "13px" }}
                        onClick={() => setShowAiKeyConfig(true)}
                      >
                        Gemini API 키 등록하기
                      </button>
                    </div>
                  )}

                  {/* 로딩 인디케이터 (스트리밍 시작 전 연결 단계) */}
                  {aiLoading && (
                    <div
                      style={{
                        padding: "28px 20px",
                        textAlign: "center",
                        background: "rgba(15, 23, 42, 0.4)",
                        borderRadius: "8px",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#f8fafc", marginBottom: "6px" }}>
                        ⚡ 업비트 실시간 호가 & 봇 지표 취합 및 Gemini 연결 중...
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                        비트코인 이평선 이격도, 변동성 지표, 3개 봇 포지션을 취합하여 맞춤형 스트리밍 브리핑을 준비하고 있습니다.
                      </div>
                    </div>
                  )}

                  {/* 분석 결과 리포트 표시 (스트리밍 작성 중이거나, 완료된 브리핑이 있을 때) */}
                  {(isStreaming || (!aiLoading && aiBriefing?.latest)) && (
                    <div>
                      {/* 주요 지표 요약 바 */}
                      {(() => {
                        const currentMeta = isStreaming && streamingMeta ? streamingMeta : aiBriefing?.latest;
                        if (!currentMeta) return null;
                        return (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "12px",
                              marginBottom: "14px",
                              padding: "10px 14px",
                              background: "rgba(15, 23, 42, 0.5)",
                              borderRadius: "8px",
                              border: "1px solid rgba(255, 255, 255, 0.05)",
                              alignItems: "center",
                            }}
                          >
                            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                              🪙 <strong style={{ color: "#f8fafc" }}>BTC 현재가:</strong>{" "}
                              {currentMeta.btc_price ? Number(currentMeta.btc_price).toLocaleString("ko-KR") + "원" : "-"}
                            </div>
                            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                              📈 <strong style={{ color: "#f8fafc" }}>일봉 20MA:</strong>{" "}
                              {currentMeta.btc_daily_20ma ? Math.floor(Number(currentMeta.btc_daily_20ma)).toLocaleString("ko-KR") + "원" : "-"}
                            </div>
                            <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>
                              ⏱️ <strong style={{ color: "#f8fafc" }}>4시간 60MA:</strong>{" "}
                              {currentMeta.btc_4h_60ma ? Math.floor(Number(currentMeta.btc_4h_60ma)).toLocaleString("ko-KR") + "원" : "-"}
                            </div>
                            <div style={{ fontSize: "12.5px" }}>
                              {currentMeta.regime_status === "HOLD_CASH" ? (
                                <span style={{ color: "#f87171", fontWeight: 700 }}>🔴 시장체제: 신규매수차단 (현금보유)</span>
                              ) : (
                                <span style={{ color: "#4ade80", fontWeight: 700 }}>🟢 시장체제: 정상거래 허용 (상승추세)</span>
                              )}
                            </div>
                            {isStreaming && (
                              <div style={{ fontSize: "12px", color: "#38bdf8", marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                                <span className="spinner" style={{ width: "12px", height: "12px" }} />
                                한 자씩 실시간 타이핑 중...
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* 마크다운 텍스트 뷰어 */}
                      <div
                        style={{
                          background: "rgba(15, 23, 42, 0.4)",
                          borderRadius: "8px",
                          padding: "16px 20px",
                          border: "1px solid rgba(255, 255, 255, 0.04)",
                        }}
                      >
                        <MarkdownViewer
                          content={isStreaming ? streamingText : aiBriefing?.latest?.briefing_text}
                          isStreaming={isStreaming}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 봇별 탭 구분 (요구사항 9, 15: 봇 별명 표기) */}
            <div className="tab-bar">
              {bots.map((bot) => (
                <button
                  key={bot.bot_id}
                  className={`tab-btn ${selectedBotId === bot.bot_id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedBotId(bot.bot_id);
                    fetchTrades(bot.bot_id);
                  }}
                >
                  <span
                    className={`status-dot ${bot.is_running ? "green" : "red"}`}
                    style={{ width: "8px", height: "8px" }}
                  />
                  <span>{bot.nickname || bot.name}</span>
                </button>
              ))}
            </div>

            {/* 선택된 봇 상태 및 거래시작 / 중단 버튼 (요구사항 20) */}
            {currentBot && (
              <div className="card">
                <div className="bot-control-panel">
                  <div>
                    <div style={{ fontSize: "18px", fontWeight: 800, marginBottom: "6px" }}>
                      {currentBot.nickname || currentBot.name}{" "}
                      <span style={{ fontSize: "13px", color: "#94a3b8", fontWeight: 500 }}>
                        ({currentBot.name})
                      </span>
                    </div>
                    <div style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "14px" }}>
                      {currentBot.description}
                    </div>
                    <div className="bot-meta-grid">
                      <div className="meta-item">
                        <span className="meta-label">동작 상태</span>
                        <span
                          className="meta-value"
                          style={{ color: currentBot.is_running ? "#22c55e" : "#f87171" }}
                        >
                          {currentBot.is_running ? "● 거래 진행 중" : "■ 거래 중지됨"}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">할당 원금 (분배비율 {currentBot.allocation_ratio}%)</span>
                        <span className="meta-value">{formatKRW(currentBot.allocated_capital)}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">가용 가상잔고 (virtual_krw)</span>
                        <span className="meta-value" style={{ color: "#a5b4fc" }}>
                          {formatKRW(currentBot.virtual_krw)}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">최소 거래대금 필터</span>
                        <span className="meta-value">{formatKRW(currentBot.min_volume_krw)}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">현재 봇 상태 메시지</span>
                        <span className="meta-value" style={{ fontSize: "13.5px", color: "#cbd5e1" }}>
                          {currentBot.last_status_msg}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="btn-group">
                    <button
                      className="btn btn-start"
                      onClick={() => handleBotStartStop(currentBot.bot_id, true)}
                      disabled={
                        Boolean(currentBot.is_running) ||
                        Number(currentBot.allocated_capital || 0) <= 0
                      }
                      title={
                        Number(currentBot.allocated_capital || 0) <= 0
                          ? "할당 원금이 0원이므로 거래를 시작할 수 없습니다. 설정 메뉴에서 자금 분배 비율을 설정해주세요."
                          : ""
                      }
                    >
                      ▶ 거래시작
                    </button>
                    <button
                      className="btn btn-stop"
                      onClick={() => handleBotStartStop(currentBot.bot_id, false)}
                      disabled={!currentBot.is_running}
                    >
                      ■ 거래중단
                    </button>
                    <button
                      className="btn btn-outline"
                      onClick={() => handleManualTradeTest(currentBot.bot_id, "buy")}
                      title="실제 주문이나 거래 이력을 남기지 않고 해당 봇의 가용 잔고 기준 매수 가능 여부만 확인합니다"
                    >
                      + 매수 테스트 (단순 확인)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 요구사항 9: 게시판 형식 거래정보 (매수, 매도, 매수일, 매도일, 차익 한 줄 표기 / 미매도 시 빈칸, 매도 시 업데이트) */}
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                  거래 내역 게시판 ({currentBot?.nickname})
                </h3>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                  * 매도를 하지 않은 포지션은 매도/매도일/차익 칸이 빈칸으로 유지되며, 매도 완료 시 해당 줄(Row)이 자동 업데이트됩니다.
                </span>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th>번호</th>
                      <th>코인(마켓)</th>
                      <th>매수 (금액 / 단가 / 수량)</th>
                      <th>매도 (금액 / 단가 / 수량)</th>
                      <th>매수일</th>
                      <th>매도일</th>
                      <th>차익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "32px", color: "#94a3b8" }}>
                          해당 봇의 거래 내역이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      trades.map((t, index) => {
                        const isSold = t.status === "COMPLETED" && t.sell_amount !== null;
                        return (
                          <tr key={t.id}>
                            <td>{trades.length - index}</td>
                            <td style={{ fontWeight: 700 }}>{t.market}</td>
                            <td>
                              <div style={{ fontWeight: 700 }}>{formatKRW(t.buy_amount)}</div>
                              <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                                단가 {Number(t.buy_price).toLocaleString()}원 | 수량 {t.buy_volume}
                              </div>
                            </td>
                            {/* 매도하지 않았다면 빈칸(""), 매도했다면 업데이트된 값 표시 */}
                            <td>
                              {isSold ? (
                                <>
                                  <div style={{ fontWeight: 700 }}>{formatKRW(t.sell_amount)}</div>
                                  <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                                    단가 {Number(t.sell_price).toLocaleString()}원 | 수량 {t.sell_volume}
                                  </div>
                                </>
                              ) : (
                                ""
                              )}
                            </td>
                            <td>{t.buy_date}</td>
                            <td>{isSold ? t.sell_date : ""}</td>
                            <td>
                              {isSold ? (
                                <div>
                                  {renderColoredProfit(t.profit_krw)}{" "}
                                  <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                                    ({t.profit_pct > 0 ? `+${t.profit_pct}` : t.profit_pct}%)
                                  </span>
                                </div>
                              ) : (
                                ""
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴 2] 통계 (요구사항 10, 11, 12)
           ============================================================ */}
        {activeMenu === "stats" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">통계</h2>
                <p className="page-desc">
                  통계 시작일({stats.start_date}) 기준 일간/주간/월간 차익 선 그래프 및 다빈도 거래 코인 누적 손익입니다.
                </p>
              </div>
            </div>

            {/* 요구사항 10: 일간 / 주간 / 월간 탭 구성 */}
            <div className="tab-bar">
              <button
                className={`tab-btn ${statsPeriodTab === "daily" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("daily")}
              >
                일간 (Daily)
              </button>
              <button
                className={`tab-btn ${statsPeriodTab === "weekly" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("weekly")}
              >
                주간 (Weekly)
              </button>
              <button
                className={`tab-btn ${statsPeriodTab === "monthly" ? "active" : ""}`}
                onClick={() => setStatsPeriodTab("monthly")}
              >
                월간 (Monthly)
              </button>
            </div>

            {/* 요구사항 10, 11: 2026.10.01부터 차익 이력 선 그래프 */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                {periodLabel} 차익 추이 선 그래프 (시작일: 2026.10.01)
              </h3>
              <ProfitLineChart series={chartSeries} periodLabel={periodLabel} />
            </div>

            {/* 요구사항 12: 그래프 하단 가장 많이 거래된 코인 순 게시판 + 주간/월간/연간 누적 손익 색상 구분 (이익:빨간색, 손해:파란색, 그외:검은색) */}
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                  다빈도 거래 코인 순위 및 기간별 누적 손익
                </h3>
                <div style={{ fontSize: "12.5px", display: "flex", gap: "14px" }}>
                  <span className="pnl-profit">● 이익: 빨간색</span>
                  <span className="pnl-loss">● 손해: 파란색</span>
                  <span className="pnl-Zero">● 그 외(0원): 검은색</span>
                </div>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th>순위</th>
                      <th>코인(마켓)</th>
                      <th>총 거래 횟수</th>
                      <th>주간 누적 손익</th>
                      <th>월간 누적 손익</th>
                      <th>연간 누적 손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!stats.coin_ranking || stats.coin_ranking.length === 0) ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                          집계된 코인 거래 통계가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      stats.coin_ranking.map((coin, idx) => (
                        <tr key={coin.market}>
                          <td style={{ fontWeight: 700 }}>{idx + 1}위</td>
                          <td style={{ fontWeight: 700 }}>{coin.market}</td>
                          <td>
                            {coin.trade_count}회{" "}
                            <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                              (완료 {coin.completed_count} / 보유 {coin.holding_count})
                            </span>
                          </td>
                          <td>{renderColoredProfit(coin.weekly_profit)}</td>
                          <td>{renderColoredProfit(coin.monthly_profit)}</td>
                          <td>{renderColoredProfit(coin.yearly_profit)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴 3] 알고리즘 검증소 (Algorithm Validation Lab / Testbed)
            - 실제 업비트 실시간 호가/시세 기반 6개 퀀트 전략 모델 실시간 경쟁 및 랭킹
            - 1위~3위 포디움 하이라이트
            - 실시간 수익률 및 총 평가자산 랭킹 테이블
            - 모델별 가상 체결 및 상세 매매 일지
           ============================================================ */}
        {activeMenu === "algo-lab" && (
          <div>
            <div className="page-header">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <h2 className="page-title">알고리즘 검증소 (Algorithm Lab)</h2>
                  <span
                    style={{
                      fontSize: "12px",
                      padding: "3px 10px",
                      borderRadius: "12px",
                      background: "rgba(99, 102, 241, 0.2)",
                      color: "#a5b4fc",
                      border: "1px solid rgba(99, 102, 241, 0.4)",
                      fontWeight: 700,
                    }}
                  >
                    ⚡ 실시간 가상 검증 랭킹
                  </span>
                </div>
                <p className="page-desc">
                  실제 업비트 실시간 호가 및 캔들 데이터를 바탕으로 6개 퀀트 전략 모델이 가상 자본으로 매매 경쟁을 펼치며, 실시간 수익률 랭킹을 산출합니다.
                </p>
              </div>

              {/* 검증소 우측 액션 버튼들 */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  최근 갱신: {algoLabLastUpdated || "-"} (10초 자동)
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRunAlgoLabCycle}
                  disabled={algoLabCycleRunning}
                  style={{ padding: "8px 14px", fontSize: "12.5px", display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <span>{algoLabCycleRunning ? "⏳" : "🔄"}</span>
                  <span>{algoLabCycleRunning ? "시뮬레이션 중..." : "실시간 검증 실행"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleResetAlgoLab}
                  disabled={algoLabLoading}
                  style={{ padding: "8px 14px", fontSize: "12.5px" }}
                >
                  초기화 (100만원 리셋)
                </button>
              </div>
            </div>

            {/* TOP 3 랭킹 포디움 (Gold 🥇 / Silver 🥈 / Bronze 🥉) */}
            <div className="podium-grid">
              {algoModels.slice(0, 3).map((m, idx) => {
                const rankNum = idx + 1;
                const isFirst = rankNum === 1;
                const badgeClass = isFirst ? "gold" : rankNum === 2 ? "silver" : "bronze";
                const medalIcon = isFirst ? "🥇 1위 (챔피언)" : rankNum === 2 ? "🥈 2위" : "🥉 3위";
                const profitRate = Number(m.profit_rate_pct || 0);

                return (
                  <div key={m.model_id} className={`podium-card ${badgeClass}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <span className={`podium-badge ${badgeClass}`}>{medalIcon}</span>
                      <span style={{ fontSize: "11px", color: "#94a3b8", background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px" }}>
                        {m.category}
                      </span>
                    </div>

                    <div style={{ fontSize: "16px", fontWeight: 800, color: "#f8fafc", marginBottom: "6px" }}>
                      {m.name}
                    </div>

                    <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "12px" }}>
                      <span
                        style={{
                          fontSize: "22px",
                          fontWeight: 800,
                          color: profitRate > 0 ? "var(--profit-red)" : profitRate < 0 ? "var(--loss-blue)" : "#94a3b8",
                        }}
                      >
                        {profitRate > 0 ? "+" : ""}{profitRate.toFixed(2)}%
                      </span>
                      <span style={{ fontSize: "13px", color: "#cbd5e1" }}>
                        ({Number(m.cumulative_profit_krw || 0) > 0 ? "+" : ""}
                        {Math.floor(Number(m.cumulative_profit_krw || 0)).toLocaleString("ko-KR")}원)
                      </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px", background: "rgba(0,0,0,0.25)", padding: "8px 10px", borderRadius: "8px" }}>
                      <div>
                        <span style={{ color: "#94a3b8" }}>총 평가자산: </span>
                        <strong style={{ color: "#f1f5f9" }}>{Math.floor(Number(m.eval_assets_krw || 0)).toLocaleString("ko-KR")}원</strong>
                      </div>
                      <div>
                        <span style={{ color: "#94a3b8" }}>승률: </span>
                        <strong style={{ color: Number(m.win_rate_pct || 0) >= 50 ? "#4ade80" : "#f87171" }}>
                          {m.win_rate_pct}% ({m.win_trades}승 {m.lose_trades}패)
                        </strong>
                      </div>
                    </div>

                    <div style={{ marginTop: "10px", fontSize: "11.5px", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      💡 {m.last_signal_text}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 실시간 알고리즘 랭킹 테이블 카드 */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "8px" }}>
                <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                  실시간 알고리즘 수익률 랭킹 보드 (전체 6개 모델)
                </h3>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  * 실제 업비트 실시간 호가/시세로 10초마다 자동 평가 및 순위가 갱신됩니다.
                </div>
              </div>

              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "65px", textAlign: "center" }}>순위</th>
                      <th>알고리즘 모델명</th>
                      <th style={{ width: "95px" }}>전략 분류</th>
                      <th style={{ textAlign: "right", width: "130px" }}>실시간 수익률</th>
                      <th style={{ textAlign: "right", width: "120px" }}>총 평가자산</th>
                      <th style={{ textAlign: "right", width: "110px" }}>가용 현금</th>
                      <th style={{ textAlign: "center", width: "120px" }}>승률 (전적)</th>
                      <th style={{ width: "150px" }}>보유 포지션</th>
                      <th style={{ width: "100px", textAlign: "center" }}>상세 검증</th>
                    </tr>
                  </thead>
                  <tbody>
                    {algoModels.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "32px", color: "var(--text-secondary)" }}>
                          알고리즘 모델 데이터를 불러오는 중입니다...
                        </td>
                      </tr>
                    ) : (
                      algoModels.map((m) => {
                        const profitRate = Number(m.profit_rate_pct || 0);
                        const cumProfit = Number(m.cumulative_profit_krw || 0);
                        const isRank1 = m.current_rank === 1;
                        const isRank2 = m.current_rank === 2;
                        const isRank3 = m.current_rank === 3;

                        return (
                          <tr
                            key={m.model_id}
                            style={{
                              background: isRank1 ? "rgba(234, 179, 8, 0.08)" : undefined,
                              cursor: "pointer",
                            }}
                            onClick={() => {
                              setSelectedAlgoModelId(m.model_id);
                              fetchAlgoLabTrades(m.model_id);
                            }}
                          >
                            <td style={{ textAlign: "center", fontWeight: 800, fontSize: "15px" }}>
                              {isRank1 ? "🥇 1위" : isRank2 ? "🥈 2위" : isRank3 ? "🥉 3위" : `${m.current_rank}위`}
                            </td>
                            <td>
                              <div style={{ fontWeight: 700, color: "#f8fafc" }}>{m.name}</div>
                              <div style={{ fontSize: "11.5px", color: "#94a3b8", marginTop: "2px" }}>
                                {m.last_signal_text}
                              </div>
                            </td>
                            <td>
                              <span
                                style={{
                                  fontSize: "11px",
                                  padding: "2px 8px",
                                  borderRadius: "10px",
                                  background: "rgba(99, 102, 241, 0.15)",
                                  color: "#a5b4fc",
                                  border: "1px solid rgba(99, 102, 241, 0.3)",
                                }}
                              >
                                {m.category}
                              </span>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  fontWeight: 800,
                                  fontSize: "14.5px",
                                  color: profitRate > 0 ? "var(--profit-red)" : profitRate < 0 ? "var(--loss-blue)" : "#94a3b8",
                                }}
                              >
                                {profitRate > 0 ? "+" : ""}{profitRate.toFixed(2)}%
                              </div>
                              <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                                ({cumProfit > 0 ? "+" : ""}{cumProfit.toLocaleString("ko-KR")}원)
                              </div>
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#f1f5f9" }}>
                              {Math.floor(Number(m.eval_assets_krw || 0)).toLocaleString("ko-KR")}원
                            </td>
                            <td style={{ textAlign: "right", color: "#cbd5e1" }}>
                              {Math.floor(Number(m.cash_krw || 0)).toLocaleString("ko-KR")}원
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  fontWeight: 700,
                                  color: Number(m.win_rate_pct || 0) >= 50 ? "#4ade80" : "#f87171",
                                }}
                              >
                                {m.win_rate_pct}%
                              </span>
                              <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                                ({m.win_trades}승 {m.lose_trades}패 / {m.total_trades}회)
                              </div>
                            </td>
                            <td>
                              {(m.open_positions || []).length === 0 ? (
                                <span style={{ fontSize: "12px", color: "#64748b" }}>보유 없음 (현금 100%)</span>
                              ) : (
                                (m.open_positions || []).map((p) => (
                                  <div
                                    key={p.id}
                                    style={{
                                      fontSize: "11.5px",
                                      background: "rgba(30, 41, 59, 0.8)",
                                      border: "1px solid #334155",
                                      borderRadius: "6px",
                                      padding: "2px 6px",
                                      marginBottom: "3px",
                                    }}
                                  >
                                    <strong style={{ color: "#38bdf8" }}>{p.market}</strong>{" "}
                                    <span style={{ color: "#94a3b8" }}>
                                      {Number(p.avg_buy_price).toLocaleString()}원
                                    </span>
                                  </div>
                                ))
                              )}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <button
                                type="button"
                                className="btn btn-outline"
                                style={{ padding: "4px 10px", fontSize: "11.5px" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedAlgoModelId(m.model_id);
                                  fetchAlgoLabTrades(m.model_id);
                                }}
                              >
                                상세
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 모델별 가상 매매 체결 이력 카드 */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "8px" }}>
                <div>
                  <h3 style={{ fontSize: "16px", fontWeight: 700 }}>
                    가상 매매 체결 일지 (
                    {selectedAlgoModelId === "all"
                      ? "전체 모델"
                      : algoModels.find((m) => m.model_id === selectedAlgoModelId)?.name || selectedAlgoModelId}
                    )
                  </h3>
                  <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                    실제 실시간 시세와 호가 지표를 기반으로 가상 매수/매도 및 수수료(0.05%)가 정밀 차감 체결된 내역입니다.
                  </p>
                </div>

                {/* 모델 필터 탭 */}
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`tab-btn ${selectedAlgoModelId === "all" ? "active" : ""}`}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                    onClick={() => {
                      setSelectedAlgoModelId("all");
                      fetchAlgoLabTrades("all");
                    }}
                  >
                    전체 이력
                  </button>
                  {algoModels.map((m) => (
                    <button
                      key={m.model_id}
                      type="button"
                      className={`tab-btn ${selectedAlgoModelId === m.model_id ? "active" : ""}`}
                      style={{ padding: "6px 10px", fontSize: "12px" }}
                      onClick={() => {
                        setSelectedAlgoModelId(m.model_id);
                        fetchAlgoLabTrades(m.model_id);
                      }}
                    >
                      {m.current_rank}위 {m.name.split(" ")[0]}
                    </button>
                  ))}
                </div>
              </div>

              {/* 체결 내역 테이블 */}
              <div className="table-container">
                <table className="board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "55px", textAlign: "center" }}>No</th>
                      <th>알고리즘 모델</th>
                      <th>코인(마켓)</th>
                      <th>가상 매수가 (매수금액)</th>
                      <th>매수 일시</th>
                      <th>가상 매도가 (매도금액)</th>
                      <th>매도 일시</th>
                      <th style={{ textAlign: "right" }}>실현 손익</th>
                      <th style={{ textAlign: "right" }}>수익률</th>
                      <th>청산 사유 / 상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {algoTrades.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                          아직 기록된 가상 체결 내역이 없습니다. 실시간 시뮬레이션이 진행되면 자동으로 기록됩니다.
                        </td>
                      </tr>
                    ) : (
                      algoTrades.map((t, idx) => (
                        <tr key={t.id || idx}>
                          <td style={{ textAlign: "center", color: "#94a3b8" }}>{t.id || idx + 1}</td>
                          <td style={{ fontWeight: 600, color: "#f8fafc" }}>
                            {t.model_name || algoModels.find((m) => m.model_id === t.model_id)?.name || t.model_id}
                          </td>
                          <td style={{ fontWeight: 700, color: "#38bdf8" }}>{t.market}</td>
                          <td>
                            {Number(t.buy_price || 0).toLocaleString("ko-KR")}원{" "}
                            <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                              ({Math.floor(Number(t.buy_amount || 0)).toLocaleString("ko-KR")}원)
                            </span>
                          </td>
                          <td style={{ fontSize: "12px", color: "#cbd5e1" }}>{t.buy_date}</td>
                          <td>
                            {t.sell_price !== null && t.sell_price !== undefined
                              ? `${Number(t.sell_price).toLocaleString("ko-KR")}원 (${Math.floor(Number(t.sell_amount || 0)).toLocaleString("ko-KR")}원)`
                              : <span style={{ color: "#eab308" }}>● 보유 중 (미매도)</span>}
                          </td>
                          <td style={{ fontSize: "12px", color: "#cbd5e1" }}>{t.sell_date || "-"}</td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>
                            {t.profit_krw !== null && t.profit_krw !== undefined
                              ? renderColoredProfit(t.profit_krw)
                              : "-"}
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>
                            {t.profit_pct !== null && t.profit_pct !== undefined ? (
                              <span
                                style={{
                                  color: Number(t.profit_pct) > 0 ? "var(--profit-red)" : Number(t.profit_pct) < 0 ? "var(--loss-blue)" : "#94a3b8",
                                }}
                              >
                                {Number(t.profit_pct) > 0 ? "+" : ""}{Number(t.profit_pct).toFixed(2)}%
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: "12px",
                                color: t.status === "HOLDING" ? "#eab308" : "#94a3b8",
                              }}
                            >
                              {t.reason || (t.status === "HOLDING" ? "포지션 유지 중" : "매도 완료")}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴] 실시간 뉴스 피드 & LLM 감성 분석 (50건 페이지네이션, 날짜/키워드 검색, AI 뉴스 판단)
           ============================================================ */}
        {activeMenu === "news" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">실시간 뉴스 & LLM 감성 피드</h2>
                <p className="page-desc">
                  주요 가상자산 언론사 및 구글 뉴스를 실시간 수집하고 호재(상승)/악재(하락)/중립 감성 분석 및 키워드를 태깅합니다.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {newsNotice && (
                  <span style={{ fontSize: "13px", color: "#38bdf8", fontWeight: 600 }}>
                    {newsNotice}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRefreshNews}
                  disabled={newsRefreshing}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <span>{newsRefreshing ? "⏳" : "🔄"}</span>
                  <span>{newsRefreshing ? "뉴스 수집 중..." : "최신 뉴스 즉시 수집"}</span>
                </button>
              </div>
            </div>

            {/* ============================================================
                요구사항: 뉴스를 기반으로 한 AI 판단 설명 (접을 수 있는 영역 & 한 글자씩 스트리밍 타이핑)
               ============================================================ */}
            <div className="news-ai-box">
              <div className="news-ai-header">
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", flex: 1 }}
                  onClick={() => setIsNewsAiExpanded((prev) => !prev)}
                >
                  <span style={{ fontSize: "22px" }}>🤖</span>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                        뉴스 기반 AI 종합 시장 판단 & 퀀트 운용 전략
                      </h3>
                      <span
                        style={{
                          background: "rgba(99, 102, 241, 0.2)",
                          color: "#a5b4fc",
                          padding: "2px 8px",
                          borderRadius: "6px",
                          fontSize: "11px",
                          fontWeight: 600,
                        }}
                      >
                        {isNewsStreaming ? "⚡ 실시간 스트리밍 분석 중" : newsAiBriefing.latest?.model || "Gemini 3.5 Flash Lite"}
                      </span>
                    </div>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "3px 0 0 0" }}>
                      수집된 {newsTotal > 0 ? `${newsTotal}건` : "최신"} 암호화폐 뉴스 헤드라인과 시장 감성을 분석하여 봇 운용 및 단기/중기 시황을 진단합니다.
                      {newsAiBriefing.latest?.created_at && ` (최근 분석: ${newsAiBriefing.latest.created_at})`}
                    </p>
                  </div>
                </div>

                <div className="news-ai-action-btns">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      triggerNewsAiAnalysis();
                    }}
                    disabled={isNewsStreaming || newsAiLoading}
                    style={{
                      padding: "8px 16px",
                      fontSize: "13px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 4px 14px rgba(99, 102, 241, 0.4)",
                    }}
                  >
                    <span>{isNewsStreaming || newsAiLoading ? "⏳" : "⚡"}</span>
                    <span>{isNewsStreaming ? "AI 분석 스트리밍 중..." : newsAiLoading ? "AI 분석 준비 중..." : "AI 분석하기"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setIsNewsAiExpanded((prev) => !prev)}
                    style={{ padding: "8px 12px", fontSize: "13px" }}
                  >
                    {isNewsAiExpanded ? "▲ 접기" : "▼ 펼치기"}
                  </button>
                </div>
              </div>

              {/* 접을 수 있는 본문 영역 */}
              {isNewsAiExpanded && (
                <div className="news-ai-body">
                  {/* 스트리밍 중이거나 방금 스트리밍된 텍스트가 있을 때 */}
                  {(isNewsStreaming || newsStreamingText) ? (
                    <div>
                      {newsStreamingMeta && (
                        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
                            ▲ 호재: {newsStreamingMeta.bullish_count}건
                          </span>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171" }}>
                            ▼ 악재: {newsStreamingMeta.bearish_count}건
                          </span>
                          <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" }}>
                            ● 중립: {newsStreamingMeta.neutral_count}건
                          </span>
                        </div>
                      )}
                      <div style={{ whiteSpace: "pre-line", wordBreak: "break-word" }}>
                        {newsStreamingText}
                        {isNewsStreaming && <span className="news-ai-cursor" />}
                      </div>
                    </div>
                  ) : newsAiBriefing.latest?.briefing_text ? (
                    <div>
                      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
                          ▲ 호재: {newsAiBriefing.latest.bullish_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(239, 68, 68, 0.15)", color: "#f87171" }}>
                          ▼ 악재: {newsAiBriefing.latest.bearish_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(100, 116, 139, 0.2)", color: "#94a3b8" }}>
                          ● 중립: {newsAiBriefing.latest.neutral_count || 0}건
                        </span>
                        <span style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc" }}>
                          모델: {newsAiBriefing.latest.model}
                        </span>
                      </div>
                      <div style={{ whiteSpace: "pre-line", wordBreak: "break-word" }}>
                        {newsAiBriefing.latest.briefing_text}
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: "28px 16px", color: "var(--text-secondary)" }}>
                      <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>
                        아직 생성된 뉴스 종합 분석 리포트가 없습니다.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={triggerNewsAiAnalysis}
                        disabled={newsAiLoading}
                        style={{ fontSize: "13px", padding: "8px 18px" }}
                      >
                        🤖 지금 AI 실시간 뉴스 종합 분석 시작
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 검색 및 필터 카드 (날짜 범위, 키워드 검색, 태그 필터) */}
            <div className="card" style={{ marginBottom: "16px" }}>
              <form onSubmit={handleSearchNews}>
                <div className="news-filter-grid">
                  {/* 날짜 범위: 시작일 */}
                  <div className="news-date-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      📅 시작일
                    </label>
                    <input
                      type="date"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 10px", fontSize: "13px" }}
                      value={newsStartDate}
                      onChange={(e) => setNewsStartDate(e.target.value)}
                    />
                  </div>

                  {/* 날짜 범위: 종료일 */}
                  <div className="news-date-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      📅 종료일
                    </label>
                    <input
                      type="date"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 10px", fontSize: "13px" }}
                      value={newsEndDate}
                      onChange={(e) => setNewsEndDate(e.target.value)}
                    />
                  </div>

                  {/* 키워드 검색창 */}
                  <div className="news-keyword-col">
                    <label style={{ display: "block", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      🔍 키워드 검색 (제목, 요약, 언론사, 해시태그)
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      style={{ width: "100%", padding: "8px 12px", fontSize: "13px" }}
                      placeholder="검색어 입력 (예: 비트코인, 업비트, ETF, 급등, SEC, 해킹...)"
                      value={newsKeyword}
                      onChange={(e) => setNewsKeyword(e.target.value)}
                    />
                  </div>

                  {/* 검색 & 초기화 버튼 */}
                  <div className="news-btn-col">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ padding: "8px 16px", fontSize: "13px" }}
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleResetNewsFilter}
                      style={{ padding: "8px 14px", fontSize: "13px" }}
                    >
                      초기화
                    </button>
                  </div>
                </div>

                {/* 추천 키워드 태그 클릭 바로가기 */}
                <div className="news-popular-tags-wrap" style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>인기 태그:</span>
                  {[
                    "#비트코인",
                    "#이더리움",
                    "#업비트",
                    "#리플",
                    "#솔라나",
                    "#ETF",
                    "#규제/정책",
                    "#시황/전망",
                    "#해킹/보안",
                    "상승",
                    "하락",
                  ].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleQuickTagClick(tag)}
                      style={{
                        background: "rgba(38, 50, 77, 0.6)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "14px",
                        padding: "3px 10px",
                        fontSize: "12px",
                        color: "#93c5fd",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(99, 102, 241, 0.3)";
                        e.currentTarget.style.borderColor = "var(--accent-indigo)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "rgba(38, 50, 77, 0.6)";
                        e.currentTarget.style.borderColor = "var(--border-color)";
                      }}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </form>
            </div>

            {/* 뉴스 목록 테이블 카드 (한 화면 50건, row 높이 동일화) */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <span style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
                  총 <strong style={{ color: "#f8fafc" }}>{newsTotal.toLocaleString()}</strong>건의 뉴스 중{" "}
                  {newsTotal > 0 ? (
                    <>
                      <strong style={{ color: "var(--accent-indigo)" }}>
                        {(newsPage - 1) * 50 + 1} ~ {Math.min(newsPage * 50, newsTotal)}
                      </strong>
                      건 표시 (페이지 {newsPage} / {newsTotalPages}, 한 화면 50건)
                    </>
                  ) : (
                    "0건 표시"
                  )}
                </span>
                {newsLoading && (
                  <span style={{ fontSize: "13px", color: "var(--accent-indigo)" }}>
                    ⏳ 목록 조회 중...
                  </span>
                )}
              </div>

              <div className="table-container">
                <table className="board-table news-board-table">
                  <thead>
                    <tr>
                      <th style={{ width: "55px", textAlign: "center" }}>No</th>
                      <th style={{ width: "95px", textAlign: "center" }}>감성 분석</th>
                      <th>기사 제목</th>
                      <th style={{ width: "140px" }}>주요 태그</th>
                      <th style={{ width: "130px" }}>언론사</th>
                      <th style={{ width: "150px", textAlign: "center" }}>발행 일시 (KST)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newsList.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "48px 16px", color: "var(--text-secondary)" }}>
                          {newsLoading
                            ? "뉴스를 불러오는 중입니다..."
                            : "등록된 뉴스가 없거나 검색 조건에 일치하는 뉴스가 없습니다. 검색어를 변경하거나 [최신 뉴스 즉시 수집]을 눌러보세요."}
                        </td>
                      </tr>
                    ) : (
                      newsList.map((item, idx) => {
                        const itemNumber = (newsPage - 1) * 50 + idx + 1;
                        const sentiment = item.sentiment || "NEUTRAL";
                        const isBullish = sentiment === "BULLISH";
                        const isBearish = sentiment === "BEARISH";

                        return (
                          <tr key={item.id || item.link || idx}>
                            <td style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }}>
                              {itemNumber}
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "3px 8px",
                                  borderRadius: "6px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  background: isBullish
                                    ? "rgba(16, 185, 129, 0.15)"
                                    : isBearish
                                    ? "rgba(239, 68, 68, 0.15)"
                                    : "rgba(100, 116, 139, 0.18)",
                                  color: isBullish
                                    ? "#34d399"
                                    : isBearish
                                    ? "#f87171"
                                    : "#94a3b8",
                                  border: `1px solid ${
                                    isBullish
                                      ? "rgba(16, 185, 129, 0.35)"
                                      : isBearish
                                      ? "rgba(239, 68, 68, 0.35)"
                                      : "rgba(100, 116, 139, 0.3)"
                                  }`,
                                }}
                              >
                                {isBullish ? "▲ 호재" : isBearish ? "▼ 악재" : "● 중립"}
                              </span>
                            </td>
                            <td title={item.title + (item.summary ? `\n[요약] ${item.summary}` : "")}>
                              <a
                                href={item.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="news-title-link"
                              >
                                {item.title}
                                <span style={{ fontSize: "11px", marginLeft: "4px", color: "#64748b" }}>↗</span>
                              </a>
                            </td>
                            <td title={item.keywords || ""}>
                              <span style={{ fontSize: "12px", color: "#38bdf8" }}>
                                {item.keywords || "-"}
                              </span>
                            </td>
                            <td title={item.source || ""}>
                              <span style={{ fontSize: "12.5px", color: "#cbd5e1" }}>
                                {item.source || "Google News"}
                              </span>
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                                {item.published_at || "-"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* 페이지네이션 컨트롤 (한 화면 50건 단위) */}
              {newsTotalPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: "6px",
                    marginTop: "20px",
                    flexWrap: "wrap",
                  }}
                >
                  {/* 맨 처음으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage <= 1 || newsLoading}
                    onClick={() => fetchNews(1)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    « 처음
                  </button>
                  {/* 이전 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage <= 1 || newsLoading}
                    onClick={() => fetchNews(newsPage - 1)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    ‹ 이전
                  </button>

                  {/* 페이지 번호 버튼들 (현재 페이지 중심 최대 7개 노출) */}
                  {(() => {
                    const pages = [];
                    const maxButtons = 7;
                    let start = Math.max(1, newsPage - Math.floor(maxButtons / 2));
                    let end = Math.min(newsTotalPages, start + maxButtons - 1);
                    if (end - start + 1 < maxButtons) {
                      start = Math.max(1, end - maxButtons + 1);
                    }

                    for (let p = start; p <= end; p++) {
                      pages.push(
                        <button
                          key={p}
                          type="button"
                          className={p === newsPage ? "btn btn-primary" : "btn btn-outline"}
                          disabled={newsLoading}
                          onClick={() => fetchNews(p)}
                          style={{
                            padding: "6px 12px",
                            fontSize: "12px",
                            minWidth: "34px",
                            fontWeight: p === newsPage ? 700 : 500,
                          }}
                        >
                          {p}
                        </button>
                      );
                    }
                    return pages;
                  })()}

                  {/* 다음 페이지 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage >= newsTotalPages || newsLoading}
                    onClick={() => fetchNews(newsPage + 1)}
                    style={{ padding: "6px 12px", fontSize: "12px" }}
                  >
                    다음 ›
                  </button>
                  {/* 맨 끝으로 */}
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={newsPage >= newsTotalPages || newsLoading}
                    onClick={() => fetchNews(newsTotalPages)}
                    style={{ padding: "6px 10px", fontSize: "12px" }}
                  >
                    마지막 »
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================
            [메뉴 3] 설정 (요구사항 13, 15, 22)
           ============================================================ */}
        {activeMenu === "settings" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">설정</h2>
                <p className="page-desc">
                  거래 실행 모드(가상거래/실거래), 봇별 자금 분배 비율, 봇 별명 및 전략 파라미터 수정, 데이터 마이그레이션을 관리합니다.
                </p>
              </div>
            </div>

            {/* 거래 실행 모드 설정 (가상거래 모의투자 ↔ 업비트 실거래) */}
            <div
              className="card"
              style={{
                background: tradeMode.mode === "paper" ? "linear-gradient(135deg, rgba(30, 27, 75, 0.7), rgba(15, 23, 42, 0.9))" : "linear-gradient(135deg, rgba(69, 10, 10, 0.7), rgba(15, 23, 42, 0.9))",
                border: tradeMode.mode === "paper" ? "1px solid rgba(99, 102, 241, 0.5)" : "1px solid rgba(239, 68, 68, 0.5)",
                marginBottom: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                      ⚡ 거래 실행 모드 설정
                    </h3>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "12px",
                        fontSize: "12px",
                        fontWeight: 700,
                        background: tradeMode.mode === "paper" ? "rgba(99, 102, 241, 0.25)" : "rgba(239, 68, 68, 0.25)",
                        color: tradeMode.mode === "paper" ? "#a5b4fc" : "#fca5a5",
                        border: tradeMode.mode === "paper" ? "1px solid #6366f1" : "1px solid #ef4444",
                      }}
                    >
                      {tradeMode.mode === "paper" ? "🧪 가상거래(모의투자) 모드 동작 중" : "⚡ 업비트 실거래 모드 동작 중"}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: "12.5px", color: "#cbd5e1", lineHeight: 1.5 }}>
                    {tradeMode.mode === "paper"
                      ? "현재 모드는 가상거래(모의투자)입니다. 실제 업비트 실시간 호가/시세 및 기술지표를 그대로 사용하여 매수/매도 신호를 포착하지만, 업비트 주문 API를 호출하지 않고 가상 체결(수수료 0.05% 반영)로 안전하게 거래를 시뮬레이션합니다."
                      : "현재 모드는 실제 업비트 계좌 실거래입니다! 봇의 매수/매도 주문이 실제 업비트 거래소 API를 통해 실제 원화/코인으로 즉시 체결됩니다. 주의하여 운용하십시오."}
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    className={`btn ${tradeMode.mode === "paper" ? "btn-stop" : "btn-primary"}`}
                    onClick={() => handleToggleTradeMode(tradeMode.mode === "paper" ? "live" : "paper")}
                    disabled={tradeMode.loading}
                    style={{
                      padding: "8px 16px",
                      fontSize: "13px",
                      fontWeight: 700,
                    }}
                  >
                    {tradeMode.loading ? "모드 전환 중..." : tradeMode.mode === "paper" ? "⚡ 업비트 실거래로 전환" : "🧪 가상거래(모의투자)로 전환"}
                  </button>
                </div>
              </div>
            </div>

            {/* 상단: 실제 업비트에서 가져온 실 계좌 잔고 및 총 보유 자산 (수정 불가 / 읽기 전용 영역) */}
            <div
              className="card"
              style={{
                background: "#0f172a",
                border: "1px solid #334155",
                marginBottom: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    🔒 업비트 실 계좌 잔고 및 총 보유 자산 (KRW)
                  </h3>
                  <span
                    style={{
                      fontSize: "11px",
                      background: "#1e293b",
                      color: "#94a3b8",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      padding: "2px 6px",
                    }}
                  >
                    읽기 전용 · 수정 불가
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: "5px 12px", fontSize: "12px" }}
                  onClick={fetchUpbitAccount}
                  disabled={upbitAccount.loading}
                >
                  {upbitAccount.loading ? "조회 중..." : "실계좌/총자산 새로고침"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                <div>
                  <div style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "6px", fontWeight: 600 }}>
                    실 계좌 잔고 (주문 가능 KRW)
                  </div>
                  <input
                    type="text"
                    readOnly
                    disabled
                    className="form-input"
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      color: upbitAccount.success ? "#38bdf8" : "#f87171",
                      fontWeight: 700,
                      cursor: "not-allowed",
                      opacity: 1,
                      WebkitTextFillColor: upbitAccount.success ? "#38bdf8" : "#f87171",
                    }}
                    value={
                      upbitAccount.loading
                        ? "조회 중..."
                        : upbitAccount.success && upbitAccount.krw_balance !== null
                        ? `${Number(upbitAccount.krw_balance).toLocaleString("ko-KR")}원 (주문중: ${Number(
                            upbitAccount.krw_locked ?? 0
                          ).toLocaleString("ko-KR")}원)`
                        : upbitAccount.message || "조회 실패"
                    }
                  />
                </div>

                <div>
                  <div style={{ fontSize: "12.5px", color: "#94a3b8", marginBottom: "6px", fontWeight: 600 }}>
                    총 보유 자산 (실계좌 원화 + 코인 평가금액 / 운용 원금 한도)
                  </div>
                  <input
                    type="text"
                    readOnly
                    disabled
                    className="form-input"
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      color: upbitAccount.success ? "#4ade80" : "#f87171",
                      fontWeight: 700,
                      cursor: "not-allowed",
                      opacity: 1,
                      WebkitTextFillColor: upbitAccount.success ? "#4ade80" : "#f87171",
                    }}
                    value={
                      upbitAccount.loading
                        ? "조회 중..."
                        : upbitAccount.success && upbitAccount.total_asset_krw !== null
                        ? `${Number(upbitAccount.total_asset_krw).toLocaleString("ko-KR")}원 (코인평가: ${Number(
                            upbitAccount.total_eval_krw ?? 0
                          ).toLocaleString("ko-KR")}원)`
                        : upbitAccount.message || "조회 실패"
                    }
                  />
                </div>
              </div>

              {upbitAccount.checked_at && (
                <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "8px" }}>
                  최근 조회 시각: {upbitAccount.checked_at} | {upbitAccount.message}
                </div>
              )}
            </div>

            {/* 하단 1: 요구사항 22 - 전체 운용 원금 및 봇별 자금 분배 비율 설정 (소수점 버림 처리) */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                1. 전체 운용 원금 및 봇별 자금 분배 비율 설정 (소수점 이하 버림 적용)
              </h3>
              {(() => {
                const allocPlan = computeAllocationPreview(
                  parseNumericInput(totalCapitalInput),
                  bots,
                  ratioInputs
                );
                return (
                  <form onSubmit={handleSaveAllocation}>
                    <div className="form-row" style={{ marginBottom: "14px" }}>
                      <label>
                        전체 운용 원금 (KRW) — 설정 금액:{" "}
                        <strong
                          style={{
                            color:
                              (upbitAccount.success &&
                                upbitAccount.total_asset_krw !== null &&
                                allocPlan.flooredTotal > Number(upbitAccount.total_asset_krw)) ||
                              (allocPlan.flooredTotal > 0 && allocPlan.flooredTotal < allocPlan.totalUsed)
                                ? "#ef4444"
                                : "#4ade80",
                          }}
                        >
                          {formatWithCommas(totalCapitalInput)
                            ? `${formatWithCommas(totalCapitalInput)}원`
                            : "미설정"}
                        </strong>{" "}
                        (총 보유 자산 한도 이하만 저장 가능 / 0 이하 입력 시 전체 봇 거래 중지)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="form-input"
                        placeholder="운용 원금을 입력하세요 (총 보유 자산 한도 이하)"
                        value={formatWithCommas(totalCapitalInput)}
                        onChange={(e) => setTotalCapitalInput(parseNumericInput(e.target.value))}
                      />
                      {upbitAccount.success &&
                        upbitAccount.total_asset_krw !== null &&
                        allocPlan.flooredTotal > Number(upbitAccount.total_asset_krw) && (
                          <div style={{ fontSize: "12px", color: "#f87171", marginTop: "4px", fontWeight: 600 }}>
                            ⚠️ 입력한 금액이 업비트 총 보유 자산 한도(
                            {Number(upbitAccount.total_asset_krw).toLocaleString("ko-KR")}원)를 초과하여 저장할 수 없습니다.
                          </div>
                        )}
                      {allocPlan.flooredTotal > 0 && allocPlan.flooredTotal < allocPlan.totalUsed && (
                        <div style={{ fontSize: "12px", color: "#f87171", marginTop: "4px", fontWeight: 600 }}>
                          ⚠️ 입력한 금액이 현재 이미 사용된 투자금(
                          {allocPlan.totalUsed.toLocaleString("ko-KR")}원)보다 적어 저장할 수 없습니다.
                        </div>
                      )}
                    </div>

                    {/* 투자금 총액 vs 이미 사용된 투자금 + 봇별 가용 잔고 일치 요약 */}
                    <div
                      style={{
                        background: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: "10px",
                        padding: "12px 14px",
                        marginBottom: "18px",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                        gap: "12px",
                        fontSize: "12.5px",
                      }}
                    >
                      <div>
                        <div style={{ color: "#94a3b8", marginBottom: "2px" }}>전체 투자금 총액</div>
                        <div style={{ fontWeight: 700, fontSize: "14px", color: "#f8fafc" }}>
                          {allocPlan.flooredTotal.toLocaleString("ko-KR")}원
                        </div>
                      </div>
                      <div>
                        <div style={{ color: "#94a3b8", marginBottom: "2px" }}>이미 사용된 투자금 합계</div>
                        <div style={{ fontWeight: 700, fontSize: "14px", color: "#fbbf24" }}>
                          {allocPlan.totalUsed.toLocaleString("ko-KR")}원
                        </div>
                      </div>
                      <div>
                        <div style={{ color: "#94a3b8", marginBottom: "2px" }}>잔여/추가 가용 분배금 합계</div>
                        <div style={{ fontWeight: 700, fontSize: "14px", color: "#38bdf8" }}>
                          {allocPlan.totalVirtual.toLocaleString("ko-KR")}원
                        </div>
                      </div>
                      <div>
                        <div style={{ color: "#94a3b8", marginBottom: "2px" }}>각 봇별 배정 원금 총합</div>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: "14px",
                            color:
                              allocPlan.totalAllocated === allocPlan.flooredTotal ? "#4ade80" : "#f87171",
                          }}
                        >
                          {allocPlan.totalAllocated.toLocaleString("ko-KR")}원{" "}
                          {allocPlan.totalAllocated === allocPlan.flooredTotal && allocPlan.flooredTotal > 0
                            ? "(총액 일치 ✓)"
                            : ""}
                        </div>
                      </div>
                    </div>

                    <div className="settings-grid">
                      {bots.map((b) => {
                        const rawRatio = ratioInputs[b.bot_id];
                        const botPreview = allocPlan.byBot[b.bot_id] || {
                          used: 0,
                          allocated: 0,
                          virtual_krw: 0,
                        };
                        return (
                          <div className="form-row" key={b.bot_id}>
                            <label>
                              [{b.nickname || b.name}] 분배 비율 (%) → 배정 원금:{" "}
                              <strong style={{ color: "#a5b4fc" }}>
                                {botPreview.allocated.toLocaleString("ko-KR")}원
                              </strong>
                            </label>
                            <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "4px" }}>
                              이미 사용: <strong style={{ color: "#fbbf24" }}>{botPreview.used.toLocaleString("ko-KR")}원</strong>{" "}
                              + 가용 잔고: <strong style={{ color: "#4ade80" }}>{botPreview.virtual_krw.toLocaleString("ko-KR")}원</strong>
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              className="form-input"
                              placeholder="분배 비율(%) 입력"
                              value={rawRatio ?? ""}
                              onChange={(e) =>
                                setRatioInputs((prev) => ({
                                  ...prev,
                                  [b.bot_id]: e.target.value === "" ? "" : Number(e.target.value),
                                }))
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ marginTop: "8px" }}>
                      자금 분배 비율 저장 (소수점 버림 적용)
                    </button>
                  </form>
                );
              })()}
            </div>

            {/* 요구사항 15: 봇 수정 및 각 봇별 별명(Nickname) 설정 */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                2. 봇별 별명(Nickname) 및 전략 파라미터 수정 (agentBot 패키지 연동)
              </h3>
              <div className="settings-grid">
                {bots.map((b) => {
                  const form = botEditForms[b.bot_id] || {
                    nickname: b.nickname,
                    min_volume_krw: b.min_volume_krw,
                    stop_loss_pct: b.stop_loss_pct,
                    take_profit_pct: b.take_profit_pct,
                    config: b.config || {},
                  };

                  const updateField = (field, val) => {
                    setBotEditForms((prev) => ({
                      ...prev,
                      [b.bot_id]: {
                        ...form,
                        [field]: val,
                      },
                    }));
                  };

                  const updateConfigField = (cKey, val) => {
                    setBotEditForms((prev) => ({
                      ...prev,
                      [b.bot_id]: {
                        ...form,
                        config: {
                          ...(form.config || {}),
                          [cKey]: val,
                        },
                      },
                    }));
                  };

                  return (
                    <div
                      key={b.bot_id}
                      style={{
                        background: "#161f33",
                        border: "1px solid #26324d",
                        borderRadius: "12px",
                        padding: "16px",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: "15px", marginBottom: "4px" }}>
                        {b.name}
                      </div>
                      <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "12px" }}>
                        패키지 모듈: <code>agentBot/{b.bot_id}.py</code>
                      </div>

                      <div className="form-row">
                        <label>봇 별명 (Nickname)</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="봇 별명을 입력하세요"
                          value={form.nickname ?? ""}
                          onChange={(e) => updateField("nickname", e.target.value)}
                        />
                      </div>

                      <div className="form-row">
                        <label>
                          최소 거래대금 유동성 필터 (min_volume_krw):{" "}
                          <strong style={{ color: "#a5b4fc" }}>
                            {formatWithCommas(form.min_volume_krw)
                              ? `${formatWithCommas(form.min_volume_krw)}원`
                              : "미설정"}
                          </strong>
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="form-input"
                          placeholder="최소 거래대금 입력"
                          value={formatWithCommas(form.min_volume_krw)}
                          onChange={(e) =>
                            updateField("min_volume_krw", parseNumericInput(e.target.value))
                          }
                        />
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                        <div className="form-row">
                          <label>손절 기준 (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="손절 %"
                            value={form.stop_loss_pct ?? ""}
                            onChange={(e) =>
                              updateField(
                                "stop_loss_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div className="form-row">
                          <label>익절 기준 (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="익절 %"
                            value={form.take_profit_pct ?? ""}
                            onChange={(e) =>
                              updateField(
                                "take_profit_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      </div>

                      {(() => {
                        const defaultRatio =
                          b.bot_id === "bot_volatility"
                            ? 0.3
                            : b.bot_id === "bot_dual_momentum"
                            ? 0.35
                            : 0.45;
                        const rawOrderRatio = form.config?.order_ratio;
                        const ratioPctVal =
                          rawOrderRatio === "" || rawOrderRatio === undefined || rawOrderRatio === null
                            ? Math.round(defaultRatio * 100)
                            : Number(rawOrderRatio) <= 1
                            ? Math.round(Number(rawOrderRatio) * 100)
                            : Number(rawOrderRatio);
                        const allocKrw = Math.floor(Number(b.allocated_capital || 0));
                        const rawPreviewKrw = Math.floor(allocKrw * (Number(ratioPctVal || 0) / 100));
                        const effectivePreviewKrw =
                          allocKrw >= 5000 && rawPreviewKrw < 5000 ? 5000 : rawPreviewKrw;

                        return (
                          <div className="form-row">
                            <label>
                              1회 매수 비중 (10% ~ 100%) → 1회 주문 예상액:{" "}
                              <strong style={{ color: "#38bdf8" }}>
                                {effectivePreviewKrw.toLocaleString("ko-KR")}원
                              </strong>
                              {allocKrw >= 5000 && rawPreviewKrw < 5000 && (
                                <span style={{ color: "#fbbf24", fontSize: "11px", marginLeft: "4px" }}>
                                  (최소주문 5,000원 자동적용)
                                </span>
                              )}
                            </label>
                            <input
                              type="number"
                              step="5"
                              min="10"
                              max="100"
                              className="form-input"
                              placeholder="1회 매수 비중(%) 입력 (예: 50, 100)"
                              value={
                                rawOrderRatio === ""
                                  ? ""
                                  : ratioPctVal
                              }
                              onChange={(e) => {
                                if (e.target.value === "") {
                                  updateConfigField("order_ratio", "");
                                } else {
                                  const pct = Math.min(100, Math.max(1, Number(e.target.value)));
                                  updateConfigField("order_ratio", Number((pct / 100).toFixed(4)));
                                }
                              }}
                            />
                          </div>
                        );
                      })()}

                      {b.bot_id === "bot_volatility" && (
                        <div className="form-row">
                          <label>변동성 돌파 K 계수 (0.1 ~ 0.9 / 추천: 0.4)</label>
                          <input
                            type="number"
                            step="0.05"
                            className="form-input"
                            placeholder="K 계수 입력 (추천: 0.4)"
                            value={form.config?.k_value ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "k_value",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      {b.bot_id === "bot_dual_momentum" && (
                        <div className="form-row">
                          <label>절대 모멘텀 최소 수익률 기준 (% / 추천: 1.5%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="최소 수익률(%) 입력 (추천: 1.5)"
                            value={form.config?.abs_momentum_threshold_pct ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "abs_momentum_threshold_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      {b.bot_id === "bot_bollinger_reversal" && (
                        <div className="form-row">
                          <label>볼린저 밴드 표준편차 배수 (σ / 추천: 2.0)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="표준편차 배수 입력 (추천: 2.0)"
                            value={form.config?.bb_std ?? ""}
                            onChange={(e) =>
                              updateConfigField(
                                "bb_std",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}

                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ width: "100%", marginTop: "6px" }}
                        onClick={() => handleSaveBotConfig(b.bot_id)}
                      >
                        [{form.nickname || b.name}] 설정 저장
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 요구사항 13: 데이터 마이그레이션(JSON 내보내기) 및 복원(JSON 파일 읽기) */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>
                3. 데이터 마이그레이션 및 복원 (JSON)
              </h3>
              <p style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "16px" }}>
                SQLite 데이터베이스의 전체 데이터(봇 설정, 거래 내역, 포지션, 시스템 설정)를 JSON 파일로 백업(마이그레이션)하거나, JSON 파일을 읽어 복원합니다.
              </p>
              <div className="btn-group">
                <button type="button" className="btn btn-primary" onClick={handleExportJson}>
                  ⬇ JSON 마이그레이션 파일 내보내기 (Export)
                </button>
                <label className="btn btn-outline" style={{ display: "inline-flex", alignItems: "center" }}>
                  ⬆ JSON 파일 읽어서 데이터 복원 (Import)
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={handleImportJsonFile}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 요구사항 20, 21: 거래 시작/중지 동작 알림 및 잔고 0 이하 거래 중지 알림 Modal Popup */}
      {modalInfo.open && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div
              className="modal-title"
              style={{
                color:
                  modalInfo.type === "danger"
                    ? "#f87171"
                    : modalInfo.type === "success"
                    ? "#4ade80"
                    : "#a5b4fc",
              }}
            >
              {modalInfo.title}
            </div>
            <div className="modal-body" style={{ whiteSpace: "pre-line" }}>
              {modalInfo.message}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={closeModal}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

