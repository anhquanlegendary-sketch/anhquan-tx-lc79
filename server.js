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

// ==================== THUẬT TOÁN BẮT CẦU SIÊU XỊN NHẤT ====================

// 1. MẠNG NƠRON ĐƠN GIẢN - PERCEPTRON ĐA LỚP
function analyzeNeuralNetwork(results, type) {
    if (results.length < 20) return null;
    
    // Mã hóa: Tài = 1, Xỉu = 0
    const encoded = results.slice(0, 20).map(r => r === 'Tài' ? 1 : 0);
    
    // Trọng số học từ dữ liệu quá khứ
    const weights = learningData[type].neuralWeights || {
        w1: 0.3, w2: 0.25, w3: 0.2, w4: 0.15, w5: 0.1,
        bias: 0.5
    };
    
    // Dự đoán dựa trên 5 phiên gần nhất
    let input = 0;
    for (let i = 0; i < 5; i++) {
        input += encoded[i] * weights[`w${i+1}`];
    }
    input += weights.bias;
    
    // Hàm sigmoid
    const output = 1 / (1 + Math.exp(-input));
    
    // Cập nhật trọng số (học online)
    const learningRate = 0.1;
    const target = encoded[5] || 0.5;
    const error = target - output;
    
    for (let i = 0; i < 5; i++) {
        weights[`w${i+1}`] += learningRate * error * encoded[i];
    }
    weights.bias += learningRate * error;
    
    learningData[type].neuralWeights = weights;
    
    if (output > 0.65 || output < 0.35) {
        return {
            detected: true,
            prediction: output > 0.5 ? 'Tài' : 'Xỉu',
            confidence: 70 + Math.abs(output - 0.5) * 40,
            priority: 13,
            name: '🧠 Mạng Nơron'
        };
    }
    return null;
}

// 2. THUẬT TOÁN DI TRUYỀN - TÌM QUY LUẬT TỐI ƯU
function analyzeGeneticPattern(results, type) {
    if (results.length < 15) return null;
    
    const patterns = learningData[type].geneticPatterns || {};
    const key = results.slice(0, 5).join('');
    
    if (!patterns[key]) {
        patterns[key] = { tai: 0, xiu: 0 };
    }
    
    // Dự đoán dựa trên pattern
    const total = patterns[key].tai + patterns[key].xiu;
    if (total > 3) {
        const probTai = patterns[key].tai / total;
        if (probTai > 0.7 || probTai < 0.3) {
            return {
                detected: true,
                prediction: probTai > 0.5 ? 'Tài' : 'Xỉu',
                confidence: 70 + Math.abs(probTai - 0.5) * 40,
                priority: 12,
                name: '🧬 Di Truyền'
            };
        }
    }
    
    // Cập nhật
    if (results.length > 5) {
        const next = results[5];
        if (next === 'Tài') patterns[key].tai++;
        else patterns[key].xiu++;
    }
    learningData[type].geneticPatterns = patterns;
    
    return null;
}

// 3. MÔ HÌNH HỖN HỢP GAUSSIAN
function analyzeGaussianMixture(results, type) {
    if (results.length < 15) return null;
    
    const encoded = results.slice(0, 15).map(r => r === 'Tài' ? 1 : 0);
    const mean = encoded.reduce((a, b) => a + b, 0) / encoded.length;
    const variance = encoded.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / encoded.length;
    
    // Dự đoán dựa trên phân phối
    const last5 = encoded.slice(0, 5);
    const lastMean = last5.reduce((a, b) => a + b, 0) / last5.length;
    
    const zScore = (lastMean - mean) / Math.sqrt(variance + 0.01);
    
    if (Math.abs(zScore) > 0.5) {
        return {
            detected: true,
            prediction: zScore > 0 ? 'Xỉu' : 'Tài',
            confidence: 72 + Math.min(20, Math.abs(zScore) * 15),
            priority: 11,
            name: '📊 Gaussian Mixture'
        };
    }
    return null;
}

