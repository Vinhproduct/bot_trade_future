const fs = require('fs');
require('dotenv').config();
const ccxt = require('ccxt');
const { RSI, MACD, SMA, EMA } = require('technicalindicators');

// Khởi tạo exchange (hỗ trợ Testnet nếu cần)
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  enableRateLimit: true,
  adjustForTimeDifference: true,
  options: { defaultType: 'future' },
  // urls: { api: { fapi: 'https://testnet.binance.vision/fapi' } }, // Bật dòng này để dùng Testnet
});

// Cấu hình bot
const maxPositions = 5;
const tradeAmount = 10; // Mỗi lệnh $10
const leverage = 5; // Đòn bẩy
const profitTarget = 2; // Mục tiêu lợi nhuận $2
const lossLimit = 3; // Giới hạn lỗ $3
const rsiPeriod = 14;
const smaPeriod = 50;
const emaPeriod = 20;
const timeframe = '15m';
const activePositions = new Map();
const targetBalance = 1000; // Mục tiêu vốn $1000
const symbolBlacklist = new Set(); // Danh sách đen cho symbol lỗi

// Ghi log
function logToFile(message) {
  const logMessage = `${new Date().toISOString()} - ${message}`;
  console.log(logMessage);
  fs.appendFileSync('bot.log', logMessage + '\n');
}

// Ngủ
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Thử lại API nếu lỗi
async function withRetry(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      logToFile(`⚠️ Thử lại ${i + 1}/${maxRetries} cho lỗi: ${e.message}`);
      await sleep(delay * (i + 1));
    }
  }
}

// Lưu và tải vị thế
function savePositions() {
  try {
    fs.writeFileSync('positions.json', JSON.stringify([...activePositions]));
    logToFile('💾 Đã lưu vị thế vào positions.json');
  } catch (e) {
    logToFile(`❌ Lỗi lưu vị thế: ${e.message}`);
  }
}

function loadPositions() {
  try {
    const data = fs.readFileSync('positions.json');
    activePositions.clear();
    const positions = JSON.parse(data);
    positions.forEach(([symbol, pos]) => activePositions.set(symbol, pos));
    logToFile('📂 Đã tải vị thế từ positions.json');
  } catch (e) {
    logToFile('⚠️ Không tìm thấy vị thế đã lưu.');
  }
}

// Lấy danh sách cặp giao dịch
async function getTradingPairs() {
  try {
    const markets = await withRetry(() => exchange.loadMarkets());
    const allSymbols = Object.keys(markets).filter(symbol =>
      symbol.includes('USDT') &&
      symbol.endsWith(':USDT') &&
      markets[symbol].type === 'swap' &&
      markets[symbol].info.contractType === 'PERPETUAL' &&
      markets[symbol].active
    );

    const volumes = [];
    for (const symbol of allSymbols) {
      try {
        const ticker = await withRetry(() => exchange.fetchTicker(symbol));
        volumes.push({ symbol, volume: ticker.quoteVolume || 0 });
        await sleep(100);
      } catch (e) {
        logToFile(`⚠️ Không lấy được ticker cho ${symbol}: ${e.message}`);
      }
    }

    const sortedTop = volumes.sort((a, b) => b.volume - a.volume).slice(0, 30);

    const filtered = [];
    for (const { symbol } of sortedTop) {
      try {
        const ohlcv = await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, 50));
        if (!ohlcv || ohlcv.length < 50) continue;

        const orderBook = await withRetry(() => exchange.fetchOrderBook(symbol, 10));
        const bidDepth = orderBook.bids.reduce((sum, [p, a]) => sum + p * a, 0);
        const askDepth = orderBook.asks.reduce((sum, [p, a]) => sum + p * a, 0);
        const depth = bidDepth + askDepth;
        if (depth < 100_000) continue;

        // Tách phần chuẩn từ symbol, bỏ ":USDT"
        const cleanSymbol = symbol.split(':')[0]; // "ETH/USDT:USDT" => "ETH/USDT"
        filtered.push(cleanSymbol);

        if (filtered.length === 20) break;
        await sleep(100);
      } catch (e) {
        logToFile(`⚠️ Lỗi kiểm tra ${symbol}: ${e.message}`);
        continue;
      }
    }

    logToFile(`✅ Đã chọn ${filtered.length} cặp top volume: ${JSON.stringify(filtered)}`);
    return filtered;
  } catch (e) {
    logToFile(`❌ Lỗi khi lấy danh sách trading pairs: ${e.message}`);
    return [];
  }
}

