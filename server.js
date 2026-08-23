const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const LEARNING_FILE = 'Tskhang.json';
const HISTORY_FILE = 'Tskhang1.json';

let predictionHistory = { hu: [], md5: [] };
const MAX_HISTORY = 100;
const AUTO_SAVE_INTERVAL = 30000;
let lastProcessedPhien = { hu: null, md5: null };

// ==================== CẤU TRÚC LEARNING DATA SIÊU NÂNG CẤP ====================
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
    markovMatrix3: {},   // Markov bậc 3 (3 phiên)
    markovMatrix4: {},   // Markov bậc 4 (4 phiên)
    markovMatrix5: {},   // Markov bậc 5 (5 phiên)
    volatility: 0,
    // === NÂNG CẤP: Phân tích chuỗi dài ===
    sequencePatterns: {},   // Pattern 10-15 phiên
    windowPatterns: {},     // Pattern theo cửa sổ trượt
    trendStrength: 0,
    momentum: 0,
    supportResistance: { support: [], resistance: [] },
    fibonacciLevels: [],
    patternConfidence: {},
    patternSuccessRate: {},
    patternLastUsed: {},
    patternTrend: {},
    optimalThresholds: {
      minConfidence: 0.55,
      minOccurrences: 3,
      maxStreakBreak: 5,
      windowSize: 12  // Cửa sổ phân tích mặc định
    },
    correlationMatrix: {},
    seasonalPatterns: [],
    anomalyThreshold: 0.15,
    bayesianPrior: { Tài: 0.5, Xỉu: 0.5 },
    kalmanFilter: {
      estimate: 0.5,
      error: 1,
      processNoise: 0.01,
      measurementNoise: 0.1
    },
    ensembleHistory: [],
    // === Lưu lịch sử 15 phiên gần nhất ===
    last15Results: [],
    last15Sums: [],
    windowAccuracy: []  // Độ chính xác theo từng cửa sổ
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
    markovMatrix3: {},
    markovMatrix4: {},
    markovMatrix5: {},
    volatility: 0,
    sequencePatterns: {},
    windowPatterns: {},
    trendStrength: 0,
    momentum: 0,
    supportResistance: { support: [], resistance: [] },
    fibonacciLevels: [],
    patternConfidence: {},
    patternSuccessRate: {},
    patternLastUsed: {},
    patternTrend: {},
    optimalThresholds: {
      minConfidence: 0.55,
      minOccurrences: 3,
      maxStreakBreak: 5,
      windowSize: 12
    },
    correlationMatrix: {},
    seasonalPatterns: [],
    anomalyThreshold: 0.15,
    bayesianPrior: { Tài: 0.5, Xỉu: 0.5 },
    kalmanFilter: {
      estimate: 0.5,
      error: 1,
      processNoise: 0.01,
      measurementNoise: 0.1
    },
    ensembleHistory: [],
    last15Results: [],
    last15Sums: [],
    windowAccuracy: []
  }
};

// ==================== HÀM LOAD/SAVE ====================
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

// ==================== HÀM LẤY DỮ LIỆU API ====================
function transformApiData(apiData) {
  if (!apiData || !Array.isArray(apiData.list)) return null;

  const rows = apiData.list
    .filter(item =>
      item &&
      item.id !== undefined &&
      Array.isArray(item.dices) &&
      item.dices.length >= 3 &&
      (item.resultTruyenThong === 'TAI' || item.resultTruyenThong === 'XIU') &&
      Number.isFinite(Number(item.point))
    )
    .map(item => ({
      Phien: Number(item.id),
      Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
      Xuc_xac_1: Number(item.dices[0]),
      Xuc_xac_2: Number(item.dices[1]),
      Xuc_xac_3: Number(item.dices[2]),
      Tong: Number(item.point)
    }))
    .filter(item => Number.isFinite(item.Phien));

  return rows.length ? rows : null;
}

async function getApiData(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800 * attempt));
    }
  }
  throw lastError || new Error('API request failed');
}

async function fetchDataHu() {
  try {
    const responseData = await getApiData(API_URL_HU);
    return transformApiData(responseData);
  } catch (error) {
    console.error('Error fetching HU data:', error.message);
    return null;
  }
}

async function fetchDataMd5() {
  try {
    const responseData = await getApiData(API_URL_MD5);
    return transformApiData(responseData);
  } catch (error) {
    console.error('Error fetching MD5 data:', error.message);
    return null;
  }
}

// ==================== HÀM PHÂN TÍCH CẦU NÂNG CẤP (DỰA TRÊN 10-15 PHIÊN) ====================

// 1. Phân tích cầu bệt với xác suất có điều kiện dựa trên 15 phiên
function analyzeCauBet(results, type) {
  if (results.length < 3) return { detected: false };
  
  // Lấy 15 phiên gần nhất để phân tích
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  let streakType = recentResults[0];
  let streakLength = 1;
  for (let i = 1; i < recentResults.length; i++) {
    if (recentResults[i] === streakType) streakLength++;
    else break;
  }
  
  if (streakLength >= 3) {
    // Tính xác suất break dựa trên lịch sử 15 phiên
    const historicalBreak = calculateBreakProbability15(type, streakType, streakLength);
    const shouldBreak = historicalBreak > 0.50 || streakLength >= 6;
    const confidence = Math.min(92, 58 + streakLength * 3 + historicalBreak * 20);
    
    return {
      detected: true,
      prediction: shouldBreak ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: confidence,
      name: `Cầu Bệt ${streakLength} phiên (${windowSize}p)`,
      priority: 9,
      weight: 1.0 + (streakLength - 3) * 0.12
    };
  }
  return { detected: false };
}

