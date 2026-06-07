const axios = require('axios');
const express = require('express');
const https = require('https');

// ======================
// CẤU HÌNH
// ======================
const BASE = "https://aibcr.me";
const LOGIN_URL = `${BASE}/login`;
const LOBBY_URL = `${BASE}/ae/lobby`;
const GETNEWRESULT_URL = `${BASE}/baccarat/getnewresult`;

const USERNAME = "tiendatoce1232";
const PASSWORD = "tiendatoceee1";

const agent = new https.Agent({ rejectUnauthorized: false });
let cookieJar = '';
let lastUpdate = null;

// ======================
// BIẾN TOÀN CỤC MỚI
// ======================
let tables = {};           // Lưu lịch sử theo từng bàn
let predictions = [];      // Lưu các dự đoán đã thực hiện
const labelMap = { P: 'Xỉu', B: 'Tài', T: 'Hòa' };

// ======================
// SESSION AXIOS
// ======================
const session = axios.create({
    baseURL: BASE,
    timeout: 30000,
    httpsAgent: agent,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

// Interceptor lưu cookie
session.interceptors.request.use(config => {
    if (cookieJar) config.headers.Cookie = cookieJar;
    return config;
});

session.interceptors.response.use(res => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
        for (const cookie of setCookie) {
            const [name, value] = cookie.split(';')[0].split('=');
            if (cookieJar.includes(`${name}=`)) {
                cookieJar = cookieJar.replace(new RegExp(`${name}=[^;]+;?`), '');
            }
            cookieJar += `${name}=${value}; `;
        }
    }
    return res;
});

// ======================
// LẤY CSRF TOKEN
// ======================
function getCsrfToken(html) {
    const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
    return match ? match[1] : null;
}

// ======================
// ĐĂNG NHẬP
// ======================
async function login() {
    try {
        const getResp = await session.get(LOGIN_URL);
        const token = getCsrfToken(getResp.data);

        const formData = new URLSearchParams();
        formData.append('username', USERNAME);
        formData.append('password', PASSWORD);
        formData.append('_token', token);
        formData.append('action', 'Login');

        const headers = {
            'Referer': LOGIN_URL,
            'Origin': BASE,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const loginResp = await session.post(LOGIN_URL, formData.toString(), { headers });
        return loginResp.status === 200;
    } catch (error) {
        console.error('Login error:', error.message);
        return false;
    }
}

// ======================
// VÀO LOBBY
// ======================
async function goToLobby() {
    try {
        await session.get(LOBBY_URL);
        return true;
    } catch (error) {
        console.error('Lobby error:', error.message);
        return false;
    }
}

// ======================
// LẤY KẾT QUẢ BACCARAT (ĐÃ SỬA)
// ======================
async function fetchBaccaratData() {
    try {
        let xsrfToken = '';
        const xsrfMatch = cookieJar.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrfMatch) xsrfToken = decodeURIComponent(xsrfMatch[1]);

        const headers = {
            'Referer': LOBBY_URL,
            'Origin': BASE,
            'X-Requested-With': 'XMLHttpRequest',
            'X-XSRF-TOKEN': xsrfToken,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        };

        const formData = new URLSearchParams();
        formData.append('gameCode', 'ae');

        const resp = await session.post(GETNEWRESULT_URL, formData.toString(), { headers });

        if (resp.data && resp.data.data) {
            const newData = resp.data.data;
            newData.forEach(item => {
                const table = item.table_name;
                const result = item.result;    // giả sử là 1 ký tự P/B/T
                const round = parseInt(item.round) || 0;

                if (!tables[table]) {
                    tables[table] = {
                        history: [],
                        lastResult: '',
                        lastRound: 0
                    };
                }

                const t = tables[table];

                // Chỉ thêm nếu có kết quả mới hoặc round mới hơn
                if ((round > 0 && round > t.lastRound) || (result && result !== t.lastResult)) {
                    const newRound = round || t.history.length + 1;
                    t.history.push({
                        round: newRound,
                        result: result,
                        timestamp: new Date().toISOString()
                    });
                    t.lastResult = result;
                    t.lastRound = newRound;

                    // Kiểm tra xem có dự đoán nào cho round này chưa được đối chiếu
                    const predIndex = predictions.findIndex(
                        p => p.table === table && p.predictedRound === newRound && p.actualResult === null
                    );
                    if (predIndex !== -1) {
                        predictions[predIndex].actualResult = result;
                        predictions[predIndex].correct = (result === predictions[predIndex].predictedResult);
                    }
                }
            });

            lastUpdate = new Date().toISOString();
        }
        return tables;
    } catch (error) {
        console.error('Fetch error:', error.message);
        return {};
    }
}

