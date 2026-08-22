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

// --- Cấu trúc learning data nâng cao ---
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

// ==================== CÁC HÀM PHÂN TÍCH CẦU (ĐÃ TỐI ƯU) ====================

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
    let confidence = streakLength >= 7 ? 88 : (streakLength >= 5 ? 78 : 70);
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
  for (let i = 1; i < Math.min(results.length, 12); i++) {
    if (results[i] !== results[i - 1]) alternatingLength++;
    else break;
  }
  if (alternatingLength >= 4) {
    let confidence = Math.min(84, 68 + alternatingLength * 2);
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
        confidence: Math.min(82, 68 + pairCount * 3),
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
    let prediction = (currentPosition === 0) ? (lastTripleType === 'Tài' ? 'Xỉu' : 'Tài') : lastTripleType;
    return {
      detected: true,
      prediction: prediction,
      confidence: Math.min(84, 70 + tripleCount * 4),
      name: `Cầu 3-3 (${tripleCount} bộ ba)`,
      priority: 7
    };
  }
  return { detected: false };
}

function analyzeCau121(results, type) {
  if (results.length < 4) return { detected: false };
  const p = results.slice(0, 4);
  if (p[0] !== p[1] && p[1] === p[2] && p[2] !== p[3] && p[0] === p[3]) {
    return { detected: true, prediction: p[0], confidence: 75, name: 'Cầu 1-2-1', priority: 6 };
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
      return { detected: true, prediction: first, confidence: 76, name: 'Cầu 1-2-3', priority: 6 };
    }
  }
  return { detected: false };
}

function analyzeCau321(results, type) {
  if (results.length < 6) return { detected: false };
  const first3 = results.slice(3, 6);
  const next2 = results.slice(1, 3);
  const last1 = results[0];
  if (first3.every(r => r === first3[0]) && next2.every(r => r === next2[0]) && first3[0] !== next2[0] && last1 !== next2[0]) {
    return { detected: true, prediction: next2[0], confidence: 78, name: 'Cầu 3-2-1', priority: 6 };
  }
  return { detected: false };
}

function analyzeCauNhayCoc(results, type) {
  if (results.length < 6) return { detected: false };
  const skipPattern = [];
  for (let i = 0; i < Math.min(results.length, 12); i += 2) skipPattern.push(results[i]);
  if (skipPattern.length >= 3) {
    if (skipPattern.slice(0, 3).every(r => r === skipPattern[0])) {
      return { detected: true, prediction: skipPattern[0], confidence: 70, name: 'Cầu Nhảy Cóc', priority: 5 };
    }
  }
  return { detected: false };
}

function analyzeCauNhipNghieng(results, type) {
  if (results.length < 5) return { detected: false };
  const last5 = results.slice(0, 5);
  const taiCount5 = last5.filter(r => r === 'Tài').length;
  if (taiCount5 >= 4) {
    return { detected: true, prediction: 'Tài', confidence: 72, name: `Cầu Nhịp Nghiêng (${taiCount5}/5 Tài)`, priority: 5 };
  } else if (taiCount5 <= 1) {
    return { detected: true, prediction: 'Xỉu', confidence: 72, name: `Cầu Nhịp Nghiêng (${5 - taiCount5}/5 Xỉu)`, priority: 5 };
  }
  return { detected: false };
}

function analyzeCau3Van1(results, type) {
  if (results.length < 4) return { detected: false };
  const last4 = results.slice(0, 4);
  const taiCount = last4.filter(r => r === 'Tài').length;
  if (taiCount === 3) return { detected: true, prediction: 'Xỉu', confidence: 70, name: 'Cầu 3 Ván 1 → Xỉu', priority: 5 };
  if (taiCount === 1) return { detected: true, prediction: 'Tài', confidence: 70, name: 'Cầu 3 Ván 1 → Tài', priority: 5 };
  return { detected: false };
}

