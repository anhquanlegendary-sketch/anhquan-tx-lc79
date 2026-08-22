const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const LEARNING_FILE = 'Tskhang.json';
const HISTORY_FILE = 'Tskhang1.json';

let predictionHistory = { hu: [], md5: [] };
const MAX_HISTORY = 100;
const AUTO_SAVE_INTERVAL = 30000;
let lastProcessedPhien = { hu: null, md5: null };

// --- Cấu trúc learning data nâng cao (ĐÃ KHỞI TẠO ĐẦY ĐỦ CHO CẢ HU VÀ MD5) ---
let learningData = {
  hu: {
    predictions: [],
    patternStats: {},
    totalPredictions: 0,
    correctPredictions: 0,
    patternWeights: {},
    lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [],
    reversalState: { active: false, streakTrigger: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    markov2Matrix: {},
    volatility: 0
  },
  md5: {
    predictions: [],
    patternStats: {},
    totalPredictions: 0,
    correctPredictions: 0,
    patternWeights: {},
    lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [],
    reversalState: { active: false, streakTrigger: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    markov2Matrix: {},
    volatility: 0
  }
};

// === HÀM LOAD/SAVE ===
function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_FILE)) {
      const data = fs.readFileSync(LEARNING_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (let type of ['hu', 'md5']) {
        if (parsed[type]) {
          learningData[type] = { ...learningData[type], ...parsed[type] };
        }
      }
      console.log('✅ Loaded learning data from', LEARNING_FILE);
    }
  } catch (error) {
    console.error('Error loading learning data:', error.message);
  }
}

function saveLearningData() {
  try {
    fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData, null, 2));
  } catch (error) {
    console.error('Error saving learning data:', error.message);
  }
}

function loadPredictionHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(data);
      predictionHistory = parsed.history || { hu: [], md5: [] };
      lastProcessedPhien = parsed.lastProcessedPhien || { hu: null, md5: null };
      console.log('✅ Loaded prediction history from', HISTORY_FILE);
    }
  } catch (error) {
    console.error('Error loading prediction history:', error.message);
  }
}

function savePredictionHistory() {
  try {
    const dataToSave = {
      history: predictionHistory,
      lastProcessedPhien,
      lastSaved: new Date().toISOString()
    };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (error) {
    console.error('Error saving prediction history:', error.message);
  }
}

// === HÀM LẤY DỮ LIỆU API ===
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
    console.error('Error fetching HU data:', error.message);
    return null;
  }
}

async function fetchDataMd5() {
  try {
    const response = await axios.get(API_URL_MD5, { timeout: 10000 });
    return transformApiData(response.data);
  } catch (error) {
    console.error('Error fetching MD5 data:', error.message);
    return null;
  }
}

// ==================== CÁC HÀM PHÂN TÍCH CẦU (COPY TỪ LC.JS GỐC) ====================
// (Đây là các hàm từ file lc.js bạn đã cung cấp, tôi chỉ giữ lại chữ ký và phần thân cần thiết)

function analyzeCauBet(results, type) {
  if (results.length < 3) return { detected: false };
  let streakType = results[0];
  let streakLength = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 3) {
    let shouldBreak = streakLength >= 5;
    let confidence = streakLength >= 7 ? 85 : (streakLength >= 5 ? 75 : 68);
    return {
      detected: true,
      prediction: shouldBreak ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: confidence,
      name: `Cầu Bệt ${streakLength} phiên`,
      priority: 9
    };
  }
  return { detected: false };
}

function analyzeCauDao11(results, type) {
  if (results.length < 4) return { detected: false };
  let alternatingLength = 1;
  for (let i = 1; i < Math.min(results.length, 10); i++) {
    if (results[i] !== results[i - 1]) alternatingLength++;
    else break;
  }
  if (alternatingLength >= 4) {
    let confidence = Math.min(80, 65 + alternatingLength * 2);
    return {
      detected: true,
      prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: confidence,
      name: `Cầu Đảo 1-1 (${alternatingLength} phiên)`,
      priority: 8
    };
  }
  return { detected: false };
}

function analyzeCau22(results, type) {
  if (results.length < 6) return { detected: false };
  let pairCount = 0, i = 0, pattern = [];
  while (i < results.length - 1 && pairCount < 4) {
    if (results[i] === results[i + 1]) {
      pattern.push(results[i]);
      pairCount++;
      i += 2;
    } else break;
  }
  if (pairCount >= 2) {
    let isAlternating = true;
    for (let j = 1; j < pattern.length; j++) if (pattern[j] === pattern[j - 1]) isAlternating = false;
    if (isAlternating) {
      const lastPairType = pattern[pattern.length - 1];
      return {
        detected: true,
        prediction: lastPairType === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: Math.min(78, 65 + pairCount * 3),
        name: `Cầu 2-2 (${pairCount} cặp)`,
        priority: 7
      };
    }
  }
  return { detected: false };
}

