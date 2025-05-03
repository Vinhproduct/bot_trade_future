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
const tradeAmount = 10;
const leverage = 7;
const profitTarget = 2;
const lossLimit = 3;
const rsiPeriod = 14;
const smaPeriod = 50;
const emaPeriod = 20;
const timeframe = '15m'; // Đã chuyển sang khung M15
const activePositions = new Map();

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
    const tradingPairs = Object.keys(markets)
      .filter(symbol => {
        const market = markets[symbol];
        return (
          market &&
          market.active &&
          market.type === 'swap' &&
          market.info.contractType === 'PERPETUAL' &&
          symbol.includes('USDT') &&
          symbol.endsWith(':USDT')
        );
      })
      .map(symbol => symbol);
    logToFile(`✅ Loaded ${tradingPairs.length} USDT perpetual futures pairs.`);
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
  const latestRSI = rsi.at(-1);
  const previousRSI = rsi.at(-2);
  const latestMACDHist = macd.at(-1)?.histogram;
  const previousMACDHist = macd.at(-2)?.histogram;
  const latestSMA = sma.at(-1);
  const latestEMA = ema.at(-1);
  const currentVolume = volumes.at(-1);

  const longSignals = [];
  const shortSignals = [];

  // RSI
  if (latestRSI < 30 && previousRSI < 30) longSignals.push('RSI');
  if (latestRSI > 70 && previousRSI > 70) shortSignals.push('RSI');

  // MACD histogram
  if (latestMACDHist > 0 && previousMACDHist <= 0) longSignals.push('MACD');
  if (latestMACDHist < 0 && previousMACDHist >= 0) shortSignals.push('MACD');

  // Volume breakout
  if (currentVolume > volumeAvg * 2) {
    if (latestRSI < 50) longSignals.push('Volume');
    else shortSignals.push('Volume');
  }

  // SMA/EMA crossover
  if (latestClose > latestSMA) longSignals.push('SMA');
  else shortSignals.push('SMA');
  if (latestClose > latestEMA) longSignals.push('EMA');
  else shortSignals.push('EMA');

  // Đếm và quyết định
  if (longSignals.length >= 3) return 'LONG';
  if (shortSignals.length >= 3) return 'SHORT';
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

    // Đặt lệnh market vào lệnh
    await exchange.createMarketOrder(symbol, side, amount);
    await sleep(300);

    const opposite = side === 'buy' ? 'sell' : 'buy';

    // TP
    await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', opposite, amount, undefined, {
      stopPrice: tpPrice,
      closePosition: true,
      reduceOnly: true,
    });
    await sleep(300);

    // SL
    await exchange.createOrder(symbol, 'STOP_MARKET', opposite, amount, undefined, {
      stopPrice: slPrice,
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

    for (const symbol of [...activePositions.keys()]) {
      if (!openSymbols.has(symbol)) {
        logToFile(`🟥 Position closed: ${symbol}`);
        activePositions.delete(symbol);
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
      
        await sleep(1000); // giảm nhẹ thời gian sleep để xử lý nhanh hơn
      }
      candidates.sort((a, b) => b.volume - a.volume);
      for (const candidate of candidates) {
        if (activePositions.size >= maxPositions) break;
      
        const side = candidate.signal === 'LONG' ? 'buy' : 'sell';
        await openPosition(candidate.symbol, side, tradeAmount);
        await sleep(500); // ngủ nhẹ để tránh rate limit
      }     
    }
    catch (e) {
      logToFile(`❌ Error in bot: ${e.message}`);
    }

    await sleep(60000); // Thời gian giữa các vòng lặp
  }
}

runBot();