function analyzeSmartBet(results, type) {
  if (results.length < 10) return { detected: false };
  const last5 = results.slice(0, 5);
  const prev5 = results.slice(5, 10);
  const taiLast5 = last5.filter(r => r === 'Tài').length;
  const taiPrev5 = prev5.filter(r => r === 'Tài').length;
  if ((taiLast5 >= 4 && taiPrev5 <= 1) || (taiLast5 <= 1 && taiPrev5 >= 4)) {
    const dominant = taiLast5 >= 4 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: dominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 80, name: 'Đảo Xu Hướng', priority: 8 };
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
    return { detected: true, prediction: prediction, confidence: Math.min(88, 72 + streakLength), name: `Bẻ Chuỗi ${streakLength}`, priority: 10 };
  }
  return { detected: false };
}

function analyzeTriplePattern(results, type) {
  if (results.length < 9) return { detected: false };
  if (results[0] === results[1] && results[1] === results[2] &&
      results[3] === results[4] && results[4] === results[5] &&
      results[6] === results[7] && results[7] === results[8]) {
    if (results[0] === results[3] && results[3] === results[6]) {
      const pred = results[0] === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, prediction: pred, confidence: 90, name: '3 Bộ Ba Cùng Màu → Bẻ', priority: 10 };
    }
  }
  return { detected: false };
}

function analyzeTongPhanTich(data, type) {
  if (data.length < 10) return { detected: false };
  const sums = data.slice(0, 10).map(d => d.Tong);
  const sumTrend = (sums.slice(0, 5).reduce((a, b) => a + b, 0) / 5) - (sums.slice(5, 10).reduce((a, b) => a + b, 0) / 5);
  if (sumTrend > 1.5) return { detected: true, prediction: 'Xỉu', confidence: 76, name: 'Tổng Phân Tích (Tổng Tăng)', priority: 12 };
  if (sumTrend < -1.5) return { detected: true, prediction: 'Tài', confidence: 76, name: 'Tổng Phân Tích (Tổng Giảm)', priority: 12 };
  return { detected: false };
}

function analyzeXuHuongManh(results, type) {
  if (results.length < 8) return { detected: false };
  const taiCount = results.slice(0, 8).filter(r => r === 'Tài').length;
  if (taiCount >= 6) return { detected: true, prediction: 'Xỉu', confidence: 82, name: 'Xu Hướng Mạnh (Quá Tài)', priority: 11 };
  if (taiCount <= 2) return { detected: true, prediction: 'Tài', confidence: 82, name: 'Xu Hướng Mạnh (Quá Xỉu)', priority: 11 };
  return { detected: false };
}

function analyzeDaoChieu(results, type) {
  if (results.length < 5) return { detected: false };
  const r5 = results.slice(0, 5);
  let isAlt = true;
  for (let i = 0; i < r5.length - 1; i++) if (r5[i] === r5[i + 1]) isAlt = false;
  if (isAlt) {
    return { detected: true, prediction: r5[0] === 'Tài' ? 'Xỉu' : 'Tài', confidence: 76, name: 'Đảo Chiều Liên Tục', priority: 10 };
  }
  return { detected: false };
}

// ==================== CÁC HÀM NÂNG CAO & MARKOV ====================
function getPatternIdFromName(name) {
  const mapping = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Cầu 1-2-1': 'cau_121', 'Cầu 1-2-3': 'cau_123', 'Cầu 3-2-1': 'cau_321', 'Cầu Nhảy Cóc': 'cau_nhay_coc',
    'Cầu Nhịp Nghiêng': 'cau_nhip_nghieng', 'Cầu 3 Ván 1': 'cau_3van1', 'Đảo Xu Hướng': 'smart_bet',
    'Bẻ Chuỗi': 'break_streak', '3 Bộ Ba': 'triple_pattern', 'Tổng Phân Tích': 'tong_phan_tich',
    'Xu Hướng Mạnh': 'xu_huong_manh', 'Đảo Chiều': 'dao_chieu', 'Markov bậc 1': 'markov1', 'Markov bậc 2': 'markov2',
    'Sóng Elliott': 'elliott', 'Kháng cự': 'resistance', 'Hỗ trợ': 'support'
  };
  for (const [key, val] of Object.entries(mapping)) if (name.includes(key)) return val;
  return null;
}