// 2. Phân tích cầu đảo 1-1 với chuỗi dài
function analyzeCauDao11(results, type) {
  if (results.length < 4) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  let alternatingLength = 1;
  for (let i = 1; i < recentResults.length; i++) {
    if (recentResults[i] !== recentResults[i - 1]) alternatingLength++;
    else break;
  }
  
  if (alternatingLength >= 4) {
    // Phân tích pattern đảo chiều trong 15 phiên
    const patternStrength = analyzeAlternatingPattern(recentResults, alternatingLength);
    const baseConfidence = 58 + alternatingLength * 2.5 + patternStrength * 15;
    const confidence = Math.min(88, baseConfidence);
    
    return {
      detected: true,
      prediction: recentResults[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: confidence,
      name: `Cầu Đảo 1-1 (${alternatingLength}/${windowSize}p)`,
      priority: 8,
      weight: 1.0 + (alternatingLength - 4) * 0.1
    };
  }
  return { detected: false };
}

// 3. Phân tích cầu 2-2 với cửa sổ 15 phiên
function analyzeCau22(results, type) {
  if (results.length < 6) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  let pairCount = 0, i = 0, pattern = [];
  while (i < recentResults.length - 1 && pairCount < 5) {
    if (recentResults[i] === recentResults[i + 1]) {
      pattern.push(recentResults[i]);
      pairCount++;
      i += 2;
    } else break;
  }
  
  if (pairCount >= 2) {
    let isAlternating = true;
    for (let j = 1; j < pattern.length; j++) {
      if (pattern[j] === pattern[j - 1]) isAlternating = false;
    }
    
    if (isAlternating) {
      const lastPairType = pattern[pattern.length - 1];
      const pairChangeProb = calculatePairChangeProbability15(type, lastPairType);
      const confidence = Math.min(85, 58 + pairCount * 3.5 + pairChangeProb * 18);
      
      return {
        detected: true,
        prediction: lastPairType === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: confidence,
        name: `Cầu 2-2 (${pairCount} cặp/${windowSize}p)`,
        priority: 7,
        weight: 1.0 + (pairCount - 2) * 0.08
      };
    }
  }
  return { detected: false };
}

// 4. Phân tích cầu 3-3 với 15 phiên
function analyzeCau33(results, type) {
  if (results.length < 6) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  let tripleCount = 0, i = 0, pattern = [];
  while (i < recentResults.length - 2) {
    if (recentResults[i] === recentResults[i + 1] && recentResults[i + 1] === recentResults[i + 2]) {
      pattern.push(recentResults[i]);
      tripleCount++;
      i += 3;
    } else break;
  }
  
  if (tripleCount >= 1) {
    const currentPosition = recentResults.length % 3;
    const lastTripleType = pattern[pattern.length - 1];
    let prediction;
    if (currentPosition === 0) {
      prediction = lastTripleType === 'Tài' ? 'Xỉu' : 'Tài';
    } else {
      prediction = lastTripleType;
    }
    
    // Phân tích xu hướng trong 15 phiên
    const trendStrength = analyzeTrendStrength(recentResults);
    const confidence = Math.min(88, 62 + tripleCount * 5 + trendStrength * 10);
    
    return {
      detected: true,
      prediction: prediction,
      confidence: confidence,
      name: `Cầu 3-3 (${tripleCount} bộ ba/${windowSize}p)`,
      priority: 7,
      weight: 1.0 + (tripleCount - 1) * 0.08
    };
  }
  return { detected: false };
}

// 5. Phân tích cầu 1-2-1 với 15 phiên
function analyzeCau121(results, type) {
  if (results.length < 4) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Tìm pattern 1-2-1 trong cửa sổ 15 phiên
  for (let start = 0; start <= recentResults.length - 4; start++) {
    const pattern = recentResults.slice(start, start + 4);
    if (pattern[0] !== pattern[1] && pattern[1] === pattern[2] && pattern[2] !== pattern[3] && pattern[0] === pattern[3]) {
      const repeatProb = calculatePatternRepeatProbability15(type, pattern);
      const confidence = Math.min(82, 60 + repeatProb * 20);
      return { 
        detected: true, 
        prediction: pattern[0], 
        confidence: confidence, 
        name: `Cầu 1-2-1 (vị trí ${start+1}/${windowSize}p)`, 
        priority: 6,
        weight: 1.0
      };
    }
  }
  return { detected: false };
}

// 6. Phân tích xu hướng tổng thể trong 15 phiên
function analyzeOverallTrend(results, type) {
  if (results.length < 10) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  const taiCount = recentResults.filter(r => r === 'Tài').length;
  const ratio = taiCount / windowSize;
  
  // Tính momentum
  const momentum = analyzeMomentum(recentResults);
  
  // Phân tích xu hướng
  if (ratio >= 0.7) {
    const confidence = 65 + (ratio - 0.5) * 40 + Math.abs(momentum) * 10;
    return {
      detected: true,
      prediction: ratio >= 0.8 ? 'Xỉu' : 'Tài', // Nếu quá lệch thì đảo
      confidence: Math.min(85, confidence),
      name: `Xu hướng ${windowSize}p: ${(ratio*100).toFixed(0)}% Tài`,
      priority: 8,
      weight: 1.0 + (ratio - 0.5) * 0.5
    };
  }
  if (ratio <= 0.3) {
    const confidence = 65 + (0.5 - ratio) * 40 + Math.abs(momentum) * 10;
    return {
      detected: true,
      prediction: ratio <= 0.2 ? 'Tài' : 'Xỉu',
      confidence: Math.min(85, confidence),
      name: `Xu hướng ${windowSize}p: ${((1-ratio)*100).toFixed(0)}% Xỉu`,
      priority: 8,
      weight: 1.0 + (0.5 - ratio) * 0.5
    };
  }
  return { detected: false };
}

// 7. Phân tích Fibonacci với tổng điểm 15 phiên
function analyzeFibonacciLevels(data, type) {
  if (data.length < 10) return { detected: false };
  
  const windowSize = Math.min(15, data.length);
  const recentData = data.slice(0, windowSize);
  const sums = recentData.map(d => d.Tong);
  
  const minSum = Math.min(...sums);
  const maxSum = Math.max(...sums);
  const range = maxSum - minSum;
  
  // Fibonacci levels
  const levels = {
    '0.236': minSum + range * 0.236,
    '0.382': minSum + range * 0.382,
    '0.5': minSum + range * 0.5,
    '0.618': minSum + range * 0.618,
    '0.786': minSum + range * 0.786
  };
  
  const lastSum = sums[0];
  const nextSum = lastSum + (sums[0] - sums[1]) * 0.5; // Dự đoán tổng tiếp theo
  
  // Kiểm tra Fibonacci retracement
  for (const [level, value] of Object.entries(levels)) {
    if (Math.abs(nextSum - value) < 0.5) {
      const direction = nextSum > lastSum ? 'Tài' : 'Xỉu';
      const confidence = 60 + (1 - Math.abs(parseFloat(level) - 0.5) * 2) * 20;
      return {
        detected: true,
        prediction: direction,
        confidence: Math.min(80, confidence),
        name: `Fibonacci ${level} (${value.toFixed(1)})`,
        priority: 7,
        weight: 1.0
      };
    }
  }
  return { detected: false };
}

// 8. Phân tích cửa sổ trượt 10-15 phiên
function analyzeSlidingWindow(results, type) {
  if (results.length < 10) return { detected: false };
  
  const windowSizes = [10, 12, 15];
  let predictions = [];
  
  for (const size of windowSizes) {
    if (results.length < size) continue;
    const window = results.slice(0, size);
    const taiCount = window.filter(r => r === 'Tài').length;
    const ratio = taiCount / size;
    
    // Dự đoán dựa trên phân phối
    if (ratio > 0.6) {
      predictions.push({ prediction: 'Xỉu', weight: ratio - 0.5, size: size });
    } else if (ratio < 0.4) {
      predictions.push({ prediction: 'Tài', weight: 0.5 - ratio, size: size });
    }
  }
  
  if (predictions.length >= 2) {
    // Đếm số lượng dự đoán cho mỗi kết quả
    const taiVotes = predictions.filter(p => p.prediction === 'Tài').length;
    const xiuVotes = predictions.filter(p => p.prediction === 'Xỉu').length;
    
    if (taiVotes > xiuVotes) {
      const avgWeight = predictions.filter(p => p.prediction === 'Tài').reduce((sum, p) => sum + p.weight, 0) / taiVotes;
      return {
        detected: true,
        prediction: 'Tài',
        confidence: Math.min(82, 60 + avgWeight * 40),
        name: `Cửa sổ ${windowSizes.join('-')}p: ${taiVotes}/${predictions.length} Tài`,
        priority: 8,
        weight: 1.0 + avgWeight
      };
    } else if (xiuVotes > taiVotes) {
      const avgWeight = predictions.filter(p => p.prediction === 'Xỉu').reduce((sum, p) => sum + p.weight, 0) / xiuVotes;
      return {
        detected: true,
        prediction: 'Xỉu',
        confidence: Math.min(82, 60 + avgWeight * 40),
        name: `Cửa sổ ${windowSizes.join('-')}p: ${xiuVotes}/${predictions.length} Xỉu`,
        priority: 8,
        weight: 1.0 + avgWeight
      };
    }
  }
  return { detected: false };
}

// 9. Phân tích cầu nhảy cóc nâng cao với 15 phiên
function analyzeCauNhayCoc(results, type) {
  if (results.length < 6) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Phân tích nhiều khoảng cách khác nhau
  for (let step = 2; step <= 4; step++) {
    const skipPattern = [];
    for (let i = 0; i < recentResults.length; i += step) {
      if (skipPattern.length < 5) skipPattern.push(recentResults[i]);
    }
    
    if (skipPattern.length >= 3) {
      const allSame = skipPattern.every(r => r === skipPattern[0]);
      if (allSame) {
        const confidence = 60 + (skipPattern.length - 3) * 5;
        return { 
          detected: true, 
          prediction: skipPattern[0], 
          confidence: Math.min(80, confidence), 
          name: `Cầu Nhảy Cóc (step ${step}/${windowSize}p)`, 
          priority: 5,
          weight: 1.0
        };
      }
      
      let alternating = true;
      for (let i = 1; i < skipPattern.length - 1; i++) {
        if (skipPattern[i] === skipPattern[i - 1]) alternating = false;
      }
      if (alternating && skipPattern.length >= 3) {
        const confidence = 58 + (skipPattern.length - 3) * 4;
        return { 
          detected: true, 
          prediction: skipPattern[0] === 'Tài' ? 'Xỉu' : 'Tài', 
          confidence: Math.min(78, confidence), 
          name: `Cầu Nhảy Cóc Đảo (step ${step})`, 
          priority: 5,
          weight: 1.0
        };
      }
    }
  }
  return { detected: false };
}

// 10. Phân tích cầu 3 ván 1 với 15 phiên
function analyzeCau3Van1(results, type) {
  if (results.length < 4) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Tìm pattern 3-1 trong cửa sổ trượt
  for (let start = 0; start <= recentResults.length - 4; start++) {
    const window = recentResults.slice(start, start + 4);
    const taiCount = window.filter(r => r === 'Tài').length;
    
    if (taiCount === 3) {
      const confidence = 62 + (windowSize - start) * 0.5;
      return { 
        detected: true, 
        prediction: 'Xỉu', 
        confidence: Math.min(80, confidence), 
        name: `Cầu 3T-1X (vị trí ${start+1})`, 
        priority: 5,
        weight: 1.0
      };
    }
    if (taiCount === 1) {
      const confidence = 62 + (windowSize - start) * 0.5;
      return { 
        detected: true, 
        prediction: 'Tài', 
        confidence: Math.min(80, confidence), 
        name: `Cầu 3X-1T (vị trí ${start+1})`, 
        priority: 5,
        weight: 1.0
      };
    }
  }
  return { detected: false };
}

// 11. Smart Bet với phân tích xu hướng 15 phiên
function analyzeSmartBet(results, type) {
  if (results.length < 15) return { detected: false };
  
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Phân tích 3 cửa sổ: 5 phiên, 10 phiên, 15 phiên
  const window5 = recentResults.slice(0, 5);
  const window10 = recentResults.slice(0, 10);
  const window15 = recentResults.slice(0, 15);
  
  const tai5 = window5.filter(r => r === 'Tài').length;
  const tai10 = window10.filter(r => r === 'Tài').length;
  const tai15 = window15.filter(r => r === 'Tài').length;
  
  const ratios = [tai5/5, tai10/10, tai15/15];
  const trend = ratios[2] - ratios[0]; // Xu hướng thay đổi
  
  // Phát hiện đảo chiều xu hướng
  if (Math.abs(trend) > 0.2 && Math.abs(ratios[2] - 0.5) > 0.1) {
    const direction = ratios[2] > 0.5 ? 'Xỉu' : 'Tài';
    const confidence = 62 + Math.abs(trend) * 30 + Math.abs(ratios[2] - 0.5) * 20;
    return {
      detected: true,
      prediction: direction,
      confidence: Math.min(88, confidence),
      name: `Smart Bet (5:${tai5}/5, 10:${tai10}/10, 15:${tai15}/15)`,
      priority: 9,
      weight: 1.0 + Math.abs(trend) * 0.5
    };
  }
  
  // Phát hiện xu hướng cực đoan
  if (tai15 >= 12 || tai15 <= 3) {
    const direction = tai15 >= 12 ? 'Xỉu' : 'Tài';
    const extreme = Math.abs(tai15 - 7.5) / 7.5;
    const confidence = 65 + extreme * 25;
    return {
      detected: true,
      prediction: direction,
      confidence: Math.min(90, confidence),
      name: `Xu hướng cực (${tai15}/15 Tài)`,
      priority: 10,
      weight: 1.0 + extreme * 0.3
    };
  }
  
  return { detected: false };
}

// 12. Phân tích tổng với 15 phiên và Kalman Filter
function analyzeTongPhanTich(data, type) {
  if (data.length < 10) return { detected: false };
  
  const windowSize = Math.min(15, data.length);
  const recentData = data.slice(0, windowSize);
  const sums = recentData.map(d => d.Tong);
  const results = recentData.map(d => d.Ket_qua);
  
  // Thống kê tổng
  const avgSum = sums.reduce((a, b) => a + b, 0) / sums.length;
  const stdDev = Math.sqrt(sums.reduce((a, b) => a + Math.pow(b - avgSum, 2), 0) / sums.length);
  
  // Phân tích xu hướng tổng
  const first5 = sums.slice(10, 15).reduce((a, b) => a + b, 0) / 5;
  const last5 = sums.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const sumTrend = last5 - first5;
  
  // Áp dụng Kalman filter
  const kalman = learningData[type].kalmanFilter;
  kalman.estimate = kalman.estimate + kalman.processNoise;
  kalman.error = kalman.error + kalman.processNoise;
  const kalmanGain = kalman.error / (kalman.error + kalman.measurementNoise);
  kalman.estimate = kalman.estimate + kalmanGain * (sumTrend - kalman.estimate);
  kalman.error = (1 - kalmanGain) * kalman.error;
  
  const filteredTrend = kalman.estimate;
  
  // Dự đoán dựa trên tổng
  if (filteredTrend > 1.5) {
    const confidence = 62 + Math.abs(filteredTrend) * 8 + (stdDev < 2 ? 10 : 0);
    return { 
      detected: true, 
      prediction: 'Xỉu', 
      confidence: Math.min(85, confidence), 
      name: `Tổng tăng ${filteredTrend.toFixed(1)} (${windowSize}p)`, 
      priority: 11,
      weight: 1.1
    };
  }
  if (filteredTrend < -1.5) {
    const confidence = 62 + Math.abs(filteredTrend) * 8 + (stdDev < 2 ? 10 : 0);
    return { 
      detected: true, 
      prediction: 'Tài', 
      confidence: Math.min(85, confidence), 
      name: `Tổng giảm ${Math.abs(filteredTrend).toFixed(1)} (${windowSize}p)`, 
      priority: 11,
      weight: 1.1
    };
  }
  
  // Phân tích độ lệch
  const taiCount = results.filter(r => r === 'Tài').length;
  if (Math.abs(taiCount - windowSize/2) >= 3) {
    const lech = taiCount > windowSize/2 ? 'Tài' : 'Xỉu';
    const prediction = lech === 'Tài' ? 'Xỉu' : 'Tài';
    const confidence = 60 + Math.abs(taiCount - windowSize/2) * 3;
    return { 
      detected: true, 
      prediction: prediction, 
      confidence: Math.min(80, confidence), 
      name: `Lệch ${Math.abs(taiCount - windowSize/2)}/${windowSize} về ${lech}`, 
      priority: 10,
      weight: 1.0
    };
  }
  return { detected: false };
}

// ==================== HÀM HỖ TRỢ PHÂN TÍCH 15 PHIÊN ====================

// Tính xác suất break dựa trên 15 phiên
function calculateBreakProbability15(type, streakType, streakLength) {
  const data = learningData[type];
  const key = `break15_${streakType}_${Math.min(streakLength, 10)}`;
  
  if (!data.patternStats[key]) {
    data.patternStats[key] = { total: 0, correct: 0 };
    return 0.48;
  }
  
  const stats = data.patternStats[key];
  if (stats.total < 5) return 0.48;
  return stats.correct / stats.total;
}

// Phân tích độ mạnh của pattern đảo
function analyzeAlternatingPattern(results, length) {
  if (results.length < length) return 0.5;
  
  let strength = 0;
  for (let i = 0; i < Math.min(length, results.length - 1); i++) {
    if (results[i] !== results[i + 1]) strength++;
  }
  return strength / Math.min(length, results.length - 1);
}

// Phân tích momentum trong 15 phiên
function analyzeMomentum(results) {
  if (results.length < 5) return 0;
  
  const windowSize = Math.min(15, results.length);
  const recent = results.slice(0, windowSize);
  
  let momentum = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] === 'Tài' && recent[i + 1] === 'Tài') momentum += 1;
    else if (recent[i] === 'Xỉu' && recent[i + 1] === 'Xỉu') momentum -= 1;
    else momentum *= 0.5; // Giảm dần
  }
  
  return momentum / windowSize;
}