function analyzeCau33(results, type) {
  if (results.length < 6) return { detected: false };
  let tripleCount = 0, i = 0, pattern = [];
  while (i < results.length - 2) {
    if (results[i] === results[i + 1] && results[i + 1] === results[i + 2]) {
      pattern.push(results[i]);
      tripleCount++;
      i += 3;
    } else break;
  }
  if (tripleCount >= 1) {
    const currentPosition = results.length % 3;
    const lastTripleType = pattern[pattern.length - 1];
    let prediction;
    if (currentPosition === 0) prediction = lastTripleType === 'Tài' ? 'Xỉu' : 'Tài';
    else prediction = lastTripleType;
    return {
      detected: true,
      prediction: prediction,
      confidence: Math.min(80, 68 + tripleCount * 4),
      name: `Cầu 3-3 (${tripleCount} bộ ba)`,
      priority: 7
    };
  }
  return { detected: false };
}

function analyzeCau121(results, type) {
  if (results.length < 4) return { detected: false };
  const pattern1 = results.slice(0, 4);
  if (pattern1[0] !== pattern1[1] && pattern1[1] === pattern1[2] && pattern1[2] !== pattern1[3] && pattern1[0] === pattern1[3]) {
    return { detected: true, prediction: pattern1[0], confidence: 72, name: 'Cầu 1-2-1', priority: 6 };
  }
  return { detected: false };
}

function analyzeCau123(results, type) {
  if (results.length < 6) return { detected: false };
  const first = results[5];
  const nextTwo = results.slice(3, 5);
  const lastThree = results.slice(0, 3);
  if (nextTwo[0] === nextTwo[1] && nextTwo[0] !== first) {
    const allSame = lastThree.every(r => r === lastThree[0]);
    if (allSame && lastThree[0] !== nextTwo[0]) {
      return { detected: true, prediction: first, confidence: 74, name: 'Cầu 1-2-3', priority: 6 };
    }
  }
  return { detected: false };
}

function analyzeCau321(results, type) {
  if (results.length < 6) return { detected: false };
  const first3 = results.slice(3, 6);
  const next2 = results.slice(1, 3);
  const last1 = results[0];
  const first3Same = first3.every(r => r === first3[0]);
  const next2Same = next2.every(r => r === next2[0]);
  if (first3Same && next2Same && first3[0] !== next2[0] && last1 !== next2[0]) {
    return { detected: true, prediction: next2[0], confidence: 76, name: 'Cầu 3-2-1', priority: 6 };
  }
  return { detected: false };
}

function analyzeCauNhayCoc(results, type) {
  if (results.length < 6) return { detected: false };
  const skipPattern = [];
  for (let i = 0; i < Math.min(results.length, 12); i += 2) skipPattern.push(results[i]);
  if (skipPattern.length >= 3) {
    const allSame = skipPattern.slice(0, 3).every(r => r === skipPattern[0]);
    if (allSame) return { detected: true, prediction: skipPattern[0], confidence: 68, name: 'Cầu Nhảy Cóc', priority: 5 };
    let alternating = true;
    for (let i = 1; i < skipPattern.length - 1; i++) if (skipPattern[i] === skipPattern[i - 1]) alternating = false;
    if (alternating && skipPattern.length >= 3) {
      return { detected: true, prediction: skipPattern[0] === 'Tài' ? 'Xỉu' : 'Tài', confidence: 66, name: 'Cầu Nhảy Cóc Đảo', priority: 5 };
    }
  }
  return { detected: false };
}

function analyzeCauNhipNghieng(results, type) {
  if (results.length < 5) return { detected: false };
  const last5 = results.slice(0, 5);
  const taiCount5 = last5.filter(r => r === 'Tài').length;
  if (taiCount5 >= 4) {
    return { detected: true, prediction: 'Tài', confidence: 70, name: `Cầu Nhịp Nghiêng (${taiCount5}/5 Tài)`, priority: 5 };
  } else if (taiCount5 <= 1) {
    return { detected: true, prediction: 'Xỉu', confidence: 70, name: `Cầu Nhịp Nghiêng (${5 - taiCount5}/5 Xỉu)`, priority: 5 };
  }
  return { detected: false };
}

