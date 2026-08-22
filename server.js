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
    markov3Matrix: {},
    volatility: 0,
    cycleAnalysis: {},
    phaseShiftData: []
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
    markov3Matrix: {},
    volatility: 0,
    cycleAnalysis: {},
    phaseShiftData: []
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

// ==================== THUẬT TOÁN BẮT CẦU SIÊU NGON ====================

// 1. THUẬT TOÁN MARKOV BẬC 3
function analyzeMarkovAdvanced(results, type) {
    if (results.length < 15) return null;
    
    const markov3 = learningData[type].markov3Matrix || {};
    
    for (let i = 0; i < results.length - 3; i++) {
        const key = results[i] + '|' + results[i+1] + '|' + results[i+2];
        const next = results[i+3];
        if (!markov3[key]) markov3[key] = {};
        markov3[key][next] = (markov3[key][next] || 0) + 1;
    }
    learningData[type].markov3Matrix = markov3;
    
    const last3 = results.slice(0, 3).join('|');
    if (markov3[last3]) {
        const probs = markov3[last3];
        const total = Object.values(probs).reduce((a, b) => a + b, 0);
        const probTai = (probs['Tài'] || 0) / total;
        const probXiu = (probs['Xỉu'] || 0) / total;
        
        if (Math.max(probTai, probXiu) > 0.7) {
            return {
                detected: true,
                prediction: probTai > probXiu ? 'Tài' : 'Xỉu',
                confidence: 75 + Math.max(probTai, probXiu) * 20,
                priority: 12,
                name: `Markov bậc 3`
            };
        }
    }
    return null;
}

// 2. Cầu Bệt
function analyzeCauBet(results, type) {
  if (results.length < 3) return null;
  let streakType = results[0];
  let streakLength = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 3) {
    let shouldBreak = streakLength >= 5;
    let confidence = streakLength >= 7 ? 88 : (streakLength >= 5 ? 80 : 72);
    return {
      detected: true,
      prediction: shouldBreak ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: confidence,
      name: `Cầu Bệt ${streakLength}`,
      priority: 10 + Math.min(3, streakLength)
    };
  }
  return null;
}

// 3. Cầu Đảo 1-1
function analyzeCauDao11(results, type) {
  if (results.length < 4) return null;
  let alternatingLength = 1;
  for (let i = 1; i < Math.min(results.length, 10); i++) {
    if (results[i] !== results[i - 1]) alternatingLength++;
    else break;
  }
  if (alternatingLength >= 4) {
    let confidence = Math.min(85, 68 + alternatingLength * 3);
    return {
      detected: true,
      prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: confidence,
      name: `Cầu Đảo 1-1`,
      priority: 9
    };
  }
  return null;
}

// 4. Cầu 2-2
function analyzeCau22(results, type) {
  if (results.length < 6) return null;
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
        confidence: Math.min(82, 68 + pairCount * 4),
        name: `Cầu 2-2`,
        priority: 8
      };
    }
  }
  return null;
}

// 5. Cầu 3-3
function analyzeCau33(results, type) {
  if (results.length < 6) return null;
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
      confidence: Math.min(84, 70 + tripleCount * 5),
      name: `Cầu 3-3`,
      priority: 8
    };
  }
  return null;
}

// 6. Cầu 1-2-1
function analyzeCau121(results, type) {
  if (results.length < 4) return null;
  const pattern1 = results.slice(0, 4);
  if (pattern1[0] !== pattern1[1] && pattern1[1] === pattern1[2] && pattern1[2] !== pattern1[3] && pattern1[0] === pattern1[3]) {
    return { detected: true, prediction: pattern1[0], confidence: 76, name: 'Cầu 1-2-1', priority: 7 };
  }
  return null;
}

// 7. Cầu 1-2-3
function analyzeCau123(results, type) {
  if (results.length < 6) return null;
  const first = results[5];
  const nextTwo = results.slice(3, 5);
  const lastThree = results.slice(0, 3);
  if (nextTwo[0] === nextTwo[1] && nextTwo[0] !== first) {
    const allSame = lastThree.every(r => r === lastThree[0]);
    if (allSame && lastThree[0] !== nextTwo[0]) {
      return { detected: true, prediction: first, confidence: 78, name: 'Cầu 1-2-3', priority: 7 };
    }
  }
  return null;
}

