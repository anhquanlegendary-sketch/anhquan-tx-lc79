const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const PATTERN_FILE = 'patterns_new.json';
const HISTORY_FILE = 'history_new.json';

// Cấu trúc dữ liệu - BẮT ĐẦU TRỐNG KHI CHẠY
let dataStore = {
  hu: {
    patterns: [],           // Pattern đã thu thập
    predictions: [],        // Lịch sử dự đoán
    lastPhien: null,        // Phiên cuối
    patternHistory: [],     // 10 pattern gần nhất (T/X)
    allPatterns: [],        // Tất cả pattern đã thu
    isCollecting: true,     // Đang thu thập
    collectedCount: 0,      // Số pattern đã thu
    startTime: null         // Thời gian bắt đầu
  },
  md5: {
    patterns: [],
    predictions: [],
    lastPhien: null,
    patternHistory: [],
    allPatterns: [],
    isCollecting: true,
    collectedCount: 0,
    startTime: null
  }
};

const MIN_PATTERNS = 10;  // Cần 10 pattern để dự đoán
const MAX_HISTORY = 1000;

// === LOAD/SAVE - CHỈ LƯU, KHÔNG LOAD PATTERN CŨ ===
function loadData() {
  try {
    // KHÔNG LOAD PATTERN CŨ - BẮT ĐẦU TỪ ĐẦU
    console.log('🔄 Bắt đầu thu thập pattern mới từ đầu');
    // Chỉ tạo file mới nếu chưa có
    if (!fs.existsSync(PATTERN_FILE)) {
      saveData();
    }
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(PATTERN_FILE, JSON.stringify(dataStore, null, 2));
    console.log('💾 Đã lưu dữ liệu');
  } catch (error) {
    console.error('❌ Lỗi save:', error.message);
  }
}

// === FETCH API ===
function transformApiData(apiData) {
  if (!apiData || !apiData.list || !Array.isArray(apiData.list)) return null;
  return apiData.list.map(item => ({
    Phien: item.id,
    Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
    Xuc_xac_1: item.dices[0],
    Xuc_xac_2: item.dices[1],
    Xuc_xac_3: item.dices[2],
    Tong: item.point
  }));
}

async function fetchDataHu() {
  try {
    const response = await axios.get(API_URL_HU, { timeout: 10000 });
    return transformApiData(response.data);
  } catch (error) {
    console.error('❌ Lỗi fetch HU:', error.message);
    return null;
  }
}

async function fetchDataMd5() {
  try {
    const response = await axios.get(API_URL_MD5, { timeout: 10000 });
    return transformApiData(response.data);
  } catch (error) {
    console.error('❌ Lỗi fetch MD5:', error.message);
    return null;
  }
}