// Lấy dữ liệu và tính chỉ báo
async function fetchIndicators(symbol) {
  try {
    const market = exchange.market(symbol);
    if (!market || !market.active) {
      logToFile(`❌ Symbol ${symbol} không hợp lệ hoặc không hoạt động`);
      symbolBlacklist.add(symbol);
      return null;
    }

    const ohlcv = await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, 100));
    if (!ohlcv || ohlcv.length < 50) {
      logToFile(`❌ Không đủ dữ liệu cho ${symbol}: ${ohlcv?.length || 0} nến)`);
      symbolBlacklist.add(symbol);
      return null;
    }

    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);

    const rsi = RSI.calculate({ values: closes, period: rsiPeriod });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const sma = SMA.calculate({ values: closes, period: smaPeriod });
    const ema = EMA.calculate({ values: closes, period: emaPeriod });

    if (rsi.length < 2 || macd.length < 2 || sma.length < 1 || ema.length < 1) {
      logToFile(`❌ Dữ liệu chỉ báo không đủ cho ${symbol}`);
      symbolBlacklist.add(symbol);
      return null;
    }

    return {
      closes,
      volumes,
      rsi,
      macd,
      sma,
      ema,
      volumeAvg: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20,
    };
  } catch (e) {
    logToFile(`❌ Lỗi lấy chỉ báo cho ${symbol}: ${e.message}, Chi tiết: ${JSON.stringify(e)}`);
    symbolBlacklist.add(symbol);
    return null;
  }
}

// Phân tích tín hiệu
function analyze({ rsi, macd, volumes, volumeAvg, sma, ema, closes }) {
  const latestClose = closes.at(-1);
  const previousClose = closes.at(-2);
  const latestRSI = rsi.at(-1);
  const previousRSI = rsi.at(-2);
  const latestMACDHist = macd.at(-1)?.histogram;
  const previousMACDHist = macd.at(-2)?.histogram;
  const latestSMA = sma.at(-1);
  const latestEMA = ema.at(-1);
  const currentVolume = volumes.at(-1);

  const isDoji = Math.abs(latestClose - previousClose) < (latestClose * 0.001);
  const isLowVolume = currentVolume < volumeAvg * 0.5;
  if (isDoji || isLowVolume) return null;

  const high = Math.max(previousClose, latestClose);
  const low = Math.min(previousClose, latestClose);
  const candleBody = Math.abs(latestClose - previousClose);
  const candleRange = high - low;
  const isStrongCandle = candleBody > candleRange * 0.7;
  if (!isStrongCandle) return null;

  let longScore = 0;
  let shortScore = 0;

  if (latestMACDHist > 0 && previousMACDHist <= 0) longScore += 1.5;
  if (latestMACDHist < 0 && previousMACDHist >= 0) shortScore += 1.5;

  if (currentVolume > volumeAvg * 2) {
    if (latestRSI < 50) longScore += 1.5;
    else shortScore += 1.5;
  }

  if (latestRSI < 30 && previousRSI < 30) longScore += 1;
  if (latestRSI > 70 && previousRSI > 70) shortScore += 1;

  if (latestClose > latestSMA) longScore += 0.5;
  else shortScore += 0.5;

  if (latestClose > latestEMA) longScore += 0.5;
  else shortScore += 0.5;

  if (longScore >= 3) return 'LONG';
  if (shortScore >= 3) return 'SHORT';
  return null;
}

// Mở vị thế
async function openPosition(symbol, side, entryPrice, quantity, leverage) {
  const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';

  const tpAmount = 2.25; // lợi nhuận mục tiêu
  const slAmount = 3; // mức lỗ tối đa

  // Tính toán TP và SL theo tỉ lệ vốn (với giả định đòn bẩy đã được áp dụng)
  const tpPrice = side === 'BUY'
    ? entryPrice + (tpAmount / quantity)
    : entryPrice - (tpAmount / quantity);

  const slPrice = side === 'BUY'
    ? entryPrice - (slAmount / quantity)
    : entryPrice + (slAmount / quantity);

  try {
    // Đặt lệnh Market để vào lệnh
    const order = await binance.futuresMarketOrder(symbol, side, quantity, {
      positionSide,
    });

    logToTerminal(`[VÀO LỆNH] ${symbol} | ${positionSide} | Giá: ${entryPrice.toFixed(4)} | SL: ${slPrice.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | Số lượng: ${quantity}`);

    // Gửi lệnh Stop Loss
    await binance.futuresOrder('STOP_MARKET', symbol, null, null, {
      stopPrice: slPrice.toFixed(4),
      closePosition: true,
      side: oppositeSide,
      positionSide,
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE',
    });

    // Gửi lệnh Take Profit
    await binance.futuresOrder('TAKE_PROFIT_MARKET', symbol, null, null, {
      stopPrice: tpPrice.toFixed(4),
      closePosition: true,
      side: oppositeSide,
      positionSide,
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE',
    });

    logToTerminal(`[LỆNH TP/SL] Đã đặt TP tại ${tpPrice.toFixed(4)} và SL tại ${slPrice.toFixed(4)} cho ${symbol}`);
  } catch (err) {
    console.error(`[LỖI OPEN] ${symbol} - ${err.message}`);
    logToTerminal(`[LỖI] Không thể mở lệnh ${symbol} - ${err.message}`);
  }
}