// 4. THUẬT TOÁN RANDOM FOREST ĐƠN GIẢN
function analyzeRandomForest(results, type) {
    if (results.length < 20) return null;
    
    // 3 cây quyết định đơn giản
    const encoded = results.slice(0, 20).map(r => r === 'Tài' ? 1 : 0);
    const predictions = [];
    
    // Cây 1: Dựa trên tổng 5 phiên
    const sum5 = encoded.slice(0, 5).reduce((a, b) => a + b, 0);
    predictions.push(sum5 >= 3 ? 1 : 0);
    
    // Cây 2: Dựa trên xu hướng
    const trend = encoded[0] - encoded[4];
    predictions.push(trend > 0 ? 1 : (trend < 0 ? 0 : 0.5));
    
    // Cây 3: Dựa trên pattern đặc biệt
    const pattern = encoded.slice(0, 3).join('');
    const patternMap = { '111': 1, '000': 0, '110': 1, '001': 0, '101': 0.5, '010': 0.5 };
    predictions.push(patternMap[pattern] !== undefined ? patternMap[pattern] : 0.5);
    
    // Bỏ phiếu
    const vote = predictions.reduce((a, b) => a + b, 0) / predictions.length;
    
    if (vote > 0.65 || vote < 0.35) {
        return {
            detected: true,
            prediction: vote > 0.5 ? 'Tài' : 'Xỉu',
            confidence: 68 + Math.abs(vote - 0.5) * 45,
            priority: 12,
            name: '🌲 Random Forest'
        };
    }
    return null;
}

// 5. THUẬT TOÁN MẠNG BAYES
function analyzeBayesianNetwork(results, type) {
    if (results.length < 15) return null;
    
    const stats = learningData[type].bayesianStats || {
        tt: 0, tx: 0, xt: 0, xx: 0,
        ttt: 0, ttx: 0, txt: 0, txx: 0,
        xtt: 0, xtx: 0, xxt: 0, xxx: 0
    };
    
    // Cập nhật thống kê
    for (let i = 0; i < results.length - 2; i++) {
        const key = results[i] + results[i+1];
        const next = results[i+2];
        if (key === 'TàiTài') stats[`t${next === 'Tài' ? 't' : 'x'}`]++;
        else if (key === 'TàiXỉu') stats[`t${next === 'Tài' ? 't' : 'x'}`]++;
        else if (key === 'XỉuTài') stats[`x${next === 'Tài' ? 't' : 'x'}`]++;
        else if (key === 'XỉuXỉu') stats[`x${next === 'Tài' ? 't' : 'x'}`]++;
    }
    learningData[type].bayesianStats = stats;
    
    // Dự đoán
    const last2 = results[0] + results[1];
    let probTai = 0.5;
    
    if (last2 === 'TàiTài') {
        const total = stats.ttt + stats.ttx;
        probTai = total > 0 ? stats.ttt / total : 0.5;
    } else if (last2 === 'TàiXỉu') {
        const total = stats.txt + stats.txx;
        probTai = total > 0 ? stats.txt / total : 0.5;
    } else if (last2 === 'XỉuTài') {
        const total = stats.xtt + stats.xtx;
        probTai = total > 0 ? stats.xtt / total : 0.5;
    } else if (last2 === 'XỉuXỉu') {
        const total = stats.xxt + stats.xxx;
        probTai = total > 0 ? stats.xxt / total : 0.5;
    }
    
    if (probTai > 0.7 || probTai < 0.3) {
        return {
            detected: true,
            prediction: probTai > 0.5 ? 'Tài' : 'Xỉu',
            confidence: 68 + Math.abs(probTai - 0.5) * 45,
            priority: 12,
            name: '📈 Mạng Bayes'
        };
    }
    return null;
}

// 6. THUẬT TOÁN CẦU KÉP 2 LỚP
function analyzeDoubleLayerPattern(results, type) {
    if (results.length < 10) return null;
    
    // Lớp 1: Phát hiện cấu trúc
    const patterns = [];
    for (let i = 0; i < results.length - 3; i++) {
        patterns.push(results.slice(i, i+3));
    }
    
    // Lớp 2: Phân tích cấu trúc
    let taiCount = 0, xiuCount = 0;
    for (const p of patterns) {
        if (p[0] === p[1] && p[1] !== p[2]) taiCount++;
        else if (p[0] !== p[1] && p[1] === p[2]) xiuCount++;
    }
    
    if (taiCount >= 3 || xiuCount >= 3) {
        const pred = taiCount > xiuCount ? 'Xỉu' : 'Tài';
        const confidence = 75 + Math.min(10, Math.abs(taiCount - xiuCount) * 2);
        return {
            detected: true,
            prediction: pred,
            confidence: Math.min(92, confidence),
            priority: 10,
            name: '🔮 Cầu Kép 2 Lớp'
        };
    }
    return null;
}

