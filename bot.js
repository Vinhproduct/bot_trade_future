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
const maxPositions = 7;
const tradeAmount = 10; // Mỗi lệnh $10
const leverage = 5; // Đòn bẩy
const profitTarget = 2; // Mục tiêu lợi nhuận $2
const lossLimit = 3; // Giới hạn lỗ $3
const rsiPeriod = 14;
const smaPeriod = 50;
const emaPeriod = 20;
const timeframe = '1h';
const activePositions = new Map();
const targetBalance = 1000; // Mục tiêu vốn $1000
const symbolBlacklist = new Set(); // Danh sách đen cho symbol lỗi
///////////////////////////////////
const moment = require('moment-timezone');
// 
const symbolLocks = new Set();
function normalizeSymbol(symbol) {
  return symbol.replace(':USDT', '').trim();
}
// 
const vietnamTime = moment().tz("Asia/Ho_Chi_Minh").format("YYYY-MM-DD HH:mm:ss");
console.log("🕒 Giờ Việt Nam:", vietnamTime);


//////////////////////////////////
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
      symbol.includes('/USDT') &&
      markets[symbol].type === 'swap' &&
      markets[symbol].info.contractType === 'PERPETUAL' &&
      markets[symbol].active
    );


    logToFile(`[DEBUG] Tổng số symbol USDT Futures: ${allSymbols.length}`);

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

    if (volumes.length === 0) {
      logToFile('⚠️ Không có symbol nào có dữ liệu volume');
      return [];
    }

    const sortedTop = volumes.sort((a, b) => b.volume - a.volume).slice(0, 30);
    logToFile(`[DEBUG] Top 30 symbol theo volume: ${JSON.stringify(sortedTop.map(v => v.symbol))}`);

    const filtered = [];
    for (const { symbol } of sortedTop) {
      try {
        const ohlcv = await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, 50));
        if (!ohlcv || ohlcv.length < 50) {
          logToFile(`⚠️ Không đủ dữ liệu OHLCV cho ${symbol}: ${ohlcv?.length || 0} nến`);
          continue;
        }

        const orderBook = await withRetry(() => exchange.fetchOrderBook(symbol, 10));
        const bidDepth = orderBook.bids.reduce((sum, [p, a]) => sum + p * a, 0);
        const askDepth = orderBook.asks.reduce((sum, [p, a]) => sum + p * a, 0);
        const depth = bidDepth + askDepth;
        if (depth < 100_000) {
          logToFile(`⚠️ Độ sâu order book không đủ cho ${symbol}: ${depth}`);
          continue;
        }

        // Tách phần chuẩn từ symbol, bỏ ":USDT"
        const cleanSymbol = symbol.split(':')[0]; // "ETH/USDT:USDT" => "ETH/USDT"
        if (!cleanSymbol || !cleanSymbol.includes('/')) {
          logToFile(`⚠️ Symbol không hợp lệ sau khi tách: ${symbol} -> ${cleanSymbol}`);
          continue;
        }

        filtered.push(cleanSymbol);
        logToFile(`[DEBUG] Đã thêm symbol: ${cleanSymbol}`);

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
  if (!symbol || typeof symbol !== 'string' || !symbol.includes('/')) {
    logToFile(`❌ Symbol không hợp lệ: ${symbol}`);
    symbolBlacklist.add(symbol);
    return null;
  }

  try {
    const market = exchange.market(symbol);
    if (!market || !market.active) {
      logToFile(`❌ Symbol ${symbol} không hợp lệ hoặc không hoạt động`);
      symbolBlacklist.add(symbol);
      return null;
    }

    const ohlcv = await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, 50));
    if (!ohlcv || ohlcv.length < 50) {
      logToFile(`❌ Không đủ dữ liệu cho ${symbol}: ${ohlcv?.length || 0} nến`);
      symbolBlacklist.add(symbol);
      return null;
    }

    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);

    const rsi = RSI.calculate({ values: closes, period: rsiPeriod });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const sma = SMA.calculate({ values: closes, period: smaPeriod });
    const ema = EMA.calculate({ values: closes, period: emaPeriod });
    const ema200 = EMA.calculate({ values: closes, period: 200 });

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
      ema200,
      volumeAvg: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20,
    };


  } catch (e) {
    logToFile(`❌ Lỗi lấy chỉ báo cho ${symbol}: ${e.message}, Chi tiết: ${JSON.stringify(e)}`);
    symbolBlacklist.add(symbol);
    return null;
  }
}

