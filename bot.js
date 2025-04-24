const fs = require('fs');
require('dotenv').config();
const ccxt = require('ccxt');
const { RSI, SMA, MACD } = require('technicalindicators');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const server = app.listen(8080, () => console.log('Server running on port 8080'));
const wss = new WebSocket.Server({ server });

const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  enableRateLimit: true,
  adjustForTimeDifference: true,
  enableFutures: true,
  options: {
    defaultType: 'future',
  },
});

let balance = 40;
const profitTarget = 2.25;
const lossLimit = 3;
const leverage = 5;
const rsiPeriod = 14;
const volumeThresholds = [
  { volume: 1_000_000_000, leverage: 20 },
  { volume: 500_000_000, leverage: 15 },
  { volume: 100_000_000, leverage: 10 },
  { volume: 0, leverage: 5 },
];
const activePositions = new Map();
const minimumBalance = 5;
const timeframe = '1m';

// WebSocket broadcast
function broadcast(data) {
  try {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  } catch (e) {
    console.error('Error broadcasting data:', e.message);
  }
}

function logToFile(message) {
  const logMessage = `${new Date().toISOString()} - ${message}`;
  console.log(logMessage); // In ra console để debug
  fs.appendFileSync('bot.log', logMessage + '\n');
  broadcast({ type: 'log', message: logMessage });
}

