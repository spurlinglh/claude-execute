/**
 * Combined worker — runs the dashboard server and the trading bot on a schedule.
 * Deploy this to Railway as a persistent web service (no cron needed).
 *
 * The bot runs immediately on startup, then every INTERVAL_MS after that.
 * The dashboard serves on PORT (set by Railway automatically).
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3737;

// How often to run the bot (default: every 4 hours)
const INTERVAL_HOURS = parseFloat(process.env.BOT_INTERVAL_HOURS || "4");
const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;

// ─── Dashboard server ────────────────────────────────────────────────────────

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
};

const serveFile = (res, filePath, contentType) => {
  try {
    const data = readFileSync(filePath);
    send(res, 200, data, { "Content-Type": contentType });
  } catch {
    send(res, 500, "Error reading file");
  }
};

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    return serveFile(res, path.join(__dirname, "dashboard/index.html"), "text/html; charset=utf-8");
  }
  if (url === "/architecture" || url === "/architecture.html") {
    return serveFile(res, path.join(__dirname, "dashboard/architecture.html"), "text/html; charset=utf-8");
  }
  if (url === "/api/log") {
    const p = path.join(__dirname, "safety-check-log.json");
    if (!existsSync(p)) return send(res, 200, '{"trades":[]}', { "Content-Type": "application/json" });
    return serveFile(res, p, "application/json");
  }
  if (url === "/api/csv") {
    const p = path.join(__dirname, "trades.csv");
    if (!existsSync(p)) return send(res, 200, "", { "Content-Type": "text/plain" });
    return serveFile(res, p, "text/plain");
  }
  if (url === "/api/rules") {
    const p = path.join(__dirname, "rules.json");
    if (!existsSync(p)) return send(res, 200, "{}", { "Content-Type": "application/json" });
    return serveFile(res, p, "application/json");
  }
  if (url === "/api/env") {
    const env = {
      symbol: process.env.SYMBOL || "BTCUSDT",
      timeframe: process.env.TIMEFRAME || "4H",
      portfolio: Number(process.env.PORTFOLIO_VALUE_USD) || null,
      maxTradeUSD: Number(process.env.MAX_TRADE_SIZE_USD) || null,
      maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY) || null,
      paperTrading: (process.env.PAPER_TRADING || "true") === "true",
    };
    return send(res, 200, JSON.stringify(env), { "Content-Type": "application/json" });
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard live at port ${PORT}\n`);
});

// ─── Bot scheduler ───────────────────────────────────────────────────────────

async function runBot() {
  console.log(`\n[${new Date().toISOString()}] Running bot...\n`);
  try {
    const { run } = await import("./bot.js");
    await run();
  } catch (err) {
    console.error("Bot run failed:", err.message);
  }
}

// Run immediately on startup, then on interval
runBot();
setInterval(runBot, INTERVAL_MS);