// Phân tích tín hiệu
function analyze({ rsi, macd, volumes, volumeAvg, sma, ema, closes, ema200 }) {
  const latestClose = closes.at(-1);
  const previousClose = closes.at(-2);
  const latestOpen = closes.at(-2); // giả định close trước là open hiện tại
  const previousOpen = closes.at(-3);
  const latestRSI = rsi.at(-1);
  const previousRSI = rsi.at(-2);
  const latestMACDHist = macd.at(-1)?.histogram;
  const previousMACDHist = macd.at(-2)?.histogram;
  const latestSMA = sma.at(-1);
  const latestEMA = ema.at(-1);
  //const ema200 = ema.at(-1); // bạn cần truyền EMA200 vào đây nếu có

  const currentVolume = volumes.at(-1);

  // Lọc nến yếu và volume thấp
  const isDoji = Math.abs(latestClose - previousClose) < (latestClose * 0.001);
  const isLowVolume = currentVolume < volumeAvg * 0.7;
  if (isDoji || isLowVolume) return null;

  // Tính lực nến
  const high = Math.max(previousClose, latestClose);
  const low = Math.min(previousClose, latestClose);
  const candleBody = Math.abs(latestClose - previousClose);
  const candleRange = high - low;
  const isStrongCandle = candleBody > candleRange * 0.5;
  if (!isStrongCandle) return null;

  // Tính tín hiệu nến engulfing đơn giản
  const isBullishEngulfing = previousClose < latestOpen && latestClose > latestOpen && latestClose > previousOpen;
  const isBearishEngulfing = previousClose > latestOpen && latestClose < latestOpen && latestClose < previousOpen;

  let longScore = 0;
  let shortScore = 0;

  // MACD cross
  if (latestMACDHist > 0 && previousMACDHist <= 0) longScore += 0.5;
  if (latestMACDHist < 0 && previousMACDHist >= 0) shortScore += 0.5;

  // RSI cực trị
  if (latestRSI < 30 && previousRSI < 30) longScore += 0.5;
  if (latestRSI > 70 && previousRSI > 70) shortScore += 0.5;

  // Volume tăng mạnh
  if (currentVolume > volumeAvg * 2) {
    if (latestRSI < 50) longScore += 1;
    else shortScore += 1;
  }

  // Đường trung bình
  if (latestClose > latestSMA) longScore += 0.5;
  else shortScore += 0.5;

  if (latestClose > latestEMA) longScore += 0.5;
  else shortScore += 0.5;

  // Nến engulfing
  if (isBullishEngulfing) longScore += 0.5;
  if (isBearishEngulfing) shortScore += 0.5;

  // Lọc xu hướng chính bằng EMA200 (cần truyền vào đúng)
  const isUptrend = latestClose > ema200;
  const isDowntrend = latestClose < ema200;

  if (longScore >= 1.5 && longScore > shortScore && isUptrend) return 'LONG';
  if (shortScore >= 1.5 && shortScore > longScore && isDowntrend) return 'SHORT';

  return null;
}

// Mở vị thế
function roundQuantityUp(quantity, stepSize) {
  // Làm tròn lên theo stepSize (ví dụ stepSize = 0.01)
  return Math.ceil(quantity / stepSize) * stepSize;
}

