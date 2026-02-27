require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const fetch = require("node-fetch");
const xml2js = require("xml2js");

const app = express();
app.use(express.json());

const CONFIG = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  resendKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM || "onboarding@resend.dev",
  emailTo: process.env.EMAIL_TO,
  searchDays: parseInt(process.env.SEARCH_DAYS || "7"),
  maxResults: parseInt(process.env.MAX_RESULTS || "15"),
  cronSchedule: process.env.CRON_SCHEDULE || "0 7 * * 1",
};

const SEARCH_TERMS = ["melatonin","ramelteon","tasimelteon","agomelatine",'"melatonin agonist"'];

async function fetchPubMed(days, maxResults) {
  console.log(`[PubMed] Searching last ${days} days...`);
  const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const query = `(${SEARCH_TERMS.join(" OR ")}) AND ("${dateFrom}"[PDat] : "3000"[PDat])`;
  const searchRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json&sort=pub+date`);
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist || [];
  console.log(`[PubMed] Found ${ids.length} papers`);
  if (ids.length === 0) return [];
  const fetchRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`);
  const xmlText = await fetchRes.text();
  const parsed = await xml2js.parseStringPromise(xmlText);
  const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];
  return articles.map((art) => {
    try {
      const medline = art.MedlineCitation[0];
      const article = medline.Article[0];
      const pmid = medline.PMID[0]._ || medline.PMID[0];
      const title = article.ArticleTitle[0]._ || article.ArticleTitle[0] || "";
      const abstractTexts = article.Abstract?.[0]?.AbstractText || [];
      const abstract = abstractTexts.map((t) => (typeof t === "string" ? t : t._ || "")).join(" ");
      const journal = article.Journal?.[0]?.Title?.[0] || "";
      const year = article.Journal?.[0]?.JournalIssue?.[0]?.PubDate?.[0]?.Year?.[0] || "";
      const authorList = article.AuthorList?.[0]?.Author || [];
      const authors = authorList.slice(0, 3).map((a) => `${a.LastName?.[0] || ""} ${a.Initials?.[0] || ""}`.trim()).join(", ") + (authorList.length > 3 ? " et al." : "");
      return { pmid, title, abstract, journal, year, authors };
    } catch { return null; }
  }).filter((a) => a && a.title && a.abstract);
}

async function triageWithClaude(articles) {
  console.log(`[Claude] Triaging ${articles.length} papers...`);
  const BATCH_SIZE = 5;
  const allResults = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    console.log(`[Claude] Batch ${Math.floor(i/BATCH_SIZE)+1}: ${batch.length} papers`);
    const prompt = `You are a Medical Director at a sleep pharma company reviewing recent PubMed publications about melatonin and melatonin agonists. Return ONLY a JSON array, no markdown:\n[{"relevance":"high"|"medium"|"low","category":"safety"|"efficacy"|"interactions"|"regulatory"|"general","summary":"2 sentence summary","action":"specific action or No action required"}]\n\nArticles:\n${batch.map((a,idx)=>`[${idx}] TITLE: ${a.title}\nABSTRACT: ${a.abstract?.slice(0,500)}`).join("\n\n---\n\n")}`;
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CONFIG.anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await response.json();
      const text = data.content?.[0]?.text || "[]";
      console.log(`[Claude] Preview: ${text.slice(0,60)}`);
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("No JSON array found");
      const results = JSON.parse(match[0]);
      allResults.push(...results);
      console.log(`[Claude] Batch done: ${results.length} results`);
    } catch (err) {
      console.error(`[Claude] Batch error: ${err.message}`);
      batch.forEach(() => allResults.push({ relevance: "medium", category: "general", summary: "AI assessment unavailable.", action: "Manual review recommended." }));
    }
  }
  console.log(`[Claude] Complete: ${allResults.length} assessments`);
  return allResults;
}

