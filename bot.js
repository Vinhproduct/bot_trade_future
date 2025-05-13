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
const maxPositions = 5;
const tradeAmount = 10; // Each trade is exactly $10
const leverage = 7;
const profitTarget = 2;
const lossLimit = 3;
const rsiPeriod = 14;
const smaPeriod = 50;
const emaPeriod = 20;
const timeframe = '15m';
const activePositions = new Map();
const targetBalance = 1000; // Mục tiêu vốn $1000

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

// Lấy danh sách cặp giao dịch
async function getTradingPairs() {
  try {
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets).filter(symbol => {
      const market = markets[symbol];
      return (
        market &&
        market.active &&
        market.type === 'swap' &&
        market.info.contractType === 'PERPETUAL' &&
        symbol.includes('USDT') &&
        symbol.endsWith(':USDT')
      );
    });

    const volumes = [];

    for (const symbol of symbols) {
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 50);
        if (!ohlcv || ohlcv.length < 50) continue; // Bỏ coin mới list

        const ticker = await exchange.fetchTicker(symbol);
        volumes.push({ symbol, volume: ticker.quoteVolume || 0 });
        await sleep(100);
      } catch {
        continue;
      }
    }

    const sorted = volumes.sort((a, b) => b.volume - a.volume);
    const tradingPairs = sorted.slice(0, 20).map(v => v.symbol);
    logToFile(`✅ Loaded ${tradingPairs.length} stable USDT pairs with 50 candles+`);
    return tradingPairs;
  } catch (e) {
    logToFile(`❌ Error loading trading pairs: ${e.message}`);
    return [];
  }
}

// Lấy dữ liệu và tính chỉ báo
async function fetchIndicators(symbol) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
    if (!ohlcv || ohlcv.length < 50) return null;

    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);

    return {
      closes,
      volumes,
      rsi: RSI.calculate({ values: closes, period: rsiPeriod }),
      macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }),
      sma: SMA.calculate({ values: closes, period: smaPeriod }),
      ema: EMA.calculate({ values: closes, period: emaPeriod }),
      volumeAvg: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20,
    };
  } catch (e) {
    logToFile(`❌ Error fetching indicators for ${symbol}: ${e.message}`);
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

  // ----- 1. Kiểm tra nhiễu: Doji hoặc volume yếu -----
  const isDoji = Math.abs(latestClose - previousClose) < (latestClose * 0.001); // nến phân vân
  const isLowVolume = currentVolume < volumeAvg * 0.5;
  if (isDoji || isLowVolume) return null;

  // ----- 2. Ưu tiên nến mạnh -----
  const high = Math.max(previousClose, latestClose);
  const low = Math.min(previousClose, latestClose);
  const candleBody = Math.abs(latestClose - previousClose);
  const candleRange = high - low;
  const isStrongCandle = candleBody > candleRange * 0.7;
  if (!isStrongCandle) return null;

  // ----- 3. Chấm điểm tín hiệu -----
  let longScore = 0;
  let shortScore = 0;

  // MACD histogram crossover
  if (latestMACDHist > 0 && previousMACDHist <= 0) longScore += 1.5;
  if (latestMACDHist < 0 && previousMACDHist >= 0) shortScore += 1.5;

  // Volume breakout
  if (currentVolume > volumeAvg * 2) {
    if (latestRSI < 50) longScore += 1.5;
    else shortScore += 1.5;
  }

  // RSI vùng quá bán / quá mua
  if (latestRSI < 30 && previousRSI < 30) longScore += 1;
  if (latestRSI > 70 && previousRSI > 70) shortScore += 1;

  // SMA/EMA
  if (latestClose > latestSMA) longScore += 0.5;
  else shortScore += 0.5;

  if (latestClose > latestEMA) longScore += 0.5;
  else shortScore += 0.5;

  // ----- 4. Kết luận -----
  if (longScore >= 3) return 'LONG';
  if (shortScore >= 3) return 'SHORT';
  return null;
}


// Mở vị thế
async function openPosition(symbol, side, amount) {
  try {
    await exchange.setLeverage(leverage, symbol);
    await sleep(300);
    await exchange.setMarginMode('isolated', symbol);
    await sleep(300);

    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker.last;

    const pricePrecision = market.precision?.price || 4;
    const tickSize = market.info?.priceIncrement ? parseFloat(market.info.priceIncrement) : 0.01;

    // Tính giá TP và SL theo tỷ lệ phần trăm
    let tpPrice, slPrice;

    const tpPercent = profitTarget / (tradeAmount * leverage);
    const slPercent = lossLimit / (tradeAmount * leverage);

    if (side === 'buy') {
      tpPrice = price * (1 + tpPercent);
      slPrice = price * (1 - slPercent);
    } else {
      tpPrice = price * (1 - tpPercent);
      slPrice = price * (1 + slPercent);
    }

    // Làm tròn giá TP/SL theo tickSize
    tpPrice = parseFloat((Math.round(tpPrice / tickSize) * tickSize).toFixed(pricePrecision));
    slPrice = parseFloat((Math.round(slPrice / tickSize) * tickSize).toFixed(pricePrecision));

    // Đặt lệnh market vào lệnh với kích thước $10
    //await exchange.createMarketOrder(symbol, side, amount); 
    const qty = parseFloat((tradeAmount * leverage / price).toFixed(market.precision.amount));// amount = tradeAmount = 10
    await exchange.createMarketOrder(symbol, side, qty);

    await sleep(300);

    const opposite = side === 'buy' ? 'sell' : 'buy';

    // TP
    await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', opposite, amount, undefined, {
      stopPrice: tpPrice,
      triggerPrice: tpPrice,
      workingType: 'CONTRACT_PRICE',
      closePosition: true,
      reduceOnly: true,
    });

    await sleep(300);

    // SL
    await exchange.createOrder(symbol, 'STOP_MARKET', opposite, amount, undefined, {
      stopPrice: slPrice,
      triggerPrice: slPrice,
      workingType: 'CONTRACT_PRICE',
      closePosition: true,
      reduceOnly: true,
    });


    activePositions.set(symbol, { side, amount, entry: price, tp: tpPrice, sl: slPrice });
    logToFile(`🟢 Opened ${side.toUpperCase()} on ${symbol} at ${price.toFixed(pricePrecision)} (TP: ${tpPrice}, SL: ${slPrice})`);
    return true;
  } catch (e) {
    logToFile(`❌ Error opening position on ${symbol}: ${e.message}`);
    return false;
  }
}

