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
const MAX_HISTORY = 200;
const AUTO_SAVE_INTERVAL = 20000;
let lastProcessedPhien = { hu: null, md5: null };
let lastResultHu = null, lastResultMd5 = null;

// === CẤU TRÚC DỮ LIỆU HỌC HỎI NÂNG CẤP ===
let learningData = {
  hu: {
    predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
    patternWeights: {}, lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [], reversalState: { active: false, streakTrigger: 0, lastReversalPhien: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
    confidenceHistory: [], skipLowConfidence: true
  },
  md5: {
    predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
    patternWeights: {}, lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [], reversalState: { active: false, streakTrigger: 0, lastReversalPhien: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
    confidenceHistory: [], skipLowConfidence: true
  }
};

// === HÀM LOAD/SAVE CẢI TIẾN ===
function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_FILE)) {
      const data = fs.readFileSync(LEARNING_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (let type of ['hu', 'md5']) {
        if (parsed[type]) {
          learningData[type] = { ...learningData[type], ...parsed[type] };
          // Đảm bảo các trường mới luôn tồn tại
          if (!learningData[type].markov3Matrix) learningData[type].markov3Matrix = {};
          if (!learningData[type].reversalState.lastReversalPhien) learningData[type].reversalState.lastReversalPhien = 0;
        }
      }
      console.log('✅ Đã tải dữ liệu học hỏi');
    }
  } catch (error) {
    console.error('❌ Lỗi tải dữ liệu:', error.message);
  }
}

function saveLearningData() {
  try {
    fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData, null, 2));
  } catch (error) {
    console.error('❌ Lỗi lưu dữ liệu:', error.message);
  }
}

function loadPredictionHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(data);
      predictionHistory = parsed.history || { hu: [], md5: [] };
      lastProcessedPhien = parsed.lastProcessedPhien || { hu: null, md5: null };
      console.log('✅ Đã tải lịch sử dự đoán');
    }
  } catch (error) {
    console.error('❌ Lỗi tải lịch sử:', error.message);
  }
}

function savePredictionHistory() {
  try {
    const dataToSave = {
      history: predictionHistory, lastProcessedPhien,
      lastSaved: new Date().toISOString()
    };
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (error) {
    console.error('❌ Lỗi lưu lịch sử:', error.message);
  }
}

// === LẤY DỮ LIỆU API ===
function transformApiData(apiData) {
  if (!apiData || !apiData.list || !Array.isArray(apiData.list)) return null;
  return apiData.list.map(item => ({
    Phien: item.id,
    Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
    Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
    Tong: item.point
  }));
}

async function fetchDataHu() {
  try {
    const response = await axios.get(API_URL_HU, { timeout: 8000 });
    return transformApiData(response.data);
  } catch (error) {
    console.error('❌ Lỗi lấy dữ liệu HU:', error.message);
    return null;
  }
}

async function fetchDataMd5() {
  try {
    const response = await axios.get(API_URL_MD5, { timeout: 8000 });
    return transformApiData(response.data);
  } catch (error) {
    console.error('❌ Lỗi lấy dữ liệu MD5:', error.message);
    return null;
  }
}

// === CÁC HÀM PHÂN TÍCH CẦU ĐÃ TỐI ƯU ===
function getStreakInfo(results) {
  if (!results.length) return { type: null, length: 0 };
  let type = results[0], len = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === type) len++; else break;
  }
  return { type, length: len };
}

function analyzeCauBet(results, type) {
  const { length, type: streakType } = getStreakInfo(results);
  if (length < 3) return { detected: false };
  let prediction, confidence;
  if (length >= 6) {
    prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    confidence = Math.min(92, 72 + length * 2.5);
  } else if (length >= 4) {
    prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    confidence = 70 + length * 2;
  } else {
    prediction = streakType;
    confidence = 65;
  }
  return { detected: true, prediction, confidence, name: `Cầu Bệt ${length} phiên`, priority: 10 };
}

