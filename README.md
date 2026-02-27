# 🔬 Melatonin Literature Monitor
### AI-powered weekly PubMed digest for sleep pharma

---

## What this does
Every Monday at 7am, this tool:
1. Searches PubMed for new melatonin / melatonin agonist papers
2. Has Claude read and triage each abstract
3. Emails you a formatted digest with priority ratings and action recommendations

---

## Setup (one time, ~30 minutes)

### 1. Get your API key
- Go to console.anthropic.com
- Create an API key, copy it

### 2. Set up Gmail for sending
- Create a Gmail account: e.g. yourcompany.litmonitor@gmail.com
- Go to myaccount.google.com → Security → 2-Step Verification (enable it)
- Then go to myaccount.google.com → Security → App Passwords
- Create an app password for "Mail" → copy the 16-character password

### 3. Create your .env file
- Copy .env.template to a new file called exactly: .env
- Fill in your values (API key, Gmail details, recipient emails)
- Never share or commit this file — it contains your secrets

### 4. Deploy to Railway
- Go to railway.app and sign up with GitHub
- Click "New Project" → "Deploy from GitHub repo"
- Select this repo
- Go to Variables tab → add each line from your .env file as a variable
- Railway will auto-deploy and run the server 24/7

### 5. Test it
- Visit your Railway URL + /run (e.g. https://yourapp.railway.app/run)
- Check your email in 2 minutes
- If it works, you're live!

---

## Files
- server.js — main application logic
- package.json — dependencies
- .env.template — copy this to .env and fill in your values
- .gitignore — keeps your .env secrets out of GitHub

---

## Customising search terms
Open server.js and edit the SEARCH_TERMS array at the top to add your own compound names.

---

## Disclaimer
AI-generated digest. All high-priority papers must be reviewed by a qualified 
medical or regulatory professional. Not a GVP-validated pharmacovigilance tool.