// Phân tích độ mạnh xu hướng
function analyzeTrendStrength(results) {
  if (results.length < 5) return 0;
  
  const windowSize = Math.min(15, results.length);
  const recent = results.slice(0, windowSize);
  
  let strength = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] === recent[i + 1]) strength++;
    else strength--;
  }
  
  return strength / (windowSize - 1);
}

// Tính xác suất thay đổi cặp trong 15 phiên
function calculatePairChangeProbability15(type, pairType) {
  const data = learningData[type];
  const key = `pair_change15_${pairType}`;
  
  if (!data.patternStats[key]) {
    data.patternStats[key] = { total: 0, correct: 0 };
    return 0.52;
  }
  
  const stats = data.patternStats[key];
  if (stats.total < 3) return 0.52;
  return stats.correct / stats.total;
}

// Tính xác suất lặp pattern trong 15 phiên
function calculatePatternRepeatProbability15(type, pattern) {
  const data = learningData[type];
  const key = `repeat15_${pattern.join('_')}`;
  
  if (!data.patternStats[key]) {
    data.patternStats[key] = { total: 0, correct: 0 };
    return 0.5;
  }
  
  const stats = data.patternStats[key];
  if (stats.total < 3) return 0.5;
  return stats.correct / stats.total;
}

// ==================== HÀM CẬP NHẬT MARKOV BẬC CAO ====================