// Kiểm tra vị thế
async function checkPositions() {
  try {
    const positions = await withRetry(() => exchange.fetchPositionsRisk());
    const openSymbols = new Set();

    for (const pos of positions) {
      if (!pos?.info || isNaN(parseFloat(pos.info.positionAmt))) continue;
      if (parseFloat(pos.info.positionAmt) !== 0) {
        openSymbols.add(pos.symbol);
        if (!activePositions.has(pos.symbol)) {
          activePositions.set(pos.symbol, {
            side: parseFloat(pos.info.positionAmt) > 0 ? 'buy' : 'sell',
            amount: Math.abs(parseFloat(pos.info.positionAmt)),
            entry: parseFloat(pos.info.entryPrice || 0),
            tp: null,
            sl: null,
          });
          savePositions();
        }
        logToFile(`📌 Vị thế ${pos.symbol}: ${pos.info.positionAmt} hợp đồng, PnL: ${pos.info.unRealizedProfit || 0}`);
      }
    }

    async function checkOpenOrders(symbol) {
      try {
        const orders = await withRetry(() => exchange.fetchOpenOrders(symbol));
        const hasTP = orders.some(o => o.type === 'TAKE_PROFIT_MARKET');
        const hasSL = orders.some(o => o.type === 'STOP_MARKET');
        if (!hasTP || !hasSL) {
          logToFile(`⚠️ Lệnh TP/SL cho ${symbol} không tồn tại`);
          return false;
        }
        return true;
      } catch (e) {
        logToFile(`❌ Lỗi kiểm tra lệnh mở cho ${symbol}: ${e.message}`);
        return false;
      }
    }

    for (const [symbol, position] of activePositions.entries()) {
      if (!openSymbols.has(symbol)) {
        const lastPrice = await withRetry(() => exchange.fetchTicker(symbol)).then(t => t.last);
        const estimatedPnl = position.side === 'buy'
          ? (lastPrice - position.entry) * position.amount * (exchange.market(symbol).contractSize || 1)
          : (position.entry - lastPrice) * position.amount * (exchange.market(symbol).contractSize || 1);
        logToFile(`🟥 Vị thế trên ${symbol} đã đóng (có thể do TP/SL) tại ${lastPrice}, PnL ước tính: ${estimatedPnl.toFixed(2)} USDT`);
        activePositions.delete(symbol);
        savePositions();
        continue;
      }

      const market = exchange.market(symbol);
      const ticker = await withRetry(() => exchange.fetchTicker(symbol));
      const currentPrice = ticker.last;
      const side = position.side;
      const entry = position.entry;
      const amount = position.amount;
      const contractSize = market.contractSize || 1;

      const hasOrders = await checkOpenOrders(symbol);
      if (!hasOrders) {
        logToFile(`⚠️ Đóng vị thế ${symbol} vì thiếu lệnh TP/SL`);
        const opposite = side === 'buy' ? 'sell' : 'buy';
        await withRetry(() => exchange.createMarketOrder(symbol, opposite, amount, { reduceOnly: true }));
        activePositions.delete(symbol);
        savePositions();
        continue;
      }

      const feeRate = 0.0004; // Phí taker 0.04%
      const entryFee = amount * entry * contractSize * feeRate;
      const exitFee = amount * currentPrice * contractSize * feeRate;
      const margin = (amount * entry * contractSize) / leverage;
      const pnl = side === 'buy'
        ? (currentPrice - entry) * amount * contractSize - (entryFee + exitFee)
        : (entry - currentPrice) * amount * contractSize - (entryFee + exitFee);
      const roi = (pnl / margin) * 100;

      const isTakeProfit = pnl >= profitTarget;
      const isStopLoss = pnl <= -lossLimit;

      if (isTakeProfit || isStopLoss) {
        const reason = isTakeProfit ? 'Take Profit (thủ công)' : 'Stop Loss (thủ công)';
        const opposite = side === 'buy' ? 'sell' : 'buy';

        try {
          await withRetry(() => exchange.cancelAllOrders(symbol));
          logToFile(`🗑️ Đã hủy lệnh TP/SL cho ${symbol}`);

          await withRetry(() =>
            exchange.createMarketOrder(symbol, opposite, position.amount, {
              reduceOnly: true,
            })
          );
          logToFile(`🛑 Đã đóng ${symbol} do ${reason} tại ${currentPrice} (ROI: ${roi.toFixed(2)}%)`);
          activePositions.delete(symbol);
          savePositions();
          await sleep(500);
        } catch (e) {
          logToFile(`❌ Lỗi đóng vị thế ${symbol}: ${e.message}`);
        }
      } else {
        logToFile(`📊 ${symbol} ROI: ${roi.toFixed(2)}% - Đang giữ.`);
      }
    }
  } catch (e) {
    logToFile(`❌ Lỗi kiểm tra vị thế: ${e.message}, Chi tiết: ${JSON.stringify(e)}`);
  }
}