// Kiểm tra vị thế
async function checkPositions() {
  try {
    const positions = await exchange.fetchPositionsRisk();
    const openSymbols = new Set();

    for (const pos of positions) {
      if (pos.info && parseFloat(pos.info.positionAmt) !== 0) {
        openSymbols.add(pos.symbol);
        if (!activePositions.has(pos.symbol)) {
          activePositions.set(pos.symbol, {
            side: parseFloat(pos.info.positionAmt) > 0 ? 'buy' : 'sell',
            amount: Math.abs(parseFloat(pos.info.positionAmt)),
            entry: parseFloat(pos.info.entryPrice),
            tp: null,
            sl: null,
          });
        }
        logToFile(`📌 Active ${pos.symbol}: ${pos.info.positionAmt} contracts, PnL: ${pos.info.unRealizedProfit}`);
      }
    }

    // Kiểm tra các vị thế đã đóng (do TP hoặc SL)
    // Kiểm tra các vị thế đang mở để xem có chạm TP hoặc SL thủ công không
    for (const [symbol, position] of activePositions.entries()) {
      if (!openSymbols.has(symbol)) {
        logToFile(`🟥 Position on ${symbol} closed externally (maybe TP/SL hit).`);
        activePositions.delete(symbol);
        continue;
      }

      const ticker = await exchange.fetchTicker(symbol);
      const currentPrice = ticker.last;
      const side = position.side;
      const entry = position.entry;
      const pnl = side === 'buy'
        ? (currentPrice - entry) * leverage
        : (entry - currentPrice) * leverage;

      const roi = (pnl / tradeAmount) * 100;
      const isTakeProfit = pnl >= profitTarget;
      const isStopLoss = pnl <= -lossLimit;

      if (isTakeProfit || isStopLoss) {
        const reason = isTakeProfit ? 'Take Profit (manual)' : 'Stop Loss (manual)';
        const opposite = side === 'buy' ? 'sell' : 'buy';

        try {
          await exchange.createMarketOrder(symbol, opposite, position.amount, {
            reduceOnly: true,
          });
          logToFile(`🛑 Manually closed ${symbol} for ${reason} at ${currentPrice} (ROI: ${roi.toFixed(2)}%)`);
          activePositions.delete(symbol);
          await sleep(500);
        } catch (e) {
          logToFile(`❌ Error manually closing ${symbol}: ${e.message}`);
        }
      } else {
        logToFile(`📊 ${symbol} ROI: ${roi.toFixed(2)}% - Still holding.`);
      }
    }

  } catch (e) {
    logToFile(`❌ Error checking positions: ${e.message}`);
  }
}

// Vòng lặp chính
async function runBot() {
  logToFile('🚀 Starting trading bot...');
  while (true) {
    try {
      const balanceInfo = await exchange.fetchBalance();
      const balance = balanceInfo.total.USDT || 0;
      logToFile(`💰 Balance: ${balance} USDT`);

      await checkPositions();

      // Kiểm tra nếu đạt mục tiêu vốn $1000
      if (balance >= targetBalance) {
        logToFile(`🎯 Target balance of ${targetBalance} USDT reached! Monitoring open positions only.`);
        if (activePositions.size === 0) {
          logToFile(`✅ No open positions left. Stopping bot.`);
          break; // Thoát vòng lặp nếu không còn vị thế mở
        }
        await sleep(60000);
        continue; // Tiếp tục kiểm tra các vị thế mở
      }

      if (activePositions.size >= maxPositions) {
        logToFile(`⚠️ Max positions reached (${maxPositions}), waiting...`);
        await sleep(60000);
        continue;
      }

      if (balance < tradeAmount) {
        logToFile(`❌ Not enough balance to trade.`);
        await sleep(60000);
        continue;
      }

      const tradingPairs = await getTradingPairs();
      if (tradingPairs.length === 0) {
        await sleep(60000);
        continue;
      }

      const candidates = [];

      for (const symbol of tradingPairs) {
        if (activePositions.size >= maxPositions) break;
        if (activePositions.has(symbol)) continue;

        const indicators = await fetchIndicators(symbol);
        if (!indicators) continue;

        const signal = analyze(indicators);
        if (signal) {
          candidates.push({ symbol, signal, volume: indicators.volumes.at(-1) });
        }

        await sleep(1000);
      }

      candidates.sort((a, b) => b.volume - a.volume);
      for (const candidate of candidates) {
        if (activePositions.size >= maxPositions) break;

        const side = candidate.signal === 'LONG' ? 'buy' : 'sell';

        const success = await openPosition(candidate.symbol, side, tradeAmount);
        if (success && activePositions.size >= maxPositions) break;

        await sleep(500);
      }
    } catch (e) {
      logToFile(`❌ Error in bot: ${e.message}`);
    }

    await sleep(60000);
  }
}

runBot();