function updateMarkovMatrices(type, results) {
  if (!Array.isArray(results) || results.length < 2 || !learningData[type]) return;

  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Markov bậc 1
  const counts = { TT: 0, TX: 0, XT: 0, XX: 0 };
  for (let i = 0; i < recentResults.length - 1; i++) {
    const a = recentResults[i], b = recentResults[i + 1];
    if (a === 'Tài' && b === 'Tài') counts.TT++;
    else if (a === 'Tài' && b === 'Xỉu') counts.TX++;
    else if (a === 'Xỉu' && b === 'Tài') counts.XT++;
    else if (a === 'Xỉu' && b === 'Xỉu') counts.XX++;
  }

  const total = recentResults.length - 1;
  learningData[type].markovMatrix = {
    TT: total > 0 ? counts.TT / total : 0.5,
    TX: total > 0 ? counts.TX / total : 0.5,
    XT: total > 0 ? counts.XT / total : 0.5,
    XX: total > 0 ? counts.XX / total : 0.5
  };

  // Markov bậc 3 (3 phiên)
  const markov3 = {};
  for (let i = 0; i < recentResults.length - 3; i++) {
    const key = recentResults[i] + recentResults[i+1] + recentResults[i+2];
    const next = recentResults[i+3];
    const k = key + next;
    markov3[k] = (markov3[k] || 0) + 1;
  }
  learningData[type].markovMatrix3 = markov3;

  // Markov bậc 4 (4 phiên)
  const markov4 = {};
  for (let i = 0; i < recentResults.length - 4; i++) {
    const key = recentResults[i] + recentResults[i+1] + recentResults[i+2] + recentResults[i+3];
    const next = recentResults[i+4];
    const k = key + next;
    markov4[k] = (markov4[k] || 0) + 1;
  }
  learningData[type].markovMatrix4 = markov4;

  // Markov bậc 5 (5 phiên)
  const markov5 = {};
  for (let i = 0; i < recentResults.length - 5; i++) {
    const key = recentResults[i] + recentResults[i+1] + recentResults[i+2] + recentResults[i+3] + recentResults[i+4];
    const next = recentResults[i+5];
    const k = key + next;
    markov5[k] = (markov5[k] || 0) + 1;
  }
  learningData[type].markovMatrix5 = markov5;

  // Lưu 15 phiên gần nhất
  learningData[type].last15Results = recentResults;
  learningData[type].last15Sums = results.slice(0, windowSize).map(d => d.Tong);
}