// ================================================================
// PHÂN TÍCH PATTERN - 20+ LOẠI CẦU
// ================================================================
function analyzeAllPatterns(results) {
  if (results.length < 3) return [];
  
  const patterns = [];
  const recent = results.slice(0, 30);
  
  // 1. Cầu Bệt (1-10 phiên)
  for (let len = 2; len <= 10; len++) {
    if (results.length >= len) {
      let isStreak = true;
      for (let i = 0; i < len - 1; i++) {
        if (results[i] !== results[i+1]) { isStreak = false; break; }
      }
      if (isStreak) {
        patterns.push({
          type: `Cầu Bệt ${len} Phiên`,
          length: len,
          prediction: len >= 5 ? (results[0] === 'Tài' ? 'Xỉu' : 'Tài') : results[0],
          confidence: Math.min(95, 60 + len * 4)
        });
      }
    }
  }

  // 2. Cầu Đảo 1-1
  for (let len = 2; len <= 10; len++) {
    if (results.length >= len) {
      let isAlternating = true;
      for (let i = 0; i < len - 1; i++) {
        if (results[i] === results[i+1]) { isAlternating = false; break; }
      }
      if (isAlternating) {
        patterns.push({
          type: `Cầu Đảo 1-1 ${len} Phiên`,
          length: len,
          prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
          confidence: Math.min(90, 65 + len * 2)
        });
      }
    }
  }

  // 3. Cầu 2-2
  for (let pairs = 2; pairs <= 5; pairs++) {
    if (results.length >= pairs * 2) {
      let isValid = true;
      let pairPattern = [];
      for (let i = 0; i < pairs; i++) {
        const idx = i * 2;
        if (results[idx] !== results[idx+1]) { isValid = false; break; }
        pairPattern.push(results[idx]);
      }
      if (isValid) {
        let isAlternating = true;
        for (let i = 1; i < pairPattern.length; i++) {
          if (pairPattern[i] === pairPattern[i-1]) { isAlternating = false; break; }
        }
        if (isAlternating) {
          patterns.push({
            type: `Cầu 2-2 ${pairs} Cặp`,
            length: pairs * 2,
            prediction: pairPattern[pairs-1] === 'Tài' ? 'Xỉu' : 'Tài',
            confidence: Math.min(88, 65 + pairs * 3)
          });
        }
      }
    }
  }

  // 4. Cầu 3-3
  for (let triples = 1; triples <= 3; triples++) {
    if (results.length >= triples * 3) {
      let isValid = true;
      let triplePattern = [];
      for (let i = 0; i < triples; i++) {
        const idx = i * 3;
        if (results[idx] !== results[idx+1] || results[idx+1] !== results[idx+2]) {
          isValid = false;
          break;
        }
        triplePattern.push(results[idx]);
      }
      if (isValid) {
        const position = results.length % 3;
        patterns.push({
          type: `Cầu 3-3 ${triples} Bộ Ba`,
          length: triples * 3,
          prediction: position === 0 ? (triplePattern[triples-1] === 'Tài' ? 'Xỉu' : 'Tài') : triplePattern[triples-1],
          confidence: Math.min(90, 68 + triples * 5)
        });
      }
    }
  }

  // 5. Cầu 1-2-1
  if (results.length >= 4) {
    const p = results.slice(0, 4);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] !== p[3] && p[0] === p[3]) {
      patterns.push({
        type: 'Cầu 1-2-1',
        length: 4,
        prediction: p[0],
        confidence: 75
      });
    }
  }

  // 6. Cầu Nhảy Cóc
  for (let step = 2; step <= 5; step++) {
    if (results.length >= step * 3) {
      const skipPattern = [];
      for (let i = 0; i < Math.min(results.length, step * 3); i += step) {
        skipPattern.push(results[i]);
      }
      if (skipPattern.length >= 3) {
        const allSame = skipPattern.every(r => r === skipPattern[0]);
        if (allSame) {
          patterns.push({
            type: `Cầu Nhảy Cóc Bước ${step}`,
            length: skipPattern.length,
            prediction: skipPattern[0],
            confidence: 70
          });
        }
        let isAlternating = true;
        for (let i = 1; i < skipPattern.length; i++) {
          if (skipPattern[i] === skipPattern[i-1]) { isAlternating = false; break; }
        }
        if (isAlternating && skipPattern.length >= 3) {
          patterns.push({
            type: `Cầu Nhảy Cóc Đảo Bước ${step}`,
            length: skipPattern.length,
            prediction: skipPattern[0] === 'Tài' ? 'Xỉu' : 'Tài',
            confidence: 68
          });
        }
      }
    }
  }

  // 7. Xu Hướng Mạnh
  for (let len = 5; len <= 10; len++) {
    if (results.length >= len) {
      const subset = results.slice(0, len);
      const taiCount = subset.filter(r => r === 'Tài').length;
      const ratio = taiCount / len;
      if (ratio >= 0.7) {
        patterns.push({
          type: `Xu Hướng Tài ${len} Phiên (${taiCount}/${len})`,
          length: len,
          prediction: 'Xỉu',
          confidence: Math.min(90, 70 + (ratio - 0.5) * 40)
        });
      } else if (ratio <= 0.3) {
        patterns.push({
          type: `Xu Hướng Xỉu ${len} Phiên (${len - taiCount}/${len})`,
          length: len,
          prediction: 'Tài',
          confidence: Math.min(90, 70 + (0.5 - ratio) * 40)
        });
      }
    }
  }

  // 8. Cầu Đảo Chiều Đột Ngột
  if (results.length >= 4) {
    const p = results.slice(0, 4);
    if (p[0] === p[1] && p[1] === p[2] && p[2] !== p[3]) {
      patterns.push({
        type: 'Cầu Đảo Chiều Đột Ngột',
        length: 4,
        prediction: p[3] === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: 78
      });
    }
  }

  // 9. Pattern 10 Phiên
  if (results.length >= 10) {
    const last10 = results.slice(0, 10);
    const pattern = last10.map(r => r === 'Tài' ? 'T' : 'X').join('');
    
    const commonPatterns = {
      'TTXXTTXXTT': { pred: 'Xỉu', conf: 85 },
      'XXTTXXTTXX': { pred: 'Tài', conf: 85 },
      'TXTXTXTXTX': { pred: 'Xỉu', conf: 82 },
      'XTXTXTXTXT': { pred: 'Tài', conf: 82 },
      'TTTTXXXXXX': { pred: 'Tài', conf: 80 },
      'XXXXXXTTTT': { pred: 'Xỉu', conf: 80 },
      'TTTTTTTTTT': { pred: 'Xỉu', conf: 90 },
      'XXXXXXXXXX': { pred: 'Tài', conf: 90 }
    };
    
    if (commonPatterns[pattern]) {
      patterns.push({
        type: `Pattern 10 Phiên: ${pattern}`,
        length: 10,
        prediction: commonPatterns[pattern].pred,
        confidence: commonPatterns[pattern].conf
      });
    }
  }

  // 10. Cầu Gãy
  if (results.length >= 3) {
    let streakType = results[0];
    let streakLen = 1;
    for (let i = 1; i < results.length; i++) {
      if (results[i] === streakType) streakLen++;
      else break;
    }
    if (streakLen >= 3 && results.length > streakLen) {
      const nextResult = results[streakLen];
      patterns.push({
        type: `Cầu Gãy Sau ${streakLen} ${streakType}`,
        length: streakLen + 1,
        prediction: nextResult === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: 72
      });
    }
  }

  return patterns;
}

