const fs = require('fs');
require('dotenv').config();
const ccxt = require('ccxt');
const { RSI, MACD, SMA, EMA } = require('technicalindicators');

// Khởi tạo exchange
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  enableRateLimit: true,
  adjustForTimeDifference: true,
  options: { defaultType: 'future' },
});

// Cấu hình bot
const maxPositions = 5; // Tối đa 5 lệnh
const tradeAmount = 10; // Mỗi lệnh 10 USDT
const leverage = 7; // Đòn bẩy 7x
const profitTarget = 2; // Lợi nhuận mục tiêu 2 USDT
const lossLimit = 3; // Cắt lỗ 3 USDT
const rsiPeriod = 14; // Chu kỳ RSI
const smaPeriod = 50;
const emaPeriod = 20;
const timeframe = '1h'; // Khung thời gian 1 giờ
const activePositions = new Map();

// Hàm ghi log
function logToFile(message) {
  const logMessage = `${new Date().toISOString()} - ${message}`;
  console.log(logMessage);
  fs.appendFileSync('bot.log', logMessage + '\n');
}

// Lấy danh sách cặp giao dịch hợp lệ (chỉ perpetual futures với USDT)
async function getTradingPairs() {
  try {
    const markets = await exchange.loadMarkets();
    let skippedCount = 0;
    const tradingPairs = Object.keys(markets)
      .filter(symbol => {
        const market = markets[symbol];
        const isPerpetual = market?.info?.contractType === 'PERPETUAL';
        const isValid =
          market &&
          market.active &&
          market.type === 'swap' &&
          isPerpetual &&
          symbol.includes('USDT') &&
          symbol.endsWith(':USDT');
        if (!isValid) {
          skippedCount++;
        }
        return isValid;
      })
      .map(symbol => symbol.replace(':USDT', ''));
    logToFile(`Loaded ${tradingPairs.length} USDT perpetual futures pairs: ${tradingPairs.join(', ')}`);
    logToFile(`Skipped ${skippedCount} non-USDT or non-perpetual pairs`);
    return tradingPairs;
  } catch (e) {
    logToFile(`Error fetching markets: ${e.message}`);
    return [];
  }
}

// Lấy dữ liệu OHLCV và tính toán chỉ báo
async function fetchIndicators(symbol) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 50);
    if (!ohlcv || ohlcv.length < 50) {
      logToFile(`Skipping ${symbol}: Insufficient OHLCV data (${ohlcv?.length || 0} candles)`);
      return null;
    }
    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);
    const macdResult = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const rsiResult = RSI.calculate({ values: closes, period: rsiPeriod });
    const smaResult = SMA.calculate({ values: closes, period: smaPeriod });
    const emaResult = EMA.calculate({ values: closes, period: emaPeriod });

    return {
      closes,
      volumes,
      rsi: rsiResult,
      macd: macdResult,
      sma: smaResult,
      ema: emaResult,
      volumeAvg: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20,
    };
  } catch (e) {
    logToFile(`Error fetching data for ${symbol}: ${e.message}`);
    return null;
  }
}

// Phân tích tín hiệu
function analyze({ rsi, macd, volumes, volumeAvg, sma, ema, closes }) {
  let signals = [];

  const latestClose = closes[closes.length - 1];
  const latestRSI = rsi[rsi.length - 1];
  const previousRSI = rsi[rsi.length - 2];
  const latestMACDHist = macd[macd.length - 1]?.histogram;
  const previousMACDHist = macd[macd.length - 2]?.histogram;
  const latestSMA = sma[sma.length - 1];
  const latestEMA = ema[ema.length - 1];
  const currentVolume = volumes[volumes.length - 1];

  // RSI Signal
  if (latestRSI < 30 && previousRSI < 30) signals.push('LONG');
  else if (latestRSI > 70 && previousRSI > 70) signals.push('SHORT');

  // MACD Signal
  if (latestMACDHist > 0 && previousMACDHist <= 0) signals.push('LONG');
  else if (latestMACDHist < 0 && previousMACDHist >= 0) signals.push('SHORT');

  // Volume Signal
  if (currentVolume > volumeAvg * 1.5) {
    if (latestRSI < 50) signals.push('LONG');
    else if (latestRSI > 50) signals.push('SHORT');
  }

  // SMA Signal
  if (latestClose > latestSMA) signals.push('LONG');
  else if (latestClose < latestSMA) signals.push('SHORT');

  // EMA Signal
  if (latestClose > latestEMA) signals.push('LONG');
  else if (latestClose < latestEMA) signals.push('SHORT');

  const longCount = signals.filter(s => s === 'LONG').length;
  const shortCount = signals.filter(s => s === 'SHORT').length;

  if (longCount >= 4) return 'LONG';
  if (shortCount >= 4) return 'SHORT';
  return null;
}

