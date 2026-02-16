const http = require('http');
const https = require('https');
const url = require('url');

// Configuration
const CONFIG = {
    baseUrl: 'http://localhost:3000',
    adminUsername: 'RUBAHAN',
    adminPassword: 'Rubahan26',
    totalUsers: 300,
    roundNumber: 1
};

// UUID Generator
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Simple HTTP Client
async function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(CONFIG.baseUrl + path);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = { raw: data };
                }
                resolve({
                    status: res.statusCode,
                    data: parsed,
                    headers: res.headers
                });
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

let sessionCookie = null;

async function loginAdmin() {
    console.log('🔑 Logging in Admin...');
    const res = await request('POST', '/api/admin/login', {
        username: CONFIG.adminUsername,
        password: CONFIG.adminPassword
    });

    if (res.data.success && res.headers['set-cookie']) {
        sessionCookie = res.headers['set-cookie'][0];
        console.log('✅ Admin Login Success');
        return true;
    }
    console.error('❌ Login Failed:', res.data);
    return false;
}

async function startRound() {
    console.log(`🚀 Starting Round ${CONFIG.roundNumber}...`);
    await request('POST', '/api/admin/event/activate', {}, { 'Cookie': sessionCookie });
    const res = await request('POST', '/api/admin/round/start', { roundNumber: CONFIG.roundNumber }, { 'Cookie': sessionCookie });

    if (res.data.success) {
        console.log(`✅ Round ${CONFIG.roundNumber} Started`);
        return true;
    }
    console.error(`❌ Start Round Failed:`, res.data);
    return false;
}

async function getQuestions() {
    const res = await request('GET', '/api/exam/questions');
    if (res.data.success) return res.data.data.questions;
    throw new Error('Failed to load questions');
}

async function simulateUser(idx, questions) {
    const token = uuidv4();
    try {
        // Generate random answers
        const answers = questions.map(q => ({
            question_id: q.questionId,
            selected_option: ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]
        }));

        const startTime = Date.now();
        const res = await request('POST', '/api/exam/submit', {
            attempt_token: token,
            round_number: CONFIG.roundNumber,
            answers: answers,
            time_taken_seconds: Math.floor(Math.random() * 600) + 60 // 1-10 mins
        });
        const duration = Date.now() - startTime;

        if (res.data.success) {
            // process.stdout.write('.'); // progress dot
            return { success: true, duration };
        } else {
            // process.stdout.write('x');
            return { success: false, error: res.data };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function endRound() {
    console.log('\n🏁 Ending Round (Finalize & Evaluate)...');
    const startTime = Date.now();
    const res = await request('POST', '/api/admin/round/end', {}, { 'Cookie': sessionCookie });
    const duration = Date.now() - startTime;

    if (res.data.success) {
        console.log(`✅ Round Ended in ${duration}ms`);
        console.log('📊 Summary:', JSON.stringify(res.data.data, null, 2));
    } else {
        console.error('❌ End Round Failed:', res.data);
    }
}

async function runTest() {
    console.log(`🔥 Starting Load Test: ${CONFIG.totalUsers} Concurrent Users`);

    if (!await loginAdmin()) return;
    if (!await startRound()) return;

    // Fetch questions once to simulate client-side caching/fetching
    let questions;
    try {
        const qRes = await request('GET', '/api/exam/questions');
        if (qRes.data.success) {
            questions = qRes.data.data.questions || []; // Adjust based on actual API response structure
            // In simulate_exam.js it was res.data.data.questions and q.questionId
            // But let's verify if questions loop works. 
            if (questions.length === 0) {
                console.warn("⚠️ No questions found. Submissions will be empty.");
            }
        }
    } catch (e) {
        console.error("❌ Failed to fetch questions:", e);
        return;
    }

    console.log(`📝 Questions loaded: ${questions.length}`);
    console.log('⚡ dispatching submissions...');

    const promises = [];
    const batchSize = 50; // Send in batches to avoid local socket exhaustion if 300 is too high for simple script

    // Changing to all at once per user request "300 users" implies concurrency.
    // Node handles 300 promises fine.

    const start = Date.now();
    for (let i = 0; i < CONFIG.totalUsers; i++) {
        promises.push(simulateUser(i, questions));
    }

    const results = await Promise.all(promises);
    const end = Date.now();

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const avgDuration = results.reduce((acc, r) => acc + (r.duration || 0), 0) / results.length;

    console.log(`\n✅ Load Test Completed in ${(end - start) / 1000}s`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Failed:  ${failCount}`);
    console.log(`   Avg Req Time: ${Math.round(avgDuration)}ms`);

    await endRound();
}

runTest();
