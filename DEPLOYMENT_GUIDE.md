# 🚀 QUIZ CONQUEST - DEPLOYMENT GUIDE (v4.0 Architecture Upgrade)

This guide covers the deployment of the major **V4 Architecture Upgrade**, designed for high concurrency (5000+ users), stateless participant flow, and event safety.

## 🚨 MANDATORY: Database Migration (v4.0)

**CRITICAL STEP:** The V4 upgrade completely changes the database schema to remove personal data storage and optimize for high-load submissions. The application **WILL NOT WORK** until you run this migration.

1.  Go to your **Supabase Dashboard**.
2.  Open the **SQL Editor**.
3.  Click **New Query**.
4.  Copy the entire content of:
    `database/v4_architecture_upgrade.sql`
5.  Paste it into the editor and click **Run**.
6.  Verify that it says "Success". This script will:
    -   Drop old `participants` and `responses` tables (Data deletion is intentional).
    -   Create new `submissions` and `results` tables optimized for speed.
    -   Install atomic functions: `submit_bulk_answers`, `finalize_round_v4`.

---

## 2. Environment Variables

Ensure your Vercel Project Settings > Environment Variables match these keys:

| Key | Value Description |
| :--- | :--- |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase `service_role` key (REQUIRED for V4 RPC calls) |
| `SESSION_SECRET` | A long, random string for admin sessions |
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD` | Admin login password |

---

## 3. Deploy to Vercel

The code is already pushed. Vercel should automatically trigger a deployment.

1.  Go to your **Vercel Dashboard**.
2.  Check the latest deployment status.
3.  Once "Ready", verify the live URL.

---

## 4. Post-Deployment Verification (V4 Checklist)

After database migration and deployment, perform these checks:

1.  **Admin Login:**
    -   Go to `/admin`.
    -   Login with credentials.
    -   **New Dashboard:** Verify you see "Total Participants" (calculated from submissions) and "Current Round".
    -   The "Participants" tab now correctly shows anonymous submissions.

2.  **Event Setup:**
    -   Ensure Round 1 is configured (duration/questions).
    -   **Important:** Upload questions to Round 1 if empty. Use the "Questions" tab or "File Upload".

3.  **Participant Flow (Stateless):**
    -   Open the main page (`/`) in Incognito mode.
    -   Click **Enter Exam**. (No registration form should appear).
    -   Start the exam.
    -   **Submission Test:** Answer a few questions and click Submit.
    -   **Success:** You should see "Exam Submitted Successfully!" immediately.
    -   **Verification:** Check the Admin Dashboard > Submissions to see your anonymous entry.

4.  **Idempotency Check:**
    -   Try to submit again in the same browser session (if allowed by UI) or refresh and re-enter.
    -   The system should either block re-entry or handle duplicate submission gracefully without error.

---

## 5. Troubleshooting

**Issue: "Failed to submit exam" / "System Error"**
-   **Cause:** The `submissions` table or `submit_bulk_answers` function is missing.
-   **Fix:** **IMMEDIATELY** run `database/v4_architecture_upgrade.sql` in Supabase.

**Issue: "Login failed" (Admin)**
-   **Cause:** Admin table schema might be outdated or user missing.
-   **Fix:** The migration script preserves admins, but if you reset everything, check `auth.admins` or `admins` table.

**Issue: Admin Dashboard shows "Error loading participants"**
-   **Cause:** You might be running old frontend code with new backend, or vice versa.
-   **Fix:** Ensure both Frontend and Backend are deployed from the latest commit. (We fixed the `/participants` route compatibility).

---

## 6. Verification Script

We have included a simulation script (`simulate_exam.js`) to test the entire flow locally or against production.

To run it:
1.  Open terminal.
2.  Run: `node simulate_exam.js`
    *(Make sure your .env has ADMIN_USERNAME and ADMIN_PASSWORD set)*

This script will:
-   Login as Admin.
-   Start Round 1.
-   Simulate 10 concurrent users submitting answers.
-   Verify that submissions are idempotent (no duplicates).
-   End the round and fetch results.
-   **Success:** You should see `✅ Round Ended Successfully` and score details.