function analyzeCauDao11(results, type) {
  if (results.length < 5) return { detected: false };
  let len = 1;
  for (let i = 1; i < Math.min(results.length, 12); i++) {
    if (results[i] !== results[i-1]) len++; else break;
  }
  if (len >= 4) {
    const prediction = results[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction, confidence: Math.min(88, 70 + len * 2.2), name: `Cầu Đảo 1-1 (${len} phiên)`, priority: 9 };
  }
  return { detected: false };
}

function analyzeBreakStreak(results, type) {
  const { length, type: streakType } = getStreakInfo(results);
  if (length < 5) return { detected: false };
  const prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
  return { detected: true, prediction, confidence: Math.min(94, 75 + length * 2), name: `Bẻ Chuỗi ${length}`, priority: 11 };
}

function analyzeXuHuongManh(results, type) {
  if (results.length < 8) return { detected: false };
  const last8 = results.slice(0,8);
  const tai = last8.filter(r => r === 'Tài').length;
  if (tai >= 7) return { detected: true, prediction: 'Xỉu', confidence: 90, name: 'Xu Hướng Cực Tài → Đảo Xỉu', priority: 10 };
  if (tai >= 6) return { detected: true, prediction: 'Xỉu', confidence: 82, name: 'Xu Hướng Mạnh Tài → Đảo Xỉu', priority: 9 };
  if (tai <= 1) return { detected: true, prediction: 'Tài', confidence: 90, name: 'Xu Hướng Cực Xỉu → Đảo Tài', priority: 10 };
  if (tai <= 2) return { detected: true, prediction: 'Tài', confidence: 82, name: 'Xu Hướng Mạnh Xỉu → Đảo Tài', priority: 9 };
  return { detected: false };
}

function analyzeDaoChieu(results, type) {
  if (results.length < 6) return { detected: false };
  let isDao = true;
  for (let i = 0; i < 5; i++) {
    if (results[i] === results[i+1]) { isDao = false; break; }
  }
  if (isDao) {
    const prediction = results[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction, confidence: 85, name: 'Đảo Chiều Liên Tục', priority: 10 };
  }
  return { detected: false };
}

function analyzeTongPhanTich(data, type) {
  if (data.length < 10) return { detected: false };
  const sums = data.slice(0,10).map(d => d.Tong);
  const avgLast5 = sums.slice(0,5).reduce((a,b) => a+b,0)/5;
  const avgPrev5 = sums.slice(5,10).reduce((a,b) => a+b,0)/5;
  const chenhLech = avgLast5 - avgPrev5;
  
  if (chenhLech > 2) return { detected: true, prediction: 'Xỉu', confidence: 80, name: `Tổng Tăng Mạnh (${chenhLech.toFixed(1)}) → Xỉu`, priority: 11 };
  if (chenhLech < -2) return { detected: true, prediction: 'Tài', confidence: 80, name: `Tổng Giảm Mạnh (${Math.abs(chenhLech).toFixed(1)}) → Tài`, priority: 11 };
  if (sums[0] >= 14) return { detected: true, prediction: 'Xỉu', confidence: 78, name: 'Tổng Đạt Kháng Cự → Xỉu', priority: 8 };
  if (sums[0] <= 7) return { detected: true, prediction: 'Tài', confidence: 78, name: 'Tổng Đạt Hỗ Trợ → Tài', priority: 8 };
  return { detected: false };
}

function analyzeCau22(results, type) {
  if (results.length < 6) return { detected: false };
  let count = 0, i = 0;
  while (i < results.length -1) {
    if (results[i] === results[i+1]) { count++; i +=2; } else break;
  }
  if (count >= 2) {
    const last = results[0];
    const prediction = last === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction, confidence: 75 + count * 3, name: `Cầu 2-2 (${count} cặp)`, priority: 8 };
  }
  return { detected: false };
}