// Vòng lặp chính
async function runBot() {
  logToFile('🚀 Khởi động bot giao dịch...');
  loadPositions();

  while (true) {
    logToFile(`🕒 Vòng mới lúc ${new Date().toLocaleString()}`);
    try {
      const balanceInfo = await withRetry(() => exchange.fetchBalance());
      const balance = balanceInfo.total.USDT || 0;
      logToFile(`💰 Số dư: ${balance} USDT`);

      await checkPositions();

      if (balance >= targetBalance) {
        logToFile(`🎯 Đạt mục tiêu vốn ${targetBalance} USDT! Chỉ theo dõi vị thế hiện tại.`);
        if (activePositions.size === 0) {
          logToFile(`✅ Không còn vị thế mở. Dừng bot.`);
          break;
        }
        await sleep(60000);
        continue;
      }

      if (activePositions.size >= maxPositions) {
        logToFile(`⚠️ Đã đạt tối đa ${maxPositions} vị thế, chờ...`);
        await sleep(60000);
        continue;
      }

      const tradingPairs = await getTradingPairs();
      if (tradingPairs.length === 0) {
        logToFile('⚠️ Không tìm thấy cặp giao dịch hợp lệ, thử lại sau...');
        await sleep(60000);
        continue;
      }

      const requiredMargin = tradeAmount / leverage;
      if (balance < requiredMargin) {
        logToFile(`❌ Số dư không đủ: ${balance} USDT, cần ${requiredMargin} USDT`);
        await sleep(60000);
        continue;
      }

      const candidates = [];
      for (const symbol of tradingPairs) {
        if (activePositions.size >= maxPositions) break;
        if (activePositions.has(symbol) || symbolBlacklist.has(symbol)) continue;

        try {
          const indicators = await withRetry(() => fetchIndicators(symbol));
          if (!indicators) continue;

          const signal = analyze(indicators);
          if (signal) {
            candidates.push({ symbol, signal, volume: indicators.volumes.at(-1) });
          }
        } catch (e) {
          logToFile(`⚠️ Lỗi khi xử lý ${symbol}: ${e.message}`);
        }

        await sleep(1000); // tránh spam API
      }

      candidates.sort((a, b) => b.volume - a.volume);
      for (const candidate of candidates) {
        if (activePositions.size >= maxPositions) break;

        const side = candidate.signal === 'LONG' ? 'buy' : 'sell';
        const success = await openPosition(candidate.symbol, side, tradeAmount);
        if (success) {
          logToFile(`✅ Đã mở vị thế ${side.toUpperCase()} trên ${candidate.symbol}`);
        }
        await sleep(500);
      }
    } catch (e) {
      logToFile(`❌ Lỗi trong bot: ${e.message}, Chi tiết: ${JSON.stringify(e)}`);
    }

    await sleep(60000); // nghỉ giữa mỗi vòng
  }
}
// Kiểm tra API key
if (!process.env.API_KEY || !process.env.API_SECRET) {
  logToFile('❌ Thiếu API_KEY hoặc API_SECRET trong file .env');
  process.exit(1);
}

runBot();