// 8. Cầu 3-2-1
function analyzeCau321(results, type) {
  if (results.length < 6) return null;
  const first3 = results.slice(3, 6);
  const next2 = results.slice(1, 3);
  const last1 = results[0];
  const first3Same = first3.every(r => r === first3[0]);
  const next2Same = next2.every(r => r === next2[0]);
  if (first3Same && next2Same && first3[0] !== next2[0] && last1 !== next2[0]) {
    return { detected: true, prediction: next2[0], confidence: 78, name: 'Cầu 3-2-1', priority: 7 };
  }
  return null;
}

// 9. Cầu Nhảy Cóc
function analyzeCauNhayCoc(results, type) {
  if (results.length < 6) return null;
  const skipPattern = [];
  for (let i = 0; i < Math.min(results.length, 12); i += 2) skipPattern.push(results[i]);
  if (skipPattern.length >= 3) {
    const allSame = skipPattern.slice(0, 3).every(r => r === skipPattern[0]);
    if (allSame) return { detected: true, prediction: skipPattern[0], confidence: 72, name: 'Cầu Nhảy Cóc', priority: 6 };
    let alternating = true;
    for (let i = 1; i < skipPattern.length - 1; i++) if (skipPattern[i] === skipPattern[i - 1]) alternating = false;
    if (alternating && skipPattern.length >= 3) {
      return { detected: true, prediction: skipPattern[0] === 'Tài' ? 'Xỉu' : 'Tài', confidence: 70, name: 'Cầu Nhảy Cóc Đảo', priority: 6 };
    }
  }
  return null;
}

// 10. Cầu Nhịp Nghiêng
function analyzeCauNhipNghieng(results, type) {
  if (results.length < 5) return null;
  const last5 = results.slice(0, 5);
  const taiCount5 = last5.filter(r => r === 'Tài').length;
  if (taiCount5 >= 4) {
    return { detected: true, prediction: 'Tài', confidence: 74, name: `Cầu Nhịp Nghiêng`, priority: 6 };
  } else if (taiCount5 <= 1) {
    return { detected: true, prediction: 'Xỉu', confidence: 74, name: `Cầu Nhịp Nghiêng`, priority: 6 };
  }
  return null;
}

// 11. Cầu 3 Ván 1
function analyzeCau3Van1(results, type) {
  if (results.length < 4) return null;
  const last4 = results.slice(0, 4);
  const taiCount = last4.filter(r => r === 'Tài').length;
  if (taiCount === 3) return { detected: true, prediction: 'Xỉu', confidence: 72, name: 'Cầu 3 Ván 1', priority: 6 };
  if (taiCount === 1) return { detected: true, prediction: 'Tài', confidence: 72, name: 'Cầu 3 Ván 1', priority: 6 };
  return null;
}

// 12. Đảo Xu Hướng
function analyzeSmartBet(results, type) {
  if (results.length < 10) return null;
  const last10 = results.slice(0, 10);
  const last5 = results.slice(0, 5);
  const prev5 = results.slice(5, 10);
  const taiLast5 = last5.filter(r => r === 'Tài').length;
  const taiPrev5 = prev5.filter(r => r === 'Tài').length;
  const trendChanging = (taiLast5 >= 4 && taiPrev5 <= 1) || (taiLast5 <= 1 && taiPrev5 >= 4);
  if (trendChanging) {
    const currentDominant = taiLast5 >= 4 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: currentDominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 82, name: `Đảo Xu Hướng`, priority: 9 };
  }
  const taiLast10 = last10.filter(r => r === 'Tài').length;
  if (taiLast10 >= 8 || taiLast10 <= 2) {
    const dominant = taiLast10 >= 8 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: dominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 85, name: `Xu Hướng Cực`, priority: 9 };
  }
  return null;
}

// 13. Bẻ Chuỗi
function analyzeBreakStreak(results, type) {
  if (results.length < 5) return null;
  let streakType = results[0];
  let streakLength = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 5) {
    const prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: Math.min(90, 72 + streakLength * 2), name: `Bẻ Chuỗi`, priority: 11 };
  }
  return null;
}