function buildEmail(articles, assessments) {
  const date = new Date().toLocaleDateString("en-GB", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const high = articles.filter((_,i) => assessments[i]?.relevance === "high");
  const medium = articles.filter((_,i) => assessments[i]?.relevance === "medium");
  const low = articles.filter((_,i) => assessments[i]?.relevance === "low");
  const catLabel = { safety:"SAFETY/ADR", efficacy:"EFFICACY", interactions:"DRUG INTERACTION", regulatory:"REGULATORY", general:"GENERAL" };
  const renderFull = (a) => {
    const ai = assessments[articles.indexOf(a)] || {};
    return `[${catLabel[ai.category]||"GENERAL"}]\n${a.title}\n${a.authors} | ${a.journal} | ${a.year}\nhttps://pubmed.ncbi.nlm.nih.gov/${a.pmid}/\n\n${ai.summary}\n${ai.action && ai.action!=="No action required" ? `-> Action: ${ai.action}` : ""}`;
  };
  const renderShort = (a) => {
    const ai = assessments[articles.indexOf(a)] || {};
    return `[${catLabel[ai.category]||"GENERAL"}] ${a.title} (${a.year}) - https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`;
  };
  const subject = `Melatonin Literature Digest ${new Date().toLocaleDateString("en-GB")} - ${high.length} high priority`;
  const body = `MELATONIN & MELATONIN AGONISTS - WEEKLY LITERATURE DIGEST\n${date}\n\nSUMMARY: ${articles.length} papers | ${high.length} high priority | ${medium.length} needs review | ${low.length} low\n\n${"=".repeat(50)}\nHIGH PRIORITY (${high.length})\n${"=".repeat(50)}\n${high.length===0?"None this week.\n":high.map(renderFull).join("\n\n---\n\n")}\n\n${"=".repeat(50)}\nNEEDS REVIEW (${medium.length})\n${"=".repeat(50)}\n${medium.length===0?"None.\n":medium.map(renderFull).join("\n\n---\n\n")}\n\n${"=".repeat(50)}\nLOW RELEVANCE (${low.length})\n${"=".repeat(50)}\n${low.length===0?"None.\n":low.map(renderShort).join("\n")}\n\n${"=".repeat(50)}\nDISCLAIMER: AI-generated digest. All flagged papers require qualified medical review before action.\n${"=".repeat(50)}`;
  return { subject, body };
}

async function sendEmail(subject, body) {
  console.log(`[Email] Sending via Resend to ${CONFIG.emailTo}...`);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.resendKey}` },
    body: JSON.stringify({ from: "Lit Monitor <onboarding@resend.dev>", to: [CONFIG.emailTo], subject, text: body }),
  });
  const data = await response.json();
  if (data.error) throw new Error(`Resend: ${JSON.stringify(data.error)}`);
  console.log(`[Email] Sent! ID: ${data.id}`);
}

async function runMonitor() {
  console.log(`\n[Monitor] Starting at ${new Date().toISOString()}`);
  try {
    const articles = await fetchPubMed(CONFIG.searchDays, CONFIG.maxResults);
    if (articles.length === 0) {
      await sendEmail("Melatonin Digest - No new papers", "No new papers found this period.");
      return;
    }
    const assessments = await triageWithClaude(articles);
    const { subject, body } = buildEmail(articles, assessments);
    await sendEmail(subject, body);
    console.log(`[Monitor] Done. ${articles.length} papers processed.`);
  } catch (err) {
    console.error("[Monitor] Error:", err.message);
  }
}

app.get("/", (req, res) => res.json({ status: "Lit Monitor running", schedule: CONFIG.cronSchedule, compounds: SEARCH_TERMS }));
app.get("/run", async (req, res) => {
  console.log("[Manual] /run triggered");
  res.json({ message: "Monitor started - check your email in ~3 minutes" });
  runMonitor();
});

cron.schedule(CONFIG.cronSchedule, () => { console.log("[Cron] Scheduled run"); runMonitor(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Schedule: ${CONFIG.cronSchedule}`);
});