function updateMarkovMatrices(type, results) {
  if (results.length < 15) return;
  let tt = 1, tx = 1, xt = 1, xx = 1; // Laplace smoothing tránh chia 0
  for (let i = 0; i < results.length - 1; i++) {
    if (results[i] === 'Tài' && results[i + 1] === 'Tài') tt++;
    else if (results[i] === 'Tài' && results[i + 1] === 'Xỉu') tx++;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Tài') xt++;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Xỉu') xx++;
  }
  const totalT = tt + tx;
  const totalX = xt + xx;
  learningData[type].markovMatrix = {
    TT: tt / totalT,
    TX: tx / totalT,
    XT: xt / totalX,
    XX: xx / totalX
  };

  const markov2 = {};
  for (let i = 0; i < results.length - 2; i++) {
    const key = results[i] + results[i + 1];
    const next = results[i + 2];
    markov2[key + next] = (markov2[key + next] || 0) + 1;
  }
  learningData[type].markov2Matrix = markov2;
}

function analyzeElliottWave(results) {
  if (results.length < 8) return null;
  let changes = [];
  for (let i = 1; i < results.length; i++) if (results[i] !== results[i - 1]) changes.push(i);
  if (changes.length >= 4) {
    const direction = results[0];
    return { detected: true, prediction: direction === 'Tài' ? 'Xỉu' : 'Tài', confidence: 75, name: 'Sóng Elliott (Correction)', priority: 10 };
  }
  return null;
}

function analyzeSupportResistance(data) {
  if (data.length < 10) return null;
  const lastSum = data[0]?.Tong;
  if (!lastSum) return null;
  if (lastSum >= 14) {
    return { detected: true, prediction: 'Xỉu', confidence: 74, name: `Kháng cự mạnh (${lastSum})`, priority: 7 };
  } else if (lastSum <= 7) {
    return { detected: true, prediction: 'Tài', confidence: 74, name: `Hỗ trợ mạnh (${lastSum})`, priority: 7 };
  }
  return null;
}