// 7. THUẬT TOÁN PHÂN TÍCH CHU KỲ 3 PHA
function analyzeThreePhaseCycle(results, type) {
    if (results.length < 12) return null;
    
    // Chia thành 3 pha: 4 phiên mỗi pha
    const phase1 = results.slice(0, 4);
    const phase2 = results.slice(4, 8);
    const phase3 = results.slice(8, 12);
    
    const tai1 = phase1.filter(r => r === 'Tài').length;
    const tai2 = phase2.filter(r => r === 'Tài').length;
    const tai3 = phase3.filter(r => r === 'Tài').length;
    
    // Phân tích xu hướng 3 pha
    const trends = [tai2 - tai1, tai3 - tai2];
    
    if (trends[0] > 0 && trends[1] < 0) {
        return {
            detected: true,
            prediction: 'Xỉu',
            confidence: 78,
            priority: 10,
            name: '📊 Chu Kỳ 3 Pha (Đỉnh)'
        };
    } else if (trends[0] < 0 && trends[1] > 0) {
        return {
            detected: true,
            prediction: 'Tài',
            confidence: 78,
            priority: 10,
            name: '📊 Chu Kỳ 3 Pha (Đáy)'
        };
    } else if (trends[0] > 0 && trends[1] > 0) {
        return {
            detected: true,
            prediction: 'Xỉu',
            confidence: 72,
            priority: 9,
            name: '📈 Chu Kỳ 3 Pha (Tăng)'
        };
    } else if (trends[0] < 0 && trends[1] < 0) {
        return {
            detected: true,
            prediction: 'Tài',
            confidence: 72,
            priority: 9,
            name: '📉 Chu Kỳ 3 Pha (Giảm)'
        };
    }
    return null;
}

// 8. THUẬT TOÁN CẦU ĐỐI XỨNG TÂM
function analyzeCenterSymmetric(results, type) {
    if (results.length < 7) return null;
    
    // Kiểm tra đối xứng quanh tâm
    const mid = Math.floor(results.length / 2);
    let symmetric = true;
    
    for (let i = 0; i < mid; i++) {
        if (i < results.length - i - 1) {
            if (results[i] !== results[results.length - i - 1]) {
                symmetric = false;
                break;
            }
        }
    }
    
    if (symmetric && results.length >= 7) {
        const center = results[mid];
        const pred = center === 'Tài' ? 'Xỉu' : 'Tài';
        return {
            detected: true,
            prediction: pred,
            confidence: 82,
            priority: 11,
            name: '🔄 Cầu Đối Xứng Tâm'
        };
    }
    return null;
}

// 9. THUẬT TOÁN MA TRẬN XÁC SUẤT NÂNG CAO
function analyzeAdvancedMarkov(results, type) {
    if (results.length < 20) return null;
    
    // Xây dựng ma trận xác suất đầy đủ
    const matrix = {};
    for (let i = 0; i < results.length - 3; i++) {
        const state = results[i] + results[i+1] + results[i+2];
        const next = results[i+3];
        if (!matrix[state]) matrix[state] = {};
        matrix[state][next] = (matrix[state][next] || 0) + 1;
    }
    
    // Thêm smoothing
    const states = ['TàiTàiTài', 'TàiTàiXỉu', 'TàiXỉuTài', 'TàiXỉuXỉu', 
                    'XỉuTàiTài', 'XỉuTàiXỉu', 'XỉuXỉuTài', 'XỉuXỉuXỉu'];
    for (const state of states) {
        if (!matrix[state]) {
            matrix[state] = { 'Tài': 1, 'Xỉu': 1 };
        }
        if (!matrix[state]['Tài']) matrix[state]['Tài'] = 1;
        if (!matrix[state]['Xỉu']) matrix[state]['Xỉu'] = 1;
    }
    
    const currentState = results.slice(0, 3).join('');
    if (matrix[currentState]) {
        const probs = matrix[currentState];
        const total = probs['Tài'] + probs['Xỉu'];
        const probTai = probs['Tài'] / total;
        
        if (probTai > 0.65 || probTai < 0.35) {
            return {
                detected: true,
                prediction: probTai > 0.5 ? 'Tài' : 'Xỉu',
                confidence: 72 + Math.abs(probTai - 0.5) * 35,
                priority: 14,
                name: '📊 Ma Trận Xác Suất'
            };
        }
    }
    return null;
}

