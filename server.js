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

// --- Cấu trúc learning data nâng cấp cực mạnh (Thêm bộ nhớ Vector ngắn hạn & Tự động thích ứng trọng số ma trận) ---
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
    entropyScore: 0, // Độ hỗn loạn của cầu (Entropy)
    adaptiveBias: 0  // Trọng số lệch động theo xu hướng nóng
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
    entropyScore: 0,
    adaptiveBias: 0
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

// ==================== HỆ THỐNG PHÂN TÍCH CẦU CHUYÊN SÂU (NÂNG CẤP ĐỘ NHẠY) ====================

function analyzeCauBet(results, type) {
  if (results.length < 3) return { detected: false };
  let streakType = results[0];
  let streakLength = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 3) {
    // Tối ưu điểm bẻ cầu thông minh dựa trên độ dài bệt
    let shouldBreak = streakLength >= 6;
    let confidence = streakLength >= 8 ? 92 : (streakLength >= 5 ? 82 : 72);
    return {
      detected: true,
      prediction: shouldBreak ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: confidence,
      name: `Cầu Bệt Nặng ${streakLength} phiên`,
      priority: streakLength >= 6 ? 12 : 9
    };
  }
  return { detected: false };
}

function analyzeCauDao11(results, type) {
  if (results.length < 4) return { detected: false };
  let alternatingLength = 1;
  for (let i = 1; i < Math.min(results.length, 15); i++) {
    if (results[i] !== results[i - 1]) alternatingLength++;
    else break;
  }
  if (alternatingLength >= 4) {
    let confidence = Math.min(88, 70 + alternatingLength * 2);
    return {
      detected: true,
      prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: confidence,
      name: `Cầu Đảo 1-1 Chuẩn (${alternatingLength} phiên)`,
      priority: 10
    };
  }
  return { detected: false };
}

function analyzeCau22(results, type) {
  if (results.length < 6) return { detected: false };
  let pairCount = 0, i = 0, pattern = [];
  while (i < results.length - 1 && pairCount < 5) {
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
        confidence: Math.min(86, 72 + pairCount * 3),
        name: `Cầu 2-2 Kép (${pairCount} cặp)`,
        priority: 8
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
      confidence: Math.min(88, 74 + tripleCount * 4),
      name: `Cầu 3-3 (${tripleCount} bộ ba)`,
      priority: 8
    };
  }
  return { detected: false };
}

function analyzeSmartMomentum(results, data) {
  if (results.length < 12) return { detected: false };
  const last6 = results.slice(0, 6);
  const prev6 = results.slice(6, 12);
  const tLast = last6.filter(r => r === 'Tài').length;
  const tPrev = prev6.filter(r => r === 'Tài').length;
  
  // Phát hiện dòng tiền đổi chiều đột ngột (Momentum Shift)
  if ((tLast >= 5 && tPrev <= 2) || (tLast <= 1 && tPrev >= 4)) {
    const target = tLast >= 5 ? 'Xỉu' : 'Tài';
    return {
      detected: true,
      prediction: target,
      confidence: 85,
      name: 'Đột Biến Dòng Tiền (Momentum Shift)',
      priority: 11
    };
  }
  return { detected: false };
}