// ==================== HÀM DỰ ĐOÁN CHÍNH NÂNG CẤP ====================

function calculateAdvancedPrediction(data, type) {
  const results = data.map(d => d.Ket_qua);
  const sums = data.map(d => d.Tong);
  
  // Cập nhật tất cả mô hình với 15 phiên
  updateMarkovMatrices(type, results);
  updateBayesianPrior(type, results);
  
  let predictions = [];
  let factors = [];
  let patternScores = { Tài: 0, Xỉu: 0 };
  let totalWeight = 0;
  
  // === 1. MARKOV BẬC CAO (3-5 phiên) ===
  const windowSize = Math.min(15, results.length);
  const recentResults = results.slice(0, windowSize);
  
  // Markov bậc 3
  if (recentResults.length >= 3) {
    const key3 = recentResults[0] + recentResults[1] + recentResults[2];
    const markov3 = learningData[type].markovMatrix3;
    const countTai = markov3[key3 + 'Tài'] || 0;
    const countXiu = markov3[key3 + 'Xỉu'] || 0;
    const total = countTai + countXiu;
    
    if (total >= 2) {
      const probTai = countTai / total;
      if (Math.abs(probTai - 0.5) > 0.15) {
        const conf = 60 + Math.abs(probTai - 0.5) * 35;
        if (probTai > 0.5) {
          predictions.push({ prediction: 'Tài', confidence: Math.min(88, conf), priority: 9, name: 'Markov bậc 3' });
          factors.push(`Markov b3 → Tài (${(probTai*100).toFixed(0)}%)`);
          patternScores.Tài += conf * 1.4;
        } else {
          predictions.push({ prediction: 'Xỉu', confidence: Math.min(88, conf), priority: 9, name: 'Markov bậc 3' });
          factors.push(`Markov b3 → Xỉu (${((1-probTai)*100).toFixed(0)}%)`);
          patternScores.Xỉu += conf * 1.4;
        }
        totalWeight += 1.4;
      }
    }
  }
  
  // Markov bậc 4
  if (recentResults.length >= 4) {
    const key4 = recentResults[0] + recentResults[1] + recentResults[2] + recentResults[3];
    const markov4 = learningData[type].markovMatrix4;
    const countTai = markov4[key4 + 'Tài'] || 0;
    const countXiu = markov4[key4 + 'Xỉu'] || 0;
    const total = countTai + countXiu;
    
    if (total >= 2) {
      const probTai = countTai / total;
      if (Math.abs(probTai - 0.5) > 0.2) {
        const conf = 62 + Math.abs(probTai - 0.5) * 38;
        if (probTai > 0.5) {
          predictions.push({ prediction: 'Tài', confidence: Math.min(90, conf), priority: 10, name: 'Markov bậc 4' });
          factors.push(`Markov b4 → Tài (${(probTai*100).toFixed(0)}%)`);
          patternScores.Tài += conf * 1.6;
        } else {
          predictions.push({ prediction: 'Xỉu', confidence: Math.min(90, conf), priority: 10, name: 'Markov bậc 4' });
          factors.push(`Markov b4 → Xỉu (${((1-probTai)*100).toFixed(0)}%)`);
          patternScores.Xỉu += conf * 1.6;
        }
        totalWeight += 1.6;
      }
    }
  }
  
  // Markov bậc 5
  if (recentResults.length >= 5) {
    const key5 = recentResults.slice(0, 5).join('');
    const markov5 = learningData[type].markovMatrix5;
    const countTai = markov5[key5 + 'Tài'] || 0;
    const countXiu = markov5[key5 + 'Xỉu'] || 0;
    const total = countTai + countXiu;
    
    if (total >= 2) {
      const probTai = countTai / total;
      if (Math.abs(probTai - 0.5) > 0.25) {
        const conf = 64 + Math.abs(probTai - 0.5) * 40;
        if (probTai > 0.5) {
          predictions.push({ prediction: 'Tài', confidence: Math.min(92, conf), priority: 11, name: 'Markov bậc 5' });
          factors.push(`Markov b5 → Tài (${(probTai*100).toFixed(0)}%)`);
          patternScores.Tài += conf * 1.8;
        } else {
          predictions.push({ prediction: 'Xỉu', confidence: Math.min(92, conf), priority: 11, name: 'Markov bậc 5' });
          factors.push(`Markov b5 → Xỉu (${((1-probTai)*100).toFixed(0)}%)`);
          patternScores.Xỉu += conf * 1.8;
        }
        totalWeight += 1.8;
      }
    }
  }
  
  // === 2. BAYESIAN INFERENCE với 15 phiên ===
  const prior = learningData[type].bayesianPrior;
  const recent10 = recentResults.slice(0, Math.min(10, recentResults.length));
  const likelihoodTai = recent10.filter(r => r === 'Tài').length / recent10.length;
  const likelihoodXiu = 1 - likelihoodTai;
  
  const posteriorTai = (likelihoodTai * prior.Tài) / (likelihoodTai * prior.Tài + likelihoodXiu * prior.Xỉu);
  if (Math.abs(posteriorTai - 0.5) > 0.12) {
    const conf = 56 + Math.abs(posteriorTai - 0.5) * 38;
    if (posteriorTai > 0.5) {
      predictions.push({ prediction: 'Tài', confidence: Math.min(85, conf), priority: 7, name: 'Bayesian' });
      factors.push(`Bayesian → Tài (${(posteriorTai*100).toFixed(0)}%)`);
      patternScores.Tài += conf * 1.2;
    } else {
      predictions.push({ prediction: 'Xỉu', confidence: Math.min(85, conf), priority: 7, name: 'Bayesian' });
      factors.push(`Bayesian → Xỉu (${((1-posteriorTai)*100).toFixed(0)}%)`);
      patternScores.Xỉu += conf * 1.2;
    }
    totalWeight += 1.2;
  }
  
  // === 3. KALMAN FILTER với 15 phiên ===
  const kalman = learningData[type].kalmanFilter;
  const kalmanPrediction = kalman.estimate > 0.5 ? 'Tài' : 'Xỉu';
  const kalmanConf = 53 + Math.abs(kalman.estimate - 0.5) * 45;
  if (Math.abs(kalman.estimate - 0.5) > 0.15) {
    predictions.push({ 
      prediction: kalmanPrediction, 
      confidence: Math.min(82, kalmanConf), 
      priority: 7, 
      name: 'Kalman Filter' 
    });
    factors.push(`Kalman → ${kalmanPrediction} (${(Math.abs(kalman.estimate-0.5)*100+50).toFixed(0)}%)`);
    patternScores[kalmanPrediction] += kalmanConf * 1.1;
    totalWeight += 1.1;
  }
  
  // === 4. CÁC PATTERN TRUYỀN THỐNG NÂNG CẤP (dùng 15 phiên) ===
  const patternFunctions = [
    analyzeCauBet, analyzeCauDao11, analyzeCau22, analyzeCau33, 
    analyzeCau121, analyzeCauNhayCoc, analyzeCau3Van1,
    analyzeOverallTrend, analyzeSlidingWindow,
    analyzeSmartBet, analyzeTongPhanTich, analyzeFibonacciLevels
  ];
  
  for (let fn of patternFunctions) {
    let p = fn(results, type);
    if (p && p.detected) {
      const weight = p.weight || 1.0;
      const adjustedConf = Math.min(95, p.confidence * weight);
      predictions.push({ 
        ...p, 
        confidence: adjustedConf,
        priority: p.priority || 5,
        weight: weight
      });
      if (p.name) factors.push(`${p.name} (${adjustedConf.toFixed(0)}%)`);
      patternScores[p.prediction] += adjustedConf * (p.priority || 5) * weight;
      totalWeight += (p.priority || 5) * weight;
    }
  }
  
  // === 5. ENSEMBLE FINAL ===
  let taiScore = 0, xiuScore = 0;
  let totalConfidence = 0;
  
  for (const p of predictions) {
    const priorityWeight = (p.priority || 5) / 10;
    const dynamicWeight = learningData[type].patternWeights[getPatternIdFromName(p.name)] || 1.0;
    const finalWeight = priorityWeight * dynamicWeight * (p.weight || 1.0);
    
    if (p.prediction === 'Tài') {
      taiScore += p.confidence * finalWeight;
    } else {
      xiuScore += p.confidence * finalWeight;
    }
    totalConfidence += p.confidence * finalWeight;
  }
  
  // === 6. PHÁT HIỆN BẤT THƯỜNG ===
  const anomalyScore = Math.abs(taiScore - xiuScore) / (taiScore + xiuScore + 1);
  learningData[type].anomalyDetected = anomalyScore < 0.12;
  
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  if (learningData[type].anomalyDetected && predictions.length > 0) {
    const topPattern = predictions.reduce((a, b) => a.confidence > b.confidence ? a : b);
    finalPrediction = topPattern.prediction;
    factors.push(`⚠️ Anomaly → Follow: ${topPattern.name}`);
  }
  
  // === 7. REVERSAL DETECTION ===
  const streak = learningData[type].streakAnalysis.currentStreak;
  if (streak <= -3 && !learningData[type].reversalState.active) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    learningData[type].reversalState = { active: true, streakTrigger: streak };
    factors.push('🔄 REVERSAL MODE');
  } else if (streak > 0 && learningData[type].reversalState.active) {
    learningData[type].reversalState.active = false;
  }
  
  // === 8. TÍNH CONFIDENCE CUỐI ===
  let baseConf = 50;
  if (predictions.length > 0) {
    const weightedConf = totalConfidence / (totalWeight || 1);
    baseConf = Math.max(50, Math.min(82, weightedConf));
  }
  
  const recentAcc = learningData[type].recentAccuracy.slice(0, 20);
  if (recentAcc.length > 5) {
    const avgAcc = recentAcc.reduce((a, b) => a + b, 0) / recentAcc.length;
    baseConf += (avgAcc - 0.5) * 25;
  }
  
  const confGap = Math.abs(taiScore - xiuScore) / (taiScore + xiuScore + 1);
  baseConf += confGap * 25;
  
  const volatility = learningData[type].volatility;
  if (volatility > 3.5) baseConf -= 8;
  else if (volatility < 2) baseConf += 8;
  
  let finalConf = Math.min(95, Math.max(45, Math.round(baseConf)));
  
  // === 9. LƯU LỊCH SỬ ===
  learningData[type].ensembleHistory.push({
    prediction: finalPrediction,
    confidence: finalConf,
    taiScore: taiScore,
    xiuScore: xiuScore,
    patterns: predictions.map(p => p.name),
    windowSize: windowSize,
    timestamp: Date.now()
  });
  if (learningData[type].ensembleHistory.length > 100) {
    learningData[type].ensembleHistory.shift();
  }
  
  // Cập nhật window accuracy
  learningData[type].windowAccuracy.push({
    window: windowSize,
    taiRatio: recentResults.filter(r => r === 'Tài').length / windowSize,
    prediction: finalPrediction,
    confidence: finalConf,
    timestamp: Date.now()
  });
  if (learningData[type].windowAccuracy.length > 50) {
    learningData[type].windowAccuracy.shift();
  }
  
  return {
    prediction: finalPrediction,
    confidence: finalConf,
    factors: factors.slice(0, 12),
    allPatterns: predictions.map(p => p.name).slice(0, 8),
    detailedAnalysis: {
      totalPatterns: predictions.length,
      taiVotes: predictions.filter(p => p.prediction === 'Tài').length,
      xiuVotes: predictions.filter(p => p.prediction === 'Xỉu').length,
      taiScore: Math.round(taiScore),
      xiuScore: Math.round(xiuScore),
      topPattern: predictions.sort((a, b) => b.confidence - a.confidence)[0]?.name || 'N/A',
      windowSize: windowSize,
      anomalyDetected: learningData[type].anomalyDetected,
      trendStrength: analyzeTrendStrength(recentResults),
      momentum: analyzeMomentum(recentResults),
      learningStats: {
        accuracy: learningData[type].totalPredictions ? (learningData[type].correctPredictions / learningData[type].totalPredictions * 100).toFixed(1) + '%' : 'N/A',
        currentStreak: streak,
        recentAccuracy: learningData[type].recentAccuracy.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, learningData[type].recentAccuracy.length) * 100 || 0,
        totalLearned: learningData[type].totalPredictions
      }
    }
  };
}

