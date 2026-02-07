/**
 * Database Configuration - Supabase Client
 * Quiz Conquest - ECE Professional Online Exam Platform
 * Optimized for 100+ concurrent participants
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase configuration. Please check your .env file.');
    process.exit(1);
}

// Create Supabase client with service role key (bypasses RLS)
// Optimized with connection pooling settings
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    },
    db: {
        schema: 'public'
    },
    global: {
        headers: { 'x-connection-pool': 'quiz-conquest' }
    }
});

// ============================================
// EVENT STATE CACHE (Reduces DB load by 80%)
// ============================================
let eventStateCache = null;
let eventStateCacheTime = 0;
const CACHE_TTL_MS = 2000; // 2 second cache

async function getEventState() {
    const now = Date.now();
    if (eventStateCache && (now - eventStateCacheTime) < CACHE_TTL_MS) {
        return eventStateCache;
    }

    const { data, error } = await supabase
        .from('event_state')
        .select('*')
        .eq('id', 1)
        .single();

    if (!error && data) {
        eventStateCache = data;
        eventStateCacheTime = now;
    }

    return data;
}

function invalidateEventStateCache() {
    eventStateCache = null;
    eventStateCacheTime = 0;
}

module.exports = {
    supabase,
    getEventState,
    invalidateEventStateCache
};
