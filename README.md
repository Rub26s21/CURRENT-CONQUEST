# Current Conquest - ECE Professional Online Exam Platform

A production-grade, fault-tolerant, secure online examination system for college technical symposium events. Built with Node.js, Express, and Supabase.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## 🎯 Features

### For Administrators
- **Full Event Control**: Activate event, start/stop rounds manually
- **Question Management**: Add questions via UI or bulk import
- **Real-time Dashboard**: Live participant count, submissions, round status
- **Results & Reporting**: Round-wise results with CSV export
- **Audit Logging**: Complete activity tracking

### For Participants
- **Simple Registration**: Name + College/Phone login
- **Strict Exam Mode**: One question at a time, no back navigation
- **Anti-Cheating**: Tab switch detection with warnings
- **Auto-Recovery**: Session persists across page refresh
- **Server-Authoritative Timer**: Accurate, tamper-proof countdown

### Technical Features
- **Server-side Sessions**: Secure, persistent authentication
- **Idempotent Submissions**: Prevents duplicate answers
- **Graceful Recovery**: Handles browser crashes, network issues
- **Local Network Support**: Works in lab environments

## 📋 Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Supabase Account** (free tier works)
- **Internet on Admin Machine** (for database connectivity)

## 🚀 Quick Start

### Step 1: Clone and Install

```bash
cd /path/to/project
npm install
```

### Step 2: Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for the project to be ready (2-3 minutes)
3. Go to **Project Settings** → **API**
4. Copy:
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **service_role key** (under "Project API keys" - the secret one)

### Step 3: Create Database Tables

1. In Supabase, go to **SQL Editor**
2. Click **New Query**
3. Copy the entire contents of `database/schema.sql`
4. Paste and click **Run**
5. You should see "Success. No rows returned"

### Step 4: Configure Environment

```bash
# Copy the example env file
cp .env.example .env

# Edit the .env file with your values
nano .env   # or use any text editor
```

Update these values in `.env`:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

SESSION_SECRET=generate-a-random-string-here-at-least-32-characters

PORT=3000

ADMIN_USERNAME=admin
ADMIN_PASSWORD=YourSecurePassword123!
```

### Step 5: Start the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

### Step 6: Access the Application

- **Participant Login**: http://localhost:3000
- **Admin Panel**: http://localhost:3000/admin

For network access (lab environment):
- Find your IP address: `ifconfig | grep inet` (Mac) or `ipconfig` (Windows)
- Participants can access: `http://YOUR_IP:3000`

## 📖 Usage Guide

### Admin Workflow

1. **Login** to Admin Panel with configured credentials
2. **Activate Event** to allow participant registration
3. **Add Questions** for each round (15 questions per round)
4. **Start Round 1** when ready
5. Monitor **Dashboard** for real-time updates
6. **End Round** manually or wait for auto-completion
7. **Shortlist** participants after each round
8. Repeat for Round 2 and Round 3
9. **Export Results** as CSV

### Adding Questions

#### Manual Entry
1. Go to **Questions** tab
2. Select round
3. Fill in question details
4. Click **Save Question**

#### Bulk Import
Use JSON format:
```json
[
  {
    "questionText": "What is 2 + 2?",
    "optionA": "3",
    "optionB": "4",
    "optionC": "5",
    "optionD": "6",
    "correctOption": "B"
  }
]
```

### Participant Workflow

1. Enter name and college/phone on login page
2. Wait for round to start (waiting screen)
3. Answer questions one by one
4. Click **Next** to proceed (no going back)
5. Submit after last question
6. Wait for results

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_SERVICE_KEY` | Service role key (secret) | Yes |
| `SESSION_SECRET` | Random string for session encryption | Yes |
| `PORT` | Server port (default: 3000) | No |
| `ADMIN_USERNAME` | Admin login username | Yes |
| `ADMIN_PASSWORD` | Admin login password | Yes |

### Round Configuration

Default settings (can be modified in database):
- **Round 1**: 15 questions, 15 minutes, Top 50% qualify
- **Round 2**: 15 questions, 15 minutes, Top 50% qualify
- **Round 3**: 15 questions, 15 minutes, Top 3 winners

## 📁 Project Structure

```
current-conquest/
├── server/
│   ├── index.js              # Express server entry point
│   ├── config/
│   │   ├── database.js       # Supabase client
│   │   └── session.js        # Session configuration
│   ├── middleware/
│   │   └── auth.js           # Authentication middleware
│   └── routes/
│       ├── admin.js          # Admin API routes
│       ├── participant.js    # Participant API routes
│       └── questions.js      # Question management routes
├── public/
│   ├── index.html            # Participant login page
│   ├── exam.html             # Exam interface
│   ├── admin/
│   │   └── index.html        # Admin panel
│   └── css/
│       └── style.css         # Global styles
├── database/
│   └── schema.sql            # Database schema
├── package.json
├── .env.example
└── README.md
```

## 🔒 Security Features

- **Server-side Sessions**: No client-side token storage
- **Password Hashing**: BCrypt for admin passwords
- **CORS Protection**: Configured for local network
- **Helmet.js**: Security headers
- **Input Validation**: All inputs validated server-side
- **Rate Limiting**: Built into session management
- **Audit Logging**: All actions tracked

## ⚠️ Anti-Cheating Measures

1. **Tab Switch Detection**
   - First violation: Warning displayed
   - Second violation: Auto-submit

2. **No Back Navigation**
   - Questions can only be answered in sequence
   - No review screen

3. **Server Timer**
   - Client timer is visual only
   - Server determines actual end time

4. **Context Menu Disabled**
   - Right-click disabled during exam

5. **Keyboard Shortcuts Blocked**
   - Ctrl+C, Ctrl+V, F12, etc.

## 🐛 Troubleshooting

### Common Issues

**"Missing Supabase configuration"**
- Ensure `.env` file exists with correct values
- Restart the server after changing `.env`

**"Event is not active"**
- Admin must activate the event first
- Go to Admin Panel → Dashboard → Activate Event

**"Cannot start round"**
- Ensure 15 questions exist for the round
- Previous round must be completed and shortlisted

**Session not persisting**
- Check that `SESSION_SECRET` is set
- Ensure cookies are enabled in browser

### Network Issues

For lab environment:
1. Ensure admin machine has internet access
2. Check firewall allows port 3000
3. Use IP address, not localhost, for other machines

## 📄 API Reference

### Participant Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/participant/login` | Login/register participant |
| GET | `/api/participant/session` | Check session status |
| GET | `/api/participant/status` | Get current event/round status |
| POST | `/api/participant/start-exam` | Start exam session |
| GET | `/api/participant/question/:num` | Get specific question |
| POST | `/api/participant/answer` | Submit answer |
| POST | `/api/participant/submit-exam` | Final submission |
| POST | `/api/participant/tab-switch` | Report violation |

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Admin login |
| GET | `/api/admin/dashboard` | Get dashboard data |
| POST | `/api/admin/event/activate` | Activate event |
| POST | `/api/admin/round/start` | Start a round |
| POST | `/api/admin/round/end` | End current round |
| POST | `/api/admin/round/shortlist` | Perform shortlisting |
| GET | `/api/admin/results/:round` | Get round results |
| GET | `/api/admin/export/:round` | Export CSV |

## 🤝 Support

For issues during event:
1. Check server logs for errors
2. Verify Supabase connection
3. Refresh admin dashboard
4. Restart server if needed

## 📜 License

MIT License - Feel free to use and modify for your events.

---

Built with ❤️ for ECE Technical Symposiums