// Mở vị thế
async function openPosition(symbol, side, amount) {
  try {
    await exchange.setLeverage(leverage, symbol);
    await exchange.setMarginMode('isolated', symbol);

    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker.last;

    // Tính TP/SL
    const tp = side === 'buy'
      ? price * (1 + profitTarget / (tradeAmount * leverage))
      : price * (1 - profitTarget / (tradeAmount * leverage));
    const sl = side === 'buy'
      ? price * (1 - lossLimit / (tradeAmount * leverage))
      : price * (1 + lossLimit / (tradeAmount * leverage));

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

    activePositions.set(symbol, { side, amount, entry: price, tp, sl });
    logToFile(`🟢 Opened ${side.toUpperCase()} on ${symbol} at ${price} (TP: ${tp}, SL: ${sl})`);
    return true;
  } catch (e) {
    logToFile(`Error opening position on ${symbol}: ${e.message}`);
    return false;
  }
}

// Kiểm tra và cập nhật vị thế
async function checkPositions() {
  try {
    const positions = await exchange.fetchPositions();
    const openSymbols = new Set();
    for (const pos of positions) {
      if (pos.contracts > 0) {
        openSymbols.add(pos.symbol);
        if (!activePositions.has(pos.symbol)) {
          activePositions.set(pos.symbol, {
            side: pos.side.toLowerCase(),
            amount: pos.contracts,
            entry: pos.entryPrice,
            tp: null,
            sl: null,
          });
        }
        logToFile(`📌 Active position on ${pos.symbol}: ${pos.side}, ${pos.contracts} contracts, PnL: ${pos.unrealizedPnl}`);
      }
    }
    for (const symbol of activePositions.keys()) {
      if (!openSymbols.has(symbol)) {
        logToFile(`🟥 Position on ${symbol} closed`);
        activePositions.delete(symbol);
      }
    }
  } catch (e) {
    logToFile(`Error checking positions: ${e.message}`);
  }
}

// Hàm chính
async function runBot() {
  while (true) {
    try {
      const balanceInfo = await exchange.fetchBalance();
      const balance = balanceInfo.total.USDT || 0;
      logToFile(`💰 Current balance: ${balance} USDT`);

      await checkPositions();

      if (activePositions.size >= maxPositions) {
        logToFile(`⚠️ Max positions reached (${maxPositions}), waiting...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      if (balance < tradeAmount) {
        logToFile(`❌ Not enough balance to open new trades.`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      const tradingPairs = await getTradingPairs();
      if (tradingPairs.length === 0) {
        logToFile('❌ No trading pairs available');
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      for (const symbol of tradingPairs) {
        if (activePositions.size >= maxPositions) break;
        if (activePositions.has(symbol)) continue;

        const indicators = await fetchIndicators(symbol);
        if (!indicators) continue;

        const signal = analyze(indicators);
        if (!signal) continue;

        const price = indicators.closes[indicators.closes.length - 1];
        const amount = tradeAmount / price;

        const estimatedCost = amount * price;
        if (estimatedCost < 9.5 || estimatedCost > 10.5) {
          logToFile(`❌ Estimated cost ${estimatedCost.toFixed(2)} USDT not acceptable for ${symbol}`);
          continue;
        }

        const side = signal === 'LONG' ? 'buy' : 'sell';
        const success = await openPosition(symbol, side, amount);
        if (!success) logToFile(`❌ Failed to open position on ${symbol}`);

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      logToFile(`Error in bot loop: ${e.message}`);
    }
    logToFile('Finished one loop cycle.');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

// Chạy bot
logToFile('Starting trading bot...');
runBot();