// 14. 3 Bộ Ba
function analyzeTriplePattern(results, type) {
  if (results.length < 9) return null;
  const isTriple1 = results[0] === results[1] && results[1] === results[2];
  const isTriple2 = results[3] === results[4] && results[4] === results[5];
  const isTriple3 = results[6] === results[7] && results[7] === results[8];
  if (isTriple1 && isTriple2 && isTriple3) {
    const tripleType1 = results[0];
    const tripleType2 = results[3];
    const tripleType3 = results[6];
    if (tripleType1 === tripleType2 && tripleType2 === tripleType3) {
      const prediction = tripleType1 === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, prediction: prediction, confidence: 90, name: `3 Bộ Ba`, priority: 12 };
    }
    if (tripleType1 !== tripleType2 && tripleType2 !== tripleType3) {
      return { detected: true, prediction: tripleType1, confidence: 84, name: `Bộ Ba Đảo`, priority: 11 };
    }
  }
  return null;
}

// 15. Tổng Phân Tích
function analyzeTongPhanTich(data, type) {
  if (data.length < 10) return null;
  const recent10 = data.slice(0, 10);
  const sums = recent10.map(d => d.Tong);
  const results = recent10.map(d => d.Ket_qua);
  const avgSum = sums.reduce((a, b) => a + b, 0) / sums.length;
  const taiCount = results.filter(r => r === 'Tài').length;
  const xiuCount = results.filter(r => r === 'Xỉu').length;
  const first5Sum = sums.slice(5, 10).reduce((a, b) => a + b, 0) / 5;
  const last5Sum = sums.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const sumTrend = last5Sum - first5Sum;
  if (sumTrend > 1.5) return { detected: true, prediction: 'Xỉu', confidence: 78, name: `Tổng Phân Tích`, priority: 10 };
  if (sumTrend < -1.5) return { detected: true, prediction: 'Tài', confidence: 78, name: `Tổng Phân Tích`, priority: 10 };
  if (Math.abs(taiCount - xiuCount) >= 3) {
    const lech = taiCount > xiuCount ? 'Tài' : 'Xỉu';
    const prediction = lech === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 74, name: `Cân Bằng Tổng`, priority: 9 };
  }
  return null;
}

// 16. Xu Hướng Mạnh
function analyzeXuHuongManh(results, type) {
  if (results.length < 8) return null;
  const recent8 = results.slice(0, 8);
  const taiCount = recent8.filter(r => r === 'Tài').length;
  if (taiCount >= 6) return { detected: true, prediction: 'Xỉu', confidence: 82, name: `Xu Hướng Mạnh`, priority: 10 };
  if (taiCount <= 2) return { detected: true, prediction: 'Tài', confidence: 82, name: `Xu Hướng Mạnh`, priority: 10 };
  return null;
}

// 17. Đảo Chiều
function analyzeDaoChieu(results, type) {
  if (results.length < 5) return null;
  const recent5 = results.slice(0, 5);
  let isAlternating = true;
  for (let i = 0; i < recent5.length - 1; i++) {
    if (recent5[i] === recent5[i + 1]) { isAlternating = false; break; }
  }
  if (isAlternating) {
    const prediction = recent5[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 78, name: `Đảo Chiều`, priority: 9 };
  }
  return null;
}

// 18. Cầu Gấp Khúc
function analyzeZigzagPattern(results, type) {
    if (results.length < 8) return null;
    
    let pairPattern = [];
    for (let i = 0; i < 4; i++) {
        if (results[i*2] === results[i*2+1]) {
            pairPattern.push(results[i*2]);
        } else break;
    }
    
    if (pairPattern.length === 4) {
        let isAlternating = true;
        for (let i = 1; i < pairPattern.length; i++) {
            if (pairPattern[i] === pairPattern[i-1]) {
                isAlternating = false;
                break;
            }
        }
        
        if (isAlternating) {
            const nextPair = pairPattern[3] === 'Tài' ? 'Xỉu' : 'Tài';
            const confidence = 85 + (pairPattern[0] === pairPattern[2] ? 5 : 0);
            return {
                detected: true,
                prediction: nextPair,
                confidence: Math.min(95, confidence),
                priority: 11,
                name: `Cầu Gấp Khúc`
            };
        }
    }
    return null;
}

