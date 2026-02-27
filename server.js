require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const xml2js = require("xml2js");

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  emailPassword: process.env.EMAIL_PASSWORD,
  emailTo: process.env.EMAIL_TO,
  searchDays: parseInt(process.env.SEARCH_DAYS || "7"),
  maxResults: parseInt(process.env.MAX_RESULTS || "20"),
  cronSchedule: process.env.CRON_SCHEDULE || "0 7 * * 1",
};

const SEARCH_TERMS = [
  "melatonin",
  "ramelteon",
  "tasimelteon",
  "agomelatine",
  '"melatonin agonist"',
];

// ─────────────────────────────────────────────
// STEP 1 — FETCH FROM PUBMED
// ─────────────────────────────────────────────
async function fetchPubMed(days, maxResults) {
  console.log(`[PubMed] Searching last ${days} days...`);

  const dateFrom = new Date(Date.now() - days * 86400000)
    .toISOString()
    .split("T")[0];

  const query = `(${SEARCH_TERMS.join(" OR ")}) AND ("${dateFrom}"[PDat] : "3000"[PDat])`;

  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
    `?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json&sort=pub+date`;

  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist || [];

  console.log(`[PubMed] Found ${ids.length} papers`);
  if (ids.length === 0) return [];

  const fetchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi` +
    `?db=pubmed&id=${ids.join(",")}&retmode=xml`;

  const fetchRes = await fetch(fetchUrl);
  const xmlText = await fetchRes.text();

  const parsed = await xml2js.parseStringPromise(xmlText);
  const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];

  return articles
    .map((art) => {
      try {
        const medline = art.MedlineCitation[0];
        const article = medline.Article[0];
        const pmid = medline.PMID[0]._ || medline.PMID[0];
        const title = article.ArticleTitle[0]._ || article.ArticleTitle[0] || "";
        const abstractTexts = article.Abstract?.[0]?.AbstractText || [];
        const abstract = abstractTexts
          .map((t) => (typeof t === "string" ? t : t._ || ""))
          .join(" ");
        const journal = article.Journal?.[0]?.Title?.[0] || "";
        const year =
          article.Journal?.[0]?.JournalIssue?.[0]?.PubDate?.[0]?.Year?.[0] ||
          "";
        const authorList = article.AuthorList?.[0]?.Author || [];
        const authors = authorList
          .slice(0, 3)
          .map((a) => `${a.LastName?.[0] || ""} ${a.Initials?.[0] || ""}`.trim())
          .join(", ") + (authorList.length > 3 ? " et al." : "");

        return { pmid, title, abstract, journal, year, authors };
      } catch {
        return null;
      }
    })
    .filter((a) => a && a.title && a.abstract);
}

// ─────────────────────────────────────────────
// STEP 2 — TRIAGE WITH CLAUDE
// ─────────────────────────────────────────────
async function triageWithClaude(articles) {
  console.log(`[Claude] Triaging ${articles.length} papers...`);

  const prompt = `You are a Medical Director at a small pharmaceutical company specialising in sleep and insomnia medicine. You are reviewing recent PubMed publications about melatonin and melatonin agonists (ramelteon, tasimelteon, agomelatine).

For each article, assess clinical relevance for a pharmacovigilance and regulatory affairs team. Be concise and practical.

Articles:
${articles
  .map(
    (a, i) =>
      `[${i}] TITLE: ${a.title}\nABSTRACT: ${a.abstract?.slice(0, 600)}`
  )
  .join("\n\n---\n\n")}

Return ONLY a JSON array (no markdown, no explanation) with one object per article:
[
  {
    "relevance": "high" | "medium" | "low",
    "category": "safety" | "efficacy" | "interactions" | "regulatory" | "general",
    "summary": "2 sentence plain-English summary of what this paper found and why it matters clinically",
    "action": "one specific action the Medical Director should consider, or 'No action required'"
  }
]`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "[]";

  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    console.error("[Claude] Failed to parse response:", text.slice(0, 200));
    return articles.map(() => ({
      relevance: "medium",
      category: "general",
      summary: "Unable to parse AI assessment — please review manually.",
      action: "Manual review recommended.",
    }));
  }
}

// ─────────────────────────────────────────────
// STEP 3 — BUILD EMAIL
// ─────────────────────────────────────────────
function buildEmail(articles, assessments) {
  const date = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const high = articles.filter((_, i) => assessments[i]?.relevance === "high");
  const medium = articles.filter((_, i) => assessments[i]?.relevance === "medium");
  const low = articles.filter((_, i) => assessments[i]?.relevance === "low");

  const categoryLabel = {
    safety: "⚠️ Safety / ADR",
    efficacy: "✅ Efficacy / Clinical",
    interactions: "🔄 Drug Interaction",
    regulatory: "📋 Regulatory / Label",
    general: "📄 General",
  };

  const renderArticle = (a, detail = true) => {
    const idx = articles.indexOf(a);
    const ai = assessments[idx] || {};
    const cat = categoryLabel[ai.category] || "📄 General";
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${cat}
${a.title}
${a.authors} | ${a.journal} | ${a.year}
🔗 https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/
${detail ? `
📝 ${ai.summary}
${ai.action && ai.action !== "No action required" ? `→ Action: ${ai.action}` : ""}` : ""}`;
  };

  const subject = `📋 Melatonin Literature Digest — ${new Date().toLocaleDateString("en-GB")} — ${high.length} high priority`;

  const text = `
MELATONIN & MELATONIN AGONISTS — WEEKLY LITERATURE DIGEST
${date}
Generated by AI Literature Monitor | Sleep Pharma

SUMMARY
───────
Total papers: ${articles.length} | High priority: ${high.length} | Needs review: ${medium.length} | Low: ${low.length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 HIGH PRIORITY — Action May Be Required (${high.length})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${high.length === 0 ? "No high priority papers this week." : high.map((a) => renderArticle(a, true)).join("\n")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 NEEDS REVIEW (${medium.length})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${medium.length === 0 ? "No papers requiring review." : medium.map((a) => renderArticle(a, true)).join("\n")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚪ LOW RELEVANCE (${low.length})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${low.length === 0 ? "None." : low.map((a) => renderArticle(a, false)).join("\n")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DISCLAIMER: AI-generated digest. All high-priority papers must be reviewed 
by a qualified medical or regulatory professional before any action is taken.
This tool does not constitute pharmacovigilance signal detection under GVP Module VI.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  return { subject, text };
}

// ─────────────────────────────────────────────
// STEP 4 — SEND EMAIL
// ─────────────────────────────────────────────
async function sendEmail(subject, text) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: CONFIG.emailFrom,
      pass: CONFIG.emailPassword,
    },
  });

  await transporter.sendMail({
    from: `"Lit Monitor 🔬" <${CONFIG.emailFrom}>`,
    to: CONFIG.emailTo,
    subject,
    text,
  });

  console.log(`[Email] Digest sent to ${CONFIG.emailTo}`);
}

// ─────────────────────────────────────────────
// MAIN RUN FUNCTION
// ─────────────────────────────────────────────
async function runMonitor() {
  console.log(`\n[Monitor] Starting run at ${new Date().toISOString()}`);

  try {
    const articles = await fetchPubMed(CONFIG.searchDays, CONFIG.maxResults);

    if (articles.length === 0) {
      console.log("[Monitor] No articles found. Sending empty digest.");
    }

    const assessments = articles.length > 0
      ? await triageWithClaude(articles)
      : [];

    const { subject, text } = buildEmail(articles, assessments);
    await sendEmail(subject, text);

    console.log(`[Monitor] Run complete. ${articles.length} papers processed.`);
    return { success: true, count: articles.length };

  } catch (err) {
    console.error("[Monitor] Error:", err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check — visit this URL to confirm the app is running
app.get("/", (req, res) => {
  res.json({
    status: "✅ Lit Monitor is running",
    schedule: CONFIG.cronSchedule,
    nextRun: "See Railway logs",
    compounds: SEARCH_TERMS,
  });
});

// Manual trigger — visit /run to fire the monitor immediately
app.get("/run", async (req, res) => {
  console.log("[Manual] Triggered via /run endpoint");
  res.json({ message: "Monitor started — check your email in ~2 minutes" });
  runMonitor(); // runs async, doesn't block response
});

// ─────────────────────────────────────────────
// SCHEDULER — runs automatically on cron schedule
// ─────────────────────────────────────────────
cron.schedule(CONFIG.cronSchedule, () => {
  console.log("[Cron] Scheduled run triggered");
  runMonitor();
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🔬 Lit Monitor — Sleep Pharma AI     ║
╠════════════════════════════════════════╣
║  Server running on port ${PORT}           ║
║  Schedule: ${CONFIG.cronSchedule}          ║
║  Test URL: http://localhost:${PORT}/run   ║
╚════════════════════════════════════════╝
  `);
});