// 10. THUẬT TOÁN HỌC TĂNG CƯỜNG (REINFORCEMENT LEARNING)
function analyzeReinforcementLearning(results, type) {
    if (results.length < 15) return null;
    
    const rl = learningData[type].reinforcement || {
        Q: {}, // Q-learning table
        alpha: 0.1, // learning rate
        gamma: 0.9, // discount factor
        epsilon: 0.1 // exploration rate
    };
    
    // State: 2 phiên gần nhất
    const state = results[0] + results[1];
    const actions = ['Tài', 'Xỉu'];
    
    // Khởi tạo Q table nếu chưa có
    if (!rl.Q[state]) {
        rl.Q[state] = { 'Tài': 0.5, 'Xỉu': 0.5 };
    }
    
    // Chọn action (exploration vs exploitation)
    let action;
    if (Math.random() < rl.epsilon) {
        action = actions[Math.floor(Math.random() * actions.length)];
    } else {
        action = rl.Q[state]['Tài'] >= rl.Q[state]['Xỉu'] ? 'Tài' : 'Xỉu';
    }
    
    // Cập nhật Q-learning
    if (results.length > 2) {
        const nextState = results[1] + results[2];
        const reward = results[2] === action ? 1 : -0.5;
        
        if (!rl.Q[nextState]) {
            rl.Q[nextState] = { 'Tài': 0.5, 'Xỉu': 0.5 };
        }
        
        const maxNext = Math.max(rl.Q[nextState]['Tài'], rl.Q[nextState]['Xỉu']);
        rl.Q[state][action] = rl.Q[state][action] + rl.alpha * (reward + rl.gamma * maxNext - rl.Q[state][action]);
    }
    
    learningData[type].reinforcement = rl;
    
    // Dự đoán
    const qTai = rl.Q[state]['Tài'] || 0.5;
    const qXiu = rl.Q[state]['Xỉu'] || 0.5;
    
    if (Math.abs(qTai - qXiu) > 0.3) {
        return {
            detected: true,
            prediction: qTai > qXiu ? 'Tài' : 'Xỉu',
            confidence: 68 + Math.abs(qTai - qXiu) * 50,
            priority: 13,
            name: '🤖 Học Tăng Cường'
        };
    }
    return null;
}

// 11. THUẬT TOÁN CẦU THỜI GIAN (TIME SERIES)
function analyzeTimeSeries(results, type) {
    if (results.length < 20) return null;
    
    const encoded = results.slice(0, 20).map(r => r === 'Tài' ? 1 : 0);
    
    // Tính các chỉ số
    const ma5 = encoded.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const ma10 = encoded.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const ma20 = encoded.reduce((a, b) => a + b, 0) / 20;
    
    // RSI đơn giản
    let gain = 0, loss = 0;
    for (let i = 1; i < 14; i++) {
        const diff = encoded[i-1] - encoded[i];
        if (diff > 0) gain += diff;
        else loss += Math.abs(diff);
    }
    const rsi = gain + loss > 0 ? (gain / (gain + loss)) * 100 : 50;
    
    // Bollinger Bands
    const std = Math.sqrt(encoded.reduce((a, b) => a + Math.pow(b - ma20, 2), 0) / 20);
    const upper = ma20 + 2 * std;
    const lower = ma20 - 2 * std;
    const current = encoded[0];
    
    let prediction = null;
    let confidence = 65;
    let name = '';
    
    if (current > upper) {
        prediction = 'Xỉu';
        confidence = 78;
        name = '📈 Time Series (Quá Mua)';
    } else if (current < lower) {
        prediction = 'Tài';
        confidence = 78;
        name = '📈 Time Series (Quá Bán)';
    } else if (ma5 > ma10 && ma10 > ma20) {
        prediction = 'Xỉu';
        confidence = 72;
        name = '📈 Time Series (Xu Hướng)';
    } else if (ma5 < ma10 && ma10 < ma20) {
        prediction = 'Tài';
        confidence = 72;
        name = '📈 Time Series (Xu Hướng)';
    } else if (rsi > 70) {
        prediction = 'Xỉu';
        confidence = 75;
        name = '📈 Time Series (RSI)';
    } else if (rsi < 30) {
        prediction = 'Tài';
        confidence = 75;
        name = '📈 Time Series (RSI)';
    }
    
    if (prediction) {
        return {
            detected: true,
            prediction: prediction,
            confidence: confidence,
            priority: 11,
            name: name
        };
    }
    return null;
}

