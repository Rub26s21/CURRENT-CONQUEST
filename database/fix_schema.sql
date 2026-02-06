-- ============================================================
-- QUIZ CONQUEST - Database Fix Script
-- ============================================================
-- 
-- INSTRUCTIONS:
-- 1. Go to your Supabase Dashboard: https://supabase.com/dashboard
-- 2. Select your project
-- 3. Go to SQL Editor (left sidebar)
-- 4. Copy and paste this entire script
-- 5. Click "Run" to execute
-- ============================================================

-- Add college_name column if it doesn't exist
ALTER TABLE participants ADD COLUMN IF NOT EXISTS college_name VARCHAR(150);

-- Set default value for any existing rows with null college_name
UPDATE participants SET college_name = 'Not Specified' WHERE college_name IS NULL;

-- Ensure event_state has a record
INSERT INTO event_state (id, current_round, round_status, event_active)
VALUES (1, 0, 'not_started', false)
ON CONFLICT (id) DO NOTHING;

-- Ensure rounds are properly set up
INSERT INTO rounds (round_number, qualification_percentage, total_questions, duration_minutes)
VALUES 
    (1, 50.00, 15, 15),
    (2, 50.00, 15, 15),
    (3, 100.00, 15, 15)
ON CONFLICT (round_number) DO UPDATE SET
    total_questions = 15,
    duration_minutes = COALESCE(rounds.duration_minutes, 15);

-- Verify the fix worked
SELECT 'participants columns:' as info;
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'participants'
ORDER BY ordinal_position;

SELECT 'event_state:' as info;
SELECT * FROM event_state WHERE id = 1;

SELECT 'rounds:' as info;
SELECT * FROM rounds ORDER BY round_number;

-- ============================================================
-- If you see 'college_name' in the participants columns output,
-- the fix was successful!
-- ============================================================