// 19. Cầu Sóng Đôi
function analyzeDoubleWave(results, type) {
    if (results.length < 12) return null;
    
    for (let offset = 0; offset < 5; offset++) {
        let isSymmetric = true;
        for (let i = 0; i < 5; i++) {
            if (i+offset+5 >= results.length) { isSymmetric = false; break; }
            if (results[i+offset] !== results[i+offset+5]) {
                isSymmetric = false;
                break;
            }
        }
        if (isSymmetric) {
            const nextIdx = 5 + offset;
            if (nextIdx < results.length) {
                const nextPred = results[nextIdx] === 'Tài' ? 'Xỉu' : 'Tài';
                return {
                    detected: true,
                    prediction: nextPred,
                    confidence: 86,
                    priority: 11,
                    name: `Cầu Sóng Đôi`
                };
            }
        }
    }
    return null;
}

// 20. Cầu Fibonacci
function analyzeFibonacciPattern(results, type) {
    if (results.length < 8) return null;
    
    const fib = [1, 1, 2, 3, 5, 8];
    let fibPositions = [];
    for (let i = 1; i < results.length; i++) {
        if (results[i] === results[0]) fibPositions.push(i);
    }
    
    if (fibPositions.length >= 3) {
        const gaps = [];
        for (let i = 1; i < fibPositions.length; i++) {
            gaps.push(fibPositions[i] - fibPositions[i-1]);
        }
        
        let isFib = true;
        for (let i = 0; i < gaps.length; i++) {
            if (!fib.includes(gaps[i])) { isFib = false; break; }
        }
        
        if (isFib) {
            const confidence = 85 + Math.min(5, fibPositions.length * 2);
            return {
                detected: true,
                prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
                confidence: Math.min(95, confidence),
                priority: 11,
                name: `Cầu Fibonacci`
            };
        }
    }
    return null;
}

// ==================== HÀM HỖ TRỢ ====================

function getPatternIdFromName(name) {
  const mapping = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Cầu 1-2-1': 'cau_121', 'Cầu 1-2-3': 'cau_123', 'Cầu 3-2-1': 'cau_321', 'Cầu Nhảy Cóc': 'cau_nhay_coc',
    'Cầu Nhịp Nghiêng': 'cau_nhip_nghieng', 'Cầu 3 Ván 1': 'cau_3van1', 'Đảo Xu Hướng': 'smart_bet',
    'Bẻ Chuỗi': 'break_streak', '3 Bộ Ba': 'triple_pattern', 'Tổng Phân Tích': 'tong_phan_tich',
    'Xu Hướng Mạnh': 'xu_huong_manh', 'Đảo Chiều': 'dao_chieu', 
    'Markov bậc 3': 'markov3', 'Cầu Gấp Khúc': 'zigzag',
    'Cầu Sóng Đôi': 'double_wave', 'Cầu Fibonacci': 'fibonacci'
  };
  for (const [key, val] of Object.entries(mapping)) {
    if (name.includes(key)) return val;
  }
  return null;
}

function updateMarkovMatrices(type, results) {
  if (results.length < 10) return;
  
  let tt = 0, tx = 0, xt = 0, xx = 0;
  for (let i = 0; i < results.length - 1; i++) {
    if (results[i] === 'Tài' && results[i + 1] === 'Tài') tt++;
    else if (results[i] === 'Tài' && results[i + 1] === 'Xỉu') tx++;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Tài') xt++;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Xỉu') xx++;
  }
  const total = tt + tx + xt + xx;
  if (total > 0) {
    learningData[type].markovMatrix = { TT: tt / total, TX: tx / total, XT: xt / total, XX: xx / total };
  }
  
  const markov2 = {};
  for (let i = 0; i < results.length - 2; i++) {
    const key = results[i] + results[i + 1];
    const next = results[i + 2];
    markov2[key + next] = (markov2[key + next] || 0) + 1;
  }
  learningData[type].markov2Matrix = markov2;
}