// ================================================================
// 5.000 THUẬT TOÁN PHÂN TÍCH PATTERN
// ================================================================
function generatePatternAlgorithms(results) {
  if (!results || results.length < 3) return null;

  const algorithms = [];
  const total = 5000;
  const chars = results.map(r => r === 'Tài' ? 'T' : 'X');
  const totalLen = chars.length;

  // Precompute các chỉ số
  const tai = chars.filter(c => c === 'T').length;
  const xiu = chars.filter(c => c === 'X').length;
  const taiRatio = tai / totalLen;
  const xiuRatio = xiu / totalLen;

  // Markov bậc 1
  const markov1 = {};
  for (let i = 0; i < chars.length - 1; i++) {
    const key = chars[i];
    const next = chars[i + 1];
    if (!markov1[key]) markov1[key] = { T: 0, X: 0 };
    markov1[key][next]++;
  }

  // Markov bậc 2
  const markov2 = {};
  for (let i = 0; i < chars.length - 2; i++) {
    const key = chars[i] + chars[i + 1];
    const next = chars[i + 2];
    if (!markov2[key]) markov2[key] = { T: 0, X: 0 };
    markov2[key][next]++;
  }

  // Streak analysis
  let maxStreak = 1;
  let currentStreak = 1;
  let streaks = [];
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === chars[i - 1]) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      streaks.push({ type: chars[i - 1], length: currentStreak });
      currentStreak = 1;
    }
  }
  streaks.push({ type: chars[chars.length - 1], length: currentStreak });

  // Alternating count
  let altCount = 0;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] !== chars[i - 1]) altCount++;
  }
  const altRatio = altCount / (chars.length - 1);

  const lastChar = chars[chars.length - 1];
  const lastTwo = chars.length >= 2 ? chars[chars.length - 2] + chars[chars.length - 1] : '';
  const lastThree = chars.length >= 3 ? chars[chars.length - 3] + chars[chars.length - 2] + chars[chars.length - 1] : '';

  // 10 pattern gần nhất
  const pattern10 = chars.slice(0, Math.min(10, chars.length)).join('');

  // Tạo 5000 thuật toán khác nhau
  for (let i = 0; i < total; i++) {
    const seed = i * 137 + 53;
    const seed2 = (i * 89 + 17) % 1000;
    const seed3 = (i * 223 + 31) % 1000;
    const seed4 = (i * 317 + 11) % 1000;
    const seed5 = (i * 431 + 29) % 1000;

    // Các tham số biến đổi
    const threshold1 = 0.25 + ((seed % 75) / 100);
    const threshold2 = 0.25 + ((seed2 % 75) / 100);
    const threshold3 = 0.25 + ((seed3 % 75) / 100);
    const threshold4 = 0.25 + ((seed4 % 75) / 100);
    const threshold5 = 0.25 + ((seed5 % 75) / 100);

    const weight1 = 0.3 + ((seed % 70) / 100);
    const weight2 = 0.3 + ((seed2 % 70) / 100);
    const weight3 = 0.3 + ((seed3 % 70) / 100);
    const weight4 = 0.3 + ((seed4 % 70) / 100);
    const weight5 = 0.3 + ((seed5 % 70) / 100);

    const windowSize = 2 + (seed % 8);
    const streakThreshold = 2 + (seed2 % 6);
    const altThreshold = 0.4 + ((seed3 % 60) / 100);

    let taiScore = 0;
    let xiuScore = 0;

    // 20 thuật toán khác nhau
    if (taiRatio > threshold1) taiScore += 30 * weight1;
    else xiuScore += 30 * weight1;

    const recent = chars.slice(0, windowSize);
    const recentTai = recent.filter(c => c === 'T').length;
    const recentXiu = recent.filter(c => c === 'X').length;
    if (recentTai > recentXiu) taiScore += 25 * weight2;
    else xiuScore += 25 * weight2;

    if (markov1[lastChar]) {
      const m = markov1[lastChar];
      if (m.T > m.X + (seed % 3)) taiScore += 22 * weight3;
      else if (m.X > m.T + (seed % 3)) xiuScore += 22 * weight3;
    }

    if (lastTwo && markov2[lastTwo]) {
      const m = markov2[lastTwo];
      if (m.T > m.X + (seed2 % 3)) taiScore += 20 * weight4;
      else if (m.X > m.T + (seed2 % 3)) xiuScore += 20 * weight4;
    }

    if (maxStreak > streakThreshold) {
      if (lastChar === 'T') taiScore += 18 * weight5;
      else xiuScore += 18 * weight5;
    } else {
      if (lastChar === 'T') xiuScore += 12 * weight5;
      else taiScore += 12 * weight5;
    }

    if (altRatio > altThreshold) {
      if (lastChar === 'T') taiScore += 16 * weight1;
      else xiuScore += 16 * weight1;
    } else {
      if (lastChar === 'T') xiuScore += 16 * weight1;
      else taiScore += 16 * weight1;
    }

    const goldRatio = 0.618;
    if (Math.abs(taiRatio - goldRatio) < 0.08 + (seed2 % 10) / 100) {
      taiScore += 15 * weight2;
    } else {
      xiuScore += 15 * weight2;
    }

    let momentum = 0;
    for (let j = chars.length - 2; j >= Math.max(0, chars.length - 6); j--) {
      if (chars[j] === chars[j + 1]) momentum++;
      else momentum--;
    }
    if (momentum > 0 + (seed3 % 4)) {
      if (lastChar === 'T') taiScore += 14 * weight3;
      else xiuScore += 14 * weight3;
    } else {
      if (lastChar === 'T') xiuScore += 14 * weight3;
      else taiScore += 14 * weight3;
    }

    if (lastThree.length >= 3) {
      const pattern3 = lastThree;
      if (pattern3 === 'TTT' || pattern3 === 'XXX') {
        if (lastChar === 'T') taiScore += 12 * weight4;
        else xiuScore += 12 * weight4;
      } else if (pattern3 === 'TXT' || pattern3 === 'XTX') {
        if (lastChar === 'T') xiuScore += 12 * weight4;
        else taiScore += 12 * weight4;
      }
    }

    if (pattern10.length >= 10) {
      const commonPatterns = {
        'TTXXTTXXTT': 'X',
        'XXTTXXTTXX': 'T',
        'TXTXTXTXTX': 'X',
        'XTXTXTXTXT': 'T',
        'TTTTXXXXXX': 'T',
        'XXXXXXTTTT': 'X',
        'TTTTTTTTTT': 'X',
        'XXXXXXXXXX': 'T'
      };
      const pred = commonPatterns[pattern10];
      if (pred) {
        if (pred === 'T') taiScore += 10 * weight5;
        else xiuScore += 10 * weight5;
      }
    }

    if (streaks.length > 0) {
      const lastStreak = streaks[streaks.length - 1];
      if (lastStreak.length >= 3) {
        if (lastStreak.type === 'T') taiScore += 10 * weight1;
        else xiuScore += 10 * weight1;
      }
    }

    // Kết luận thuật toán
    const totalScore = taiScore + xiuScore;
    let prediction;
    if (taiScore > xiuScore) prediction = 'Tài';
    else if (xiuScore > taiScore) prediction = 'Xỉu';
    else prediction = (seed % 2 === 0) ? 'Tài' : 'Xỉu';

    const confidence = Math.min(96, Math.round((Math.max(taiScore, xiuScore) / totalScore) * 100) + 5);

    algorithms.push({
      id: i + 1,
      prediction: prediction,
      confidence: confidence,
      taiScore: Math.round(taiScore),
      xiuScore: Math.round(xiuScore),
      diff: Math.abs(taiScore - xiuScore),
      totalScore: Math.round(totalScore)
    });
  }

  return algorithms;
}

