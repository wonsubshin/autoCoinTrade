import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = "http://localhost:8001";

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
  const range = maxVal - minVal === 0 ? 100000 : maxVal - minVal;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const points = series.map((item, idx) => {
    const x =
      series.length === 1
        ? padLeft + plotW / 2
        : padLeft + (idx / (series.length - 1)) * plotW;
    const y =
      padTop + plotH - ((Number(item.cumulative_profit || 0) - minVal) / range) * plotH;
    return { x, y, ...item };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const zeroY = padTop + plotH - ((0 - minVal) / range) * plotH;

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
        <text x={10} y={zeroY + 4} fill="#94a3b8" fontSize="11">
          0원
        </text>
        <text x={10} y={padTop + 8} fill="#94a3b8" fontSize="11">
          {Math.floor(maxVal).toLocaleString()}원
        </text>
        <text x={10} y={padTop + plotH} fill="#94a3b8" fontSize="11">
          {Math.floor(minVal).toLocaleString()}원
        </text>

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
  const fileInputRef = useRef(null);

  // 6) Modal Popup 상태 (요구사항 20: 거래 시작/중지 모달, 요구사항 21: 잔고 0 이하 중지 알림 모달)
  const [modalInfo, setModalInfo] = useState({
    open: false,
    title: "",
    message: "",
    type: "info",
  });
  const [zeroBalanceAlerted, setZeroBalanceAlerted] = useState(false);

  const showModal = (title, message, type = "info") => {
    setModalInfo({ open: true, title, message, type });
  };

  const closeModal = () => {
    setModalInfo((prev) => ({ ...prev, open: false }));
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

  useEffect(() => {
    if (!authenticated) return;
    fetchUpbitStatus();
    fetchOverviewAndBots(true);
    fetchTrades(selectedBotId);
    fetchStatistics();

    const timer = setInterval(() => {
      fetchUpbitStatus();
      fetchTrades(selectedBotId);
    }, 6000);
    return () => clearInterval(timer);
  }, [authenticated, selectedBotId]);

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

  // 메뉴 전환 시 처리 (거래현황 진입 시 잔고 0 이하 여부 즉시 체크하여 모달 표기)
  const handleMenuChange = (menuKey) => {
    setActiveMenu(menuKey);
    sessionStorage.setItem("autoCoinTrade_menu", menuKey);
    localStorage.setItem("autoCoinTrade_menu", menuKey);
    if (menuKey === "trades") {
      fetchOverviewAndBots(true);
      fetchTrades(selectedBotId);
    } else if (menuKey === "stats") {
      fetchStatistics();
    } else if (menuKey === "settings") {
      fetchOverviewAndBots(false);
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
          <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
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

        {/* 요구사항 8: 메뉴 구성 (거래현황, 통계, 설정) */}
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
            className={`menu-btn ${activeMenu === "settings" ? "active" : ""}`}
            onClick={() => handleMenuChange("settings")}
          >
            <span>⚙️</span>
            <span>설정</span>
          </button>
        </nav>

        <div className="sidebar-footer">
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
                      disabled={Boolean(currentBot.is_running)}
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
                      title="해당 봇의 virtual_krw 예산 락을 거쳐 즉시 매수 Row를 생성합니다"
                    >
                      + 매수 테스트
                    </button>
                    <button
                      className="btn btn-outline"
                      onClick={() => handleManualTradeTest(currentBot.bot_id, "sell")}
                      title="bot_positions에 기록된 본인 bot_id의 volume만 지정하여 분할 매도 후 Row를 업데이트합니다"
                    >
                      ✓ 보유지분 매도 업데이트
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
            [메뉴 3] 설정 (요구사항 13, 15, 22)
           ============================================================ */}
        {activeMenu === "settings" && (
          <div>
            <div className="page-header">
              <div>
                <h2 className="page-title">설정</h2>
                <p className="page-desc">
                  봇별 자금 분배 비율(소수점 버림), 봇 별명 및 전략 파라미터 수정, JSON 데이터 마이그레이션 및 복원을 관리합니다.
                </p>
              </div>
            </div>

            {/* 요구사항 22: 봇별 자금 분배 비율 설정 (소수점 버림 처리) */}
            <div className="card">
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "14px" }}>
                1. 운용 원금 및 봇별 자금 분배 비율 설정 (소수점 이하 버림 적용)
              </h3>
              <form onSubmit={handleSaveAllocation}>
                <div className="settings-grid">
                  <div className="form-row">
                    <label>
                      전체 운용 원금 (KRW) — 설정 금액:{" "}
                      <strong style={{ color: "#4ade80" }}>
                        {formatWithCommas(totalCapitalInput)
                          ? `${formatWithCommas(totalCapitalInput)}원`
                          : "미설정"}
                      </strong>{" "}
                      (0 이하 입력 시 전체 봇 거래 중지)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="form-input"
                      placeholder="운용 원금을 입력하세요"
                      value={formatWithCommas(totalCapitalInput)}
                      onChange={(e) => setTotalCapitalInput(parseNumericInput(e.target.value))}
                    />
                  </div>
                  {bots.map((b) => {
                    const rawRatio = ratioInputs[b.bot_id];
                    const ratioVal = Number(rawRatio || 0);
                    const previewAllocated = Math.floor(
                      Math.floor(Number(parseNumericInput(totalCapitalInput) || 0)) *
                        (ratioVal / 100.0)
                    );
                    return (
                      <div className="form-row" key={b.bot_id}>
                        <label>
                          [{b.nickname || b.name}] 분배 비율 (%) → 배정 원금(버림):{" "}
                          <strong style={{ color: "#a5b4fc" }}>
                            {previewAllocated.toLocaleString("ko-KR")}원
                          </strong>
                        </label>
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

                      {b.bot_id === "bot_volatility" && (
                        <div className="form-row">
                          <label>변동성 돌파 K 계수 (0.1 ~ 0.9)</label>
                          <input
                            type="number"
                            step="0.05"
                            className="form-input"
                            placeholder="K 계수 입력"
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
                          <label>절대 모멘텀 최소 수익률 기준 (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="최소 수익률(%) 입력"
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
                          <label>볼린저 밴드 표준편차 배수 (σ)</label>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            placeholder="표준편차 배수 입력"
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
                        [{form.nickname}] 설정 저장
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