// ==================== CÁC HÀM HỖ TRỢ KHÁC ====================

function getPatternIdFromName(name) {
  const mapping = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Cầu 1-2-1': 'cau_121', 'Cầu Nhảy Cóc': 'cau_nhay_coc', 'Cầu 3 Ván 1': 'cau_3van1',
    'Xu hướng': 'overall_trend', 'Cửa sổ': 'sliding_window',
    'Smart Bet': 'smart_bet', 'Tổng Phân Tích': 'tong_phan_tich', 'Fibonacci': 'fibonacci',
    'Markov bậc 3': 'markov3', 'Markov bậc 4': 'markov4', 'Markov bậc 5': 'markov5',
    'Bayesian': 'bayesian', 'Kalman Filter': 'kalman'
  };
  for (const [key, val] of Object.entries(mapping)) {
    if (name && name.includes(key)) return val;
  }
  return null;
}

function updateBayesianPrior(type, results) {
  if (results.length < 5) return;
  
  const windowSize = Math.min(15, results.length);
  const recent = results.slice(0, windowSize);
  const taiCount = recent.filter(r => r === 'Tài').length;
  const total = recent.length;
  
  learningData[type].bayesianPrior = {
    Tài: (taiCount + 1) / (total + 2),
    Xỉu: (total - taiCount + 1) / (total + 2)
  };
}

