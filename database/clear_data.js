/**
 * Clear all Supabase data including legacy tables
 * Run: node database/clear_data.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function clearAllData() {
    console.log('🔄 Starting Supabase data cleanup...\n');

    // 1. Delete all results
    console.log('  Deleting results...');
    const { error: resultsErr } = await supabase
        .from('results')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    console.log(resultsErr ? `  ❌ Error: ${resultsErr.message}` : `  ✅ Results cleared`);

    // 2. Delete all submissions
    console.log('  Deleting submissions...');
    const { error: submissionsErr } = await supabase
        .from('submissions')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    console.log(submissionsErr ? `  ❌ Error: ${submissionsErr.message}` : `  ✅ Submissions cleared`);

    // 3. Delete legacy responses table (has FK to questions)
    console.log('  Deleting legacy responses...');
    const { error: responsesErr } = await supabase
        .from('responses')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    if (responsesErr && responsesErr.code === '42P01') {
        console.log('  ⚠️  No responses table found (already dropped)');
    } else {
        console.log(responsesErr ? `  ❌ Error: ${responsesErr.message}` : `  ✅ Legacy responses cleared`);
    }

    // 4. Delete legacy participants table
    console.log('  Deleting legacy participants...');
    const { error: participantsErr } = await supabase
        .from('participants')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    if (participantsErr && participantsErr.code === '42P01') {
        console.log('  ⚠️  No participants table found (already dropped)');
    } else {
        console.log(participantsErr ? `  ❌ Error: ${participantsErr.message}` : `  ✅ Legacy participants cleared`);
    }

    // 5. Delete all questions (now possible after responses are cleared)
    console.log('  Deleting questions...');
    const { error: questionsErr } = await supabase
        .from('questions')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    console.log(questionsErr ? `  ❌ Error: ${questionsErr.message}` : `  ✅ Questions cleared`);

    // 6. Delete audit logs
    console.log('  Deleting audit logs...');
    const { error: auditErr } = await supabase
        .from('audit_logs')
        .delete()
        .gte('id', '00000000-0000-0000-0000-000000000000');
    console.log(auditErr ? `  ❌ Error: ${auditErr.message}` : `  ✅ Audit logs cleared`);

    // 7. Reset rounds to pending
    console.log('  Resetting rounds...');
    for (let r = 1; r <= 3; r++) {
        const { error: roundErr } = await supabase
            .from('rounds')
            .update({
                status: 'pending',
                started_at: null,
                ended_at: null,
                shortlisting_completed: false
            })
            .eq('round_number', r);
        console.log(roundErr ? `  ❌ Round ${r} error: ${roundErr.message}` : `  ✅ Round ${r} reset`);
    }

    // 8. Reset event state
    console.log('  Resetting event state...');
    const { error: eventErr } = await supabase
        .from('event_state')
        .update({
            current_round: 0,
            round_status: 'not_started',
            round_started_at: null,
            round_ends_at: null,
            event_active: false,
            updated_at: new Date().toISOString()
        })
        .eq('id', 1);
    console.log(eventErr ? `  ❌ Error: ${eventErr.message}` : `  ✅ Event state reset`);

    // 9. Verify
    console.log('\n📊 Verification:');
    const { count: qCount } = await supabase
        .from('questions')
        .select('*', { count: 'exact', head: true });
    console.log(`  Questions remaining: ${qCount || 0}`);

    const { count: sCount } = await supabase
        .from('submissions')
        .select('*', { count: 'exact', head: true });
    console.log(`  Submissions remaining: ${sCount || 0}`);

    const { count: rCount } = await supabase
        .from('results')
        .select('*', { count: 'exact', head: true });
    console.log(`  Results remaining: ${rCount || 0}`);

    const { data: eventState } = await supabase
        .from('event_state')
        .select('*')
        .eq('id', 1)
        .single();
    console.log(`  Event active: ${eventState?.event_active}`);
    console.log(`  Current round: ${eventState?.current_round}`);
    console.log(`  Round status: ${eventState?.round_status}`);

    console.log('\n✅ All data cleared! You can now upload fresh questions.');
}

clearAllData().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