function analyzeEntropyAndChaos(results) {
  if (results.length < 10) return null;
  let switches = 0;
  for (let i = 0; i < 9; i++) {
    if (results[i] !== results[i + 1]) switches++;
  }
  // Tính độ hỗn loạn: nếu dao động quá nhiều (switches >= 7), cầu cực kỳ lật đật -> ưu tiên đánh đảo chiều con gần nhất
  if (switches >= 7) {
    return {
      detected: true,
      prediction: results[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: 78,
      name: 'Cầu Loạn Nhịp (High Entropy Reversal)',
      priority: 9
    };
  }
  return null;
}

function calculateEntropy(results) {
  if (results.length < 20) return 0.5;
  let tCount = results.slice(0, 20).filter(r => r === 'Tài').length;
  let pT = tCount / 20;
  let pX = 1 - pT;
  if (pT === 0 || pX === 0) return 0;
  let entropy = -(pT * Math.log2(pT) + pX * Math.log2(pX));
  return entropy; // Max = 1 (hoàn toàn hỗn loạn), min = 0 (bệt tuyệt đối)
}

// ==================== MA TRẬN MARKOV BẬC CAO & TRỌNG SỐ ĐỘNG ====================

function updateMarkovMatrices(type, results) {
  if (results.length < 15) return;
  let tt = 1.5, tx = 1.5, xt = 1.5, xx = 1.5; // Laplace smoothing cải tiến
  for (let i = 0; i < results.length - 1; i++) {
    if (results[i] === 'Tài' && results[i + 1] === 'Tài') tt += 1.2;
    else if (results[i] === 'Tài' && results[i + 1] === 'Xỉu') tx += 1.2;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Tài') xt += 1.2;
    else if (results[i] === 'Xỉu' && results[i + 1] === 'Xỉu') xx += 1.2;
  }
  const totalT = tt + tx;
  const totalX = xt + xx;
  learningData[type].markovMatrix = {
    TT: tt / totalT,
    TX: tx / totalT,
    XT: xt / totalX,
    XX: xx / totalX
  };

  // Markov bậc 3 (Memory chuỗi 3 phiên gần nhất) để bắt pattern dài
  if (results.length >= 4) {
    const m3Key = results[2] + results[1] + results[0];
    // Lưu vết tạm thời trong object
    if (!learningData[type].markov3Matrix) learningData[type].markov3Matrix = {};
    learningData[type].markov3Matrix[m3Key + results[0]] = (learningData[type].markov3Matrix[m3Key + results[0]] || 0) + 1;
  }
}

function getPatternIdFromName(name) {
  const mapping = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Momentum': 'momentum', 'Loạn Nhịp': 'chaos', 'Markov': 'markov'
  };
  for (const [key, val] of Object.entries(mapping)) if (name.includes(key)) return val;
  return 'general';
}

// === THUẬT TOÁN DỰ ĐOÁN SIU CẤP (ENSEMBLE VOTE + DYNAMIC WEIGHTS) ===
function calculateAdvancedPrediction(data, type) {
  const results = data.map(d => d.Ket_qua);
  const sums = data.map(d => d.Tong);
  
  updateMarkovMatrices(type, results);
  learningData[type].entropyScore = calculateEntropy(results);

  let predictions = [];
  let factors = [];

  // 1. Phân tích Markov bậc 1
  const lastResult = results[0];
  if (lastResult && learningData[type].markovMatrix) {
    const probTai = (lastResult === 'Tài') ? learningData[type].markovMatrix.TT : learningData[type].markovMatrix.XT;
    if (probTai > 0.58) {
      predictions.push({ prediction: 'Tài', confidence: 70 + (probTai - 0.5) * 30, priority: 8, name: 'Markov bậc 1' });
      factors.push(`Markov 1 (${(probTai*100).toFixed(0)}% Tài)`);
    } else if (probTai < 0.42) {
      predictions.push({ prediction: 'Xỉu', confidence: 70 + (0.5 - probTai) * 30, priority: 8, name: 'Markov bậc 1' });
      factors.push(`Markov 1 (${((1-probTai)*100).toFixed(0)}% Xỉu)`);
    }
  }

  // 2. Kiểm tra độ hỗn loạn Entropy
  const chaos = analyzeEntropyAndChaos(results);
  if (chaos) {
    predictions.push(chaos);
    factors.push(chaos.name);
  }

  // 3. Kiểm tra biến động Momentum dòng tiền
  const momentum = analyzeSmartMomentum(results, data);
  if (momentum) {
    predictions.push(momentum);
    factors.push(momentum.name);
  }

  // 4. Các mô hình bắt cầu truyền thống tối ưu
  const patternFuncs = [analyzeCauBet, analyzeCauDao11, analyzeCau22, analyzeCau33];
  for (let fn of patternFuncs) {
    let p = fn(results, type);
    if (p && p.detected) {
      predictions.push(p);
      factors.push(p.name);
    }
  }

  // 5. Hệ thống chấm điểm trọng số tổng hợp (Ensemble Voting) cực kỳ khắt khe
  let taiScore = 0, xiuScore = 0;
  let totalWeight = 0;

  for (const p of predictions) {
    const patId = getPatternIdFromName(p.name);
    // Tự động điều chỉnh trọng số dựa trên lịch sử chiến thắng thực tế của từng mẫu cầu
    const baseWeight = (learningData[type].patternWeights[patId]) || 1.0;
    const effectiveWeight = baseWeight * (p.priority || 5);
    
    totalWeight += effectiveWeight;
    if (p.prediction === 'Tài') {
      taiScore += p.confidence * effectiveWeight;
    } else {
      xiuScore += p.confidence * effectiveWeight;
    }
  }

  let finalPrediction = 'Tài';
  let rawConfidence = 65;

  if (totalWeight > 0) {
    if (taiScore >= xiuScore) {
      finalPrediction = 'Tài';
      rawConfidence = taiScore / totalWeight;
    } else {
      finalPrediction = 'Xỉu';
      rawConfidence = xiuScore / totalWeight;
    }
  } else {
    // Fallback thông minh theo kết quả phiên gần nhất nếu không bắt được khuôn mẫu cầu rõ ràng
    finalPrediction = results[0] === 'Tài' ? 'Xỉu' : 'Tài';
    rawConfidence = 62;
    factors.push('Cơ chế dự phòng đảo chiều thông minh');
  }

  // 6. Cơ chế Reversal thông minh (Bẻ dây khi thua liên tiếp sâu)
  const streak = learningData[type].streakAnalysis.currentStreak;
  if (streak <= -3 && !learningData[type].reversalState.active) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    learningData[type].reversalState = { active: true, streakTrigger: streak };
    rawConfidence += 8;
    factors.push('⚡ BẺ CẦU KỸ THUẬT (Reversal Active)');
  } else if (streak > 0 && learningData[type].reversalState.active) {
    learningData[type].reversalState.active = false;
  }

  // Chuẩn hóa độ tin cậy cuối cùng (Giới hạn từ 65% đến 96%)
  let finalConf = Math.min(96, Math.max(65, Math.round(rawConfidence)));

  return {
    prediction: finalPrediction,
    confidence: finalConf,
    factors: factors.slice(0, 7),
    allPatterns: predictions.map(p => p.name),
    detailedAnalysis: {
      totalPatternsDetected: predictions.length,
      entropy: learningData[type].entropyScore.toFixed(2),
      currentStreak: streak,
      learningAccuracy: learningData[type].totalPredictions > 0 
        ? ((learningData[type].correctPredictions / learningData[type].totalPredictions) * 100).toFixed(1) + '%' 
        : 'Đang khởi động'
    }
  };
}