function updateKalmanFilter(type, prediction, actual) {
  const kalman = learningData[type].kalmanFilter;
  const error = prediction === actual ? 0 : 1;
  
  const recentAccuracy = learningData[type].recentAccuracy.slice(0, 20);
  if (recentAccuracy.length > 5) {
    const variance = recentAccuracy.reduce((sum, val) => sum + Math.pow(val - 0.5, 2), 0) / recentAccuracy.length;
    kalman.measurementNoise = Math.max(0.05, Math.min(0.3, variance));
  }
  
  kalman.estimate = kalman.estimate + kalman.processNoise * (error - 0.5);
  kalman.error = kalman.error + kalman.processNoise;
}

// ==================== HÀM TỰ ĐỘNG VÀ LƯU TRỮ ====================

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
        learningData[type].streakAnalysis.wins++;
        learningData[type].streakAnalysis.currentStreak = Math.max(1, learningData[type].streakAnalysis.currentStreak + 1);
        if (pred.patterns) {
          for (const pName of pred.patterns) {
            const patId = getPatternIdFromName(pName);
            if (patId && learningData[type].patternStats[patId]) {
              learningData[type].patternStats[patId].correct++;
              learningData[type].patternStats[patId].recentResults.push(1);
              if (learningData[type].patternStats[patId].recentResults.length > 20) {
                learningData[type].patternStats[patId].recentResults.shift();
              }
              const acc = learningData[type].patternStats[patId].correct / learningData[type].patternStats[patId].total;
              learningData[type].patternWeights[patId] = Math.min(2.0, Math.max(0.3, acc * 1.8));
            }
          }
        }
        updateKalmanFilter(type, pred.prediction, pred.actual);
      } else {
        learningData[type].streakAnalysis.losses++;
        learningData[type].streakAnalysis.currentStreak = Math.min(-1, learningData[type].streakAnalysis.currentStreak - 1);
        if (pred.patterns) {
          for (const pName of pred.patterns) {
            const patId = getPatternIdFromName(pName);
            if (patId && learningData[type].patternStats[patId]) {
              learningData[type].patternStats[patId].recentResults.push(0);
              if (learningData[type].patternStats[patId].recentResults.length > 20) {
                learningData[type].patternStats[patId].recentResults.shift();
              }
              const acc = learningData[type].patternStats[patId].correct / learningData[type].patternStats[patId].total;
              learningData[type].patternWeights[patId] = Math.min(2.0, Math.max(0.3, acc * 1.8));
            }
          }
        }
      }

      const s = learningData[type].streakAnalysis.currentStreak;
      learningData[type].streakAnalysis.bestStreak = Math.max(learningData[type].streakAnalysis.bestStreak || 0, s);
      learningData[type].streakAnalysis.worstStreak = Math.min(learningData[type].streakAnalysis.worstStreak || 0, s);
      learningData[type].recentAccuracy.push(pred.isCorrect ? 1 : 0);
      if (learningData[type].recentAccuracy.length > 50) learningData[type].recentAccuracy.shift();
      
      if (pred.isCorrect !== null) {
        const prior = learningData[type].bayesianPrior;
        const alpha = pred.prediction === 'Tài' ? 1 : 0;
        prior.Tài = (prior.Tài * 100 + alpha) / 101;
        prior.Xỉu = 1 - prior.Tài;
      }
      
      updated = true;
    }
  }
  if (updated) {
    saveLearningData();
  }
}

function recordPrediction(type, phien, prediction, confidence, patterns) {
  const key = phien.toString();
  const existing = learningData[type].predictions.find(p => p.phien === key && !p.verified);
  if (existing) return existing;

  const record = {
    phien: key,
    prediction,
    confidence,
    patterns: Array.isArray(patterns) ? patterns : [],
    timestamp: new Date().toISOString(),
    verified: false,
    actual: null,
    isCorrect: null
  };

  learningData[type].predictions.unshift(record);
  learningData[type].totalPredictions++;
  if (learningData[type].predictions.length > 500) learningData[type].predictions.pop();
  saveLearningData();
  return record;
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

let autoProcessing = false;

async function autoProcessPredictions() {
  if (autoProcessing) return;
  autoProcessing = true;
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
        console.log(`[Auto] Hu phiên ${nextPhien}: ${result.prediction} (${result.confidence}%) | Window: ${result.detailedAnalysis.windowSize}p | Factors: ${result.factors.slice(0,2).join(', ')}`);
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
        console.log(`[Auto] MD5 phiên ${nextPhien}: ${result.prediction} (${result.confidence}%) | Window: ${result.detailedAnalysis.windowSize}p | Factors: ${result.factors.slice(0,2).join(', ')}`);
      }
    }
    savePredictionHistory();
    saveLearningData();
  } catch (error) {
    console.error('[Auto] Error:', error && error.stack ? error.stack : error.message);
  } finally {
    autoProcessing = false;
  }
}

function startAutoSaveTask() {
  setTimeout(autoProcessPredictions, 5000);
  setInterval(autoProcessPredictions, AUTO_SAVE_INTERVAL);
}

// ==================== ENDPOINTS ====================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'tx-predictor-v3',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version: '3.0 - 15-phiên analysis'
  });
});

app.get('/', (req, res) => res.send('t.me/Tskhang - Advanced Predictor v3.0 (15 phiên)'));

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
    res.json({
      ...record,
      analysis: result.detailedAnalysis,
      factors: result.factors
    });
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
    res.json({
      ...record,
      analysis: result.detailedAnalysis,
      factors: result.factors
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/hu/lichsu', async (req, res) => {
  await updateHistoryStatus('hu');
  res.json({ 
    type: 'Lẩu Cua 79 - Tài Xỉu Hũ', 
    history: predictionHistory.hu, 
    total: predictionHistory.hu.length, 
    id: '@Tskhang',
    version: '3.0'
  });
});

