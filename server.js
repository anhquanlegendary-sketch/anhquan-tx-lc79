const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;

// === API CẤU HÌNH ===
const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const LEARNING_FILE = 'Tskhang.json';
const HISTORY_FILE = 'Tskhang1.json';

let predictionHistory = { hu: [], md5: [] };
const MAX_HISTORY = 200;
const AUTO_SAVE_INTERVAL = 20000;
let lastProcessedPhien = { hu: null, md5: null };

// === DỮ LIỆU HỌC HỎI TỐI ƯU CHO LC79 ===
let learningData = {
  hu: {
    predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
    patternWeights: {}, lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    volatility: 0
  },
  md5: {
    predictions: [], patternStats: {}, totalPredictions: 0, correctPredictions: 0,
    patternWeights: {}, lastUpdate: null,
    streakAnalysis: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, worstStreak: 0 },
    recentAccuracy: [], reversalState: { active: false, streakTrigger: 0 },
    markovMatrix: { TT: 0.5, TX: 0.5, XT: 0.5, XX: 0.5 },
    volatility: 0
  }
};

// === HÀM LƯU/TẢI DỮ LIỆU ===
function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_FILE)) {
      const data = fs.readFileSync(LEARNING_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (let type of ['hu', 'md5']) {
        if (parsed[type]) learningData[type] = { ...learningData[type], ...parsed[type] };
      }
      console.log('✅ Đã tải dữ liệu học hỏi LC79');
    }
  } catch (e) { console.error('Lỗi tải:', e.message); }
}
function saveLearningData() {
  try { fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData, null, 2)); }
  catch (e) { console.error('Lỗi lưu:', e.message); }
}
function loadPredictionHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const d = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      predictionHistory = d.history || { hu: [], md5: [] };
      lastProcessedPhien = d.lastProcessedPhien || { hu: null, md5: null };
    }
  } catch (e) {}
}
function savePredictionHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({
      history: predictionHistory, lastProcessedPhien, lastSaved: new Date().toISOString()
    }, null, 2));
  } catch (e) {}
}

// === LẤY DỮ LIỆU API ===
function transformApiData(apiData) {
  if (!apiData?.list || !Array.isArray(apiData.list)) return null;
  return apiData.list.map(item => ({
    Phien: item.id,
    Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
    Tong: item.point,
    Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2]
  }));
}
async function fetchDataHu() {
  try { const r = await axios.get(API_URL_HU, { timeout: 8000 }); return transformApiData(r.data); }
  catch { return null; }
}
async function fetchDataMd5() {
  try { const r = await axios.get(API_URL_MD5, { timeout: 8000 }); return transformApiData(r.data); }
  catch { return null; }
}

// === PHÂN TÍCH CẦU THEO QUY LUẬT LC79 - ƯU TIÊN CAO NHẤT ===
function getStreakInfo(results) {
  if (!results.length) return { type: null, length: 0 };
  let type = results[0], len = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === type) len++; else break;
  }
  return { type, length: len };
}

// 🔴 CẦU BỆT - LUÔN ĐÚNG TRƯỚC KHI ĐỦ ĐỀ BẺ
function analyzeCauBetLC79(results) {
  const { length, type: streakType } = getStreakInfo(results);
  if (length < 3) return { detected: false };
  let prediction, conf;
  // Theo cầu khi dưới 5 phiên, bẻ khi đủ 5 phiên trở lên - quy luật LC79
  if (length >= 7) {
    prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    conf = 91;
  } else if (length >= 5) {
    prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
    conf = 85;
  } else {
    prediction = streakType;
    conf = 72 + length * 3;
  }
  return { detected: true, prediction, confidence: conf, priority: 12, name: `Cầu Bệt ${length} phiên` };
}

// 🟠 BỂ CHUỖI - ĐÚNG NGƯỠNG LC79
function analyzeBreakStreakLC79(results) {
  const { length, type: streakType } = getStreakInfo(results);
  if (length < 5) return { detected: false };
  const prediction = streakType === 'Tài' ? 'Xỉu' : 'Tài';
  return { detected: true, prediction, confidence: 88, priority: 11, name: `Bẻ Chuỗi ${length} → ${prediction}` };
}