// 12. THUẬT TOÁN KẾT HỢP CÁC CẦU SIÊU ĐẲNG
function analyzeSuperCombination(results, type) {
    if (results.length < 12) return null;
    
    // Kết hợp nhiều cầu cùng lúc
    let taiScore = 0, xiuScore = 0;
    let patterns = [];
    
    // Kiểm tra các cầu cơ bản
    const checks = [
        { func: (r) => r[0] === r[1] && r[1] === r[2] && r[2] === r[3], name: 'Bệt 4', tai: 1, xiu: 0 },
        { func: (r) => r[0] !== r[1] && r[1] !== r[2] && r[2] !== r[3], name: 'Đan Xen', tai: 0, xiu: 1 },
        { func: (r) => r[0] === r[1] && r[2] === r[3] && r[0] !== r[2], name: 'Cặp Đôi', tai: 1, xiu: 1 },
        { func: (r) => r[0] === r[2] && r[1] === r[3] && r[0] !== r[1], name: 'Đối Xứng', tai: 1, xiu: 1 },
        { func: (r) => r[0] === r[1] && r[1] !== r[2] && r[2] === r[3], name: 'Hình Tháp', tai: 1, xiu: 1 },
        { func: (r) => r[0] !== r[1] && r[1] === r[2] && r[2] !== r[3], name: 'Tam Giác', tai: 1, xiu: 1 }
    ];
    
    for (const check of checks) {
        if (check.func(results)) {
            taiScore += check.tai;
            xiuScore += check.xiu;
            patterns.push(check.name);
        }
    }
    
    // Phân tích tổng
    const sum = results.slice(0, 4).reduce((acc, r) => acc + (r === 'Tài' ? 1 : 0), 0);
    if (sum >= 3) xiuScore += 2;
    else if (sum <= 1) taiScore += 2;
    
    if (patterns.length >= 2 || Math.abs(taiScore - xiuScore) >= 2) {
        const pred = taiScore > xiuScore ? 'Tài' : 'Xỉu';
        const confidence = 75 + Math.min(15, patterns.length * 3 + Math.abs(taiScore - xiuScore) * 2);
        return {
            detected: true,
            prediction: pred,
            confidence: Math.min(94, confidence),
            priority: 15,
            name: `⭐ Super Combo (${patterns.join(', ')})`
        };
    }
    return null;
}

// ==================== CÁC HÀM PHÂN TÍCH CẦU CƠ BẢN ====================

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
    let confidence = streakLength >= 7 ? 90 : (streakLength >= 5 ? 82 : 75);
    return {
      detected: true,
      prediction: shouldBreak ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: confidence,
      name: `🔥 Cầu Bệt ${streakLength}`,
      priority: 10 + Math.min(3, streakLength)
    };
  }
  return null;
}

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
      name: `🔄 Cầu Đảo 1-1`,
      priority: 9
    };
  }
  return null;
}

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
        confidence: Math.min(84, 68 + pairCount * 4),
        name: `📦 Cầu 2-2`,
        priority: 8
      };
    }
  }
  return null;
}

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
      confidence: Math.min(86, 70 + tripleCount * 5),
      name: `📦 Cầu 3-3`,
      priority: 8
    };
  }
  return null;
}

function analyzeCau121(results, type) {
  if (results.length < 4) return null;
  const pattern1 = results.slice(0, 4);
  if (pattern1[0] !== pattern1[1] && pattern1[1] === pattern1[2] && pattern1[2] !== pattern1[3] && pattern1[0] === pattern1[3]) {
    return { detected: true, prediction: pattern1[0], confidence: 78, name: '📐 Cầu 1-2-1', priority: 7 };
  }
  return null;
}

function analyzeCau123(results, type) {
  if (results.length < 6) return null;
  const first = results[5];
  const nextTwo = results.slice(3, 5);
  const lastThree = results.slice(0, 3);
  if (nextTwo[0] === nextTwo[1] && nextTwo[0] !== first) {
    const allSame = lastThree.every(r => r === lastThree[0]);
    if (allSame && lastThree[0] !== nextTwo[0]) {
      return { detected: true, prediction: first, confidence: 78, name: '📐 Cầu 1-2-3', priority: 7 };
    }
  }
  return null;
}

