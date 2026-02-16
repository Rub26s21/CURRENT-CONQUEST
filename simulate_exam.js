const http = require('http');
const https = require('https');
const url = require('url');

// UUID Generator (RFC4122 version 4 compliant)
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Simple http client
async function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const parsedUrl = url.parse(baseUrl);

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = {};
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = { raw: data };
                }

                // Merge set-cookie if present
                const result = {
                    status: res.statusCode,
                    data: parsed,
                    headers: res.headers
                };
                resolve(result);
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

let sessionCookie = null;

async function setupAdmin() {
    console.log('Logging in Admin...');
    const res = await request('POST', '/api/admin/login', {
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin123'
    });

    if (res.data.success) {
        if (res.headers['set-cookie']) {
            sessionCookie = res.headers['set-cookie'][0];
            console.log('✅ Admin Login Success (Cookie Saved)');
            return true;
        } else {
            console.warn('⚠️ No Cookie Received!');
            return false;
        }
    } else {
        console.error('❌ Login Failed:', JSON.stringify(res.data));
        return false;
    }
}

async function startRound(roundNum) {
    if (!sessionCookie) return;

    await request('POST', '/api/admin/event/activate', {}, { 'Cookie': sessionCookie });

    console.log(`Starting Round ${roundNum}...`);
    const res = await request('POST', '/api/admin/round/start', { roundNumber: roundNum }, { 'Cookie': sessionCookie });

    if (res.data.success) {
        console.log(`✅ Round ${roundNum} Started`);
    } else {
        console.error(`❌ Start Round Failed: ${JSON.stringify(res.data)}`);
    }
}

async function endRound() {
    if (!sessionCookie) return;

    console.log('Ending Round...');
    const res = await request('POST', '/api/admin/round/end', {}, { 'Cookie': sessionCookie });

    if (res.data.success) {
        console.log('✅ Round Ended Successfully');
        console.log('   Results Summary:', JSON.stringify(res.data.data, null, 2));
    } else {
        console.error(`❌ End Round Failed: ${JSON.stringify(res.data)}`);
    }
}

async function checkResults(roundNum) {
    if (!sessionCookie) return;

    console.log('Checking Results...');
    const res = await request('GET', `/api/admin/results/${roundNum}`, null, { 'Cookie': sessionCookie });

    if (res.data.success) {
        console.log(`✅ Results Fetched (${res.data.data.results.length} records)`);
        if (res.data.data.results.length > 0) {
            console.log('   Top Scorer:', JSON.stringify(res.data.data.results[0], null, 2));
        }
    } else {
        console.error('❌ Failed to fetch results:', JSON.stringify(res.data));
    }
}

async function simulateUser(id) {
    const token = uuidv4(); // V4 UUID for submission

    try {
        const qRes = await request('GET', '/api/exam/questions');
        if (!qRes.data.success) {
            console.error(`User ${id}: Failed to load questions`);
            return;
        }

        const questions = qRes.data.data.questions;
        const answers = questions.map(q => ({
            question_id: q.questionId,
            selected_option: (id <= 5) ? 'A' : (Math.random() > 0.5 ? 'A' : 'B')
        }));

        const sRes = await request('POST', '/api/exam/submit', {
            attempt_token: token,
            round_number: 1,
            answers: answers,
            time_taken_seconds: 100 + id
        });

        if (sRes.data.success) {
            console.log(`✅ User ${id} Submitted`);

            // Idempotency Retry
            const sRes2 = await request('POST', '/api/exam/submit', {
                attempt_token: token,
                round_number: 1,
                answers: answers,
                time_taken_seconds: 100 + id
            });

            if (sRes2.data.success && sRes2.data.already_submitted) {
                // Verified
            } else {
                console.warn(`   User ${id} Idempotency Check Failed? ${JSON.stringify(sRes2.data)}`);
            }

        } else {
            console.error(`❌ User ${id} Submit Failed: ${JSON.stringify(sRes.data)}`);
        }

    } catch (e) {
        console.error(`User ${id} Error:`, e.message);
    }
}

(async () => {
    if (await setupAdmin()) {
        await startRound(1);

        console.log('Simulating 10 users...');
        const userPromises = [];
        for (let i = 1; i <= 10; i++) {
            userPromises.push(simulateUser(i));
        }
        await Promise.all(userPromises);

        await new Promise(r => setTimeout(r, 2000));

        await endRound();
        await checkResults(1);
    }
})();