function analyzeCau33(results, type) {
  if (results.length < 9) return { detected: false };
  let count = 0, i = 0;
  while (i < results.length -2) {
    if (results[i] === results[i+1] && results[i+1] === results[i+2]) { count++; i +=3; } else break;
  }
  if (count >= 2) {
    const last = results[0];
    const prediction = last === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction, confidence: 80 + count * 3, name: `Cầu 3-3 (${count} bộ ba)`, priority: 9 };
  }
  return { detected: false };
}

// === NÂNG CẤP MÔ HÌNH MARKOV ===
function updateMarkovMatrices(type, results) {
  if (results.length < 15) return;
  let tt=0, tx=0, xt=0, xx=0;
  for (let i=0; i<results.length-1; i++) {
    if (results[i]==='Tài' && results[i+1]==='Tài') tt++;
    else if (results[i]==='Tài' && results[i+1]==='Xỉu') tx++;
    else if (results[i]==='Xỉu' && results[i+1]==='Tài') xt++;
    else xx++;
  }
  const total = tt+tx+xt+xx;
  if (total>0) learningData[type].markovMatrix = {
    TT: tt/total, TX: tx/total, XT: xt/total, XX: xx/total
  };

  // Markov bậc 2
  const m2 = {};
  for (let i=0; i<results.length-2; i++) {
    const key = results[i] + results[i+1];
    const next = results[i+2];
    m2[key] = m2[key] || { Tài:0, Xỉu:0 };
    m2[key][next]++;
  }
  learningData[type].markov2Matrix = m2;

  // Markov bậc 3 - TỐI ƯU MỚI
  const m3 = {};
  for (let i=0; i<results.length-3; i++) {
    const key = results[i] + results[i+1] + results[i+2];
    const next = results[i+3];
    m3[key] = m3[key] || { Tài:0, Xỉu:0 };
    m3[key][next]++;
  }
  learningData[type].markov3Matrix = m3;
}

function getMarkovPrediction(type, results) {
  const preds = [];
  const last1 = results[0], last2 = results[1], last3 = results[2];
  const ld = learningData[type];

  // Bậc 1
  if (last1) {
    const pTai = last1==='Tài' ? ld.markovMatrix.TT : ld.markovMatrix.XT;
    const pXiu = last1==='Tài' ? ld.markovMatrix.TX : ld.markovMatrix.XX;
    if (pTai > 0.72) preds.push({ prediction:'Tài', confidence:70 + pTai*15, priority:8, name:'Markov Bậc 1' });
    if (pXiu > 0.72) preds.push({ prediction:'Xỉu', confidence:70 + pXiu*15, priority:8, name:'Markov Bậc 1' });
  }

  // Bậc 2
  if (last1 && last2 && ld.markov2Matrix) {
    const key = last2 + last1;
    const data = ld.markov2Matrix[key];
    if (data && (data.Tài + data.Xỉu) >=3) {
      const total = data.Tài + data.Xỉu;
      if (data.Tài / total > 0.75) preds.push({ prediction:'Tài', confidence:75, priority:9, name:'Markov Bậc 2' });
      if (data.Xỉu / total > 0.75) preds.push({ prediction:'Xỉu', confidence:75, priority:9, name:'Markov Bậc 2' });
    }
  }

  // Bậc 3 - MỚI THÊM
  if (last1 && last2 && last3 && ld.markov3Matrix) {
    const key = last3 + last2 + last1;
    const data = ld.markov3Matrix[key];
    if (data && (data.Tài + data.Xỉu) >=2) {
      const total = data.Tài + data.Xỉu;
      if (data.Tài / total > 0.8) preds.push({ prediction:'Tài', confidence:82, priority:10, name:'Markov Bậc 3' });
      if (data.Xỉu / total > 0.8) preds.push({ prediction:'Xỉu', confidence:82, priority:10, name:'Markov Bậc 3' });
    }
  }
  return preds;
}