async function openPosition(symbol, side, entryPrice, quantity, leverage) {
  if (!entryPrice || entryPrice <= 0 || isNaN(entryPrice)) {
    logToFile(`❌ entryPrice không hợp lệ cho ${symbol}: ${entryPrice}`);
    return false;
  }

  if (!quantity || quantity <= 0 || isNaN(quantity)) {
    logToFile(`❌ Quantity không hợp lệ cho ${symbol}: ${quantity}`);
    return false;
  }

  try {
    logToFile(`DEBUG: symbol=${symbol}, side=${side}, entryPrice=${entryPrice}, quantity=${quantity}, leverage=${leverage}`);

    const market = exchange.markets[symbol];
    if (!market) {
      logToFile(`❌ Không tìm thấy thị trường: ${symbol}`);
      return false;
    }

    const minNotional = 5;
    // const stepSize = market.limits.amount.step || 0.0001;
    const stepSize = market?.precision?.amount
      ? Math.pow(10, -market.precision.amount)
      : 0.0001;

    const notional = entryPrice * quantity;

    let adjustedQuantity = quantity;

    if (notional < minNotional) {
      adjustedQuantity = minNotional / entryPrice;
      adjustedQuantity = Math.floor(adjustedQuantity / stepSize) * stepSize;

      if (adjustedQuantity < stepSize) {
        logToFile(`❌ Khối lượng sau điều chỉnh (${adjustedQuantity}) nhỏ hơn bước nhảy tối thiểu (${stepSize}) cho ${symbol}`);
        return false;
      }
      logToFile(`⚠️ Điều chỉnh khối lượng cho ${symbol} từ ${quantity} thành ${adjustedQuantity} để đạt min notional ${minNotional}`);
    }

    logToFile(`🚀 Mở vị thế ${side.toUpperCase()} cho ${symbol} với giá vào lệnh ${entryPrice}, khối lượng ${adjustedQuantity}, đòn bẩy ${leverage}x`);

    await exchange.setLeverage(leverage, symbol);

    const orderSide = side.toLowerCase() === 'long' ? 'buy' : 'sell';
    logToFile(`DEBUG: orderSide=${orderSide}`);

    let order;
    try {
      order = await exchange.createMarketOrder(symbol, orderSide, adjustedQuantity);
      logToFile(`DEBUG: order result = ${JSON.stringify(order)}`);
    } catch (err) {
      logToFile(`❌ Lỗi khi gọi createMarketOrder: ${err.message || err}`);
      return false;
    }

    const filledPrice = order?.average || entryPrice;

    const riskAmount = 3;
    const priceChange = riskAmount / (adjustedQuantity * leverage);
    const tpPrice = side === 'long' ? filledPrice + priceChange : filledPrice - priceChange;
    const slPrice = side === 'long' ? filledPrice - priceChange : filledPrice + priceChange;

    const oppositeSide = side.toLowerCase() === 'long' ? 'sell' : 'buy';

    await exchange.createOrder(symbol, 'take_profit_market', oppositeSide, adjustedQuantity, null, {
      stopPrice: tpPrice,
      reduceOnly: true,
      closePosition: true,
      workingType: 'MARK_PRICE'
    });

    await exchange.createOrder(symbol, 'stop_market', oppositeSide, adjustedQuantity, null, {
      stopPrice: slPrice,
      reduceOnly: true,
      closePosition: true,
      workingType: 'MARK_PRICE'
    });


    logToFile(`✅ Đã mở lệnh ${side.toUpperCase()} ${symbol}. TP: ${tpPrice}, SL: ${slPrice}`);

    return true;

  } catch (error) {
    logToFile(`❌ Lỗi khi mở lệnh ${side.toUpperCase()} cho ${symbol}: ${error.message || error}`);
    return false;
  }
}