// ================================================================
// TỔNG HỢP KẾT QUẢ TỪ 5000 THUẬT TOÁN
// ================================================================
function aggregateAlgorithmResults(algorithms) {
  if (!algorithms || algorithms.length === 0) return null;

  const totalAlgos = algorithms.length;

  let taiWeighted = 0;
  let xiuWeighted = 0;
  let sumConfidence = 0;
  let sumDiff = 0;

  for (const a of algorithms) {
    if (a.prediction === 'Tài') {
      taiWeighted += a.confidence;
    } else {
      xiuWeighted += a.confidence;
    }
    sumConfidence += a.confidence;
    sumDiff += a.diff;
  }

  const totalWeighted = taiWeighted + xiuWeighted;

  let prediction;
  let confidence;
  let taiPercent = 0;
  let xiuPercent = 0;

  if (totalWeighted > 0) {
    taiPercent = (taiWeighted / totalWeighted) * 100;
    xiuPercent = (xiuWeighted / totalWeighted) * 100;

    if (taiPercent > 50) {
      prediction = 'Tài';
      confidence = Math.min(98, Math.round(taiPercent));
    } else if (xiuPercent > 50) {
      prediction = 'Xỉu';
      confidence = Math.min(98, Math.round(xiuPercent));
    } else {
      prediction = 'Cân bằng';
      confidence = 50;
    }
  } else {
    prediction = 'Cân bằng';
    confidence = 50;
  }

  if (isNaN(confidence)) confidence = 50;

  const bestAlgo = algorithms.reduce((a, b) => a.confidence > b.confidence ? a : b);

  const mean = sumConfidence / totalAlgos;
  let variance = 0;
  for (const a of algorithms) {
    variance += Math.pow(a.confidence - mean, 2);
  }
  const stdDev = Math.sqrt(variance / totalAlgos);

  const topAlgos = algorithms
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  return {
    prediction,
    confidence,
    taiWeighted: Math.round(taiWeighted),
    xiuWeighted: Math.round(xiuWeighted),
    taiPercent: Math.round(taiPercent),
    xiuPercent: Math.round(xiuPercent),
    totalAlgos,
    avgConfidence: Math.round(mean),
    stdDev: Math.round(stdDev),
    avgDiff: Math.round(sumDiff / totalAlgos),
    bestAlgo: bestAlgo,
    topAlgos: topAlgos,
    allAlgos: algorithms
  };
}