// === TÍNH ĐIỂM TRỌNG SỐ THÔNG MINH ===
function getPatternIdFromName(name) {
  const map = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Bẻ Chuỗi': 'break_streak',
    'Xu Hướng': 'xu_huong', 'Đảo Chiều': 'dao_chieu', 'Tổng Phân Tích': 'tong_phan_tich',
    'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33', 'Markov': 'markov'
  };
  for (const [k, v] of Object.entries(map)) if (name.includes(k)) return v;
  return 'unknown';
}

// === HÀM DỰ ĐOÁN CHÍNH SIÊU CHUẨN ===
function calculateAdvancedPrediction(data, type) {
  const results = data.map(d => d.Ket_qua);
  const sums = data.map(d => d.Tong);
  updateMarkovMatrices(type, results);
  const ld = learningData[type];
  let allPredictions = [];
  let factors = [];

  // Lấy dự đoán từ tất cả các hàm phân tích
  const patternFunctions = [
    analyzeCauBet, analyzeCauDao11, analyzeBreakStreak, analyzeXuHuongManh,
    analyzeDaoChieu, analyzeCau22, analyzeCau33
  ];
  
  for (const fn of patternFunctions) {
    const res = fn(results, type);
    if (res?.detected) {
      allPredictions.push(res);
      factors.push(res.name);
    }
  }

  // Thêm phân tích tổng và Markov
  const tongRes = analyzeTongPhanTich(data, type);
  if (tongRes?.detected) { allPredictions.push(tongRes); factors.push(tongRes.name); }
  allPredictions.push(...getMarkovPrediction(type, results));

  // === TÍNH ĐIỂM TRỌNG SỐ THÔNG MINH ===
  let taiScore = 0, xiuScore = 0;
  const recentAcc = ld.recentAccuracy.length ? ld.recentAccuracy.reduce((a,b)=>a+b,0)/ld.recentAccuracy.length : 0.7;
  const accMultiplier = 0.8 + recentAcc * 0.4;

  for (const p of allPredictions) {
    const patId = getPatternIdFromName(p.name);
    const weight = ld.patternWeights[patId] || 1.0;
    const score = p.confidence * weight * (p.priority / 8) * accMultiplier;
    if (p.prediction === 'Tài') taiScore += score;
    else xiuScore += score;
  }

  // === CHỐNG TRƯỜNG HỢP ĐOÁN SAI LIÊN TỤC ===
  const currentStreak = ld.streakAnalysis.currentStreak;
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  
  // Chế độ đảo chiều thông minh
  if (currentStreak <= -3 && ld.reversalState.lastReversalPhien !== lastProcessedPhien[type]) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    ld.reversalState = { active: true, streakTrigger: currentStreak, lastReversalPhien: lastProcessedPhien[type] };
    factors.push('🔄 Đảo Chiều Thông Minh');
  } else if (currentStreak > 0) {
    ld.reversalState.active = false;
  }

  // === TÍNH ĐỘ TIN CẬY CHUẨN ===
  const totalScore = taiScore + xiuScore;
  let finalConf = 60;
  if (totalScore > 0) {
    const ratio = Math.max(taiScore, xiuScore) / totalScore;
    finalConf = Math.round(55 + ratio * 35 + (allPredictions.length >=3 ? 3 : 0));
  }
  finalConf = Math.min(95, Math.max(58, finalConf));

  return {
    prediction: finalPrediction, confidence: finalConf,
    factors: factors.slice(0, 6), totalPatterns: allPredictions.length,
    taiVotes: allPredictions.filter(p=>p.prediction==='Tài').length,
    xiuVotes: allPredictions.filter(p=>p.prediction==='Xỉu').length,
    accuracy: ld.totalPredictions ? (ld.correctPredictions/ld.totalPredictions*100).toFixed(1)+'%' : 'N/A',
    currentStreak: currentStreak
  };
}

