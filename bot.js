const fs = require('fs');
require('dotenv').config();
const ccxt = require('ccxt');
const { RSI, MACD } = require('technicalindicators');

// Khởi tạo exchange
const exchange = new ccxt.binance({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  enableRateLimit: true,
  adjustForTimeDifference: true,
  options: {
    defaultType: 'future',
  },
});

// Cấu hình bot
let balance = 40;
const maxPositions = 5; // Tối đa 5 lệnh
const tradeAmount = 10; // Mỗi lệnh 10 USDT
const leverage = 7; // Đòn bẩy 7x
const profitTarget = 2.25; // Lợi nhuận mục tiêu 2.25 USDT
const lossLimit = 3; // Cắt lỗ 3 USDT
const rsiPeriod = 14; // Chu kỳ RSI
const timeframe = '1h'; // Khung thời gian 1 giờ
const activePositions = new Map();

// Hàm ghi log
function logToFile(message) {
  const logMessage = `${new Date().toISOString()} - ${message}`;
  console.log(logMessage);
  fs.appendFileSync('bot.log', logMessage + '\n');
}

// Lấy danh sách cặp giao dịch hợp lệ
async function getTradingPairs() {
  try {
    const markets = await exchange.loadMarkets();
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
          logToFile(`Skipping ${symbol}: Not a valid perpetual future`);
        }
        return isValid;
      })
      .map(symbol => symbol.replace(':USDT', '')); // Loại bỏ :USDT
    logToFile(`Loaded ${tradingPairs.length} trading pairs`);
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

    return {
      closes,
      volumes,
      rsi: RSI.calculate({ values: closes, period: rsiPeriod }),
      macd: macdResult,
      volumeAvg: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20, // Trung bình volume 20 cây
    };
  } catch (e) {
    logToFile(`Error fetching data for ${symbol}: ${e.message}`);
    return null;
  }
}

// Phân tích tín hiệu
function analyze({ rsi, macd, volumes, volumeAvg }) {
  let signals = [];

  // RSI Signal
  if (rsi[rsi.length - 1] < 30 && rsi[rsi.length - 2] < 30) {
    signals.push('LONG');
  } else if (rsi[rsi.length - 1] > 70 && rsi[rsi.length - 2] > 70) {
    signals.push('SHORT');
  }

  // MACD Signal
  const macdHist = macd[macd.length - 1]?.histogram;
  if (macdHist > 0 && macd[macd.length - 2]?.histogram <= 0) {
    signals.push('LONG');
  } else if (macdHist < 0 && macd[macd.length - 2]?.histogram >= 0) {
    signals.push('SHORT');
  }

  // Volume Signal
  const currentVolume = volumes[volumes.length - 1];
  if (currentVolume > volumeAvg * 1.5) {
    // Volume tăng đột biến
    if (rsi[rsi.length - 1] < 50) signals.push('LONG');
    else if (rsi[rsi.length - 1] > 50) signals.push('SHORT');
  }

  const longCount = signals.filter(s => s === 'LONG').length;
  const shortCount = signals.filter(s => s === 'SHORT').length;

  if (longCount >= 2) return 'LONG';
  if (shortCount >= 2) return 'SHORT';
  return null;
}

// Mở vị thế
async function openPosition(symbol, side, amount) {
  try {
    await exchange.setLeverage(leverage, symbol);
    await exchange.setMarginMode('isolated', symbol);

    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker.last;

    // Tính TP/SL dựa trên giá
    const tp = side === 'buy'
      ? price * (1 + profitTarget / (tradeAmount * leverage))
      : price * (1 - profitTarget / (tradeAmount * leverage));
    const sl = side === 'buy'
      ? price * (1 - lossLimit / (tradeAmount * leverage))
      : price * (1 + lossLimit / (tradeAmount * leverage));

    // Mở lệnh thị trường
    await exchange.createMarketOrder(symbol, side, amount);

    // Đặt TP/SL
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
    balance -= tradeAmount;
    logToFile(`💰 Updated balance: ${balance} USDT`);
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
        balance += tradeAmount; // Cập nhật lại balance khi đóng lệnh
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
      // Cập nhật số dư
      const balanceInfo = await exchange.fetchBalance();
      const usdtBalance = balanceInfo.total.USDT || 0;
      logToFile(`💰 Current balance: ${usdtBalance} USDT`);
      balance = usdtBalance;

      // Kiểm tra điều kiện vốn
      if (balance < tradeAmount && activePositions.size < maxPositions) {
        logToFile(`❌ Insufficient balance: ${balance} USDT, need at least ${tradeAmount} USDT`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      // Kiểm tra vị thế hiện tại
      await checkPositions();
      if (activePositions.size >= maxPositions) {
        logToFile(`⚠️ Max positions reached (${maxPositions}), waiting for positions to close`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      // Lấy danh sách cặp giao dịch
      const tradingPairs = await getTradingPairs();
      if (tradingPairs.length === 0) {
        logToFile('❌ No trading pairs available');
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      // Duyệt qua các cặp giao dịch
      for (const symbol of tradingPairs) {
        if (activePositions.size >= maxPositions) {
          logToFile(`⚠️ Max positions reached (${maxPositions})`);
          break;
        }
        if (balance < tradeAmount) {
          logToFile(`⚠️ Insufficient balance: ${balance} USDT`);
          break;
        }
        if (activePositions.has(symbol)) {
          logToFile(`⚠️ Already trading on ${symbol}`);
          continue;
        }

        // Lấy và phân tích chỉ báo
        const indicators = await fetchIndicators(symbol);
        if (!indicators) continue;

        const signal = analyze(indicators);
        if (!signal) {
          logToFile(`📊 No clear signal for ${symbol}`);
          continue;
        }

        // Tính số lượng dựa trên tradeAmount
        const price = indicators.closes[indicators.closes.length - 1];
        const amount = tradeAmount / price;

        // Mở vị thế
        const side = signal === 'LONG' ? 'buy' : 'sell';
        const success = await openPosition(symbol, side, amount);
        if (!success) {
          logToFile(`❌ Failed to open position on ${symbol}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); // Tránh bị giới hạn API
      }
    } catch (e) {
      logToFile(`Error in bot loop: ${e.message}`);
    }
    logToFile('Finished one loop cycle');
    await new Promise(resolve => setTimeout(resolve, 60000)); // Nghỉ 1 phút mỗi chu kỳ
  }
}

// Chạy bot
logToFile('Starting trading bot...');
runBot();