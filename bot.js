/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) return null;

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now,
  })).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${claim}`);
  const signature = sign.sign(key, "base64url");
  const jwt = `${header}.${claim}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token || null;
}

async function appendToSheet(values) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return;
  try {
    const token = await getGoogleAccessToken();
    if (!token) return;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [values] }),
      }
    );
    console.log("Google Sheet updated ✓");
  } catch (err) {
    console.log(`Google Sheet update failed: ${err.message}`);
  }
}

async function ensureSheetHeaders() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return;
  try {
    const token = await getGoogleAccessToken();
    if (!token) return;
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (!data.values) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [["Date", "Time (UTC)", "Symbol", "Action", "Entry Price", "Exit Price", "Size USD", "P&L USD", "P&L %", "Mode", "Notes"]] }),
        }
      );
    }
  } catch {}
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    const msg = `Missing credentials: ${missing.join(", ")}`;
    console.log(`\n⚠️  ${msg}\n`);
    throw new Error(msg);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Position Tracking ───────────────────────────────────────────────────────

const POSITION_FILE = "position.json";

function loadPosition() {
  if (!existsSync(POSITION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(POSITION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function savePosition(position) {
  writeFileSync(POSITION_FILE, JSON.stringify(position, null, 2));
}

function clearPosition() {
  if (existsSync(POSITION_FILE)) writeFileSync(POSITION_FILE, "null");
}

// ─── Exit Check ──────────────────────────────────────────────────────────────

function checkExitConditions(position, price, ema8, vwap, rsi3) {
  const results = [];
  const isLong = position.side === "long";

  console.log("\n── Exit Check ───────────────────────────────────────────\n");
  console.log(`  Open ${isLong ? "LONG" : "SHORT"} from $${position.entryPrice.toFixed(2)}`);

  const check = (label, hit) => {
    results.push({ label, hit });
    console.log(`  ${hit ? "✅" : "  "} ${label}`);
  };

  const stopHit = isLong
    ? price <= position.stopLoss
    : price >= position.stopLoss;
  check(`Hard stop hit (${position.stopLoss.toFixed(2)})`, stopHit);

  if (isLong) {
    check("RSI(3) crossed back above 50", rsi3 > 50);
    check("Price touched VWAP", Math.abs(price - vwap) / vwap < 0.001);
    check("Price crossed below EMA(8)", price < ema8);
  } else {
    check("RSI(3) crossed back below 50", rsi3 < 50);
    check("Price touched VWAP", Math.abs(price - vwap) / vwap < 0.001);
    check("Price crossed above EMA(8)", price > ema8);
  }

  const shouldExit = results.some((r) => r.hit);
  const reason = results.find((r) => r.hit)?.label || "";
  return { shouldExit, reason, results };
}

function calcPnL(position, exitPrice) {
  const isLong = position.side === "long";
  const priceDiff = isLong
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;
  const pnlUSD = (priceDiff / position.entryPrice) * position.sizeUSD;
  const pnlPct = (priceDiff / position.entryPrice) * 100;
  return { pnlUSD, pnlPct };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Entry Price",
  "Exit Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "P&L USD",
  "P&L %",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let entryPrice = "";
  let exitPrice = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let pnlUSD = "";
  let pnlPct = "";
  let orderId = "";
  let mode = logEntry.paperTrading ? "PAPER" : "LIVE";
  let notes = "";

  if (logEntry.type === "EXIT") {
    side = logEntry.side === "long" ? "SELL" : "BUY";
    quantity = logEntry.quantity;
    entryPrice = logEntry.entryPrice.toFixed(2);
    exitPrice = logEntry.exitPrice.toFixed(2);
    totalUSD = logEntry.sizeUSD.toFixed(2);
    fee = (logEntry.sizeUSD * 0.001 * 2).toFixed(4);
    pnlUSD = logEntry.pnlUSD.toFixed(2);
    pnlPct = logEntry.pnlPct.toFixed(3);
    netAmount = (logEntry.sizeUSD + logEntry.pnlUSD - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    notes = `Exit: ${logEntry.exitReason}`;
  } else if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    entryPrice = logEntry.price.toFixed(2);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "Entry — position opened";
  }

  const row = [
    date,
    time,
    "Coinbase",
    logEntry.symbol,
    side,
    quantity,
    entryPrice,
    exitPrice,
    totalUSD,
    fee,
    netAmount,
    pnlUSD,
    pnlPct,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  await ensureSheetHeaders();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // ── Check exit first if we have an open position ──────────────────────────
  const openPosition = loadPosition();

  if (openPosition && openPosition.symbol === CONFIG.symbol) {
    const { shouldExit, reason } = checkExitConditions(openPosition, price, ema8, vwap, rsi3);

    if (shouldExit) {
      const { pnlUSD, pnlPct } = calcPnL(openPosition, price);
      const pnlSign = pnlUSD >= 0 ? "+" : "";

      console.log("\n── Decision ─────────────────────────────────────────────\n");
      console.log(`📤 CLOSING POSITION — ${reason}`);
      console.log(`   Entry: $${openPosition.entryPrice.toFixed(2)} → Exit: $${price.toFixed(2)}`);
      console.log(`   P&L: ${pnlSign}$${pnlUSD.toFixed(2)} (${pnlSign}${pnlPct.toFixed(3)}%)`);

      const exitEntry = {
        type: "EXIT",
        timestamp: new Date().toISOString(),
        symbol: CONFIG.symbol,
        side: openPosition.side,
        entryPrice: openPosition.entryPrice,
        exitPrice: price,
        quantity: openPosition.quantity,
        sizeUSD: openPosition.sizeUSD,
        pnlUSD,
        pnlPct,
        exitReason: reason,
        orderId: CONFIG.paperTrading ? `PAPER-EXIT-${Date.now()}` : null,
        paperTrading: CONFIG.paperTrading,
        price,
        conditions: [],
        allPass: true,
      };

      log.trades.push(exitEntry);
      saveLog(log);
      writeTradeCsv(exitEntry);
      clearPosition();
      const pnlSign = exitEntry.pnlUSD >= 0 ? "+" : "";
      await appendToSheet([
        new Date().toISOString().slice(0, 10),
        new Date().toISOString().slice(11, 19),
        CONFIG.symbol, "EXIT",
        exitEntry.entryPrice.toFixed(2),
        exitEntry.exitPrice.toFixed(2),
        exitEntry.sizeUSD.toFixed(2),
        `${pnlSign}${exitEntry.pnlUSD.toFixed(2)}`,
        `${pnlSign}${exitEntry.pnlPct.toFixed(3)}%`,
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `Exit: ${exitEntry.exitReason}`,
      ]);
      console.log(`\nDecision log saved → ${LOG_FILE}`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    } else {
      console.log("\n── Decision ─────────────────────────────────────────────\n");
      console.log(`  Holding open ${openPosition.side} from $${openPosition.entryPrice.toFixed(2)}`);
      const { pnlUSD, pnlPct } = calcPnL(openPosition, price);
      const pnlSign = pnlUSD >= 0 ? "+" : "";
      console.log(`  Current P&L: ${pnlSign}$${pnlUSD.toFixed(2)} (${pnlSign}${pnlPct.toFixed(3)}%)`);
      console.log(`  No exit conditions met — holding.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
  }

  // ── No open position — check entry ────────────────────────────────────────

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    const stopLoss = price * (1 - 0.003); // 0.3% below entry for longs
    const quantity = (tradeSize / price).toFixed(6);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — buying ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   Stop loss: $${stopLoss.toFixed(2)} (0.3% below entry)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`);
      try {
        const order = await placeBitGetOrder(CONFIG.symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      savePosition({
        symbol: CONFIG.symbol,
        side: "long",
        entryPrice: price,
        entryTime: new Date().toISOString(),
        quantity,
        sizeUSD: tradeSize,
        stopLoss,
        orderId: logEntry.orderId,
      });
      console.log(`   Position saved — will check exit conditions next run`);
      await appendToSheet([
        new Date().toISOString().slice(0, 10),
        new Date().toISOString().slice(11, 19),
        CONFIG.symbol, "ENTRY",
        price.toFixed(2), "", tradeSize.toFixed(2), "", "",
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `Stop loss: $${stopLoss.toFixed(2)}`,
      ]);
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

export { run };

const isMain = process.argv[1] && process.argv[1].endsWith("bot.js");
if (isMain) {
  if (process.argv.includes("--tax-summary")) {
    generateTaxSummary();
  } else {
    run().catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}
