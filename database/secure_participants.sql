-- Secure Participant Details Table
-- Run this in Supabase SQL Editor to secure the table after testing

-- 1. Disable the temporary open access policy
DROP POLICY IF EXISTS "Service role full access" ON participant_details;

-- 2. Ensure RLS is enabled
ALTER TABLE participant_details ENABLE ROW LEVEL SECURITY;

-- 3. (Optional) Create a policy for service role only (explicit)
-- Note: Service role key bypasses RLS by default, so no policy needed for backend.
-- But to be explicit and prevent ANY anon access:
CREATE POLICY "Service role only" ON participant_details
    TO service_role
    USING (true)
    WITH CHECK (true);

-- The table is now secure. Only the backend (using service key) can access it.