function loadHistoricalPatternStats() {
  try {
    if (fs.existsSync('learning_data.json')) {
      const histData = JSON.parse(fs.readFileSync('learning_data.json', 'utf8'));
      for (const type of ['hu', 'md5']) {
        if (histData[type] && histData[type].patternStats) {
          Object.keys(histData[type].patternStats).forEach(pat => {
            const stats = histData[type].patternStats[pat];
            if (stats.total >= 5) {
              const realAccuracy = stats.correct / stats.total;
              learningData[type].patternWeights[pat] = Math.min(2.0, Math.max(0.4, realAccuracy * 1.5));
            } else {
              learningData[type].patternWeights[pat] = 1.0;
            }
            learningData[type].patternStats[pat] = { ...stats };
          });
        }
      }
      console.log('✅ Loaded pattern stats from learning_data.json');
    }
  } catch (e) { console.error('Error loading historical data:', e.message); }
}

// === HÀM DỰ ĐOÁN CHÍNH ===
function calculateAdvancedPrediction(data, type) {
  const results = data.map(d => d.Ket_qua);
  const sums = data.map(d => d.Tong);
  updateMarkovMatrices(type, results);

  let predictions = [];
  let factors = [];

  const advancedFunctions = [
    analyzeMarkovAdvanced,
    analyzeTriplePattern,
    analyzeBreakStreak,
    analyzeCauBet,
    analyzeZigzagPattern,
    analyzeDoubleWave,
    analyzeFibonacciPattern,
    analyzeSmartBet,
    analyzeXuHuongManh,
    analyzeTongPhanTich,
    analyzeCauDao11,
    analyzeCau22,
    analyzeCau33,
    analyzeCau121,
    analyzeCau123,
    analyzeCau321,
    analyzeCauNhayCoc,
    analyzeCauNhipNghieng,
    analyzeCau3Van1,
    analyzeDaoChieu
  ];

  for (let fn of advancedFunctions) {
    let p;
    if (fn.name === 'analyzeTongPhanTich') {
      p = fn(data, type);
    } else {
      p = fn(results, type);
    }
    if (p && p.detected) {
      predictions.push({ ...p, priority: p.priority || 5 });
      if (p.name) factors.push(p.name);
    }
  }

  let taiScore = 0, xiuScore = 0;
  for (const p of predictions) {
    const weight = learningData[type].patternWeights[getPatternIdFromName(p.name)] || 1.0;
    const conf = p.confidence * weight;
    const priorityBonus = (p.priority || 5) / 5;
    if (p.prediction === 'Tài') taiScore += conf * priorityBonus;
    else xiuScore += conf * priorityBonus;
  }

  const streak = learningData[type].streakAnalysis.currentStreak;
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  
  const volatility = learningData[type].volatility || 2;
  const reversalThreshold = volatility > 3 ? 2 : 4;
  
  if (streak <= -reversalThreshold && !learningData[type].reversalState.active) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    learningData[type].reversalState = { active: true, streakTrigger: streak };
    factors.push('REVERSAL');
  } else if (streak > 0 && learningData[type].reversalState.active) {
    learningData[type].reversalState.active = false;
  }

  let baseConf = 65;
  const topPatterns = predictions.sort((a, b) => b.priority - a.priority).slice(0, 5);
  for (const p of topPatterns) {
    if (p.prediction === finalPrediction) {
      baseConf += (p.confidence - 65) * 0.2;
    }
  }
  
  const totalPredictions = predictions.length;
  const agreement = totalPredictions > 0 ? 
    (finalPrediction === 'Tài' ? 
      predictions.filter(p => p.prediction === 'Tài').length : 
      predictions.filter(p => p.prediction === 'Xỉu').length) / totalPredictions : 0.5;
  baseConf += agreement * 15;
  
  let volatilityBoost = 0;
  if (volatility > 4) volatilityBoost = -8;
  else if (volatility < 2) volatilityBoost = 5;
  baseConf += volatilityBoost;
  
  if (Math.abs(streak) >= 5) {
    baseConf += streak > 0 ? -5 : 5;
  }
  
  let finalConf = Math.min(96, Math.max(55, Math.round(baseConf)));

  return {
    prediction: finalPrediction,
    confidence: finalConf,
    factors: factors.slice(0, 5)
  };
}