app.get('/md5/lichsu', async (req, res) => {
  await updateHistoryStatus('md5');
  res.json({ 
    type: 'Lẩu Cua 79 - Tài Xỉu MD5', 
    history: predictionHistory.md5, 
    total: predictionHistory.md5.length, 
    id: '@Tskhang',
    version: '3.0'
  });
});

app.get('/hu/thamso', async (req, res) => {
  const data = await fetchDataHu();
  if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
  const result = calculateAdvancedPrediction(data, 'hu');
  res.json({ 
    prediction: result.prediction, 
    confidence: result.confidence, 
    factors: result.factors, 
    analysis: result.detailedAnalysis,
    modelStats: {
      markovMatrix: learningData.hu.markovMatrix,
      markovMatrix3: learningData.hu.markovMatrix3,
      markovMatrix4: learningData.hu.markovMatrix4,
      markovMatrix5: learningData.hu.markovMatrix5,
      bayesianPrior: learningData.hu.bayesianPrior,
      kalmanEstimate: learningData.hu.kalmanFilter.estimate,
      volatility: learningData.hu.volatility,
      last15Results: learningData.hu.last15Results.slice(0, 15)
    }
  });
});

app.get('/md5/thamso', async (req, res) => {
  const data = await fetchDataMd5();
  if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
  const result = calculateAdvancedPrediction(data, 'md5');
  res.json({ 
    prediction: result.prediction, 
    confidence: result.confidence, 
    factors: result.factors, 
    analysis: result.detailedAnalysis,
    modelStats: {
      markovMatrix: learningData.md5.markovMatrix,
      markovMatrix3: learningData.md5.markovMatrix3,
      markovMatrix4: learningData.md5.markovMatrix4,
      markovMatrix5: learningData.md5.markovMatrix5,
      bayesianPrior: learningData.md5.bayesianPrior,
      kalmanEstimate: learningData.md5.kalmanFilter.estimate,
      volatility: learningData.md5.volatility,
      last15Results: learningData.md5.last15Results.slice(0, 15)
    }
  });
});

app.get('/hu/hochoi', (req, res) => {
  const stats = learningData.hu;
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ 
    type: 'HU Learning - v3.0 (15 phiên)', 
    totalPredictions: stats.totalPredictions, 
    correctPredictions: stats.correctPredictions, 
    accuracy: acc + '%', 
    streakAnalysis: stats.streakAnalysis,
    recentAccuracy: stats.recentAccuracy.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, stats.recentAccuracy.length) * 100 || 0,
    patternCount: Object.keys(stats.patternStats).length,
    last15Results: stats.last15Results.slice(0, 15),
    id: '@Tskhang',
    version: '3.0'
  });
});

app.get('/md5/hochoi', (req, res) => {
  const stats = learningData.md5;
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ 
    type: 'MD5 Learning - v3.0 (15 phiên)', 
    totalPredictions: stats.totalPredictions, 
    correctPredictions: stats.correctPredictions, 
    accuracy: acc + '%', 
    streakAnalysis: stats.streakAnalysis,
    recentAccuracy: stats.recentAccuracy.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, stats.recentAccuracy.length) * 100 || 0,
    patternCount: Object.keys(stats.patternStats).length,
    last15Results: stats.last15Results.slice(0, 15),
    id: '@Tskhang',
    version: '3.0'
  });
});

app.get('/resetdata', (req, res) => {
  learningData = {
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
      markovMatrix3: {},
      markovMatrix4: {},
      markovMatrix5: {},
      volatility: 0,
      sequencePatterns: {},
      windowPatterns: {},
      trendStrength: 0,
      momentum: 0,
      supportResistance: { support: [], resistance: [] },
      fibonacciLevels: [],
      patternConfidence: {},
      patternSuccessRate: {},
      patternLastUsed: {},
      patternTrend: {},
      optimalThresholds: { minConfidence: 0.55, minOccurrences: 3, maxStreakBreak: 5, windowSize: 12 },
      correlationMatrix: {},
      seasonalPatterns: [],
      anomalyThreshold: 0.15,
      bayesianPrior: { Tài: 0.5, Xỉu: 0.5 },
      kalmanFilter: { estimate: 0.5, error: 1, processNoise: 0.01, measurementNoise: 0.1 },
      ensembleHistory: [],
      last15Results: [],
      last15Sums: [],
      windowAccuracy: []
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
      markovMatrix3: {},
      markovMatrix4: {},
      markovMatrix5: {},
      volatility: 0,
      sequencePatterns: {},
      windowPatterns: {},
      trendStrength: 0,
      momentum: 0,
      supportResistance: { support: [], resistance: [] },
      fibonacciLevels: [],
      patternConfidence: {},
      patternSuccessRate: {},
      patternLastUsed: {},
      patternTrend: {},
      optimalThresholds: { minConfidence: 0.55, minOccurrences: 3, maxStreakBreak: 5, windowSize: 12 },
      correlationMatrix: {},
      seasonalPatterns: [],
      anomalyThreshold: 0.15,
      bayesianPrior: { Tài: 0.5, Xỉu: 0.5 },
      kalmanFilter: { estimate: 0.5, error: 1, processNoise: 0.01, measurementNoise: 0.1 },
      ensembleHistory: [],
      last15Results: [],
      last15Sums: [],
      windowAccuracy: []
    }
  };
  saveLearningData();
  res.json({ message: 'Learning data reset to v3.0 (15 phiên)', id: '@Tskhang', version: '3.0' });
});

// ==================== KHỞI ĐỘNG ====================
try { loadLearningData(); } catch (e) { console.error('[Startup] loadLearningData:', e.message); }
try { loadPredictionHistory(); } catch (e) { console.error('[Startup] loadPredictionHistory:', e.message); }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server @Tskhang running on http://0.0.0.0:${PORT}`);
  console.log('✅ VERSION 3.0 - PHÂN TÍCH 10-15 PHIÊN GẦN NHẤT');
  console.log('✅ Các cải tiến chính:');
  console.log('   - Markov Chain bậc 3, 4, 5 (3-5 phiên)');
  console.log('   - Phân tích cửa sổ trượt 10-12-15 phiên');
  console.log('   - Xu hướng tổng thể 15 phiên');
  console.log('   - Momentum và trend strength');
  console.log('   - Fibonacci levels với 15 phiên');
  console.log('   - Smart Bet với 3 cửa sổ thời gian');
  console.log('   - Phát hiện đảo chiều xu hướng');
  console.log('   - KHÔNG RANDOM - chỉ dùng xác suất thống kê');
  startAutoSaveTask();
});