// ================================================================
// DỰ ĐOÁN CHÍNH - CHỈ DÙNG PATTERN MỚI THU
// ================================================================
function predictWithAlgorithms(data, type) {
  if (!data || data.length === 0) {
    return { canPredict: false, message: 'Không có dữ liệu' };
  }

  const results = data.map(d => d.Ket_qua);
  const lastPhien = data[0]?.Phien || 0;
  const phienHienTai = lastPhien + 1;

  // Phân tích pattern từ dữ liệu mới
  const detectedPatterns = analyzeAllPatterns(results);
  
  // Lưu pattern mới vào collection
  if (detectedPatterns.length > 0) {
    dataStore[type].allPatterns.push({
      phien: lastPhien,
      timestamp: new Date().toISOString(),
      patterns: detectedPatterns,
      results: results.slice(0, 10)
    });
    
    // Cập nhật số lượng pattern đã thu
    dataStore[type].collectedCount = dataStore[type].allPatterns.length;
    
    // Giới hạn lịch sử
    if (dataStore[type].allPatterns.length > MAX_HISTORY) {
      dataStore[type].allPatterns = dataStore[type].allPatterns.slice(-MAX_HISTORY);
    }
  }

  // Cập nhật 10 pattern gần nhất
  dataStore[type].patternHistory = results.slice(0, 10);
  
  // Cập nhật trạng thái thu thập
  if (dataStore[type].allPatterns.length >= MIN_PATTERNS) {
    dataStore[type].isCollecting = false;
  }

  // Kiểm tra đã đủ 10 pattern chưa (CHỈ DÙNG PATTERN MỚI THU)
  if (dataStore[type].allPatterns.length < MIN_PATTERNS) {
    return {
      canPredict: false,
      isCollecting: true,
      phien_hien_tai: phienHienTai,
      collected: dataStore[type].allPatterns.length,
      needed: MIN_PATTERNS,
      pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
      message: `⏳ Đang thu thập pattern mới: ${dataStore[type].allPatterns.length}/${MIN_PATTERNS}`,
      progress: Math.round((dataStore[type].allPatterns.length / MIN_PATTERNS) * 100),
      timestamp: new Date().toISOString()
    };
  }

  // ===== ĐÃ ĐỦ 10 PATTERN =====
  // CHẠY 5000 THUẬT TOÁN PHÂN TÍCH PATTERN
  const algorithms = generatePatternAlgorithms(results);
  const algoResult = aggregateAlgorithmResults(algorithms);

  if (!algoResult) {
    return {
      canPredict: false,
      message: 'Không thể tạo thuật toán',
      timestamp: new Date().toISOString()
    };
  }

  // Lấy dự đoán từ pattern truyền thống
  let patternPrediction = null;
  let patternConfidence = 0;
  if (detectedPatterns.length > 0) {
    const bestPattern = detectedPatterns.reduce((a, b) => a.confidence > b.confidence ? a : b);
    patternPrediction = bestPattern.prediction;
    patternConfidence = bestPattern.confidence;
  }

  // Kết quả cuối cùng
  let finalPrediction = algoResult.prediction;
  let finalConfidence = algoResult.confidence;

  // Lưu kết quả
  const predictionRecord = {
    phien_hien_tai: phienHienTai,
    du_doan: finalPrediction,
    do_tin_cay: finalConfidence,
    pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    so_pattern_da_thu: dataStore[type].allPatterns.length,
    tong_pattern: dataStore[type].allPatterns.length,
    so_thuat_toan: algoResult.totalAlgos,
    thong_ke_thuat_toan: {
      taiVotes: algoResult.taiWeighted,
      xiuVotes: algoResult.xiuWeighted,
      taiPercent: algoResult.taiPercent + '%',
      xiuPercent: algoResult.xiuPercent + '%',
      do_lech_chuan: algoResult.stdDev,
      do_tin_cay_trung_binh: algoResult.avgConfidence + '%'
    },
    top_10_thuat_toan: algoResult.topAlgos.map(a => ({
      id: '#' + a.id,
      du_doan: a.prediction,
      do_tin_cay: a.confidence + '%'
    })),
    cac_pattern_phat_hien: detectedPatterns.slice(0, 10).map(p => ({
      ten: p.type,
      do_tin_cay: p.confidence + '%',
      du_doan: p.prediction
    })),
    timestamp: new Date().toISOString()
  };

  dataStore[type].predictions.unshift(predictionRecord);
  if (dataStore[type].predictions.length > 100) {
    dataStore[type].predictions = dataStore[type].predictions.slice(0, 100);
  }

  saveData();

  return {
    canPredict: true,
    isCollecting: false,
    phien_hien_tai: phienHienTai,
    du_doan: finalPrediction,
    do_tin_cay: finalConfidence,
    pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    so_pattern_da_thu: dataStore[type].allPatterns.length,
    tong_pattern: dataStore[type].allPatterns.length,
    so_thuat_toan_da_chay: algoResult.totalAlgos,
    thong_ke_thuat_toan: {
      taiVotes: algoResult.taiWeighted,
      xiuVotes: algoResult.xiuWeighted,
      taiPercent: algoResult.taiPercent + '%',
      xiuPercent: algoResult.xiuPercent + '%',
      do_lech_chuan: algoResult.stdDev,
      do_tin_cay_trung_binh: algoResult.avgConfidence + '%'
    },
    top_10_thuat_toan: algoResult.topAlgos.map(a => ({
      id: '#' + a.id,
      du_doan: a.prediction,
      do_tin_cay: a.confidence + '%'
    })),
    cac_pattern_phat_hien: detectedPatterns.slice(0, 10).map(p => ({
      ten: p.type,
      do_tin_cay: p.confidence + '%',
      du_doan: p.prediction
    })),
    timestamp: new Date().toISOString()
  };
}