function analyzeCau321(results, type) {
  if (results.length < 6) return null;
  const first3 = results.slice(3, 6);
  const next2 = results.slice(1, 3);
  const last1 = results[0];
  const first3Same = first3.every(r => r === first3[0]);
  const next2Same = next2.every(r => r === next2[0]);
  if (first3Same && next2Same && first3[0] !== next2[0] && last1 !== next2[0]) {
    return { detected: true, prediction: next2[0], confidence: 78, name: '📐 Cầu 3-2-1', priority: 7 };
  }
  return null;
}

function analyzeCauNhayCoc(results, type) {
  if (results.length < 6) return null;
  const skipPattern = [];
  for (let i = 0; i < Math.min(results.length, 12); i += 2) skipPattern.push(results[i]);
  if (skipPattern.length >= 3) {
    const allSame = skipPattern.slice(0, 3).every(r => r === skipPattern[0]);
    if (allSame) return { detected: true, prediction: skipPattern[0], confidence: 74, name: '🐸 Cầu Nhảy Cóc', priority: 6 };
    let alternating = true;
    for (let i = 1; i < skipPattern.length - 1; i++) if (skipPattern[i] === skipPattern[i - 1]) alternating = false;
    if (alternating && skipPattern.length >= 3) {
      return { detected: true, prediction: skipPattern[0] === 'Tài' ? 'Xỉu' : 'Tài', confidence: 72, name: '🐸 Cầu Nhảy Cóc Đảo', priority: 6 };
    }
  }
  return null;
}

function analyzeCauNhipNghieng(results, type) {
  if (results.length < 5) return null;
  const last5 = results.slice(0, 5);
  const taiCount5 = last5.filter(r => r === 'Tài').length;
  if (taiCount5 >= 4) {
    return { detected: true, prediction: 'Tài', confidence: 76, name: `📊 Cầu Nhịp Nghiêng`, priority: 6 };
  } else if (taiCount5 <= 1) {
    return { detected: true, prediction: 'Xỉu', confidence: 76, name: `📊 Cầu Nhịp Nghiêng`, priority: 6 };
  }
  return null;
}

function analyzeCau3Van1(results, type) {
  if (results.length < 4) return null;
  const last4 = results.slice(0, 4);
  const taiCount = last4.filter(r => r === 'Tài').length;
  if (taiCount === 3) return { detected: true, prediction: 'Xỉu', confidence: 74, name: '🎯 Cầu 3 Ván 1', priority: 6 };
  if (taiCount === 1) return { detected: true, prediction: 'Tài', confidence: 74, name: '🎯 Cầu 3 Ván 1', priority: 6 };
  return null;
}

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
    return { detected: true, prediction: currentDominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 84, name: `🔄 Đảo Xu Hướng`, priority: 9 };
  }
  const taiLast10 = last10.filter(r => r === 'Tài').length;
  if (taiLast10 >= 8 || taiLast10 <= 2) {
    const dominant = taiLast10 >= 8 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: dominant === 'Tài' ? 'Xỉu' : 'Tài', confidence: 86, name: `📈 Xu Hướng Cực`, priority: 9 };
  }
  return null;
}

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
    return { detected: true, prediction: prediction, confidence: Math.min(92, 74 + streakLength * 2), name: `⛔ Bẻ Chuỗi ${streakLength}`, priority: 12 };
  }
  return null;
}

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
      return { detected: true, prediction: prediction, confidence: 92, name: `🎲 3 Bộ Ba`, priority: 13 };
    }
    if (tripleType1 !== tripleType2 && tripleType2 !== tripleType3) {
      return { detected: true, prediction: tripleType1, confidence: 86, name: `🎲 Bộ Ba Đảo`, priority: 12 };
    }
  }
  return null;
}

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
  if (sumTrend > 1.5) return { detected: true, prediction: 'Xỉu', confidence: 80, name: `📊 Tổng tăng → Xỉu`, priority: 11 };
  if (sumTrend < -1.5) return { detected: true, prediction: 'Tài', confidence: 80, name: `📊 Tổng giảm → Tài`, priority: 11 };
  if (Math.abs(taiCount - xiuCount) >= 3) {
    const lech = taiCount > xiuCount ? 'Tài' : 'Xỉu';
    const prediction = lech === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 76, name: `⚖️ Cân bằng tổng`, priority: 10 };
  }
  return null;
}