function analyzeCau3Van1(results, type) {
  if (results.length < 4) return { detected: false };
  const last4 = results.slice(0, 4);
  const taiCount = last4.filter(r => r === 'Tài').length;
  if (taiCount === 3) return { detected: true, prediction: 'Xỉu', confidence: 68, name: 'Cầu 3 Ván 1 (3T-1X) → Xỉu', priority: 5 };
  if (taiCount === 1) return { detected: true, prediction: 'Tài', confidence: 68, name: 'Cầu 3 Ván 1 (3X-1T) → Tài', priority: 5 };
  return { detected: false };
}

function analyzeSmartBet(results, type) {
  if (results.length < 10) return { detected: false };
  const last10 = results.slice(0, 10);
  const last5 = results.slice(0, 5);
  const prev5 = results.slice(5, 10);
  const taiLast5 = last5.filter(r => r === 'Tài').length;
  const taiPrev5 = prev5.filter(r => r === 'Tài').length;
  const trendChanging = (taiLast5 >= 4 && taiPrev5 <= 1) || (taiLast5 <= 1 && taiPrev5 >= 4);
  if (trendChanging) {
    const currentDominant = taiLast5 >= 4 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: currentDominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 78, name: `Đảo Xu Hướng (${taiLast5}T-${5-taiLast5}X → ${taiPrev5}T-${5-taiPrev5}X)`, priority: 8 };
  }
  const taiLast10 = last10.filter(r => r === 'Tài').length;
  if (taiLast10 >= 8 || taiLast10 <= 2) {
    const dominant = taiLast10 >= 8 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: dominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 82, name: `Xu Hướng Cực (${taiLast10}T-${10-taiLast10}X) → Đảo`, priority: 8 };
  }
  return { detected: false };
}

function analyzeBreakStreak(results, type) {
  if (results.length < 5) return { detected: false };
  let streakType = results[0];
  let streakLength = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 5) {
    const prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: Math.min(85, 70 + streakLength), name: `Bẻ Chuỗi ${streakLength} (${streakType} → ${prediction})`, priority: 10 };
  }
  return { detected: false };
}

function analyzeTriplePattern(results, type) {
  if (results.length < 9) return { detected: false };
  const isTriple1 = results[0] === results[1] && results[1] === results[2];
  const isTriple2 = results[3] === results[4] && results[4] === results[5];
  const isTriple3 = results[6] === results[7] && results[7] === results[8];
  if (isTriple1 && isTriple2 && isTriple3) {
    const tripleType1 = results[0];
    const tripleType2 = results[3];
    const tripleType3 = results[6];
    if (tripleType1 === tripleType2 && tripleType2 === tripleType3) {
      const prediction = tripleType1 === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, prediction: prediction, confidence: 88, name: `3 Bộ Ba Cùng ${tripleType1} → Bẻ ${prediction}`, priority: 10 };
    }
    if (tripleType1 !== tripleType2 && tripleType2 !== tripleType3) {
      return { detected: true, prediction: tripleType1, confidence: 80, name: `Bộ Ba Đảo → Theo ${tripleType1}`, priority: 10 };
    }
  }
  return { detected: false };
}

function analyzeTongPhanTich(data, type) {
  if (data.length < 10) return { detected: false };
  const recent10 = data.slice(0, 10);
  const sums = recent10.map(d => d.Tong);
  const results = recent10.map(d => d.Ket_qua);
  const avgSum = sums.reduce((a, b) => a + b, 0) / sums.length;
  const taiCount = results.filter(r => r === 'Tài').length;
  const xiuCount = results.filter(r => r === 'Xỉu').length;
  const first5Sum = sums.slice(5, 10).reduce((a, b) => a + b, 0) / 5;
  const last5Sum = sums.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const sumTrend = last5Sum - first5Sum;
  if (sumTrend > 1.5) return { detected: true, prediction: 'Xỉu', confidence: 75, name: `Tổng Phân Tích (Tổng tăng ${sumTrend.toFixed(1)} → Xỉu)`, priority: 12 };
  if (sumTrend < -1.5) return { detected: true, prediction: 'Tài', confidence: 75, name: `Tổng Phân Tích (Tổng giảm ${Math.abs(sumTrend).toFixed(1)} → Tài)`, priority: 12 };
  if (Math.abs(taiCount - xiuCount) >= 3) {
    const lech = taiCount > xiuCount ? 'Tài' : 'Xỉu';
    const prediction = lech === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 70, name: `Tổng Phân Tích (Lệch ${Math.abs(taiCount - xiuCount)} về ${lech} → ${prediction})`, priority: 11 };
  }
  return { detected: false };
}

function analyzeXuHuongManh(results, type) {
  if (results.length < 8) return { detected: false };
  const recent8 = results.slice(0, 8);
  const taiCount = recent8.filter(r => r === 'Tài').length;
  if (taiCount >= 6) return { detected: true, prediction: 'Xỉu', confidence: 80, name: `Xu Hướng Mạnh (${taiCount}/8 Tài → Đảo Xỉu)`, priority: 11 };
  if (taiCount <= 2) return { detected: true, prediction: 'Tài', confidence: 80, name: `Xu Hướng Mạnh (${8 - taiCount}/8 Xỉu → Đảo Tài)`, priority: 11 };
  return { detected: false };
}