// Kiểm tra vị thế
async function checkPositions() {
  try {
    const positions = await withRetry(() => exchange.fetchPositionsRisk());
    const openSymbols = new Set();

    for (const pos of positions) {
      const info = pos?.info;
      const symbol = pos?.symbol;

      if (!info || !symbol || typeof info.positionAmt === 'undefined') continue;

      const positionAmt = parseFloat(info.positionAmt);
      if (isNaN(positionAmt) || positionAmt === 0) continue;

      const entryPrice = parseFloat(info.entryPrice);
      if (isNaN(entryPrice)) continue;

      const side = positionAmt > 0 ? 'long' : 'short';
      const amount = Math.abs(positionAmt);

      openSymbols.add(symbol);

      activePositions.set(symbol, {
        side,
        entry: entryPrice,
        amount,
        openedAt: new Date().toISOString(),
      });

      logToFile(`📌 Vị thế ${symbol}: ${positionAmt} hợp đồng, PnL: ${info.unRealizedProfit || 0}`);
    }

    // Kiểm tra lệnh TP/SL
    async function checkOpenOrders(symbol, positionTimestamp) {
      try {
        const orders = await withRetry(() => exchange.fetchOpenOrders(symbol));
        const types = orders.map(o => o.type?.toLowerCase());

        const hasTP = types.includes('take_profit_market') || types.includes('take_profit');
        const hasSL = types.includes('stop_market') || types.includes('stop');

        if (!hasTP || !hasSL) {
          const age = Date.now() - new Date(positionTimestamp).getTime();
          if (age < 10_000) {
            logToFile(`⏳ TP/SL chưa kiểm tra vì lệnh ${symbol} mới mở < 10s`);
            return true;
          }
          logToFile(`⚠️ Lệnh TP/SL cho ${symbol} không tồn tại sau 10s`);
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
        logToFile(`🟥 Vị thế ${symbol} đã đóng. Xóa khỏi activePositions.`);
        activePositions.delete(symbol);
        savePositions();
        continue;
      }

      const market = exchange.market(symbol);
      const ticker = await withRetry(() => exchange.fetchTicker(symbol));
      const currentPrice = ticker.last;

      const entry = position.entry;
      const amount = position.amount;
      const side = position.side;
      const contractSize = market.contractSize || 1;

      const hasOrders = await checkOpenOrders(symbol, position.openedAt);
      if (!hasOrders) {
        logToFile(`⚠️ Đóng vị thế ${symbol} vì thiếu lệnh TP/SL`);
        const opposite = side === 'long' ? 'sell' : 'buy';
        await withRetry(() => exchange.createMarketOrder(symbol, opposite, amount, { reduceOnly: true }));
        activePositions.delete(symbol);
        savePositions();
        continue;
      }

      const feeRate = 0.0004;
      const entryFee = amount * entry * contractSize * feeRate;
      const exitFee = amount * currentPrice * contractSize * feeRate;
      const margin = (amount * entry * contractSize) / leverage;

      const pnl = side === 'long'
        ? (currentPrice - entry) * amount * contractSize - entryFee - exitFee
        : (entry - currentPrice) * amount * contractSize - entryFee - exitFee;

      const roi = (pnl / margin) * 100;

      const isTakeProfit = pnl >= profitTarget;
      const isStopLoss = pnl <= -lossLimit;

      if (isTakeProfit || isStopLoss) {
        const reason = isTakeProfit ? 'Take Profit (thủ công)' : 'Stop Loss (thủ công)';
        const opposite = side === 'long' ? 'sell' : 'buy';

        try {
          await withRetry(() => exchange.cancelAllOrders(symbol));
          logToFile(`🗑️ Đã hủy lệnh TP/SL cho ${symbol}`);

          await withRetry(() =>
            exchange.createMarketOrder(symbol, opposite, amount, { reduceOnly: true })
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
        logToFile(`⚠️ Đạt số lượng vị thế tối đa (${maxPositions}). Chỉ theo dõi vị thế hiện tại.`);
        await sleep(30000);
        continue;
      }

      const symbols = await getTradingPairs();

      for (const symbolRaw of symbols) {
        const symbol = normalizeSymbol(symbolRaw);

        if (symbolBlacklist.has(symbol)) {
          logToFile(`⚠️ Bỏ qua symbol trong danh sách đen: ${symbol}`);
          continue;
        }

        if (symbolLocks.has(symbol)) {
          logToFile(`🔒 ${symbol} đang được xử lý, bỏ qua.`);
          continue;
        }

        if (activePositions.has(symbol)) {
          logToFile(`ℹ️ Đã có vị thế mở trên ${symbol}, bỏ qua.`);
          continue;
        }

        symbolLocks.add(symbol);

        const indicators = await fetchIndicators(symbol);
        if (!indicators) {
          symbolLocks.delete(symbol);
          continue;
        }

        const signal = analyze(indicators);
        if (!signal) {
          logToFile(`ℹ️ Không có tín hiệu rõ ràng trên ${symbol}.`);
          symbolLocks.delete(symbol);
          continue;
        }

        const ticker = await withRetry(() => exchange.fetchTicker(symbol));
        const price = ticker.last;

        const market = exchange.market(symbol);
        const contractSize = market.contractSize || 1;
        let quantity = tradeAmount / price / contractSize;
        quantity = Math.floor(quantity * 1000) / 1000;

        if (quantity <= 0) {
          logToFile(`⚠️ Quantity tính được không hợp lệ cho ${symbol}: ${quantity}`);
          symbolLocks.delete(symbol);
          continue;
        }

        // Kiểm tra lần nữa đề phòng race condition
        if (activePositions.has(symbol)) {
          logToFile(`⚠️ Phát hiện ${symbol} đã có vị thế ngay trước khi mở. Bỏ qua.`);
          symbolLocks.delete(symbol);
          continue;
        }

        const opened = await openPosition(symbol, signal.toLowerCase(), price, quantity, leverage);
        
        if (opened) {
          activePositions.set(symbol, {
            side: parseFloat(pos.info.positionAmt) > 0 ? 'long' : 'short',
            entry: parseFloat(pos.info.entryPrice),
            amount: Math.abs(parseFloat(pos.info.positionAmt)),
            openedAt: new Date().toISOString(),
          });
          savePositions();
          logToFile(`✅ Đã ghi nhận vị thế mới trên ${symbol}`);
          await sleep(2000);
          if (activePositions.size >= maxPositions) break;
        } else {
          logToFile(`❌ Mở lệnh thất bại cho ${symbol}, xóa khỏi khoá.`);
        }

        symbolLocks.delete(symbol);
      }

      await sleep(15000);

    } catch (e) {
      logToFile(`❌ Lỗi ở vòng main: ${e.message}`);
      await sleep(10000);
    }
  }
}


// Kiểm tra API key
if (!process.env.API_KEY || !process.env.API_SECRET) {
  logToFile('❌ Thiếu API_KEY hoặc API_SECRET trong file .env');
  process.exit(1);
}

runBot();