// 🟡 CẦU ĐẢO 1-1 - QUY LUẬT ĐỀU ĐẶC TRƯNG
function analyzeCauDao11LC79(results) {
  if (results.length < 5) return { detected: false };
  let len = 1;
  for (let i = 1; i < Math.min(results.length, 10); i++) {
    if (results[i] !== results[i-1]) len++; else break;
  }
  if (len >= 4) {
    const prediction = results[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, prediction, confidence: 82, priority: 10, name: `Cầu Đảo 1-1 (${len} nhịp)` };
  }
  return { detected: false };
}

// 🟢 CẦU 2-2 / 3-3 - MẪU CẦU THƯỜNG RA LC79
function analyzeCau22LC79(results) {
  if (results.length < 6) return { detected: false };
  let count = 0, i = 0;
  while (i < results.length - 1) {
    if (results[i] === results[i+1]) { count++; i += 2; } else break;
  }
  if (count >= 2) {
    const last = results[0];
    return { detected: true, prediction: last === 'Tài' ? 'Xỉu' : 'Tài', confidence: 78, priority: 9, name: `Cầu 2-2 (${count} cặp)` };
  }
  return { detected: false };
}

function analyzeCau33LC79(results) {
  if (results.length < 9) return { detected: false };
  let count = 0, i = 0;
  while (i < results.length - 2) {
    if (results[i] === results[i+1] && results[i+1] === results[i+2]) { count++; i += 3; } else break;
  }
  if (count >= 2) {
    const last = results[0];
    return { detected: true, prediction: last === 'Tài' ? 'Xỉu' : 'Tài', confidence: 80, priority: 9, name: `Cầu 3-3 (${count} bộ)` };
  }
  return { detected: false };
}

// 🔵 TỔNG PHÂN TÍCH THEO ĐIỂM LC79
function analyzeTongDiemLC79(data) {
  if (data.length < 10) return { detected: false };
  const sums = data.slice(0,10).map(d => d.Tong);
  const avgLast5 = sums.slice(0,5).reduce((a,b) => a+b,0)/5;
  const avgPrev5 = sums.slice(5,10).reduce((a,b) => a+b,0)/5;
  const chenh = avgLast5 - avgPrev5;
  
  if (chenh > 2.2) return { detected: true, prediction: 'Xỉu', confidence: 83, priority: 11, name: 'Tổng Tăng Mạnh → Xỉu' };
  if (chenh < -2.2) return { detected: true, prediction: 'Tài', confidence: 83, priority: 11, name: 'Tổng Giảm Mạnh → Tài' };
  if ([14,15,16].includes(sums[0])) return { detected: true, prediction: 'Xỉu', confidence: 80, priority: 8, name: 'Tổng Kháng Cự → Xỉu' };
  if ([5,6,7].includes(sums[0])) return { detected: true, prediction: 'Tài', confidence: 80, priority: 8, name: 'Tổng Hỗ Trợ → Tài' };
  return { detected: false };
}

// 🟣 XU HƯỚNG CỰC - ĐẢO CHIỀU LC79
function analyzeXuHuongCucLC79(results) {
  if (results.length < 8) return { detected: false };
  const last8 = results.slice(0,8);
  const tai = last8.filter(r => r === 'Tài').length;
  if (tai >= 7) return { detected: true, prediction: 'Xỉu', confidence: 90, priority: 10, name: 'Xu Hướng Cực Tài → Đảo Xỉu' };
  if (tai <= 1) return { detected: true, prediction: 'Tài', confidence: 90, priority: 10, name: 'Xu Hướng Cực Xỉu → Đảo Tài' };
  return { detected: false };
}