// === HÀM DỰ ĐOÁN CHÍNH ĐÃ CẢI TIẾN ===
function calculateAdvancedPrediction(data, type) {
  const results = data.map(d => d.Ket_qua);
  const sums = data.map(d => d.Tong);
  updateMarkovMatrices(type, results);

  let predictions = [];
  let factors = [];

  // Markov bậc 1
  const lastResult = results[0];
  if (lastResult && learningData[type].markovMatrix) {
    const nextProbTai = (lastResult === 'Tài') ? learningData[type].markovMatrix.TT : learningData[type].markovMatrix.XT;
    if (nextProbTai > 0.60) {
      predictions.push({ prediction: 'Tài', confidence: 70 + (nextProbTai - 0.5) * 20, priority: 8, name: 'Markov bậc 1' });
      factors.push('Markov bậc 1 → Tài');
    } else if (nextProbTai < 0.40) {
      predictions.push({ prediction: 'Xỉu', confidence: 70 + (0.5 - nextProbTai) * 20, priority: 8, name: 'Markov bậc 1' });
      factors.push('Markov bậc 1 → Xỉu');
    }
  }

  // Markov bậc 2
  if (results.length >= 2) {
    const key2 = results[1] + results[0];
    const m2 = learningData[type].markov2Matrix;
    const tCount = m2[key2 + 'Tài'] || 0;
    const xCount = m2[key2 + 'Xỉu'] || 0;
    const totalM2 = tCount + xCount;
    if (totalM2 >= 2) {
      const probTai = tCount / totalM2;
      if (probTai >= 0.7) {
        predictions.push({ prediction: 'Tài', confidence: 75, priority: 9, name: 'Markov bậc 2' });
        factors.push('Markov bậc 2 → Tài');
      } else if (probTai <= 0.3) {
        predictions.push({ prediction: 'Xỉu', confidence: 75, priority: 9, name: 'Markov bậc 2' });
        factors.push('Markov bậc 2 → Xỉu');
      }
    }
  }

  // Các mô hình bổ sung
  const elliott = analyzeElliottWave(results);
  if (elliott) { predictions.push(elliott); factors.push(elliott.name); }

  const sr = analyzeSupportResistance(data);
  if (sr) { predictions.push(sr); factors.push(sr.name); }

  // Chạy các bộ lọc cầu
  const patternFunctions = [
    analyzeCauBet, analyzeCauDao11, analyzeCau22, analyzeCau33, analyzeCau121, analyzeCau123,
    analyzeCau321, analyzeCauNhayCoc, analyzeCauNhipNghieng, analyzeCau3Van1, analyzeSmartBet,
    analyzeBreakStreak, analyzeTriplePattern, analyzeTongPhanTich, analyzeXuHuongManh, analyzeDaoChieu
  ];

  for (let fn of patternFunctions) {
    let p = fn(results, type);
    if (p && p.detected) {
      predictions.push({ ...p, priority: p.priority || 5 });
      if (p.name) factors.push(p.name);
    }
  }

  // Ensemble tính điểm tối ưu trọng số học máy
  let taiScore = 0, xiuScore = 0;
  for (const p of predictions) {
    const patId = getPatternIdFromName(p.name);
    const weight = (patId && learningData[type].patternWeights[patId]) ? learningData[type].patternWeights[patId] : 1.0;
    const conf = p.confidence * weight;
    if (p.prediction === 'Tài') taiScore += conf * (p.priority || 5);
    else xiuScore += conf * (p.priority || 5);
  }

  // Cơ chế Reversal dựa trên chuỗi thua liên tiếp để bẻ cầu thông minh
  const streak = learningData[type].streakAnalysis.currentStreak;
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  
  if (streak <= -3 && !learningData[type].reversalState.active) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    learningData[type].reversalState = { active: true, streakTrigger: streak };
    factors.push('🔄 REVERSAL MODE ACTIVE (Auto-Switch)');
  } else if (streak > 0 && learningData[type].reversalState.active) {
    learningData[type].reversalState.active = false;
  }

  // Tính độ tin cậy cuối cùng chuẩn xác hơn
  let baseConf = 68;
  const topPatterns = predictions.sort((a, b) => b.priority - a.priority).slice(0, 3);
  for (const p of topPatterns) {
    if (p.prediction === finalPrediction) baseConf += (p.confidence - 65) * 0.3;
  }
  
  const agreement = predictions.length > 0 ? (finalPrediction === 'Tài' ? predictions.filter(p => p.prediction === 'Tài').length : predictions.filter(p => p.prediction === 'Xỉu').length) / predictions.length : 0.5;
  baseConf += agreement * 15;
  let finalConf = Math.min(95, Math.max(60, Math.round(baseConf)));

  return {
    prediction: finalPrediction,
    confidence: finalConf,
    factors: factors.slice(0, 8),
    allPatterns: predictions.map(p => p.name).slice(0, 5),
    detailedAnalysis: {
      totalPatterns: predictions.length,
      taiVotes: predictions.filter(p => p.prediction === 'Tài').length,
      xiuVotes: predictions.filter(p => p.prediction === 'Xỉu').length,
      topPattern: topPatterns[0]?.name || 'N/A',
      learningStats: {
        accuracy: learningData[type].totalPredictions ? (learningData[type].correctPredictions / learningData[type].totalPredictions * 100).toFixed(1) + '%' : '0.0%',
        currentStreak: streak
      }
    }
  };
}