// === HÀM TỰ ĐỘNG VÀ LƯU TRỮ ===
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
        learningData[type].streakAnalysis.currentStreak = Math.max(1, learningData[type].streakAnalysis.currentStreak + 1);
      } else {
        learningData[type].streakAnalysis.currentStreak = Math.min(-1, learningData[type].streakAnalysis.currentStreak - 1);
      }
      learningData[type].recentAccuracy.push(pred.isCorrect ? 1 : 0);
      if (learningData[type].recentAccuracy.length > 50) learningData[type].recentAccuracy.shift();
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
  if (learningData[type].predictions.length > 500) learningData[type].predictions.pop();
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
app.get('/', (req, res) => res.send('t.me/Tskhang - Dự đoán Tài Xỉu Siêu Chuẩn 🚀'));

app.get('/hu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
    await verifyPredictions('hu', data);
    const nextPhien = data[0].Phien + 1;
    const result = calculateAdvancedPrediction(data, 'hu');
    savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('hu'), 5000);
    
    // Trả về JSON đơn giản
    res.json({
      phien_hien_tai: nextPhien,
      du_doan: result.prediction,
      do_tin_cay: result.confidence + '%'
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
    savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('md5'), 5000);
    
    // Trả về JSON đơn giản
    res.json({
      phien_hien_tai: nextPhien,
      du_doan: result.prediction,
      do_tin_cay: result.confidence + '%'
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
    id: '@Tskhang' 
  });
});

app.get('/md5/lichsu', async (req, res) => {
  await updateHistoryStatus('md5');
  res.json({ 
    type: 'Lẩu Cua 79 - Tài Xỉu MD5', 
    history: predictionHistory.md5, 
    total: predictionHistory.md5.length, 
    id: '@Tskhang' 
  });
});

app.get('/hu/hochoi', (req, res) => {
  const stats = learningData.hu;
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ 
    type: 'HU Learning', 
    totalPredictions: stats.totalPredictions, 
    correctPredictions: stats.correctPredictions, 
    accuracy: acc + '%', 
    streakAnalysis: stats.streakAnalysis,
    id: '@Tskhang' 
  });
});

app.get('/md5/Hochoi', (req, res) => {
  const stats = learningData.md5;
  const acc = stats.totalPredictions ? (stats.correctPredictions / stats.totalPredictions * 100).toFixed(2) : 0;
  res.json({ 
    type: 'MD5 Learning', 
    totalPredictions: stats.totalPredictions, 
    correctPredictions: stats.correctPredictions, 
    accuracy: acc + '%', 
    streakAnalysis: stats.streakAnalysis,
    id: '@Tskhang' 
  });
});

app.get('/Resetdata', (req, res) => {
  learningData = {
    hu: {
      predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
      patternWeights: {}, lastUpdate: null,
      streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
      recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
      markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
      markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
      cycleAnalysis: {}, phaseShiftData: []
    },
    md5: {
      predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
      patternWeights: {}, lastUpdate: null,
      streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
      recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
      markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
      markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
      cycleAnalysis: {}, phaseShiftData: []
    }
  };
  saveLearningData();
  res.json({ message: '✅ Reset learning data thành công!', id: '@Tskhang' });
});

// ==================== KHỞI ĐỘNG ====================
loadHistoricalPatternStats();
loadLearningData();
loadPredictionHistory();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server @Tskhang đang chạy tại http://0.0.0.0:${PORT}`);
  console.log('✅ Đã nâng cấp thuật toán bắt cầu siêu ngon!');
  console.log('📊 Các cầu: Markov bậc 3, Bệt, Đảo, 2-2, 3-3, 1-2-1, 1-2-3, 3-2-1, Nhảy Cóc, Nhịp Nghiêng, 3 Ván 1, Xu Hướng, Bẻ Chuỗi, 3 Bộ Ba, Tổng, Gấp Khúc, Sóng Đôi, Fibonacci');
  startAutoSaveTask();
});
