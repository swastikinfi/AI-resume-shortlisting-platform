import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
}

// ---------------------------------------------------------------------------
// Bot 1 — Extraction only. No scoring, no ranking, no invented data.
// ---------------------------------------------------------------------------
const BOT1_SYSTEM = `You are a resume extraction engine. Extract ONLY information explicitly present in the resume. Never invent, guess, or infer missing details — if something is not mentioned, use "Not Mentioned" (or an empty array for list fields).

Extract every item found — if there are 10 projects, list all 10; if there are multiple jobs, internships, hackathons, or open-source contributions, list all of them.

Return ONLY raw JSON (no markdown fences, no commentary) matching this schema exactly:
{
  "name": "",
  "email": "",
  "phone": "",
  "linkedin": "",
  "github": "",
  "skills": [],
  "experience": [{"company":"","role":"","duration":"","location":"","description":""}],
  "projects": [{"name":"","date":"","problem_solved":"","description":""}],
  "internships": [{"company":"","duration":"","description":""}],
  "open_source": [{"description":""}],
  "hackathons": [{"name":"","description":""}],
  "education": {"degree":"","institution":"","cgpa_or_percentage":""},
  "missing_information": ""
}`;

// ---------------------------------------------------------------------------
// Bot 2 — Ranks all candidates against the JD. Receives Bot 1's structured
// output for every candidate at once, plus the JD.
// ---------------------------------------------------------------------------
const BOT2_SYSTEM = `You are a JD-matching and ranking engine. You receive a Job Description and a list of structured candidate profiles (already extracted by another system — treat that data as ground truth, do not re-invent facts).

For each candidate:
- Compute a match_percent (0-100) reflecting how well they fit the JD (skills, experience level, projects, education/CGPA if the JD requires it).
- Rank all candidates 1..N, 1 being the best match.
- Give a short "why_this_rank" explanation: concretely say why this candidate ranked where they did relative to the JD (what they have, what they lack).
- List strengths (JD-relevant) and missing_requirements (JD asks for it, candidate doesn't have it).
- Carry over contact info and summarize experience/projects/education concisely — do not drop any candidate.

If the JD does not require a field (e.g. CGPA not mentioned in JD), still show the candidate's value if known but do not penalize its absence in scoring.

Return ONLY raw JSON — an array, one object per candidate, sorted by rank ascending, no markdown fences, no commentary. Schema per item:
{
  "rank": 1,
  "match_percent": 0,
  "name": "",
  "email": "",
  "phone": "",
  "linkedin": "",
  "github": "",
  "skills": [],
  "experience_summary": "[{"company":"","role":"","duration":"","location":"","description":""}],",
  "projects": "",         [{"name":"","date":"","problem_solved":"","description":""}],
  "open_source": "",  [{"description":"where and when they contributed to open sources"}],
  "internships": "",   "[{"company":"","role":"","duration":"","location":"","description":""}],",
  "hackathons": "",
  "education": "",
  "cgpa": "",
  "strengths": "",
  "missing_requirements": "",
  "why_this_rank": ""
}`;

async function callGemini(systemPrompt, userParts, model = GEMINI_MODEL) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  };
  const res = await fetch(GEMINI_URL(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error('Model did not return valid JSON: ' + clean.slice(0, 300));
  }
}

async function fileToParts(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === '.pdf') {
    const buf = fs.readFileSync(file.path);
    // Send the PDF natively — Gemini reads PDFs directly (text + layout).
    return [{ inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }];
  }
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const buf = fs.readFileSync(file.path);
    const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
    return [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }];
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: file.path });
    return [{ text: `Resume content:\n\n${result.value}` }];
  }
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const wb = XLSX.readFile(file.path);
    let text = '';
    wb.SheetNames.forEach((sn) => {
      text += `\n--- Sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]);
    });
    return [{ text: `Resume content:\n${text}` }];
  }
  if (ext === '.txt') {
    return [{ text: `Resume content:\n\n${fs.readFileSync(file.path, 'utf-8')}` }];
  }
  throw new Error('Unsupported file type: ' + ext);
}

// POST /api/analyze  (Bot 1) — multipart form: files[]
app.post('/api/analyze', upload.array('files', 50), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

  const results = [];
  for (const file of files) {
    try {
      const parts = await fileToParts(file);
      parts.push({ text: 'Extract this resume per the schema. Return JSON only.' });
      const parsed = await callGemini(BOT1_SYSTEM, parts);
      parsed._fileName = file.originalname;
      results.push(parsed);
    } catch (e) {
      results.push({ _fileName: file.originalname, _error: e.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }
  res.json({ success: true, results });
});

// POST /api/rank  (Bot 2) — JSON body: { jd, candidates }
app.post('/api/rank', async (req, res) => {
  try {
    const { jd, candidates } = req.body || {};
    if (!jd || !jd.trim()) return res.status(400).json({ success: false, error: 'Job description is required' });
    if (!Array.isArray(candidates) || !candidates.length)
      return res.status(400).json({ success: false, error: 'No candidates to rank' });

    const usable = candidates.filter((c) => !c._error);
    const parts = [
      {
        text:
          `Job Description:\n${jd.trim()}\n\n` +
          `Candidates (Bot 1 extracted data, ${usable.length} total):\n${JSON.stringify(usable)}\n\n` +
          `Rank all ${usable.length} candidates per the rules. Return the JSON array only.`
      }
    ];
    const ranked = await callGemini(BOT2_SYSTEM, parts);
    res.json({ success: true, ranked });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, model: GEMINI_MODEL, keySet: !!GEMINI_API_KEY }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Next You server running → http://localhost:${PORT}`));