async function getAllTradingPairs() {
  try {
    const markets = await exchange.loadMarkets();
    logToFile(`Markets loaded: ${Object.keys(markets).length} markets`);
    const tradingPairs = Object.keys(markets)
      .filter(symbol => {
        const market = markets[symbol];
        const isValid =
          market &&
          market.active &&
          market.type === 'future' &&
          (symbol.includes('USDT') || symbol.includes('USD')); // Chấp nhận cả USDT và USD
        if (!isValid) {
          logToFile(
            `Skipping ${symbol}: Not a valid future (active=${market?.active}, type=${market?.type}, includesUSDTorUSD=${symbol.includes('USDT') || symbol.includes('USD')}, contractType=${market?.contractType})`
          );
        } else {
          logToFile(`Valid pair: ${symbol} (contractType=${market.contractType})`);
        }
        return isValid;
      });
    logToFile(`Filtered trading pairs: ${tradingPairs.join(', ')}`);
    return tradingPairs;
  } catch (e) {
    logToFile(`Error fetching markets: ${e.message}`);
    throw e;
  }
}
async function fetchDataWithRetry(symbol, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 50); // Giảm xuống 50
      if (!ohlcv || ohlcv.length < 50) {
        logToFile(`Skipping ${symbol}: Insufficient OHLCV data (${ohlcv?.length || 0} candles)`);
        return null;
      }
      const closes = ohlcv.map(c => c[4]);
      return {
        closes,
        rsi: RSI.calculate({ values: closes, period: rsiPeriod }),
        smaFast: SMA.calculate({ values: closes, period: 7 }),
        smaSlow: SMA.calculate({ values: closes, period: 25 }),
        macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }),
      };
    } catch (e) {
      logToFile(`Retry ${i + 1}/${retries} for ${symbol}: ${e.message}`);
      if (i === retries - 1) {
        logToFile(`Failed to fetch data for ${symbol}`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

function analyze({ rsi, smaFast, smaSlow, macd }) {
  let signals = [];
  if (rsi[rsi.length - 1] < 30 && rsi[rsi.length - 2] < 30) signals.push('LONG');
  if (rsi[rsi.length - 1] > 70 && rsi[rsi.length - 2] > 70) signals.push('SHORT');

  const smaCond = smaFast[smaFast.length - 1] > smaSlow[smaSlow.length - 1] ? 'LONG' : 'SHORT';
  signals.push(smaCond);

  const macdHist = macd[macd.length - 1]?.histogram;
  if (macdHist > 0) signals.push('LONG');
  else if (macdHist < 0) signals.push('SHORT');

  if (signals.filter(s => s === 'LONG').length >= 3) {
    signals = ['LONG'];
  } else if (signals.filter(s => s === 'SHORT').length >= 3) {
    signals = ['SHORT'];
  }

  return signals;
}

async function openPosition(symbol, side, amount) {
  try {
    const ticker = await exchange.fetchTicker(symbol);
    const volumeUSD = ticker.quoteVolume || 0;

    // Tính toán leverage động dựa trên volume thị trường
    let dynamicLeverage = volumeThresholds.find(t => volumeUSD >= t.volume)?.leverage || leverage;
    await exchange.setLeverage(dynamicLeverage, symbol);

    const price = ticker.last;
    
    // Tính toán TP và SL
    const tp = side === 'buy' 
      ? price + (profitTarget / dynamicLeverage) 
      : price - (profitTarget / dynamicLeverage);
    const sl = side === 'buy' 
      ? price - (lossLimit / dynamicLeverage) 
      : price + (lossLimit / dynamicLeverage);

    // Kiểm tra nếu có đủ số dư và mở lệnh
    if (balance < 10) {
      logToFile(`❌ Not enough balance to open position for ${symbol}`);
      return false;
    }

    await exchange.createMarketOrder(symbol, side, amount);
    
    const opposite = side === 'buy' ? 'sell' : 'buy';
    await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', opposite, amount, undefined, {
      stopPrice: tp,
      closePosition: true,
      reduceOnly: true,
    });
    await exchange.createOrder(symbol, 'STOP_MARKET', opposite, amount, undefined, {
      stopPrice: sl,
      closePosition: true,
      reduceOnly: true,
    });

    // Lưu trạng thái của lệnh
    activePositions.set(symbol, { side, amount, entry: price, tp, sl });
    logToFile(`🟢 ${symbol} ${side.toUpperCase()} opened at ${price} (TP: ${tp}, SL: ${sl})`);
    
    // Cập nhật thông tin các lệnh đang mở
    broadcast({
      type: 'positions',
      positions: Array.from(activePositions.entries()).map(([sym, pos]) => ({
        symbol: sym,
        side: pos.side,
        entry: pos.entry,
        amount: pos.amount,
        tp: pos.tp,
        sl: pos.sl,
        pnl: 0,
      })),
    });
    return true;
  } catch (e) {
    logToFile(`Error opening position for ${symbol}: ${e.message}`);
    return false;
  }
}


async function checkPositions() {
  try {
    const positions = await exchange.fetchPositions();
    const openSymbols = new Set();
    const updatedPositions = [];
    for (const pos of positions) {
      if (pos.contracts > 0) {
        logToFile(`📌 Active position on ${pos.symbol}: ${pos.side}, ${pos.contracts} contracts`);
        openSymbols.add(pos.symbol);
        const storedPos = activePositions.get(pos.symbol) || {};
        const pnl = pos.unrealizedPnl || 0;
        updatedPositions.push({
          symbol: pos.symbol,
          side: pos.side.toLowerCase(),
          entry: pos.entryPrice,
          amount: pos.contracts,
          tp: storedPos.tp,
          sl: storedPos.sl,
          pnl,
        });
        activePositions.set(pos.symbol, {
          side: pos.side.toLowerCase(),
          amount: pos.contracts,
          entry: pos.entryPrice,
          tp: storedPos.tp,
          sl: storedPos.sl,
        });
      }
    }
    for (const symbol of activePositions.keys()) {
      if (!openSymbols.has(symbol)) {
        logToFile(`🟥 Position on ${symbol} closed`);
        activePositions.delete(symbol);
      }
    }
    broadcast({ type: 'positions', positions: updatedPositions });
  } catch (e) {
    logToFile(`Error checking positions: ${e.message}`);
  }
}

async function main() {
  logToFile('Starting main loop...');
  try {
    const tradingPairs = await getAllTradingPairs();
    logToFile(`✅ Trading pairs loaded: ${tradingPairs.length} pairs`);

    const balanceInfo = await exchange.fetchBalance();
    const usdtBalance = balanceInfo.total.USDT || 0;
    logToFile(`💰 Current balance: ${usdtBalance} USDT`);
    broadcast({ type: 'balance', balance: usdtBalance });

    if (usdtBalance < minimumBalance) {
      logToFile(`❌ Insufficient balance: ${usdtBalance} USDT < ${minimumBalance} USDT`);
      return;
    }

    await checkPositions();

    let tradesCount = Math.floor(usdtBalance / 10);
    let remainder = usdtBalance % 10;
    logToFile(`💼 Can open ${tradesCount} trades of 10$ each, with ${remainder} USDT left`);

    const signalData = [];
    for (const symbol of tradingPairs) {
      logToFile(`🔍 Checking ${symbol}...`);
      if (tradesCount <= 0 && remainder < minimumBalance) {
        logToFile('🔴 Not enough balance to open more trades');
        break;
      }
      if (activePositions.has(symbol)) {
        logToFile(`⚠️ Already trading on ${symbol}`);
        continue;
      }

      try {
        const data = await fetchDataWithRetry(symbol);
        if (!data) {
          logToFile(`Skipping ${symbol}: No data available`);
          continue;
        }
        logToFile(`📈 Data for ${symbol}: RSI=${data.rsi[data.rsi.length - 1]?.toFixed(2) || '-'}`);

        const signals = analyze(data);
        logToFile(`📊 Signals for ${symbol}: ${signals.join(', ')}`);

        signalData.push({
          symbol,
          rsi: data.rsi[data.rsi.length - 1] || 0,
          sma: signals.includes('LONG') && signals.includes('SHORT') ? 'NEUTRAL' : signals.includes('LONG') ? 'LONG' : 'SHORT',
          macd: data.macd[data.macd.length - 1]?.histogram > 0 ? 'LONG' : 'SHORT',
          signal: signals.length > 0 ? signals[0] : 'NEUTRAL',
        });

        const long = signals.filter(s => s === 'LONG').length;
        const short = signals.filter(s => s === 'SHORT').length;

        if (long >= 2 || short >= 2) {
          const side = long > short ? 'buy' : 'sell';
          const amount = tradesCount > 0 ? 10 : remainder;
          const price = data.closes[data.closes.length - 1];
          const success = await openPosition(symbol, side, amount / price);
          if (success) {
            if (tradesCount > 0) tradesCount--;
            else remainder = 0;
          }
        }
      } catch (e) {
        logToFile(`❌ ${symbol} error: ${e.message}`);
      }
    }
    broadcast({ type: 'signals', signals: signalData });
  } catch (e) {
    logToFile(`Error in main function: ${e.message}`);
  }
  logToFile('Finished main loop');
}

async function startBot() {
  logToFile('🚀 Bot started');
  while (true) {
    await main();
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

startBot().catch(e => logToFile(`Bot crashed: ${e.message}`));