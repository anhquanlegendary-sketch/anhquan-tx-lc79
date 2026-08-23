const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;

const API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const PATTERN_FILE = 'patterns.json';
const HISTORY_FILE = 'prediction_history.json';

// Cấu trúc dữ liệu
let dataStore = {
  hu: {
    patterns: [],
    predictions: [],
    lastProcessedPhien: null,
    patternCollection: []
  },
  md5: {
    patterns: [],
    predictions: [],
    lastProcessedPhien: null,
    patternCollection: []
  }
};

const MAX_PATTERN_HISTORY = 100;
const MIN_PATTERNS_FOR_PREDICTION = 10;

// === HÀM LOAD/SAVE ===
function loadData() {
  try {
    if (fs.existsSync(PATTERN_FILE)) {
      const raw = fs.readFileSync(PATTERN_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      dataStore = parsed;
      console.log('✅ Đã tải dữ liệu pattern từ file');
    }
  } catch (error) {
    console.error('❌ Lỗi tải dữ liệu:', error.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(PATTERN_FILE, JSON.stringify(dataStore, null, 2));
  } catch (error) {
    console.error('❌ Lỗi lưu dữ liệu:', error.message);
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

// === PHÂN TÍCH PATTERN ===
function detectPatterns(results) {
  if (results.length < 3) return [];
  
  const patterns = [];
  const recent = results.slice(0, 20); // Lấy 20 phiên gần nhất
  
  // 1. Cầu bệt
  let streakType = recent[0];
  let streakLength = 1;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === streakType) streakLength++;
    else break;
  }
  if (streakLength >= 3) {
    patterns.push({
      type: 'Cầu Bệt',
      length: streakLength,
      prediction: streakLength >= 5 ? (streakType === 'Tài' ? 'Xỉu' : 'Tài') : streakType,
      confidence: Math.min(85, 60 + streakLength * 5)
    });
  }

  // 2. Cầu đảo 1-1
  let alternatingLength = 1;
  for (let i = 1; i < Math.min(recent.length, 10); i++) {
    if (recent[i] !== recent[i-1]) alternatingLength++;
    else break;
  }
  if (alternatingLength >= 4) {
    patterns.push({
      type: 'Cầu Đảo 1-1',
      length: alternatingLength,
      prediction: recent[0] === 'Tài' ? 'Xỉu' : 'Tài',
      confidence: Math.min(80, 65 + alternatingLength * 2)
    });
  }

  // 3. Cầu 2-2
  let pairCount = 0;
  let i = 0;
  let pairPattern = [];
  while (i < recent.length - 1 && pairCount < 4) {
    if (recent[i] === recent[i+1]) {
      pairPattern.push(recent[i]);
      pairCount++;
      i += 2;
    } else break;
  }
  if (pairCount >= 2) {
    let isAlternating = true;
    for (let j = 1; j < pairPattern.length; j++) {
      if (pairPattern[j] === pairPattern[j-1]) isAlternating = false;
    }
    if (isAlternating) {
      const lastPair = pairPattern[pairPattern.length - 1];
      patterns.push({
        type: 'Cầu 2-2',
        length: pairCount,
        prediction: lastPair === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: Math.min(78, 65 + pairCount * 3)
      });
    }
  }

  // 4. Cầu 3-3
  let tripleCount = 0;
  let j = 0;
  let triplePattern = [];
  while (j < recent.length - 2 && tripleCount < 3) {
    if (recent[j] === recent[j+1] && recent[j+1] === recent[j+2]) {
      triplePattern.push(recent[j]);
      tripleCount++;
      j += 3;
    } else break;
  }
  if (tripleCount >= 1) {
    const lastTriple = triplePattern[triplePattern.length - 1];
    const position = recent.length % 3;
    patterns.push({
      type: 'Cầu 3-3',
      length: tripleCount,
      prediction: position === 0 ? (lastTriple === 'Tài' ? 'Xỉu' : 'Tài') : lastTriple,
      confidence: Math.min(80, 68 + tripleCount * 4)
    });
  }

  // 5. Cầu 1-2-1
  if (recent.length >= 4) {
    const p1 = recent.slice(0, 4);
    if (p1[0] !== p1[1] && p1[1] === p1[2] && p1[2] !== p1[3] && p1[0] === p1[3]) {
      patterns.push({
        type: 'Cầu 1-2-1',
        length: 4,
        prediction: p1[0],
        confidence: 72
      });
    }
  }

  // 6. Cầu nhảy cóc
  if (recent.length >= 6) {
    const skipPattern = [];
    for (let i = 0; i < Math.min(recent.length, 12); i += 2) {
      skipPattern.push(recent[i]);
    }
    if (skipPattern.length >= 3) {
      const allSame = skipPattern.slice(0, 3).every(r => r === skipPattern[0]);
      if (allSame) {
        patterns.push({
          type: 'Cầu Nhảy Cóc',
          length: skipPattern.length,
          prediction: skipPattern[0],
          confidence: 68
        });
      }
    }
  }

  // 7. Xu hướng mạnh
  if (recent.length >= 8) {
    const last8 = recent.slice(0, 8);
    const taiCount = last8.filter(r => r === 'Tài').length;
    if (taiCount >= 6) {
      patterns.push({
        type: 'Xu Hướng Mạnh Tài',
        length: 8,
        prediction: 'Xỉu',
        confidence: 80
      });
    } else if (taiCount <= 2) {
      patterns.push({
        type: 'Xu Hướng Mạnh Xỉu',
        length: 8,
        prediction: 'Tài',
        confidence: 80
      });
    }
  }

  // 8. Đảo chiều
  if (recent.length >= 5) {
    const last5 = recent.slice(0, 5);
    let isAlternating = true;
    for (let i = 0; i < last5.length - 1; i++) {
      if (last5[i] === last5[i+1]) { isAlternating = false; break; }
    }
    if (isAlternating) {
      patterns.push({
        type: 'Đảo Chiều',
        length: 5,
        prediction: last5[0] === 'Tài' ? 'Xỉu' : 'Tài',
        confidence: 75
      });
    }
  }

  return patterns;
}

// === PHÂN TÍCH VÀ DỰ ĐOÁN ===
function analyzeAndPredict(data, type) {
  if (!data || data.length === 0) {
    return { canPredict: false, message: 'Không có dữ liệu' };
  }

  // Lấy kết quả
  const results = data.map(d => d.Ket_qua);
  
  // Phát hiện pattern
  const detectedPatterns = detectPatterns(results);
  
  // Lưu pattern vào collection
  if (detectedPatterns.length > 0) {
    dataStore[type].patternCollection.push({
      timestamp: new Date().toISOString(),
      phien: data[0]?.Phien || 0,
      patterns: detectedPatterns,
      results: results.slice(0, 10)
    });
    
    // Giới hạn số lượng pattern lưu
    if (dataStore[type].patternCollection.length > MAX_PATTERN_HISTORY) {
      dataStore[type].patternCollection = dataStore[type].patternCollection.slice(-MAX_PATTERN_HISTORY);
    }
    
    saveData();
  }

  // Kiểm tra đã đủ pattern để dự đoán chưa
  const collectedCount = dataStore[type].patternCollection.length;
  
  if (collectedCount < MIN_PATTERNS_FOR_PREDICTION) {
    return {
      canPredict: false,
      collected: collectedCount,
      needed: MIN_PATTERNS_FOR_PREDICTION,
      patterns: detectedPatterns,
      message: `Đang thu thập pattern: ${collectedCount}/${MIN_PATTERNS_FOR_PREDICTION}`,
      recentPatterns: dataStore[type].patternCollection.slice(-10)
    };
  }

  // Đã đủ pattern, tiến hành dự đoán
  let taiVotes = 0;
  let xiuVotes = 0;
  let totalConfidence = 0;
  const usedPatterns = [];
  
  // Lấy 10 pattern gần nhất để phân tích
  const recentPatterns = dataStore[type].patternCollection.slice(-10);
  
  for (const patternData of recentPatterns) {
    if (patternData.patterns && patternData.patterns.length > 0) {
      // Lấy pattern có độ tin cậy cao nhất
      const bestPattern = patternData.patterns.reduce((a, b) => 
        (a.confidence || 0) > (b.confidence || 0) ? a : b
      );
      
      if (bestPattern && bestPattern.prediction) {
        if (bestPattern.prediction === 'Tài') {
          taiVotes += (bestPattern.confidence || 50) / 100;
        } else {
          xiuVotes += (bestPattern.confidence || 50) / 100;
        }
        totalConfidence += (bestPattern.confidence || 50);
        usedPatterns.push(bestPattern);
      }
    }
  }

  // Dự đoán cuối cùng
  let finalPrediction = 'Tài';
  let finalConfidence = 50;
  
  if (taiVotes > xiuVotes) {
    finalPrediction = 'Tài';
    finalConfidence = Math.min(95, 55 + (taiVotes / (taiVotes + xiuVotes)) * 40);
  } else if (xiuVotes > taiVotes) {
    finalPrediction = 'Xỉu';
    finalConfidence = Math.min(95, 55 + (xiuVotes / (taiVotes + xiuVotes)) * 40);
  } else {
    // Hòa, dùng pattern gần nhất
    const latestPattern = recentPatterns[recentPatterns.length - 1];
    if (latestPattern && latestPattern.patterns && latestPattern.patterns.length > 0) {
      const best = latestPattern.patterns[0];
      finalPrediction = best.prediction || 'Tài';
      finalConfidence = 60;
    }
  }

  // Lưu dự đoán
  const predictionRecord = {
    phien: data[0]?.Phien || 0,
    prediction: finalPrediction,
    confidence: Math.round(finalConfidence),
    timestamp: new Date().toISOString(),
    patterns: usedPatterns,
    taiVotes: taiVotes,
    xiuVotes: xiuVotes,
    totalPatterns: recentPatterns.length
  };
  
  dataStore[type].predictions.unshift(predictionRecord);
  if (dataStore[type].predictions.length > 100) {
    dataStore[type].predictions = dataStore[type].predictions.slice(0, 100);
  }
  saveData();

  return {
    canPredict: true,
    collected: collectedCount,
    prediction: finalPrediction,
    confidence: Math.round(finalConfidence),
    patterns: detectedPatterns,
    usedPatterns: usedPatterns.slice(0, 5),
    statistics: {
      taiVotes: taiVotes,
      xiuVotes: xiuVotes,
      totalPatterns: recentPatterns.length
    },
    recentPatterns: dataStore[type].patternCollection.slice(-10).map(p => ({
      timestamp: p.timestamp,
      patternCount: p.patterns?.length || 0,
      topPrediction: p.patterns?.[0]?.prediction || 'N/A'
    }))
  };
}

// === API ENDPOINTS ===
app.get('/', (req, res) => {
  res.json({
    name: 'API Dự Đoán Tài Xỉu',
    version: '2.0',
    status: 'running',
    author: '@Tskhang',
    endpoints: {
      '/hu': 'Dự đoán cho HU',
      '/md5': 'Dự đoán cho MD5',
      '/hu/patterns': 'Xem pattern đã thu thập HU',
      '/md5/patterns': 'Xem pattern đã thu thập MD5',
      '/hu/history': 'Lịch sử dự đoán HU',
      '/md5/history': 'Lịch sử dự đoán MD5',
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
    
    const result = analyzeAndPredict(data, 'hu');
    res.json({
      type: 'HU',
      ...result,
      latestPhien: data[0]?.Phien || 0,
      timestamp: new Date().toISOString()
    });
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
    
    const result = analyzeAndPredict(data, 'md5');
    res.json({
      type: 'MD5',
      ...result,
      latestPhien: data[0]?.Phien || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }
});

// Xem pattern đã thu thập HU
app.get('/hu/patterns', (req, res) => {
  const patterns = dataStore.hu.patternCollection;
  res.json({
    type: 'HU',
    totalCollected: patterns.length,
    needed: MIN_PATTERNS_FOR_PREDICTION,
    canPredict: patterns.length >= MIN_PATTERNS_FOR_PREDICTION,
    recentPatterns: patterns.slice(-10).map(p => ({
      timestamp: p.timestamp,
      phien: p.phien,
      patternCount: p.patterns?.length || 0,
      patterns: p.patterns
    }))
  });
});

// Xem pattern đã thu thập MD5
app.get('/md5/patterns', (req, res) => {
  const patterns = dataStore.md5.patternCollection;
  res.json({
    type: 'MD5',
    totalCollected: patterns.length,
    needed: MIN_PATTERNS_FOR_PREDICTION,
    canPredict: patterns.length >= MIN_PATTERNS_FOR_PREDICTION,
    recentPatterns: patterns.slice(-10).map(p => ({
      timestamp: p.timestamp,
      phien: p.phien,
      patternCount: p.patterns?.length || 0,
      patterns: p.patterns
    }))
  });
});

// Lịch sử dự đoán HU
app.get('/hu/history', (req, res) => {
  res.json({
    type: 'HU',
    totalPredictions: dataStore.hu.predictions.length,
    predictions: dataStore.hu.predictions.slice(0, 50)
  });
});

// Lịch sử dự đoán MD5
app.get('/md5/history', (req, res) => {
  res.json({
    type: 'MD5',
    totalPredictions: dataStore.md5.predictions.length,
    predictions: dataStore.md5.predictions.slice(0, 50)
  });
});

// Reset dữ liệu
app.get('/reset', (req, res) => {
  dataStore = {
    hu: { patterns: [], predictions: [], lastProcessedPhien: null, patternCollection: [] },
    md5: { patterns: [], predictions: [], lastProcessedPhien: null, patternCollection: [] }
  };
  saveData();
  res.json({ message: 'Đã reset toàn bộ dữ liệu', timestamp: new Date().toISOString() });
});

// === TỰ ĐỘNG THU THẬP PATTERN ===
async function autoCollectPatterns() {
  try {
    console.log('🔄 Đang thu thập pattern tự động...');
    
    // Thu thập HU
    const dataHu = await fetchDataHu();
    if (dataHu && dataHu.length > 0) {
      const huPatterns = detectPatterns(dataHu.map(d => d.Ket_qua));
      if (huPatterns.length > 0) {
        dataStore.hu.patternCollection.push({
          timestamp: new Date().toISOString(),
          phien: dataHu[0]?.Phien || 0,
          patterns: huPatterns,
          results: dataHu.slice(0, 10).map(d => d.Ket_qua)
        });
        if (dataStore.hu.patternCollection.length > MAX_PATTERN_HISTORY) {
          dataStore.hu.patternCollection = dataStore.hu.patternCollection.slice(-MAX_PATTERN_HISTORY);
        }
        console.log(`✅ Đã thu thập ${huPatterns.length} pattern từ HU`);
      }
    }

    // Thu thập MD5
    const dataMd5 = await fetchDataMd5();
    if (dataMd5 && dataMd5.length > 0) {
      const md5Patterns = detectPatterns(dataMd5.map(d => d.Ket_qua));
      if (md5Patterns.length > 0) {
        dataStore.md5.patternCollection.push({
          timestamp: new Date().toISOString(),
          phien: dataMd5[0]?.Phien || 0,
          patterns: md5Patterns,
          results: dataMd5.slice(0, 10).map(d => d.Ket_qua)
        });
        if (dataStore.md5.patternCollection.length > MAX_PATTERN_HISTORY) {
          dataStore.md5.patternCollection = dataStore.md5.patternCollection.slice(-MAX_PATTERN_HISTORY);
        }
        console.log(`✅ Đã thu thập ${md5Patterns.length} pattern từ MD5`);
      }
    }

    saveData();
    console.log(`📊 Tổng pattern: HU=${dataStore.hu.patternCollection.length}, MD5=${dataStore.md5.patternCollection.length}`);
  } catch (error) {
    console.error('❌ Lỗi thu thập pattern:', error.message);
  }
}

// === KHỞI ĐỘNG ===
loadData();

// Chạy tự động thu thập pattern mỗi 30 giây
setInterval(autoCollectPatterns, 30000);

// Chạy lần đầu sau 5 giây
setTimeout(autoCollectPatterns, 5000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server chạy tại http://0.0.0.0:${PORT}`);
  console.log(`📋 Cần thu thập tối thiểu ${MIN_PATTERNS_FOR_PREDICTION} pattern để dự đoán`);
  console.log(`🔄 Tự động thu thập pattern mỗi 30 giây`);
  console.log(`📊 Pattern hiện tại: HU=${dataStore.hu.patternCollection.length}, MD5=${dataStore.md5.patternCollection.length}`);
});