function analyzeDaoChieu(results, type) {
  if (results.length < 5) return { detected: false };
  const recent5 = results.slice(0, 5);
  let isAlternating = true;
  for (let i = 0; i < recent5.length - 1; i++) {
    if (recent5[i] === recent5[i + 1]) { isAlternating = false; break; }
  }
  if (isAlternating) {
    const prediction = recent5[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 75, name: `Đảo Chiều (Chuỗi ${recent5.join('-')} → ${prediction})`, priority: 10 };
  }
  return { detected: false };
}

// ==================== NÂNG CẤP PHÂN TÍCH THỐNG KÊ ====================
// Lưu ý: đây là mô hình thống kê/backtest, không thể đảm bảo kết quả thắng.
// API trả dữ liệu mới nhất trước -> khi học chuyển sang thứ tự cũ -> mới.

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function laplaceProb(success, total, alpha = 1) {
  return (success + alpha) / (total + alpha * 2);
}

function getChronologicalResults(data) {
  return data.map(d => d.Ket_qua).slice().reverse();
}

function getChronologicalData(data) {
  return data.slice().reverse();
}

function getTransitionStats(sequence) {
  const stats = {
    Tài: { 'Tài': 1, 'Xỉu': 1 },
    Xỉu: { 'Tài': 1, 'Xỉu': 1 }
  };
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = sequence[i], to = sequence[i + 1];
    if (stats[from] && stats[from][to] !== undefined) stats[from][to]++;
  }
  return stats;
}

function analyzeMarkov1(data) {
  const seq = getChronologicalResults(data);
  if (seq.length < 12) return null;
  const stats = getTransitionStats(seq);
  const last = seq[seq.length - 1];
  const row = stats[last];
  const total = row['Tài'] + row['Xỉu'];
  const pTai = row['Tài'] / total;
  const pXiu = row['Xỉu'] / total;
  const prediction = pTai >= pXiu ? 'Tài' : 'Xỉu';
  const edge = Math.abs(pTai - pXiu);
  if (edge < 0.10) return null;
  return {
    prediction,
    probability: Math.max(pTai, pXiu),
    confidence: clamp(50 + edge * 100, 52, 82),
    name: `Markov bậc 1 (${last} → ${prediction})`,
    priority: 8
  };
}

function analyzeMarkov2(data) {
  const seq = getChronologicalResults(data);
  if (seq.length < 20) return null;
  const counts = {};
  for (let i = 0; i < seq.length - 2; i++) {
    const key = seq[i] + '|' + seq[i + 1];
    if (!counts[key]) counts[key] = { 'Tài': 1, 'Xỉu': 1 };
    counts[key][seq[i + 2]]++;
  }
  const key = seq[seq.length - 2] + '|' + seq[seq.length - 1];
  const row = counts[key];
  if (!row) return null;
  const total = row['Tài'] + row['Xỉu'];
  const pTai = row['Tài'] / total;
  const pXiu = row['Xỉu'] / total;
  const prediction = pTai >= pXiu ? 'Tài' : 'Xỉu';
  const edge = Math.abs(pTai - pXiu);
  if (edge < 0.08) return null;
  return {
    prediction,
    probability: Math.max(pTai, pXiu),
    confidence: clamp(50 + edge * 100, 52, 85),
    name: `Markov bậc 2 (${key} → ${prediction})`,
    priority: 9
  };
}

function analyzeNGram(data, n = 3) {
  const seq = getChronologicalResults(data);
  if (seq.length < 35) return null;
  const counts = {};
  for (let i = 0; i < seq.length - n; i++) {
    const key = seq.slice(i, i + n).join('|');
    if (!counts[key]) counts[key] = { 'Tài': 1, 'Xỉu': 1 };
    counts[key][seq[i + n]]++;
  }
  const key = seq.slice(-n).join('|');
  const row = counts[key];
  if (!row) return null;
  const total = row['Tài'] + row['Xỉu'];
  const pTai = row['Tài'] / total;
  const pXiu = row['Xỉu'] / total;
  const prediction = pTai >= pXiu ? 'Tài' : 'Xỉu';
  const edge = Math.abs(pTai - pXiu);
  // N-gram chỉ được dùng khi mẫu lặp lại đủ mạnh.
  if (total < 5 || edge < 0.10) return null;
  return {
    prediction,
    probability: Math.max(pTai, pXiu),
    confidence: clamp(50 + edge * 100 + Math.min(5, total / 4), 53, 86),
    name: `N-gram ${n} (${key.replace(/\|/g, '-')} → ${prediction})`,
    priority: 10
  };
}