// ================================================================
// API ENDPOINTS
// ================================================================
app.get('/', (req, res) => {
  res.json({
    name: 'API Dự Đoán Tài Xỉu - Pattern Mới 100%',
    version: '5.0',
    author: '@Tskhang',
    min_patterns: MIN_PATTERNS,
    so_thuat_toan: '5.000 thuật toán phân tích pattern',
    trang_thai: {
      hu: {
        dang_thu: dataStore.hu.isCollecting,
        da_thu: dataStore.hu.collectedCount,
        can_predict: dataStore.hu.collectedCount >= MIN_PATTERNS
      },
      md5: {
        dang_thu: dataStore.md5.isCollecting,
        da_thu: dataStore.md5.collectedCount,
        can_predict: dataStore.md5.collectedCount >= MIN_PATTERNS
      }
    },
    endpoints: {
      '/hu': 'Dự đoán HU',
      '/md5': 'Dự đoán MD5',
      '/status': 'Trạng thái thu thập',
      '/reset': 'Reset dữ liệu'
    }
  });
});

// API Dự đoán HU
app.get('/hu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    if (!data) {
      return res.status(500).json({ error: 'Không thể lấy dữ liệu HU' });
    }
    
    const result = predictWithAlgorithms(data, 'hu');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }
});

// API Dự đoán MD5
app.get('/md5', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    if (!data) {
      return res.status(500).json({ error: 'Không thể lấy dữ liệu MD5' });
    }
    
    const result = predictWithAlgorithms(data, 'md5');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }
});