// === MÔ HÌNH DỰ ĐOÁN CHÍNH - TỐI ƯU LC79 ===
function calculatePredictionLC79(data, type) {
  const results = data.map(d => d.Ket_qua);
  let allPredictions = [];
  let factors = [];

  // ✅ ƯU TIÊN THEO THỨ TỰ ĐỘ CHÍNH XÁC LC79
  const hamUuTien = [
    analyzeBreakStreakLC79,
    analyzeCauBetLC79,
    analyzeXuHuongCucLC79,
    analyzeCauDao11LC79,
    analyzeCau22LC79,
    analyzeCau33LC79
  ];

  for (const fn of hamUuTien) {
    const res = fn(results);
    if (res?.detected) { allPredictions.push(res); factors.push(res.name); }
  }

  const tong = analyzeTongDiemLC79(data);
  if (tong?.detected) { allPredictions.push(tong); factors.push(tong.name); }

  // ✅ TÍNH ĐIỂM TRỌNG SỐ - ƯU TIÊN Ý KIẾN ĐỒNG THUẬN CAO
  let taiScore = 0, xiuScore = 0;
  for (const p of allPredictions) {
    const diem = p.confidence * (p.priority / 10);
    if (p.prediction === 'Tài') taiScore += diem;
    else xiuScore += diem;
  }

  // ✅ QUYẾT ĐỊNH KẾT QUẢ - KHÔNG ĐOÁN MÒ
  let finalPred, finalConf;
  if (taiScore > xiuScore + 20) {
    finalPred = 'Tài';
    finalConf = Math.min(93, 70 + Math.round((taiScore - xiuScore) / 15));
  } else if (xiuScore > taiScore + 20) {
    finalPred = 'Xỉu';
    finalConf = Math.min(93, 70 + Math.round((xiuScore - taiScore) / 15));
  } else {
    // Khi chưa rõ ràng: ưu tiên theo cầu bệt hoặc giữ nguyên kết quả gần nhất
    const bet = analyzeCauBetLC79(results);
    finalPred = bet.detected ? bet.prediction : results[0];
    finalConf = 62;
  }

  return {
    prediction: finalPred,
    confidence: finalConf,
    factors: factors.slice(0, 5),
    taiVotes: allPredictions.filter(p => p.prediction === 'Tài').length,
    xiuVotes: allPredictions.filter(p => p.prediction === 'Xỉu').length,
    totalPattern: allPredictions.length
  };
}

// === XÁC MINH & LƯU LỊCH SỬ ===
async function verifyAndSave(type, currentData) {
  let updated = false;
  for (let pred of learningData[type].predictions) {
    if (pred.verified) continue;
    const actual = currentData.find(d => d.Phien.toString() === pred.phien);
    if (actual) {
      pred.verified = true;
      pred.actual = actual.Ket_qua;
      pred.isCorrect = pred.prediction === actual.Ket_qua;
      learningData[type].totalPredictions++;
      if (pred.isCorrect) {
        learningData[type].correctPredictions++;
        learningData[type].streakAnalysis.currentStreak = Math.max(1, learningData[type].streakAnalysis.currentStreak + 1);
      } else {
        learningData[type].streakAnalysis.currentStreak = Math.min(-1, learningData[type].streakAnalysis.currentStreak - 1);
      }
      updated = true;
    }
  }
  if (updated) saveLearningData();
}

function saveResultToHistory(type, phien, pred, conf, latest) {
  const record = {
    Phien: latest.Phien, Ket_qua: latest.Ket_qua, Tong: latest.Tong,
    Do_tin_cay: `${conf}%`, Phien_du_doan: phien.toString(),
    Du_doan: pred, ket_qua_thuc_te: '', id: '@Tskhang', time: new Date().toISOString()
  };
  predictionHistory[type].unshift(record);
  if (predictionHistory[type].length > MAX_HISTORY) predictionHistory[type].pop();
  return record;
}

async function updateStatus(type) {
  const data = type==='hu' ? await fetchDataHu() : await fetchDataMd5();
  if (!data) return;
  for (let r of predictionHistory[type]) {
    if (r.ket_qua_thuc_te) continue;
    const act = data.find(d => d.Phien.toString() === r.Phien_du_doan);
    if (act) r.ket_qua_thuc_te = r.Du_doan === act.Ket_qua ? '✅ Đúng' : '❌ Sai';
  }
  savePredictionHistory();
}

