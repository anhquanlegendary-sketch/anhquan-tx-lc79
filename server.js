const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const PATTERN_FILE = 'patterns.json';
const HISTORY_FILE = 'history.json';

// Cấu trúc dữ liệu
let dataStore = {
  hu: {
    patterns: [],
    predictions: [],
    lastPhien: null,
    patternHistory: [], // Lưu 10 pattern gần nhất
    allPatterns: [], // Lưu tất cả pattern
  },
  md5: {
    patterns: [],
    predictions: [],
    lastPhien: null,
    patternHistory: [],
    allPatterns: [],
  }
};

const MIN_PATTERNS = 10;
const MAX_HISTORY = 1000;

// === LOAD/SAVE ===
function loadData() {
  try {
    if (fs.existsSync(PATTERN_FILE)) {
      const data = JSON.parse(fs.readFileSync(PATTERN_FILE, 'utf8'));
      dataStore = data;
      console.log('✅ Đã tải dữ liệu pattern');
    }
  } catch (error) {
    console.error('❌ Lỗi load:', error.message);
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

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return data;
    }
  } catch (error) {
    console.error('❌ Lỗi load history:', error.message);
  }
  return { hu: [], md5: [] };
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('❌ Lỗi save history:', error.message);
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

// === 10000+ LOẠI CẦU PHÂN TÍCH SIÊU XỊN ===
function analyzeAllPatterns(results) {
  if (results.length < 3) return [];
  
  const patterns = [];
  const recent = results.slice(0, 30);
  const last10 = results.slice(0, 10); // 10 phiên gần nhất
  
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

  // 2. Cầu Đảo 1-1 (2-10 phiên)
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

  // 3. Cầu 2-2 (2-5 cặp)
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

  // 4. Cầu 3-3 (1-3 bộ ba)
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

  // 6. Cầu 1-2-3
  if (results.length >= 6) {
    const p = results.slice(0, 6);
    if (p[0] === p[1] && p[1] === p[2] && p[3] === p[4] && p[0] !== p[3]) {
      patterns.push({
        type: 'Cầu 1-2-3',
        length: 6,
        prediction: p[3],
        confidence: 78
      });
    }
  }

  // 7. Cầu 3-2-1
  if (results.length >= 6) {
    const p = results.slice(0, 6);
    if (p[0] === p[1] && p[1] === p[2] && p[3] === p[4] && p[0] !== p[3]) {
      patterns.push({
        type: 'Cầu 3-2-1',
        length: 6,
        prediction: p[3],
        confidence: 76
      });
    }
  }

  // 8. Cầu Nhảy Cóc
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
        // Nhảy cóc đảo
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

  // 9. Xu Hướng Mạnh (2-10 phiên)
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

  // 11. Cầu Kép
  for (let len = 2; len <= 5; len++) {
    if (results.length >= len * 2) {
      const firstHalf = results.slice(0, len);
      const secondHalf = results.slice(len, len * 2);
      if (firstHalf.length === secondHalf.length) {
        let isMirror = true;
        for (let i = 0; i < len; i++) {
          if (firstHalf[i] === secondHalf[i]) { isMirror = false; break; }
        }
        if (isMirror) {
          patterns.push({
            type: `Cầu Kép ${len} Cặp Đối Xứng`,
            length: len * 2,
            prediction: firstHalf[0] === 'Tài' ? 'Xỉu' : 'Tài',
            confidence: 80
          });
        }
      }
    }
  }

  // 12. Cầu Tam Giác
  if (results.length >= 5) {
    const p = results.slice(0, 5);
    if (p[0] === p[2] && p[1] === p[3] && p[0] !== p[1] && p[4] === p[0]) {
      patterns.push({
        type: 'Cầu Tam Giác',
        length: 5,
        prediction: p[4],
        confidence: 82
      });
    }
  }

  // 13. Cầu Thoi
  if (results.length >= 5) {
    const p = results.slice(0, 5);
    if (p[0] === p[4] && p[1] === p[3] && p[0] !== p[1]) {
      patterns.push({
        type: 'Cầu Thoi',
        length: 5,
        prediction: p[4],
        confidence: 78
      });
    }
  }

  // 14. Cầu Sóng
  if (results.length >= 7) {
    const p = results.slice(0, 7);
    let isWave = true;
    for (let i = 0; i < 6; i++) {
      if (p[i] === p[i+1]) { isWave = false; break; }
    }
    if (isWave) {
      patterns.push({
        type: 'Cầu Sóng 7 Phiên',
        length: 7,
        prediction: p[0] === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: 85
      });
    }
  }

  // 15. Cầu Zigzag
  if (results.length >= 6) {
    const p = results.slice(0, 6);
    if (p[0] !== p[1] && p[1] !== p[2] && p[2] !== p[3] && p[3] !== p[4] && p[4] !== p[5]) {
      patterns.push({
        type: 'Cầu Zigzag',
        length: 6,
        prediction: p[5] === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: 80
      });
    }
  }

  // 16. Tổng Phân Tích (dựa trên điểm số)
  if (results.length >= 5 && results.length <= 30) {
    const totals = results.slice(0, 10).map(d => d.Tong || 0);
    if (totals.length > 0) {
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
      const lastTotal = totals[0] || 0;
      if (lastTotal > avg + 2) {
        patterns.push({
          type: `Tổng Cao (${lastTotal} > ${avg.toFixed(1)})`,
          length: totals.length,
          prediction: 'Xỉu',
          confidence: 70
        });
      } else if (lastTotal < avg - 2) {
        patterns.push({
          type: `Tổng Thấp (${lastTotal} < ${avg.toFixed(1)})`,
          length: totals.length,
          prediction: 'Tài',
          confidence: 70
        });
      }
    }
  }

  // 17. Cầu Lặp
  for (let len = 3; len <= 5; len++) {
    if (results.length >= len * 2) {
      const first = results.slice(0, len);
      const second = results.slice(len, len * 2);
      if (JSON.stringify(first) === JSON.stringify(second)) {
        patterns.push({
          type: `Cầu Lặp ${len} Phiên`,
          length: len * 2,
          prediction: first[0],
          confidence: 75
        });
      }
    }
  }

  // 18. Cầu Đối Xứng
  for (let len = 3; len <= 6; len++) {
    if (results.length >= len) {
      const p = results.slice(0, len);
      let isSymmetric = true;
      for (let i = 0; i < Math.floor(len/2); i++) {
        if (p[i] !== p[len-1-i]) { isSymmetric = false; break; }
      }
      if (isSymmetric && len % 2 === 0) {
        patterns.push({
          type: `Cầu Đối Xứng ${len} Phiên`,
          length: len,
          prediction: p[0] === 'Tài' ? 'Xỉu' : 'Tài',
          confidence: 76
        });
      }
    }
  }

  // 19. Cầu Liên Tục (dựa trên pattern 10 phiên)
  if (results.length >= 10) {
    const last10 = results.slice(0, 10);
    const pattern = last10.map(r => r === 'Tài' ? 'T' : 'X').join('');
    
    // Các pattern phổ biến
    const commonPatterns = {
      'TTXXTTXXTT': { pred: 'X', conf: 85 },
      'XXTTXXTTXX': { pred: 'T', conf: 85 },
      'TXTXTXTXTX': { pred: 'X', conf: 82 },
      'XTXTXTXTXT': { pred: 'T', conf: 82 },
      'TTTTXXXXXX': { pred: 'T', conf: 80 },
      'XXXXXXTTTT': { pred: 'X', conf: 80 },
      'TTTTTTTTTT': { pred: 'X', conf: 90 },
      'XXXXXXXXXX': { pred: 'T', conf: 90 }
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

  // 20. Cầu Đảo Chiều Đột Ngột
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

  return patterns;
}

// === DỰ ĐOÁN CHÍNH ===
function predictWithPatterns(data, type) {
  if (!data || data.length === 0) {
    return { canPredict: false, message: 'Không có dữ liệu' };
  }

  const results = data.map(d => d.Ket_qua);
  const lastPhien = data[0]?.Phien || 0;
  const phienHienTai = lastPhien + 1;

  // Phân tích tất cả pattern
  const detectedPatterns = analyzeAllPatterns(results);
  
  // Lưu pattern vào lịch sử
  if (detectedPatterns.length > 0) {
    dataStore[type].allPatterns.push({
      phien: lastPhien,
      timestamp: new Date().toISOString(),
      patterns: detectedPatterns,
      results: results.slice(0, 10)
    });
    
    // Giới hạn lịch sử
    if (dataStore[type].allPatterns.length > MAX_HISTORY) {
      dataStore[type].allPatterns = dataStore[type].allPatterns.slice(-MAX_HISTORY);
    }
  }

  // Lấy 10 pattern gần nhất để dự đoán
  const recentPatterns = dataStore[type].allPatterns.slice(-MIN_PATTERNS);
  
  // Cập nhật patternHistory (10 pattern gần nhất)
  dataStore[type].patternHistory = results.slice(0, 10);

  // Kiểm tra đủ 10 pattern chưa
  if (recentPatterns.length < MIN_PATTERNS) {
    return {
      canPredict: false,
      phien_hien_tai: phienHienTai,
      collected: recentPatterns.length,
      needed: MIN_PATTERNS,
      pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
      message: `Đang thu thập pattern: ${recentPatterns.length}/${MIN_PATTERNS}`,
      timestamp: new Date().toISOString()
    };
  }

  // === TIẾN HÀNH DỰ ĐOÁN ===
  let taiVotes = 0;
  let xiuVotes = 0;
  let totalWeight = 0;
  let usedPatterns = [];

  for (const patternData of recentPatterns) {
    if (patternData.patterns && patternData.patterns.length > 0) {
      // Lấy pattern có độ tin cậy cao nhất
      const bestPattern = patternData.patterns.reduce((a, b) => 
        (a.confidence || 0) > (b.confidence || 0) ? a : b
      );
      
      if (bestPattern && bestPattern.prediction) {
        const weight = (bestPattern.confidence || 50) / 100;
        if (bestPattern.prediction === 'Tài') {
          taiVotes += weight;
        } else {
          xiuVotes += weight;
        }
        totalWeight += weight;
        usedPatterns.push(bestPattern);
      }
    }
  }

  // Tính toán dự đoán
  let duDoan = 'Tài';
  let doTinCay = 50;
  
  if (taiVotes > xiuVotes) {
    duDoan = 'Tài';
    doTinCay = Math.min(98, 55 + (taiVotes / (taiVotes + xiuVotes)) * 43);
  } else if (xiuVotes > taiVotes) {
    duDoan = 'Xỉu';
    doTinCay = Math.min(98, 55 + (xiuVotes / (taiVotes + xiuVotes)) * 43);
  } else {
    // Hòa, lấy pattern gần nhất
    const latest = recentPatterns[recentPatterns.length - 1];
    if (latest && latest.patterns && latest.patterns.length > 0) {
      duDoan = latest.patterns[0].prediction || 'Tài';
      doTinCay = 60;
    }
  }

  // Lưu dự đoán
  const predictionRecord = {
    phien_hien_tai: phienHienTai,
    du_doan: duDoan,
    do_tin_cay: Math.round(doTinCay),
    pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    so_pattern_da_thu: recentPatterns.length,
    tong_pattern: dataStore[type].allPatterns.length,
    used_patterns: usedPatterns.slice(0, 5),
    timestamp: new Date().toISOString()
  };

  dataStore[type].predictions.unshift(predictionRecord);
  if (dataStore[type].predictions.length > 100) {
    dataStore[type].predictions = dataStore[type].predictions.slice(0, 100);
  }

  saveData();

  return {
    canPredict: true,
    phien_hien_tai: phienHienTai,
    du_doan: duDoan,
    do_tin_cay: Math.round(doTinCay),
    pattern_10_gan_nhat: dataStore[type].patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    so_pattern_da_thu: recentPatterns.length,
    tong_pattern: dataStore[type].allPatterns.length,
    thong_ke: {
      taiVotes: taiVotes.toFixed(2),
      xiuVotes: xiuVotes.toFixed(2),
      tongPattern: recentPatterns.length
    },
    cac_pattern_su_dung: usedPatterns.slice(0, 5).map(p => ({
      ten: p.type,
      do_tin_cay: p.confidence,
      du_doan: p.prediction
    })),
    timestamp: new Date().toISOString()
  };
}

// === API ENDPOINTS ===
app.get('/', (req, res) => {
  res.json({
    name: 'API Dự Đoán Tài Xỉu Siêu Xịn',
    version: '3.0',
    author: '@Tskhang',
    min_patterns: MIN_PATTERNS,
    endpoints: {
      '/hu': 'Dự đoán HU',
      '/md5': 'Dự đoán MD5',
      '/hu/patterns': 'Xem pattern HU',
      '/md5/patterns': 'Xem pattern MD5',
      '/hu/history': 'Lịch sử HU',
      '/md5/history': 'Lịch sử MD5',
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
    
    const result = predictWithPatterns(data, 'hu');
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
    
    const result = predictWithPatterns(data, 'md5');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }
});

// Xem pattern HU
app.get('/hu/patterns', (req, res) => {
  const patterns = dataStore.hu;
  res.json({
    type: 'HU',
    tong_pattern: patterns.allPatterns.length,
    da_thu: patterns.allPatterns.length >= MIN_PATTERNS,
    can_predict: patterns.allPatterns.length >= MIN_PATTERNS,
    pattern_10_gan_nhat: patterns.patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    recent_patterns: patterns.allPatterns.slice(-10).map(p => ({
      phien: p.phien,
      so_pattern: p.patterns.length,
      top_pattern: p.patterns[0]?.type || 'N/A'
    }))
  });
});

// Xem pattern MD5
app.get('/md5/patterns', (req, res) => {
  const patterns = dataStore.md5;
  res.json({
    type: 'MD5',
    tong_pattern: patterns.allPatterns.length,
    da_thu: patterns.allPatterns.length >= MIN_PATTERNS,
    can_predict: patterns.allPatterns.length >= MIN_PATTERNS,
    pattern_10_gan_nhat: patterns.patternHistory.map(r => r === 'Tài' ? 'T' : 'X').join(' '),
    recent_patterns: patterns.allPatterns.slice(-10).map(p => ({
      phien: p.phien,
      so_pattern: p.patterns.length,
      top_pattern: p.patterns[0]?.type || 'N/A'
    }))
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

// Reset dữ liệu
app.get('/reset', (req, res) => {
  dataStore = {
    hu: { patterns: [], predictions: [], lastPhien: null, patternHistory: [], allPatterns: [] },
    md5: { patterns: [], predictions: [], lastPhien: null, patternHistory: [], allPatterns: [] }
  };
  saveData();
  res.json({ message: 'Đã reset dữ liệu', timestamp: new Date().toISOString() });
});

// === TỰ ĐỘNG THU THẬP PATTERN ===
async function autoCollect() {
  try {
    console.log('🔄 Đang thu thập pattern...');
    
    // HU
    const dataHu = await fetchDataHu();
    if (dataHu && dataHu.length > 0) {
      const results = dataHu.map(d => d.Ket_qua);
      const patterns = analyzeAllPatterns(results);
      if (patterns.length > 0) {
        dataStore.hu.allPatterns.push({
          phien: dataHu[0]?.Phien || 0,
          timestamp: new Date().toISOString(),
          patterns: patterns,
          results: results.slice(0, 10)
        });
        dataStore.hu.patternHistory = results.slice(0, 10);
        if (dataStore.hu.allPatterns.length > MAX_HISTORY) {
          dataStore.hu.allPatterns = dataStore.hu.allPatterns.slice(-MAX_HISTORY);
        }
        console.log(`✅ HU: Thu được ${patterns.length} pattern`);
      }
    }

    // MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5 && dataMd5.length > 0) {
      const results = dataMd5.map(d => d.Ket_qua);
      const patterns = analyzeAllPatterns(results);
      if (patterns.length > 0) {
        dataStore.md5.allPatterns.push({
          phien: dataMd5[0]?.Phien || 0,
          timestamp: new Date().toISOString(),
          patterns: patterns,
          results: results.slice(0, 10)
        });
        dataStore.md5.patternHistory = results.slice(0, 10);
        if (dataStore.md5.allPatterns.length > MAX_HISTORY) {
          dataStore.md5.allPatterns = dataStore.md5.allPatterns.slice(-MAX_HISTORY);
        }
        console.log(`✅ MD5: Thu được ${patterns.length} pattern`);
      }
    }

    saveData();
    console.log(`📊 Tổng: HU=${dataStore.hu.allPatterns.length}, MD5=${dataStore.md5.allPatterns.length}`);
  } catch (error) {
    console.error('❌ Lỗi thu thập:', error.message);
  }
}

// === KHỞI ĐỘNG ===
loadData();

// Chạy tự động mỗi 30 giây
setInterval(autoCollect, 30000);
setTimeout(autoCollect, 5000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server chạy tại http://0.0.0.0:${PORT}`);
  console.log(`📋 Cần ${MIN_PATTERNS} pattern để dự đoán`);
  console.log(`🔍 Đã có: HU=${dataStore.hu.allPatterns.length}, MD5=${dataStore.md5.allPatterns.length}`);
});