// Trạng thái thu thập
app.get('/status', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    hu: {
      isCollecting: dataStore.hu.isCollecting,
      collected: dataStore.hu.collectedCount,
      needed: MIN_PATTERNS,
      canPredict: dataStore.hu.collectedCount >= MIN_PATTERNS,
      progress: Math.round((dataStore.hu.collectedCount / MIN_PATTERNS) * 100),
      pattern_10_gan_nhat: dataStore.hu.patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' ')
    },
    md5: {
      isCollecting: dataStore.md5.isCollecting,
      collected: dataStore.md5.collectedCount,
      needed: MIN_PATTERNS,
      canPredict: dataStore.md5.collectedCount >= MIN_PATTERNS,
      progress: Math.round((dataStore.md5.collectedCount / MIN_PATTERNS) * 100),
      pattern_10_gan_nhat: dataStore.md5.patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' ')
    }
  });
});

// Lịch sử dự đoán HU
app.get('/hu/history', (req, res) => {
  res.json({
    type: 'HU',
    tong_du_doan: dataStore.hu.predictions.length,
    predictions: dataStore.hu.predictions.slice(0, 50)
  });
});

// Lịch sử dự đoán MD5
app.get('/md5/history', (req, res) => {
  res.json({
    type: 'MD5',
    tong_du_doan: dataStore.md5.predictions.length,
    predictions: dataStore.md5.predictions.slice(0, 50)
  });
});

// Reset dữ liệu - BẮT ĐẦU THU THẬP LẠI TỪ ĐẦU
app.get('/reset', (req, res) => {
  dataStore = {
    hu: {
      patterns: [],
      predictions: [],
      lastPhien: null,
      patternHistory: [],
      allPatterns: [],
      isCollecting: true,
      collectedCount: 0,
      startTime: new Date().toISOString()
    },
    md5: {
      patterns: [],
      predictions: [],
      lastPhien: null,
      patternHistory: [],
      allPatterns: [],
      isCollecting: true,
      collectedCount: 0,
      startTime: new Date().toISOString()
    }
  };
  saveData();
  res.json({ 
    message: '🔄 Đã reset dữ liệu. Bắt đầu thu thập pattern mới từ đầu!',
    timestamp: new Date().toISOString()
  });
});

