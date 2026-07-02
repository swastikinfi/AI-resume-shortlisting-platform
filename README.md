# Next You — Resume Analyzer (Bot 1 → Bot 2, Gemini API)

## Workflow
1. User pastes the **Job Description** in the message box and attaches up to **50 resumes** (PDF, DOCX, image, or sheet).
2. **Bot 1** (`/api/analyze`) — calls Gemini once per resume, extracts structured data only (name, contact, skills, experience, projects, internships, open source, hackathons, education). No scoring, nothing invented.
3. **Bot 2** (`/api/rank`) — calls Gemini once with the JD + all of Bot 1's outputs together, and returns every candidate ranked with `match_percent` and a `why_this_rank` explanation.
4. Frontend shows the ranked list as a **table** (Rank, Match %, Name, Skills, Experience, Projects, Education, Strengths, Missing) — click any row to open a **detail panel** with the full, unclipped text (this is what fixes the "text crops when output is large" problem: the table shows a 2-line preview per cell, the modal shows everything).

## Why a backend is required
Gemini needs an API key on every request. Keeping it in browser JavaScript would expose it to anyone who opens dev tools. This server holds the key in `.env` and the browser only ever talks to your own server.

## Setup
```bash

npm install
cp .env.example .env
# edit .env and paste your key from https://aistudio.google.com/apikey
npm start
```
Open **http://localhost:4000**

## Files
- `server.js` — Express backend, both bots, file parsing (pdf-parse, mammoth for docx, xlsx for sheets, images sent natively to Gemini)
- `public/index.html` — frontend (chat-style upload + results table + detail modal)
- `.env.example` — copy to `.env`, set `GEMINI_API_KEY`

## Notes
- `GEMINI_MODEL` defaults to `gemini-2.5-flash` in `.env.example` — change it there if you want a different Gemini model.
- Max 50 files per request (`multer` limit in `server.js`, matches the UI's stated limit).
- If a resume file fails to parse or Gemini returns bad JSON for it, that candidate is skipped from ranking and reported in the chat message instead of breaking the whole batch.
- To deploy this for real users (not just your own machine), host `server.js` on any Node host (Render, Railway, a VPS, etc.) and set `GEMINI_API_KEY` as an environment variable there — never commit `.env`.