// === TỰ ĐỘNG XÁC THỰC & HỌC TẬP ===
async function verifyPredictions(type, currentData) {
  let updated = false;
  for (let pred of learningData[type].predictions) {
    if (pred.verified) continue;
    const actual = currentData.find(d => d.Phien.toString() === pred.phien);
    if (actual) {
      pred.verified = true;
      pred.actual = actual.Ket_qua;
      pred.isCorrect = (pred.prediction === pred.actual);
      
      if (pred.isCorrect) {
        learningData[type].correctPredictions++;
        let streak = learningData[type].streakAnalysis;
        streak.currentStreak = streak.currentStreak > 0 ? streak.currentStreak + 1 : 1;
        if (streak.currentStreak > streak.bestStreak) streak.bestStreak = streak.currentStreak;
      } else {
        let streak = learningData[type].streakAnalysis;
        streak.currentStreak = streak.currentStreak < 0 ? streak.currentStreak - 1 : -1;
        if (streak.currentStreak < streak.worstStreak) streak.worstStreak = streak.currentStreak;
      }

      // Cập nhật trọng số pattern dựa trên kết quả thực tế
      if (pred.patterns) {
        pred.patterns.forEach(pName => {
          const patId = getPatternIdFromName(pName);
          if (patId) {
            if (!learningData[type].patternStats[patId]) {
              learningData[type].patternStats[patId] = { total: 0, correct: 0 };
            }
            learningData[type].patternStats[patId].total++;
            if (pred.isCorrect) learningData[type].patternStats[patId].correct++;
            
            const stats = learningData[type].patternStats[patId];
            const acc = stats.correct / stats.total;
            learningData[type].patternWeights[patId] = Math.min(2.2, Math.max(0.3, acc * 1.8));
          }
        });
      }
      updated = true;
    }
  }
  if (updated) saveLearningData();
}

function recordPrediction(type, phien, prediction, confidence, patterns) {
  learningData[type].predictions.unshift({
    phien: phien.toString(),
    prediction, confidence, patterns,
    timestamp: new Date().toISOString(),
    verified: false, actual: null, isCorrect: null
  });
  learningData[type].totalPredictions++;
  if (learningData[type].predictions.length > 300) learningData[type].predictions.pop();
  saveLearningData();
}

function savePredictionToHistory(type, phien, prediction, confidence, latestData) {
  const record = {
    Phien: latestData.Phien,
    Xuc_xac_1: latestData.Xuc_xac_1,
    Xuc_xac_2: latestData.Xuc_xac_2,
    Xuc_xac_3: latestData.Xuc_xac_3,
    Tong: latestData.Tong,
    Ket_qua: latestData.Ket_qua,
    Do_tin_cay: `${confidence}%`,
    Phien_hien_tai: phien.toString(),
    Du_doan: prediction,
    ket_qua_du_doan: '',
    id: '@Tskhang',
    timestamp: new Date().toISOString()
  };
  predictionHistory[type].unshift(record);
  if (predictionHistory[type].length > MAX_HISTORY) predictionHistory[type].pop();
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
app.get('/', (req, res) => res.send('t.me/Tskhang - Optimized Prediction Engine Active'));

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
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ type: 'HU Learning', totalPredictions: stats.totalPredictions, correctPredictions: stats.correctPredictions, accuracy: acc + '%', streakAnalysis: stats.streakAnalysis, id: '@Tskhang' });
});

app.get('/md5/Hochoi', (req, res) => {
  const stats = learningData.md5;
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ type: 'MD5 Learning', totalPredictions: stats.totalPredictions, correctPredictions: stats.correctPredictions, accuracy: acc + '%', streakAnalysis: stats.streakAnalysis, id: '@Tskhang' });
});

app.get('/Resetdata', (req, res) => {
  learningData = {
    hu: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, volatility: 0 },
    md5: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, volatility: 0 }
  };
  saveLearningData();
  res.json({ message: 'Learning data reset successfully', id: '@Tskhang' });
});

// KHỞI ĐỘNG
loadLearningData();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server @Tskhang running on http://0.0.0.0:${PORT}`);
  console.log('✅ Đã nâng cấp thuật toán: Tối ưu trọng số học máy, chống nhiễu Markov và tự động bẻ chuỗi.');
  startAutoSaveTask();
});