// ======================
// DỰ ĐOÁN VÀ ĐỘ TIN CẬY
// ======================
function predictNextWithConfidence(historyArray) {
    const historyStr = historyArray.join('');
    const len = historyStr.length;
    if (len < 3) return null;

    // Thử với 3 ký tự cuối, nếu không đủ thì 2
    for (let lookback = 3; lookback >= 2; lookback--) {
        const lastPattern = historyStr.slice(-lookback);
        const occurrences = [];
        let pos = historyStr.indexOf(lastPattern, 0);
        while (pos !== -1 && pos < len - lookback) {
            const nextChar = historyStr[pos + lookback];
            if (nextChar) {
                occurrences.push(nextChar);
            }
            pos = historyStr.indexOf(lastPattern, pos + 1);
        }

        if (occurrences.length > 0) {
            const freq = { P: 0, B: 0, T: 0 };
            occurrences.forEach(c => { if (freq[c] !== undefined) freq[c]++; });
            const total = occurrences.length;
            const best = Object.keys(freq).reduce((a, b) => freq[a] > freq[b] ? a : b);
            const confidence = (freq[best] / total) * 100;
            return { result: best, confidence: Math.round(confidence * 10) / 10 };
        }
    }
    return null;
}

// ======================
// VÒNG LẶP TỰ ĐỘNG CẬP NHẬT
// ======================
async function autoUpdate() {
    while (true) {
        await fetchBaccaratData();
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// ======================
// KHỞI TẠO API SERVER
// ======================
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

// API lấy tất cả bàn (tóm lược)
app.get('/api/baccarat', (req, res) => {
    const summary = {};
    for (const [table, data] of Object.entries(tables)) {
        const last = data.history[data.history.length - 1];
        summary[table] = {
            currentRound: last ? last.round : 0,
            lastResult: last ? last.result : '',
            totalSessions: data.history.length
        };
    }
    res.json({ success: true, data: summary, lastUpdate });
});

// API lấy chi tiết một bàn (đầy đủ lịch sử)
app.get('/api/baccarat/:table', (req, res) => {
    const table = req.params.table;
    if (tables[table]) {
        const t = tables[table];
        res.json({
            success: true,
            table: table,
            currentRound: t.lastRound,
            lastResult: t.lastResult,
            totalSessions: t.history.length,
            history: t.history
        });
    } else {
        res.json({ success: false, message: 'Không tìm thấy bàn ' + table });
    }
});

// API lấy kết quả mới nhất (giữ nguyên nhưng dùng dữ liệu từ tables)
app.get('/api/latest', (req, res) => {
    // Sắp xếp các bàn theo round giảm dần rồi lấy 10 bàn có round cao nhất
    const sorted = Object.entries(tables)
        .map(([table, data]) => ({ table, ...data }))
        .sort((a, b) => b.lastRound - a.lastRound)
        .slice(0, 10);
    res.json({ success: true, data: sorted, lastUpdate });
});

// API dự đoán phiên tiếp theo
app.get('/predict/:table', (req, res) => {
    const table = req.params.table;
    if (!tables[table] || tables[table].history.length === 0) {
        return res.json({ success: false, message: 'Chưa có lịch sử' });
    }

    const t = tables[table];
    const historyChars = t.history.map(e => e.result);
    const prediction = predictNextWithConfidence(historyChars);

    if (!prediction) {
        return res.json({ success: false, message: 'Không đủ dữ liệu để dự đoán' });
    }

    const duDoan = labelMap[prediction.result] || prediction.result;
    const predictedRound = t.lastRound + 1;

    // Lưu dự đoán
    predictions.push({
        table: table,
        predictedRound: predictedRound,
        predictedResult: prediction.result,
        confidence: prediction.confidence,
        timestamp: new Date().toISOString(),
        actualResult: null,
        correct: null
    });

    // Trả về JSON giống /api/baccarat/:table + thêm trường dự đoán
    res.json({
        success: true,
        table: table,
        currentRound: t.lastRound,
        lastResult: t.lastResult,
        totalSessions: t.history.length,
        history: t.history,
        phien_hien_tai: predictedRound,
        du_doan: duDoan,
        do_tin_cay: prediction.confidence
    });
});

// Giao diện /status - lịch sử dự đoán
app.get('/status', (req, res) => {
    const done = predictions.filter(p => p.actualResult !== null);
    const correctCount = done.filter(p => p.correct).length;
    const accuracy = done.length > 0 ? ((correctCount / done.length) * 100).toFixed(1) : 0;

    let html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>Lịch sử dự đoán Baccarat</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4; }
            table { border-collapse: collapse; width: 100%; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            th, td { border: 1px solid #ddd; padding: 12px 8px; text-align: center; }
            th { background: #4CAF50; color: white; }
            .correct { background: #d4edda; }
            .wrong { background: #f8d7da; }
            .pending { background: #fff3cd; }
            .summary { font-size: 1.3em; margin: 20px 0; background: white; padding: 15px; border-radius: 5px; }
        </style>
    </head>
    <body>
        <h1>Lịch sử dự đoán Baccarat</h1>
        <div class="summary">
            <strong>Tổng dự đoán đã kiểm tra:</strong> ${done.length} &nbsp;&nbsp;
            <strong>Đúng:</strong> ${correctCount} &nbsp;&nbsp;
            <strong>Độ chính xác:</strong> ${accuracy}%
        </div>
        <table>
            <thead>
                <tr>
                    <th>Bàn</th>
                    <th>Phiên</th>
                    <th>Dự đoán</th>
                    <th>Độ tin cậy</th>
                    <th>Kết quả thực</th>
                    <th>Đúng/Sai</th>
                    <th>Thời gian dự đoán</th>
                </tr>
            </thead>
            <tbody>`;

    const allSorted = [...predictions].reverse(); // mới nhất lên đầu
    for (const p of allSorted) {
        const rowClass = p.actualResult ? (p.correct ? 'correct' : 'wrong') : 'pending';
        const correctText = p.actualResult ? (p.correct ? 'Đúng' : 'Sai') : 'Đang chờ';
        const actualText = p.actualResult || '...';
        html += `
                <tr class="${rowClass}">
                    <td>${p.table}</td>
                    <td>${p.predictedRound}</td>
                    <td>${labelMap[p.predictedResult] || p.predictedResult}</td>
                    <td>${p.confidence}%</td>
                    <td>${actualText}</td>
                    <td>${correctText}</td>
                    <td>${new Date(p.timestamp).toLocaleString('vi-VN')}</td>
                </tr>`;
    }

    html += `
            </tbody>
        </table>
    </body>
    </html>`;

    res.send(html);
});

// ======================
// KHỞI ĐỘNG
// ======================
async function start() {
    console.log('========================================');
    console.log('BACCARAT API SERVER');
    console.log('========================================');

    console.log('[1] Đang đăng nhập...');
    const loginOk = await login();
    if (!loginOk) {
        console.error('[ERROR] Đăng nhập thất bại!');
        process.exit(1);
    }
    console.log('[OK] Đăng nhập thành công');

    console.log('[2] Vào lobby...');
    await goToLobby();
    console.log('[OK] Vào lobby thành công');

    console.log('[3] Lấy dữ liệu lần đầu...');
    await fetchBaccaratData();
    const tableCount = Object.keys(tables).length;
    console.log(`[OK] Đã lấy ${tableCount} bàn`);

    // Hiển thị danh sách bàn
    console.log('\n📊 DANH SÁCH BÀN:');
    for (const [name, data] of Object.entries(tables)) {
        const last = data.history[data.history.length - 1];
        const shortResult = last ? last.result : '...';
        console.log(`   ${name.padEnd(4)}: ${shortResult} (phiên ${data.lastRound})`);
    }

    // Chạy auto update background
    autoUpdate();

    const PORT = 5000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 API SERVER ĐANG CHẠY:`);
        console.log(`   http://localhost:${PORT}/api/baccarat`);
        console.log(`   http://localhost:${PORT}/api/baccarat/1`);
        console.log(`   http://localhost:${PORT}/api/latest`);
        console.log(`   http://localhost:${PORT}/predict/1`);
        console.log(`   http://localhost:${PORT}/status`);
        console.log(`\n⏰ Auto update mỗi 2 giây`);
    });
}

start();