function loadHistoricalPatternStats() {
  try {
    // Nạp thống kê pattern cũ nếu file tồn tại.
    if (fs.existsSync('learning_data.json')) {
      const histData = JSON.parse(fs.readFileSync('learning_data.json', 'utf8'));
      for (const type of ['hu', 'md5']) {
        if (!histData[type] || !histData[type].patternStats) continue;
        for (const [pat, statsRaw] of Object.entries(histData[type].patternStats)) {
          const stats = statsRaw || {};
          const total = Number(stats.total || 0);
          const correct = Number(stats.correct || 0);
          const existing = learningData[type].patternStats[pat] || {
            total: 0, correct: 0, recentResults: []
          };

          existing.total = Math.max(Number(existing.total || 0), total);
          existing.correct = Math.max(Number(existing.correct || 0), correct);
          if (!Array.isArray(existing.recentResults)) existing.recentResults = [];
          if (Array.isArray(stats.recentResults)) {
            existing.recentResults = stats.recentResults.slice(-50);
          }
          learningData[type].patternStats[pat] = existing;

          if (existing.total >= 8) {
            learningData[type].patternWeights[pat] = getPatternEmpiricalWeight(type, pat);
          } else {
            learningData[type].patternWeights[pat] = 1.0;
          }
        }
      }
      console.log('✅ Loaded historical pattern stats from learning_data.json');
    }

    // Nạp các prediction cũ đã xác minh nếu có.
    if (fs.existsSync('tiendat.json')) {
      const tiendat = JSON.parse(fs.readFileSync('tiendat.json', 'utf8'));
      for (const type of ['hu', 'md5']) {
        const oldPredictions = tiendat[type]?.predictions;
        if (!Array.isArray(oldPredictions)) continue;

        for (const pred of oldPredictions) {
          if (!pred?.verified || pred.isCorrect === null || !Array.isArray(pred.patterns)) continue;
          for (const pName of pred.patterns) {
            const patId = getPatternKey(pName);
            if (!patId) continue;
            const s = learningData[type].patternStats[patId] || {
              total: 0, correct: 0, recentResults: []
            };
            s.total++;
            if (pred.isCorrect) s.correct++;
            if (!Array.isArray(s.recentResults)) s.recentResults = [];
            s.recentResults.push(pred.isCorrect ? 1 : 0);
            if (s.recentResults.length > 50) s.recentResults.shift();
            learningData[type].patternStats[patId] = s;
            learningData[type].patternWeights[patId] = getPatternEmpiricalWeight(type, patId);
          }
        }
      }
      console.log('✅ Loaded verified historical predictions from tiendat.json');
    }
  } catch (error) {
    console.error('Error loading historical pattern stats:', error.message);
  }
}

function getPatternKey(name) {
  return getPatternIdFromName(name) || name;
}

function getPatternEmpiricalWeight(type, patternName) {
  const id = getPatternKey(patternName);
  const stats = learningData[type].patternStats?.[id];
  if (!stats || !stats.total || stats.total < 8) return 1.0;

  // Bayesian smoothing + ưu tiên dữ liệu gần đây.
  const correct = Number(stats.correct || 0);
  const total = Number(stats.total || 0);
  const recent = Array.isArray(stats.recentResults) ? stats.recentResults : [];
  const recentAcc = recent.length
    ? recent.reduce((a, b) => a + Number(b), 0) / recent.length
    : correct / total;

  const smoothed = laplaceProb(correct, total, 2);
  const blended = smoothed * 0.65 + recentAcc * 0.35;

  // Không để một pattern thắng vài lần rồi áp đảo toàn bộ ensemble.
  return clamp(0.55 + (blended - 0.5) * 2.2, 0.55, 1.55);
}

function updatePatternLearning(type, predictionRecord) {
  if (!predictionRecord || !predictionRecord.verified || !Array.isArray(predictionRecord.patterns)) return;
  for (const name of predictionRecord.patterns) {
    const id = getPatternKey(name);
    if (!id) continue;
    const s = learningData[type].patternStats[id] || {
      total: 0, correct: 0, recentResults: []
    };
    s.total++;
    if (predictionRecord.isCorrect) s.correct++;
    if (!Array.isArray(s.recentResults)) s.recentResults = [];
    s.recentResults.push(predictionRecord.isCorrect ? 1 : 0);
    if (s.recentResults.length > 50) s.recentResults.shift();
    learningData[type].patternStats[id] = s;
    learningData[type].patternWeights[id] = getPatternEmpiricalWeight(type, id);
  }
}