// === XÁC MINH VÀ HỌC HỎI TỰ ĐỘNG ===
async function verifyPredictions(type, currentData) {
  let updated = false;
  for (const pred of learningData[type].predictions) {
    if (pred.verified) continue;
    const actual = currentData.find(d => d.Phien.toString() === pred.phien);
    if (actual) {
      pred.verified = true;
      pred.actual = actual.Ket_qua;
      pred.isCorrect = pred.prediction === pred.actual;
      
      learningData[type].totalPredictions++;
      if (pred.isCorrect) {
        learningData[type].correctPredictions++;
        learningData[type].streakAnalysis.currentStreak = Math.max(1, learningData[type].streakAnalysis.currentStreak + 1);
        learningData[type].streakAnalysis.wins++;
        learningData[type].streakAnalysis.bestStreak = Math.max(learningData[type].streakAnalysis.bestStreak, learningData[type].streakAnalysis.currentStreak);
      } else {
        learningData[type].streakAnalysis.currentStreak = Math.min(-1, learningData[type].streakAnalysis.currentStreak - 1);
        learningData[type].streakAnalysis.losses++;
        learningData[type].streakAnalysis.worstStreak = Math.min(learningData[type].streakAnalysis.worstStreak, learningData[type].streakAnalysis.currentStreak);
      }
      
      // Cập nhật trọng số cầu
      pred.patterns.forEach(pName => {
        const patId = getPatternIdFromName(pName);
        if (!learningData[type].patternStats[patId]) {
          learningData[type].patternStats[patId] = { total:0, correct:0 };
        }
        learningData[type].patternStats[patId].total++;
        if (pred.isCorrect) learningData[type].patternStats[patId].correct++;
        const acc = learningData[type].patternStats[patId].correct / learningData[type].patternStats[patId].total;
        learningData[type].patternWeights[patId] = Math.min(1.8, Math.max(0.5, acc * 1.4));
      });

      learningData[type].recentAccuracy.push(pred.isCorrect ? 1 : 0);
      if (learningData[type].recentAccuracy.length > 30) learningData[type].recentAccuracy.shift();
      updated = true;
    }
  }
  if (updated) saveLearningData();
}

function recordPrediction(type, phien, prediction, confidence, patterns) {
  learningData[type].predictions.unshift({
    phien: phien.toString(), prediction, confidence, patterns,
    timestamp: new Date().toISOString(), verified: false, actual: null, isCorrect: null
  });
  if (learningData[type].predictions.length > 300) learningData[type].predictions.pop();
}

function savePredictionToHistory(type, phien, prediction, confidence, latestData) {
  const record = {
    Phien: latestData.Phien, Xuc_xac_1: latestData.Xuc_xac_1, Xuc_xac_2: latestData.Xuc_xac_2, Xuc_xac_3: latestData.Xuc_xac_3,
    Tong: latestData.Tong, Ket_qua: latestData.Ket_qua, Do_tin_cay: `${confidence}%`,
    Phien_hien_tai: phien.toString(), Du_doan: prediction, ket_qua_du_doan: '',
    id: '@Tskhang', timestamp: new Date().toISOString()
  };
  predictionHistory[type].unshift(record);
  if (predictionHistory[type].length > MAX_HISTORY) predictionHistory[type].pop();
  return record;
}

async function updateHistoryStatus(type) {
  const data = type==='hu' ? await fetchDataHu() : await fetchDataMd5();
  if (!data) return;
  for (const record of predictionHistory[type]) {
    if (record.ket_qua_du_doan) continue;
    const actual = data.find(d => d.Phien.toString() === record.Phien_hien_tai);
    if (actual) {
      record.ket_qua_du_doan = record.Du_doan === actual.Ket_qua ? '✅ Đúng' : '❌ Sai';
    }
  }
  savePredictionHistory();
}

