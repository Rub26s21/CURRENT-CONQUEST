/**
 * TEST SUITE: QUIZ CONQUEST V3.0 REFLECTOR
 * Simulates a full exam lifecycle with Admin + 50 Concurrent Participants.
 */

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Config
const API_URL = 'http://localhost:3000/api';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'password';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// State
let adminCookies = '';
let participantCookies = [];
let roundNumber = 1;

// Helper: Standardized request
async function req(method, endpoint, data = {}, cookies = '') {
    try {
        const config = {
            method,
            url: `${API_URL}${endpoint}`,
            data,
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookies
            },
            withCredentials: true
        };
        const response = await axios(config);
        return {
            success: true,
            data: response.data,
            headers: response.headers
        };
    } catch (error) {
        return {
            success: false,
            status: error.response?.status,
            message: error.response?.data?.message || error.message
        };
    }
}

// ─────────────────────────────────────────────────────────────
// TEST SCENARIOS
// ─────────────────────────────────────────────────────────────

async function runTests() {
    console.log('\n🚀 STARTING INTEGRATION TESTS...\n');

    // 1. ADMIN LOGIN
    console.log('🔹 [ADMIN] Logging in...');
    const loginRes = await req('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
    if (!loginRes.success) {
        console.error('❌ Admin Login Failed:', loginRes.message);
        process.exit(1);
    }
    adminCookies = loginRes.headers['set-cookie'][0];
    console.log('✅ Admin Logged In');

    // 2. RESET EVENT (Clean Slate)
    console.log('🔹 [ADMIN] Resetting Event...');
    const resetRes = await req('POST', '/admin/reset-event', { confirmReset: 'RESET_ALL_DATA', preserveQuestions: false }, adminCookies);
    if (!resetRes.success) {
        console.error('❌ Reset Failed:', resetRes.message);
    } else {
        console.log('✅ Event Reset Successful');
    }

    // 3. ACTIVATE EVENT
    console.log('🔹 [ADMIN] Activating Event...');
    const activateRes = await req('POST', '/admin/event/activate', {}, adminCookies);
    if (!activateRes.success) {
        console.error('❌ Activation Failed:', activateRes.message); // Likely already active/DB error
    } else {
        console.log('✅ Event Activated');
    }

    // 4. ADD QUESTIONS (Mock)
    console.log('🔹 [ADMIN] Adding Questions for Round 1...');
    const questions = Array.from({ length: 15 }, (_, i) => ({
        questionText: `Question ${i + 1} for Round 1`,
        optionA: 'Option A', optionB: 'Option B', optionC: 'Option C', optionD: 'Option D',
        correctOption: ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]
    }));
    const addQRes = await req('POST', '/questions/bulk-add', { roundNumber: 1, questions }, adminCookies);
    if (!addQRes.success) {
        console.error('❌ Add Questions Failed:', addQRes.message);
    } else {
        console.log(`✅ Default Questions Added (${questions.length})`);
    }

    // 5. START ROUND 1
    console.log('🔹 [ADMIN] Starting Round 1...');
    const startRes = await req('POST', '/admin/round/start', { roundNumber: 1 }, adminCookies);
    if (!startRes.success) {
        console.error('❌ Start Round Failed:', startRes.message);
    } else {
        console.log('✅ Round 1 Started');
    }

    // 6. PARTICIPANT REGISTRATION (50 Users)
    console.log('🔹 [PARTICIPANT] Registering 50 Test Users...');
    const users = Array.from({ length: 50 }, (_, i) => ({
        name: `Test User ${i + 1}`,
        collegeName: `Test College ${i % 5}`,
        phoneNumber: `99999${String(i).padStart(5, '0')}`
    }));

    for (const user of users) {
        const res = await req('POST', '/participant/login', user);
        if (res.success) {
            participantCookies.push({
                cookies: res.headers['set-cookie'][0],
                id: res.data.data.systemId
            });
        } else {
            console.error(`❌ Registration Failed for ${user.name}:`, res.message);
        }
    }
    console.log(`✅ Registered ${participantCookies.length}/50 Participants`);

    // 7. EXAM TAKING & SCORING
    console.log('🔹 [EXAM] Simulating Exam Sessions...');
    let submittedCount = 0;

    // Shuffle and pick half to pass (score 15/15) and half to fail (score 0/15)
    // Also disqualify 2 users via tab switching

    for (let i = 0; i < participantCookies.length; i++) {
        const p = participantCookies[i];

        // Start Exam
        const startExam = await req('POST', '/participant/start-exam', {}, p.cookies);
        if (!startExam.success) continue;

        // Disqualify User 0 & 1 (Tab Switch Test)
        if (i < 2) {
            // 1st Warning
            await req('POST', '/participant/tab-switch', { violationType: 'visibility_change' }, p.cookies);
            // 2nd Disqualify
            const dqRes = await req('POST', '/participant/tab-switch', { violationType: 'visibility_change' }, p.cookies);
            if (dqRes.success && dqRes.data.data.disqualified) {
                console.log(`⚡ Verified Disqualification Logic for User ${i}`);
            } else {
                console.error(`❌ Disqualification Logic Failed for User ${i}`);
            }
            continue; // Stop exam for them
        }

        // Submit Answers
        // Users 2-26 get perfect scores (pass), Users 27-49 fail
        const isPass = i >= 2 && i <= 26;

        // We need the correct answers from DB to simulate passing
        // (In real life, client doesn't know correct answer, but we are simulating 'correct' behavior)
        // For simplicity, we assume we know the pattern or fetched questions.
        // Actually, let's just create answers. We know the pattern we stored? 
        // We stored random A/B/C/D. We'll cheat and read from DB for test accuracy.

        const { data: dbQuestions } = await supabase.from('questions').select('id, correct_option').eq('round_number', 1);

        const answers = dbQuestions.map(q => ({
            question_id: q.id,
            selected_option: isPass ? q.correct_option : (q.correct_option === 'A' ? 'B' : 'A') // Force wrong if fail
        }));

        const submitRes = await req('POST', '/participant/submit-exam', {
            answers,
            submissionType: 'manual'
        }, p.cookies);

        if (submitRes.success) submittedCount++;
    }
    console.log(`✅ Submitted ${submittedCount} Exams`);

    // 8. END ROUND (Admin)
    console.log('🔹 [ADMIN] Ending Round 1...');
    const endRes = await req('POST', '/admin/round/end', {}, adminCookies);

    if (endRes.success) {
        console.log('✅ Round Ended Successfully');
        console.log('📊 Stats:', endRes.data.data);

        if (endRes.data.data.qualified_count === 25) {
            console.log('✅ Qualification Logic Correct (Limit 25)');
        } else {
            console.warn(`⚠️ Qualification Logic Warning: Expected 25, got ${endRes.data.data.qualified_count}`);
        }
    } else {
        console.error('❌ End Round Failed:', endRes.message);
    }

    // 9. VERIFY RESULTS
    console.log('🔹 [ADMIN] Verifying Results...');
    const resultsRes = await req('GET', '/admin/results/1', {}, adminCookies);
    if (resultsRes.success) {
        const qualified = resultsRes.data.data.results.filter(r => r.qualified_for_next);
        console.log(`✅ Verified ${qualified.length} Qualified via API`);

        // Check for disqualified users appearing in ranking
        const dqInRanking = resultsRes.data.data.results.some(r => r.participants.is_disqualified && r.rank !== null);
        if (dqInRanking) {
            console.error('❌ CRITICAL BUG: Disqualified user found in ranking!');
        } else {
            console.log('✅ Disqualified users correctly excluded from rank');
        }
    }

    console.log('\n🏁 TESTS COMPLETED\n');
}

runTests();