function analyzeXuHuongManh(results, type) {
  if (results.length < 8) return null;
  const recent8 = results.slice(0, 8);
  const taiCount = recent8.filter(r => r === 'Tài').length;
  if (taiCount >= 6) return { detected: true, prediction: 'Xỉu', confidence: 84, name: `📈 Xu Hướng Mạnh`, priority: 11 };
  if (taiCount <= 2) return { detected: true, prediction: 'Tài', confidence: 84, name: `📈 Xu Hướng Mạnh`, priority: 11 };
  return null;
}

function analyzeDaoChieu(results, type) {
  if (results.length < 5) return null;
  const recent5 = results.slice(0, 5);
  let isAlternating = true;
  for (let i = 0; i < recent5.length - 1; i++) {
    if (recent5[i] === recent5[i + 1]) { isAlternating = false; break; }
  }
  if (isAlternating) {
    const prediction = recent5[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: prediction, confidence: 80, name: `🔄 Đảo Chiều`, priority: 10 };
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
    'Mạng Nơron': 'neural_network', 'Di Truyền': 'genetic', 'Gaussian Mixture': 'gaussian',
    'Random Forest': 'random_forest', 'Mạng Bayes': 'bayesian', 'Cầu Kép 2 Lớp': 'double_layer',
    'Chu Kỳ 3 Pha': 'three_phase', 'Cầu Đối Xứng Tâm': 'center_symmetric',
    'Ma Trận Xác Suất': 'matrix_probability', 'Học Tăng Cường': 'reinforcement',
    'Time Series': 'time_series', 'Super Combo': 'super_combo'
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
  
  // Cập nhật volatility
  const sums = []; // Sẽ được cập nhật từ data
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
    if (fs.existsSync('tiendat.json')) {
      const tiendat = JSON.parse(fs.readFileSync('tiendat.json', 'utf8'));
      for (const type of ['hu', 'md5']) {
        if (tiendat[type] && tiendat[type].predictions) {
          for (const pred of tiendat[type].predictions) {
            if (pred.verified && pred.isCorrect !== null && pred.patterns) {
              pred.patterns.forEach(pName => {
                const patId = getPatternIdFromName(pName);
                if (patId && learningData[type].patternStats[patId]) {
                  learningData[type].patternStats[patId].total++;
                  if (pred.isCorrect) learningData[type].patternStats[patId].correct++;
                  learningData[type].patternStats[patId].recentResults = 
                    learningData[type].patternStats[patId].recentResults || [];
                  learningData[type].patternStats[patId].recentResults.push(pred.isCorrect ? 1 : 0);
                  if (learningData[type].patternStats[patId].recentResults.length > 20) 
                    learningData[type].patternStats[patId].recentResults.shift();
                  const acc = learningData[type].patternStats[patId].correct / 
                             learningData[type].patternStats[patId].total;
                  learningData[type].patternWeights[patId] = Math.min(2.0, Math.max(0.4, acc * 1.6));
                }
              });
            }
          }
        }
      }
      console.log('✅ Loaded verified predictions from tiendat.json');
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

  // Tất cả các thuật toán siêu xịn
  const superFunctions = [
    analyzeSuperCombination,
    analyzeTriplePattern,
    analyzeBreakStreak,
    analyzeAdvancedMarkov,
    analyzeNeuralNetwork,
    analyzeReinforcementLearning,
    analyzeRandomForest,
    analyzeBayesianNetwork,
    analyzeTimeSeries,
    analyzeGeneticPattern,
    analyzeGaussianMixture,
    analyzeDoubleLayerPattern,
    analyzeThreePhaseCycle,
    analyzeCenterSymmetric,
    analyzeCauBet,
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

  for (let fn of superFunctions) {
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

  // Ensemble tính điểm
  let taiScore = 0, xiuScore = 0;
  for (const p of predictions) {
    const weight = learningData[type].patternWeights[getPatternIdFromName(p.name)] || 1.0;
    const conf = p.confidence * weight;
    const priorityBonus = (p.priority || 5) / 5;
    if (p.prediction === 'Tài') taiScore += conf * priorityBonus;
    else xiuScore += conf * priorityBonus;
  }

  // Reversal mode thông minh
  const streak = learningData[type].streakAnalysis.currentStreak;
  let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  
  const volatility = learningData[type].volatility || 2;
  const reversalThreshold = volatility > 3 ? 2 : 4;
  
  if (streak <= -reversalThreshold && !learningData[type].reversalState.active) {
    finalPrediction = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
    learningData[type].reversalState = { active: true, streakTrigger: streak };
    factors.push('🔄 REVERSAL');
  } else if (streak > 0 && learningData[type].reversalState.active) {
    learningData[type].reversalState.active = false;
  }

  // Tính confidence
  let baseConf = 65;
  const topPatterns = predictions.sort((a, b) => b.priority - a.priority).slice(0, 5);
  for (const p of topPatterns) {
    if (p.prediction === finalPrediction) {
      baseConf += (p.confidence - 65) * 0.25;
    }
  }
  
  const totalPredictions = predictions.length;
  const agreement = totalPredictions > 0 ? 
    (finalPrediction === 'Tài' ? 
      predictions.filter(p => p.prediction === 'Tài').length : 
      predictions.filter(p => p.prediction === 'Xỉu').length) / totalPredictions : 0.5;
  baseConf += agreement * 15;
  
  // Điều chỉnh theo volatility
  let volatilityBoost = 0;
  if (volatility > 4) volatilityBoost = -8;
  else if (volatility < 2) volatilityBoost = 5;
  baseConf += volatilityBoost;
  
  if (Math.abs(streak) >= 5) {
    baseConf += streak > 0 ? -5 : 5;
  }
  
  let finalConf = Math.min(98, Math.max(55, Math.round(baseConf)));

  return {
    prediction: finalPrediction,
    confidence: finalConf,
    factors: factors.slice(0, 10)
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
app.get('/', (req, res) => res.send('t.me/Tskhang - Dự đoán Tài Xỉu Siêu Xịn 🚀'));

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
  res.json({ prediction: result.prediction, confidence: result.confidence, factors: result.factors });
});

app.get('/md5/Thamso', async (req, res) => {
  const data = await fetchDataMd5();
  if (!data) return res.status(500).json({ error: 'Không thể lấy dữ liệu' });
  const result = calculateAdvancedPrediction(data, 'md5');
  res.json({ prediction: result.prediction, confidence: result.confidence, factors: result.factors });
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
    hu: { 
      predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
      patternWeights: {}, lastUpdate: null,
      streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
      recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
      markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
      markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
      cycleAnalysis: {}, phaseShiftData: [],
      neuralWeights: { w1: 0.3, w2: 0.25, w3: 0.2, w4: 0.15, w5: 0.1, bias: 0.5 },
      geneticPatterns: {}, bayesianStats: {}, reinforcement: {}
    },
    md5: { 
      predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
      patternWeights: {}, lastUpdate: null,
      streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
      recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
      markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
      markov2Matrix: {}, markov3Matrix: {}, volatility: 0,
      cycleAnalysis: {}, phaseShiftData: [],
      neuralWeights: { w1: 0.3, w2: 0.25, w3: 0.2, w4: 0.15, w5: 0.1, bias: 0.5 },
      geneticPatterns: {}, bayesianStats: {}, reinforcement: {}
    }
  };
  saveLearningData();
  res.json({ message: '✅ Reset dữ liệu học thành công!', id: '@Tskhang' });
});

// KHỞI ĐỘNG
loadHistoricalPatternStats();
loadLearningData();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server @Tskhang đang chạy tại http://0.0.0.0:${PORT}`);
  console.log('✅ ĐÃ NÂNG CẤP THUẬT TOÁN BẮT CẦU SIÊU XỊN NHẤT!');
  console.log('📊 CÁC THUẬT TOÁN MỚI:');
  console.log('   🧠 Mạng Nơron - Học từ dữ liệu');
  console.log('   🧬 Di Truyền - Tìm quy luật tối ưu');
  console.log('   📊 Gaussian Mixture - Phân tích xác suất');
  console.log('   🌲 Random Forest - Bỏ phiếu đa cây');
  console.log('   📈 Mạng Bayes - Xác suất có điều kiện');
  console.log('   🔮 Cầu Kép 2 Lớp - Phân tích cấu trúc');
  console.log('   📊 Chu Kỳ 3 Pha - Phân tích xu hướng');
  console.log('   🔄 Cầu Đối Xứng Tâm - Đối xứng hoàn hảo');
  console.log('   📊 Ma Trận Xác Suất - Xác suất nâng cao');
  console.log('   🤖 Học Tăng Cường - Q-Learning');
  console.log('   📈 Time Series - Phân tích chuỗi thời gian');
  console.log('   ⭐ Super Combo - Kết hợp siêu đẳng');
  startAutoSaveTask();
});