// === TỰ ĐỘNG CHẠY LIÊN TỤC ===
async function autoProcessPredictions() {
  try {
    // Xử lý HU
    const dataHu = await fetchDataHu();
    if (dataHu?.length > 0) {
      const nextPhien = dataHu[0].Phien + 1;
      if (lastProcessedPhien.hu !== nextPhien) {
        await verifyPredictions('hu', dataHu);
        const result = calculateAdvancedPrediction(dataHu, 'hu');
        savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence, dataHu[0]);
        recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
        lastProcessedPhien.hu = nextPhien;
        console.log(`🎯 HU Phiên ${nextPhien}: ${result.prediction} | ${result.confidence}% | Độ chính xác TB: ${result.accuracy}`);
      }
    }

    // Xử lý MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5?.length > 0) {
      const nextPhien = dataMd5[0].Phien + 1;
      if (lastProcessedPhien.md5 !== nextPhien) {
        await verifyPredictions('md5', dataMd5);
        const result = calculateAdvancedPrediction(dataMd5, 'md5');
        savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence, dataMd5[0]);
        recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
        lastProcessedPhien.md5 = nextPhien;
        console.log(`🎯 MD5 Phiên ${nextPhien}: ${result.prediction} | ${result.confidence}% | Độ chính xác TB: ${result.accuracy}`);
      }
    }
    savePredictionHistory();
    saveLearningData();
  } catch (e) {
    console.error('❌ Lỗi xử lý tự động:', e.message);
  }
}

function startAutoSaveTask() {
  setTimeout(autoProcessPredictions, 3000);
  setInterval(autoProcessPredictions, AUTO_SAVE_INTERVAL);
}

// === API ROUTES ===
app.get('/', (req, res) => res.send('🎯 Bắt Cầu Siêu Chuẩn @Tskhang'));

app.get('/hu', async (req, res) => {
  try {
    const data = await fetchDataHu();
    if (!data) return res.status(500).json({ error: 'Lỗi lấy dữ liệu' });
    await verifyPredictions('hu', data);
    const nextPhien = data[0].Phien + 1;
    const result = calculateAdvancedPrediction(data, 'hu');
    const record = savePredictionToHistory('hu', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('hu', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('hu'), 4000);
    res.json({ ...record, phan_tich: result });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/md5', async (req, res) => {
  try {
    const data = await fetchDataMd5();
    if (!data) return res.status(500).json({ error: 'Lỗi lấy dữ liệu' });
    await verifyPredictions('md5', data);
    const nextPhien = data[0].Phien + 1;
    const result = calculateAdvancedPrediction(data, 'md5');
    const record = savePredictionToHistory('md5', nextPhien, result.prediction, result.confidence, data[0]);
    recordPrediction('md5', nextPhien, result.prediction, result.confidence, result.factors);
    setTimeout(() => updateHistoryStatus('md5'), 4000);
    res.json({ ...record, phan_tich: result });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/hu/lichsu', async (req, res) => { await updateHistoryStatus('hu'); res.json({ type: 'HU - Tài Xỉu Hũ', history: predictionHistory.hu, id: '@Tskhang' }); });
app.get('/md5/lichsu', async (req, res) => { await updateHistoryStatus('md5'); res.json({ type: 'MD5 - Tài Xỉu MD5', history: predictionHistory.md5, id: '@Tskhang' }); });
app.get('/hu/thongke', (req, res) => {
  const s = learningData.hu;
  res.json({ type: 'HU Thống Kê', tong_du_doan: s.totalPredictions, dung: s.correctPredictions, do_chinh_xac: s.totalPredictions ? (s.correctPredictions/s.totalPredictions*100).toFixed(1)+'%' : '0%', hien_tai: s.streakAnalysis.currentStreak, id: '@Tskhang' });
});
app.get('/md5/thongke', (req, res) => {
  const s = learningData.md5;
  res.json({ type: 'MD5 Thống Kê', tong_du_doan: s.totalPredictions, dung: s.correctPredictions, do_chinh_xac: s.totalPredictions ? (s.correctPredictions/s.totalPredictions*100).toFixed(1)+'%' : '0%', hien_tai: s.streakAnalysis.currentStreak, id: '@Tskhang' });
});

// === KHỞI ĐỘNG ===
loadLearningData();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server chạy thành công tại cổng ${PORT}`);
  console.log(`🚀 Đã nâng cấp toàn bộ thuật toán bắt cầu siêu ngon!`);
  startAutoSaveTask();
});