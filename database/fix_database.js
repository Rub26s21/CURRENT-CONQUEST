/**
 * Database Fix Script
 * Fixes missing columns in Supabase database
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase configuration. Please check your .env file.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

async function fixDatabase() {
    console.log('🔧 Starting database fix...\n');

    try {
        // Test connection by checking if participants table exists
        console.log('1. Testing database connection...');
        const { data: testData, error: testError } = await supabase
            .from('participants')
            .select('id')
            .limit(1);

        if (testError) {
            console.error('❌ Database connection failed:', testError.message);
            console.log('\nThe participants table might not exist. Please run the schema.sql file in Supabase SQL Editor first.');
            return;
        }
        console.log('✅ Database connection successful\n');

        // Check if event_state exists and has a record
        console.log('2. Checking event_state table...');
        const { data: eventState, error: eventError } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (eventError || !eventState) {
            console.log('⚠️  No event_state record found. Creating one...');
            const { error: insertError } = await supabase
                .from('event_state')
                .insert({
                    id: 1,
                    current_round: 0,
                    round_status: 'not_started',
                    event_active: false
                });

            if (insertError) {
                console.error('❌ Failed to create event_state:', insertError.message);
            } else {
                console.log('✅ Created event_state record');
            }
        } else {
            console.log('✅ event_state table is OK');
        }

        // Check rounds table
        console.log('\n3. Checking rounds table...');
        const { data: rounds, error: roundsError } = await supabase
            .from('rounds')
            .select('round_number')
            .order('round_number');

        if (roundsError) {
            console.error('❌ Failed to check rounds:', roundsError.message);
        } else if (!rounds || rounds.length === 0) {
            console.log('⚠️  No rounds found. Creating default rounds...');
            const { error: insertRoundsError } = await supabase
                .from('rounds')
                .upsert([
                    { round_number: 1, qualification_percentage: 50.00, total_questions: 15, duration_minutes: 15 },
                    { round_number: 2, qualification_percentage: 50.00, total_questions: 15, duration_minutes: 15 },
                    { round_number: 3, qualification_percentage: 100.00, total_questions: 15, duration_minutes: 15 }
                ], { onConflict: 'round_number' });

            if (insertRoundsError) {
                console.error('❌ Failed to create rounds:', insertRoundsError.message);
            } else {
                console.log('✅ Created default rounds');
            }
        } else {
            console.log(`✅ rounds table has ${rounds.length} rounds`);
        }

        // Test participant insert
        console.log('\n4. Testing participant creation (will be deleted)...');
        const testId = `TEST-${Date.now()}`;
        const { data: testParticipant, error: insertParticipantError } = await supabase
            .from('participants')
            .insert({
                system_id: testId,
                name: 'Test User',
                college_name: 'Test College',
                phone_number: '1234567890',
                is_active: true,
                is_qualified: true,
                current_round: 1
            })
            .select()
            .single();

        if (insertParticipantError) {
            console.error('❌ Participant creation test failed:', insertParticipantError.message);

            // Check if it's the college_name column issue
            if (insertParticipantError.message.includes('college_name')) {
                console.log('\n⚠️  The college_name column is missing from the participants table.');
                console.log('   Please run the following SQL in Supabase SQL Editor:\n');
                console.log('   ALTER TABLE participants ADD COLUMN IF NOT EXISTS college_name VARCHAR(150);\n');
            }
        } else {
            console.log('✅ Participant creation test successful');

            // Clean up test participant
            await supabase
                .from('participants')
                .delete()
                .eq('system_id', testId);
            console.log('✅ Test participant cleaned up');
        }

        console.log('\n🎉 Database check complete!');
        console.log('\nIf there were errors, please run database/fix_schema.sql in Supabase SQL Editor.');

    } catch (error) {
        console.error('❌ Unexpected error:', error.message);
    }
}

fixDatabase();