function updateStreak(type, isCorrect) {
  const s = learningData[type].streakAnalysis;
  if (isCorrect) {
    s.wins = (s.wins || 0) + 1;
    s.currentStreak = s.currentStreak > 0 ? s.currentStreak + 1 : 1;
    s.bestStreak = Math.max(s.bestStreak || 0, s.currentStreak);
  } else {
    s.losses = (s.losses || 0) + 1;
    s.currentStreak = s.currentStreak < 0 ? s.currentStreak - 1 : -1;
    s.worstStreak = Math.min(s.worstStreak || 0, s.currentStreak);
  }
}

function getVerifiedAccuracy(type) {
  const arr = learningData[type].recentAccuracy || [];
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + Number(b), 0) / arr.length;
}

function calculateEnsemble(predictions, type) {
  let tai = 0, xiu = 0;
  for (const p of predictions) {
    const w = getPatternEmpiricalWeight(type, p.name);
    const prob = clamp(Number(p.probability || p.confidence / 100), 0.50, 0.95);
    const score = (0.50 + (prob - 0.50) * 1.8) * w * (p.priority || 5);
    if (p.prediction === 'Tài') tai += score;
    else xiu += score;
  }
  const total = tai + xiu || 1;
  const pTai = tai / total;
  const prediction = pTai >= 0.5 ? 'Tài' : 'Xỉu';
  const edge = Math.abs(pTai - 0.5) * 2;
  return {
    prediction,
    pTai,
    pXiu: 1 - pTai,
    edge,
    confidence: clamp(50 + edge * 38, 51, 88)
  };
}

function calculateAdvancedPrediction(data, type) {
  if (!Array.isArray(data) || data.length < 12) {
    return {
      prediction: 'Xỉu',
      confidence: 50,
      factors: ['Chưa đủ dữ liệu để kết luận mạnh'],
      allPatterns: [],
      detailedAnalysis: { totalPatterns: 0, taiVotes: 0, xiuVotes: 0, topPattern: 'N/A' }
    };
  }

  const results = data.map(d => d.Ket_qua);
  updateMarkovMatrices(type, results);

  const predictions = [];
  const factors = [];

  // 1) Các pattern cầu hiện có.
  const patternFunctions = [
    analyzeCauBet, analyzeCauDao11, analyzeCau22, analyzeCau33,
    analyzeCau121, analyzeCau123, analyzeCau321, analyzeCauNhayCoc,
    analyzeCauNhipNghieng, analyzeCau3Van1, analyzeSmartBet,
    analyzeBreakStreak, analyzeTriplePattern, analyzeTongPhanTich,
    analyzeXuHuongManh, analyzeDaoChieu
  ];

  for (const fn of patternFunctions) {
    try {
      const p = fn(results, type);
      if (p && p.detected) {
        predictions.push({
          ...p,
          probability: clamp(Number(p.confidence || 65) / 100, 0.50, 0.90),
          priority: p.priority || 5
        });
      }
    } catch (_) {}
  }

  // 2) Mô hình thống kê theo thứ tự thời gian đúng.
  for (const model of [
    analyzeMarkov1(data),
    analyzeMarkov2(data),
    analyzeNGram(data, 3)
  ]) {
    if (model) predictions.push(model);
  }

  if (!predictions.length) {
    const last5 = results.slice(0, 5);
    const tai = last5.filter(x => x === 'Tài').length;
    const prediction = tai >= 3 ? 'Tài' : 'Xỉu';
    predictions.push({
      prediction,
      probability: 0.50,
      confidence: 50,
      priority: 1,
      name: 'Fallback cân bằng'
    });
  }

  // 3) Ensemble có trọng số theo hiệu quả thực tế của từng pattern.
  const ensemble = calculateEnsemble(predictions, type);
  let finalPrediction = ensemble.prediction;

  const votesTai = predictions.filter(p => p.prediction === 'Tài').length;
  const votesXiu = predictions.filter(p => p.prediction === 'Xỉu').length;
  const agreement = Math.max(votesTai, votesXiu) / predictions.length;

  // 4) Hiệu chỉnh confidence theo độ đồng thuận và accuracy gần đây.
  const recentAcc = getVerifiedAccuracy(type);
  let finalConf = ensemble.confidence;
  finalConf += (agreement - 0.5) * 12;
  if (recentAcc !== null && recentAcc < 0.48) finalConf -= 4;
  if (recentAcc !== null && recentAcc > 0.58) finalConf += 2;

  const top = predictions
    .slice()
    .sort((a, b) => {
      const wa = getPatternEmpiricalWeight(type, a.name);
      const wb = getPatternEmpiricalWeight(type, b.name);
      return (b.priority * b.confidence * wb) - (a.priority * a.confidence * wa);
    })
    .slice(0, 4);

  for (const p of top) {
    const w = getPatternEmpiricalWeight(type, p.name);
    factors.push(`${p.name} [w=${w.toFixed(2)}]`);
  }

  return {
    prediction: finalPrediction,
    confidence: Math.round(clamp(finalConf, 51, 88)),
    factors: factors.slice(0, 8),
    allPatterns: predictions.map(p => p.name).slice(0, 8),
    detailedAnalysis: {
      totalPatterns: predictions.length,
      taiVotes: votesTai,
      xiuVotes: votesXiu,
      agreement: Math.round(agreement * 100) + '%',
      topPattern: top[0]?.name || 'N/A',
      probabilities: {
        tai: +(ensemble.pTai * 100).toFixed(2),
        xiu: +(ensemble.pXiu * 100).toFixed(2)
      },
      learningStats: {
        recentAccuracy: recentAcc === null ? 'N/A' : (recentAcc * 100).toFixed(1) + '%',
        verifiedPredictions: learningData[type].predictions.filter(p => p.verified).length,
        currentStreak: learningData[type].streakAnalysis.currentStreak
      }
    }
  };
}



