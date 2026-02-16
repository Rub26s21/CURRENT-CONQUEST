const http = require('http');
const https = require('https');
require('dotenv').config();

// Configuration
const CONCURRENT_USERS = 200;
const API_BASE = 'http://localhost:3000';

// UUID Generator
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// HTTP Client Helper
async function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(API_BASE + path);
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        data: JSON.parse(data)
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        data: { raw: data }
                    });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runStressTest() {
    console.log(`🚀 Starting Stress Test: ${CONCURRENT_USERS} concurrent users...`);
    const startTime = Date.now();

    // 1. Get Questions first (simulating fetching them once per client)
    console.log('Fetching questions...');
    // Ensure a round is running first? 
    // We assume round 1 is running or we start it.
    // Let's just try to fetch. If fails, we can't test submission.

    // We'll skip admin setup for simplicity and assume Event is Active.
    // If not, submissions might execute but return "event not active" implicitly or just work if logic allows.
    // V4 submission doesn't check event status strictly in the `submit` function itself? 
    // It does check `event_state` in `questions` route.

    // Let's create users and register them
    const users = Array.from({ length: CONCURRENT_USERS }, (_, i) => ({
        id: i + 1,
        token: uuidv4(),
        name: `Stress User ${i + 1}`,
        answers: [] // to be filled
    }));

    // 2. Registration Phase
    console.log(`\n📝 Registering ${CONCURRENT_USERS} users...`);
    const regStart = Date.now();
    let regSuccess = 0;

    // Process in batches of 50 to avoid local socket exhaustion if limit exists
    const batchSize = 50;
    for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.all(batch.map(async u => {
            try {
                const res = await request('POST', '/api/exam/register', {
                    attempt_token: u.token,
                    name: u.name,
                    phone: '0000000000',
                    email: `user${u.id}@stress.test`,
                    department: 'Stress Testing',
                    college: 'Load Test University'
                });
                if (res.data.success) regSuccess++;
                else console.error(`User ${u.id} Reg Failed:`, res.data);
            } catch (e) {
                console.error(`User ${u.id} Reg Error:`, e.message);
            }
        }));
    }
    console.log(`   Registration complete: ${regSuccess}/${CONCURRENT_USERS} succeeded in ${(Date.now() - regStart) / 1000}s`);

    // 3. Questions (Simulate 1 user fetching for now to get IDs)
    const qRes = await request('GET', '/api/exam/questions');
    if (!qRes.data.success) {
        console.error('❌ Failed to fetch questions. Ensure a round is active.');
        process.exit(1);
    }
    const questions = qRes.data.data.questions;
    console.log(`   Fetched ${questions.length} questions.`);

    // 4. PREPARE SUBMISSIONS
    console.log(`\n⚡ Preparing submissions...`);
    users.forEach(u => {
        u.answers = questions.map(q => ({
            question_id: q.questionId,
            selected_option: ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]
        }));
    });

    // 5. BULK SUBMIT (The real test)
    console.log(`\n🔥 FIRING ${CONCURRENT_USERS} SUBMISSIONS SIMULTANEOUSLY...`);
    const subStart = Date.now();

    const submissions = users.map(u =>
        request('POST', '/api/exam/submit', {
            attempt_token: u.token,
            round_number: 1,
            answers: u.answers,
            time_taken_seconds: 300
        }).then(res => ({ id: u.id, success: res.data.success, res: res.data }))
            .catch(err => ({ id: u.id, success: false, error: err.message }))
    );

    const results = await Promise.all(submissions);
    const subEnd = Date.now();

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`\n📊 RESULTS:`);
    console.log(`   Total Users:      ${CONCURRENT_USERS}`);
    console.log(`   Successful Subs:  ${successCount}`);
    console.log(`   Failed Subs:      ${failCount}`);
    console.log(`   Total Time:       ${(subEnd - subStart) / 1000}s`);
    console.log(`   Avg Throughput:   ${CONCURRENT_USERS / ((subEnd - subStart) / 1000)} req/sec`);

    if (failCount > 0) {
        console.log('   Sample Failure:', results.find(r => !r.success));
    }
}

runStressTest();