// === TỰ ĐỘNG HỌC TẬP VÀ ĐÁNH GIÁ CHÍNH XÁC ===
async function verifyPredictions(type, currentData) {
  let updated = false;
  for (let pred of learningData[type].predictions) {
    if (pred.verified) continue;
    const actual = currentData.find(d => d.Phien.toString() === pred.phien);
    if (actual) {
      pred.verified = true;
      pred.actual = actual.Ket_qua;
      pred.isCorrect = (pred.prediction === pred.actual);

      let streak = learningData[type].streakAnalysis;
      if (pred.isCorrect) {
        learningData[type].correctPredictions++;
        streak.currentStreak = streak.currentStreak > 0 ? streak.currentStreak + 1 : 1;
        if (streak.currentStreak > streak.bestStreak) streak.bestStreak = streak.currentStreak;
      } else {
        streak.currentStreak = streak.currentStreak < 0 ? streak.currentStreak - 1 : -1;
        if (streak.currentStreak < streak.worstStreak) streak.worstStreak = streak.currentStreak;
      }

      // Cập nhật điểm trọng số mẫu cầu thích ứng thông minh
      if (pred.patterns) {
        pred.patterns.forEach(pName => {
          const patId = getPatternIdFromName(pName);
          if (!learningData[type].patternStats[patId]) {
            learningData[type].patternStats[patId] = { total: 0, correct: 0 };
          }
          learningData[type].patternStats[patId].total++;
          if (pred.isCorrect) learningData[type].patternStats[patId].correct++;

          const stats = learningData[type].patternStats[patId];
          const accuracyRate = stats.correct / stats.total;
          // Tự động tinh chỉnh trọng số vinh danh pattern chuẩn xác
          learningData[type].patternWeights[patId] = Math.min(2.5, Math.max(0.4, accuracyRate * 2.0));
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
app.get('/', (req, res) => res.send('t.me/Tskhang - Ultra High-Accuracy Prediction Engine Active'));

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
    hu: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, entropyScore: 0, adaptiveBias: 0 },
    md5: { predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0, patternWeights: {}, lastUpdate: null, streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 }, recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 }, markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 }, markov2Matrix: {}, entropyScore: 0, adaptiveBias: 0 }
  };
  saveLearningData();
  res.json({ message: 'Learning data reset successfully', id: '@Tskhang' });
});

// KHỞI ĐỘNG
loadLearningData();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server @Tskhang running on http://0.0.0.0:${PORT}`);
  console.log('🚀 ĐÃ NÂNG CẤP SIU CẤP: Tích hợp hệ thống phân tích độ hỗn loạn Entropy, bắt dòng tiền Momentum & Tự động tối ưu hóa trọng số học máy.');
  startAutoSaveTask();
});