// === HÀM TỰ ĐỘNG VÀ LƯU TRỮ ===
async function verifyPredictions(type, currentData) {
  let updated = false;

  for (let pred of learningData[type].predictions) {
    if (pred.verified) continue;

    const actual = currentData.find(d => d.Phien.toString() === pred.phien);
    if (!actual) continue;

    pred.verified = true;
    pred.actual = actual.Ket_qua;
    pred.isCorrect = (pred.prediction === pred.actual);

    learningData[type].verifiedPredictions = (learningData[type].verifiedPredictions || 0) + 1;
    if (pred.isCorrect) learningData[type].correctPredictions++;
    updateStreak(type, pred.isCorrect);

    learningData[type].recentAccuracy.push(pred.isCorrect ? 1 : 0);
    if (learningData[type].recentAccuracy.length > 100) {
      learningData[type].recentAccuracy.shift();
    }

    updatePatternLearning(type, pred);
    updated = true;
  }

  if (updated) {
    learningData[type].lastUpdate = new Date().toISOString();
    saveLearningData();
  }
}

function recordPrediction(type, phien, prediction, confidence, patterns) {
  const key = phien.toString();
  const existing = learningData[type].predictions.find(p => p.phien === key);
  if (existing) return existing;

  const rec = {
    phien: key,
    prediction,
    confidence,
    patterns: Array.isArray(patterns) ? patterns.slice(0, 12) : [],
    timestamp: new Date().toISOString(),
    verified: false,
    actual: null,
    isCorrect: null
  };

  learningData[type].predictions.unshift(rec);
  learningData[type].totalPredictions++;
  if (learningData[type].predictions.length > 500) {
    learningData[type].predictions.pop();
  }
  saveLearningData();
  return rec;
}

function savePredictionToHistory(type, phien, prediction, confidence, latestData) {
  const key = phien.toString();
  const existing = predictionHistory[type].find(r => r.Phien_hien_tai?.toString() === key);
  if (existing) return existing;

  const record = {
    Phien: latestData.Phien,
    Xuc_xac_1: latestData.Xuc_xac_1,
    Xuc_xac_2: latestData.Xuc_xac_2,
    Xuc_xac_3: latestData.Xuc_xac_3,
    Tong: latestData.Tong,
    Ket_qua: latestData.Ket_qua,
    Do_tin_cay: `${confidence}%`,
    Phien_hien_tai: key,
    Du_doan: prediction,
    ket_qua_du_doan: '',
    id: '@Tskhang',
    timestamp: new Date().toISOString()
  };

  predictionHistory[type].unshift(record);
  if (predictionHistory[type].length > MAX_HISTORY) {
    predictionHistory[type].pop();
  }
  return record;
}

async function updateHistoryStatus(type) {
  let data = (type === 'hu') ? await fetchDataHu() : await fetchDataMd5();
  if (!data) return;
  for (let record of predictionHistory[type]) {
    if (record.ket_qua_du_doan && record.ket_qua_du_doan !== '') continue;
    const actual = data.find(d => d.Phien.toString() === record.Phien_hien_tai);
    if (actual) {
      record.ket_qua_du_doan = (record.Du_doan === actual.Ket_qua) ? 'Đúng ✅' : 'Sai ❌';
    }
  }
  savePredictionHistory();
}