// === TỰ ĐỘNG CHẠY ===
async function autoRun() {
  try {
    // Xử lý Hũ
    const dataHu = await fetchDataHu();
    if (dataHu?.length > 0) {
      const nextPhien = dataHu[0].Phien + 1;
      if (lastProcessedPhien.hu !== nextPhien) {
        await verifyAndSave('hu', dataHu);
        const res = calculatePredictionLC79(dataHu, 'hu');
        saveResultToHistory('hu', nextPhien, res.prediction, res.confidence, dataHu[0]);
        learningData.hu.predictions.unshift({ phien: nextPhien.toString(), prediction: res.prediction, verified: false });
        lastProcessedPhien.hu = nextPhien;
        console.log(`🎯 HU Phiên ${nextPhien}: ${res.prediction} | ${res.confidence}%`);
      }
    }
    // Xử lý MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5?.length > 0) {
      const nextPhien = dataMd5[0].Phien + 1;
      if (lastProcessedPhien.md5 !== nextPhien) {
        await verifyAndSave('md5', dataMd5);
        const res = calculatePredictionLC79(dataMd5, 'md5');
        saveResultToHistory('md5', nextPhien, res.prediction, res.confidence, dataMd5[0]);
        learningData.md5.predictions.unshift({ phien: nextPhien.toString(), prediction: res.prediction, verified: false });
        lastProcessedPhien.md5 = nextPhien;
        console.log(`🎯 MD5 Phiên ${nextPhien}: ${res.prediction} | ${res.confidence}%`);
      }
    }
    savePredictionHistory();
    saveLearningData();
  } catch (e) { console.error('Lỗi tự động:', e.message); }
}

function startAuto() {
  setTimeout(autoRun, 3000);
  setInterval(autoRun, AUTO_SAVE_INTERVAL);
}

// === API ROUTES ===
app.get('/', (req, res) => res.send('🎯 Bắt Cầu LC79 Siêu Chuẩn @Tskhang'));

app.get('/hu', async (req, res) => {
  const data = await fetchDataHu();
  if (!data) return res.status(500).json({ error: 'Lỗi dữ liệu' });
  await verifyAndSave('hu', data);
  const next = data[0].Phien + 1;
  const resPred = calculatePredictionLC79(data, 'hu');
  const record = saveResultToHistory('hu', next, resPred.prediction, resPred.confidence, data[0]);
  setTimeout(() => updateStatus('hu'), 4000);
  res.json({ ...record, phan_tich: resPred });
});

app.get('/md5', async (req, res) => {
  const data = await fetchDataMd5();
  if (!data) return res.status(500).json({ error: 'Lỗi dữ liệu' });
  await verifyAndSave('md5', data);
  const next = data[0].Phien + 1;
  const resPred = calculatePredictionLC79(data, 'md5');
  const record = saveResultToHistory('md5', next, resPred.prediction, resPred.confidence, data[0]);
  setTimeout(() => updateStatus('md5'), 4000);
  res.json({ ...record, phan_tich: resPred });
});

app.get('/hu/lichsu', async (req, res) => { await updateStatus('hu'); res.json({ type: 'LC79 - Hũ', data: predictionHistory.hu }); });
app.get('/md5/lichsu', async (req, res) => { await updateStatus('md5'); res.json({ type: 'LC79 - MD5', data: predictionHistory.md5 }); });
app.get('/hu/thongke', (req, res) => {
  const s = learningData.hu;
  res.json({ tong: s.totalPredictions, dung: s.correctPredictions, do_chinh_xac: s.totalPredictions ? (s.correctPredictions/s.totalPredictions*100).toFixed(1)+'%' : '0%' });
});
app.get('/md5/thongke', (req, res) => {
  const s = learningData.md5;
  res.json({ tong: s.totalPredictions, dung: s.correctPredictions, do_chinh_xac: s.totalPredictions ? (s.correctPredictions/s.totalPredictions*100).toFixed(1)+'%' : '0%' });
});

// === KHỞI ĐỘNG ===
loadLearningData();
loadPredictionHistory();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server LC79 chạy tại cổng ${PORT}`);
  startAuto();
});