// === TỰ ĐỘNG THU THẬP PATTERN MỚI ===
async function autoCollect() {
  try {
    console.log('🔄 Đang thu thập pattern mới...');
    
    // HU
    const dataHu = await fetchDataHu();
    if (dataHu && dataHu.length > 0) {
      const results = dataHu.map(d => d.Ket_qua);
      const patterns = analyzeAllPatterns(results);
      if (patterns.length > 0) {
        // Chỉ lưu nếu chưa có pattern này
        const lastPattern = dataStore.hu.allPatterns[dataStore.hu.allPatterns.length - 1];
        if (!lastPattern || lastPattern.phien !== dataHu[0]?.Phien) {
          dataStore.hu.allPatterns.push({
            phien: dataHu[0]?.Phien || 0,
            timestamp: new Date().toISOString(),
            patterns: patterns,
            results: results.slice(0, 10)
          });
          dataStore.hu.collectedCount = dataStore.hu.allPatterns.length;
          dataStore.hu.patternHistory = results.slice(0, 10);
          
          if (dataStore.hu.allPatterns.length > MAX_HISTORY) {
            dataStore.hu.allPatterns = dataStore.hu.allPatterns.slice(-MAX_HISTORY);
          }
          console.log(`✅ HU: Đã thu pattern #${dataStore.hu.collectedCount}`);
        }
      }
    }

    // MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5 && dataMd5.length > 0) {
      const results = dataMd5.map(d => d.Ket_qua);
      const patterns = analyzeAllPatterns(results);
      if (patterns.length > 0) {
        const lastPattern = dataStore.md5.allPatterns[dataStore.md5.allPatterns.length - 1];
        if (!lastPattern || lastPattern.phien !== dataMd5[0]?.Phien) {
          dataStore.md5.allPatterns.push({
            phien: dataMd5[0]?.Phien || 0,
            timestamp: new Date().toISOString(),
            patterns: patterns,
            results: results.slice(0, 10)
          });
          dataStore.md5.collectedCount = dataStore.md5.allPatterns.length;
          dataStore.md5.patternHistory = results.slice(0, 10);
          
          if (dataStore.md5.allPatterns.length > MAX_HISTORY) {
            dataStore.md5.allPatterns = dataStore.md5.allPatterns.slice(-MAX_HISTORY);
          }
          console.log(`✅ MD5: Đã thu pattern #${dataStore.md5.collectedCount}`);
        }
      }
    }

    // Cập nhật trạng thái
    if (dataStore.hu.collectedCount >= MIN_PATTERNS) {
      dataStore.hu.isCollecting = false;
    }
    if (dataStore.md5.collectedCount >= MIN_PATTERNS) {
      dataStore.md5.isCollecting = false;
    }

    saveData();
    console.log(`📊 Trạng thái: HU=${dataStore.hu.collectedCount}/${MIN_PATTERNS}, MD5=${dataStore.md5.collectedCount}/${MIN_PATTERNS}`);
  } catch (error) {
    console.error('❌ Lỗi thu thập:', error.message);
  }
}

// === KHỞI ĐỘNG ===
// KHÔNG LOAD PATTERN CŨ - BẮT ĐẦU TỪ ĐẦU
console.log('🚀 Khởi động API - Bắt đầu thu thập pattern mới...');
console.log('📋 Cần thu thập 10 pattern mới để bắt đầu dự đoán');
console.log('⏳ Pattern cũ sẽ KHÔNG được sử dụng');

// Khởi tạo dữ liệu mới
dataStore = {
  hu: {
    patterns: [],
    predictions: [],
    lastPhien: null,
    patternHistory: [],
    allPatterns: [],
    isCollecting: true,
    collectedCount: 0,
    startTime: new Date().toISOString()
  },
  md5: {
    patterns: [],
    predictions: [],
    lastPhien: null,
    patternHistory: [],
    allPatterns: [],
    isCollecting: true,
    collectedCount: 0,
    startTime: new Date().toISOString()
  }
};

// Lưu file mới
saveData();

// Chạy tự động thu thập mỗi 30 giây
setInterval(autoCollect, 30000);
// Chạy lần đầu sau 3 giây
setTimeout(autoCollect, 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server chạy tại http://0.0.0.0:${PORT}`);
  console.log(`📋 Cần ${MIN_PATTERNS} pattern MỚI để dự đoán`);
  console.log(`🔢 5.000 thuật toán phân tích pattern`);
  console.log(`⏳ Đang thu thập... HU: 0/${MIN_PATTERNS}, MD5: 0/${MIN_PATTERNS}`);
  console.log(`🔄 Pattern cũ KHÔNG được sử dụng`);
});