async function autoProcessPredictions() {
  try {
    const dataHu = await fetchDataHu();
    if (dataHu && dataHu.length > 0) {
      const nextPhien = dataHu[0].Phien + 1;
      if (lastProcessedPhien.hu !== nextPhien) {
        await verifyPredictions('hu', dataHu);
        const result = calculateAdvancedPrediction(dataHu, 'hu');
        savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence, dataHu[0]);
        recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
        lastProcessedPhien.hu = nextPhien;
        console.log(`[Auto] Hu phiên ${nextPhien}: ${result.prediction} (${result.confidence}%)`);
      }
    }
    const dataMd5 = await fetchDataMd5();
    if (dataMd5 && dataMd5.length > 0) {
      const nextPhien = dataMd5[0].Phien + 1;
      if (lastProcessedPhien.md5 !== nextPhien) {
        await verifyPredictions('md5', dataMd5);
        const result = calculateAdvancedPrediction(dataMd5, 'md5');
        savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence, dataMd5[0]);
        recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
        lastProcessedPhien.md5 = nextPhien;
        console.log(`[Auto] MD5 phiên ${nextPhien}: ${result.prediction} (${result.confidence}%)`);
      }
    }
    savePredictionHistory();
    saveLearningData();
  } catch (error) {
    console.error('[Auto] Error:', error.message);
  }
}

function startAutoSaveTask() {
  setTimeout(autoProcessPredictions, 5000);
  setInterval(autoProcessPredictions, AUTO_SAVE_INTERVAL);
}

// ==================== ENDPOINTS ====================
app.get('/', (req, res) => res.send('t.me/Tskhang'));

app.get('/hu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
    await verifyPredictions('hu', data);
    const nextPhien = data[0].Phien + 1;
    const result = calculateAdvancedPrediction(data, 'hu');
    const record = savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('hu'), 5000);
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/md5', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
    await verifyPredictions('md5', data);
    const nextPhien = data[0].Phien + 1;
    const result = calculateAdvancedPrediction(data, 'md5');
    const record = savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('md5'), 5000);
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/hu/lichsu', async (req, res) => {
  await updateHistoryStatus('hu');
  res.json({ type: 'Lẩu Cua 79 - Tài Xỉu Hũ', history: predictionHistory.hu, total: predictionHistory.hu.length, id: '@Tskhang' });
});

app.get('/md5/lichsu', async (req, res) => {
  await updateHistoryStatus('md5');
  res.json({ type: 'Lẩu Cua 79 - Tài Xỉu MD5', history: predictionHistory.md5, total: predictionHistory.md5.length, id: '@Tskhang' });
});

app.get('/hu/thamso', async (req, res) => {
  const data = await fetchDataHu();
  if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
  const result = calculateAdvancedPrediction(data, 'hu');
  res.json({ prediction: result.prediction, confidence: result.confidence, factors: result.factors, analysis: result.detailedAnalysis });
});

app.get('/md5/Thamso', async (req, res) => {
  const data = await fetchDataMd5();
  if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
  const result = calculateAdvancedPrediction(data, 'md5');
  res.json({ prediction: result.prediction, confidence: result.confidence, factors: result.factors, analysis: result.detailedAnalysis });
});

app.get('/hu/hochoi', (req, res) => {
  const stats = learningData.hu;
  const verified = stats.verifiedPredictions || stats.predictions.filter(p => p.verified).length;
    const acc = verified ? (stats.correctPredictions / verified * 100).toFixed(2) : 0;
  res.json({ type: 'HU Learning', totalPredictions: stats.totalPredictions, verifiedPredictions: verified, correctPredictions: stats.correctPredictions, accuracy: acc + '%', streakAnalysis: stats.streakAnalysis, id: '@Tskhang' });
});

app.get('/md5/Hochoi', (req, res) => {
  const stats = learningData.md5;
  const verified = stats.verifiedPredictions || stats.predictions.filter(p => p.verified).length;
    const acc = verified ? (stats.correctPredictions / verified * 100).toFixed(2) : 0;
  res.json({ type: 'MD5 Learning', totalPredictions: stats.totalPredictions, verifiedPredictions: verified, correctPredictions: stats.correctPredictions, accuracy: acc + '%', streakAnalysis: stats.streakAnalysis, id: '@Tskhang' });
});

app.get('/Resetdata', (req, res) => {
  learningData = {
    hu: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, volatility: 0 },
    md5: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, volatility: 0 }
  };
  saveLearningData();
  res.json({ message: 'Learning data reset', id: '@Tskhang' });
});

// KHỞI ĐỘNG
loadLearningData();
loadHistoricalPatternStats();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server @Tskhang running on http://0.0.0.0:${PORT}`);
  console.log('✅ Đã fix lỗi: loadLearningData, khởi tạo md5, thêm toàn bộ hàm phân tích cầu');
  startAutoSaveTask();
});