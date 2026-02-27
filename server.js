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
    const prompt = `You are a Medical Director at AGB-Pharma, a sleep medicine pharmaceutical company. Review these PubMed publications about melatonin and melatonin agonists. Return ONLY a JSON array, no markdown:\n[{"relevance":"high"|"medium"|"low","category":"safety"|"efficacy"|"interactions"|"regulatory"|"general","summary":"2 sentence plain-English summary","action":"specific action or No action required"}]\n\nArticles:\n${batch.map((a,idx)=>`[${idx}] TITLE: ${a.title}\nABSTRACT: ${a.abstract?.slice(0,500)}`).join("\n\n---\n\n")}`;
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CONFIG.anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await response.json();
      const text = data.content?.[0]?.text || "[]";
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

function buildEmailHtml(articles, assessments) {
  const date = new Date().toLocaleDateString("en-GB", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const high = articles.filter((_,i) => assessments[i]?.relevance === "high");
  const medium = articles.filter((_,i) => assessments[i]?.relevance === "medium");
  const low = articles.filter((_,i) => assessments[i]?.relevance === "low");

  const catConfig = {
    safety:       { label:"Safety / ADR",        color:"#c0392b", bg:"#fdf2f2" },
    efficacy:     { label:"Efficacy / Clinical",  color:"#1a6b3c", bg:"#f0faf4" },
    interactions: { label:"Drug Interaction",     color:"#b7770d", bg:"#fef9ee" },
    regulatory:   { label:"Regulatory / Label",   color:"#1a3f6b", bg:"#f0f5fb" },
    general:      { label:"General",              color:"#555",    bg:"#f7f7f7" },
  };

  const relevanceBadge = (r) => {
    const cfg = { high: ["#c0392b","#fdf2f2","HIGH PRIORITY"], medium: ["#b7770d","#fef9ee","REVIEW"], low: ["#888","#f7f7f7","LOW"] }[r] || ["#888","#f7f7f7","LOW"];
    return `<span style="display:inline-block;background:${cfg[1]};color:${cfg[0]};border:1px solid ${cfg[0]};border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.08em;padding:2px 8px;text-transform:uppercase;">${cfg[2]}</span>`;
  };

  const renderCard = (a) => {
    const idx = articles.indexOf(a);
    const ai = assessments[idx] || {};
    const cat = catConfig[ai.category] || catConfig.general;
    return `
    <div style="background:#ffffff;border:1px solid #e0e0e0;border-left:4px solid ${cat.color};border-radius:4px;margin-bottom:16px;overflow:hidden;">
      <div style="padding:16px 20px;">
        <div style="margin-bottom:10px;">
          ${relevanceBadge(ai.relevance)}
          <span style="display:inline-block;margin-left:8px;background:${cat.bg};color:${cat.color};border-radius:3px;font-size:10px;font-weight:600;letter-spacing:0.06em;padding:2px 8px;text-transform:uppercase;">${cat.label}</span>
        </div>
        <a href="https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/" style="display:block;font-size:15px;font-weight:700;color:#0d2b1f;text-decoration:none;line-height:1.4;margin-bottom:6px;">${a.title}</a>
        <div style="font-size:11px;color:#888;font-family:monospace;margin-bottom:12px;">${a.authors} &nbsp;·&nbsp; ${a.journal} &nbsp;·&nbsp; ${a.year} &nbsp;·&nbsp; PMID ${a.pmid}</div>
        <div style="background:#f4f8f5;border-radius:4px;padding:12px 14px;margin-bottom:10px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#1a6b3c;font-weight:700;margin-bottom:5px;">AI Summary</div>
          <div style="font-size:13px;color:#333;line-height:1.6;">${ai.summary}</div>
        </div>
        ${ai.action && ai.action !== "No action required" ? `<div style="font-size:12px;color:#555;border-left:3px solid #1a6b3c;padding-left:10px;font-style:italic;"><strong style="font-style:normal;color:#0d2b1f;">Suggested action:</strong> ${ai.action}</div>` : `<div style="font-size:11px;color:#aaa;">No action required</div>`}
      </div>
    </div>`;
  };

  const renderShortRow = (a) => {
    const idx = articles.indexOf(a);
    const ai = assessments[idx] || {};
    const cat = catConfig[ai.category] || catConfig.general;
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:12px;"><span style="color:${cat.color};font-weight:600;font-size:10px;text-transform:uppercase;">${cat.label}</span><br><a href="https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/" style="color:#333;text-decoration:none;">${a.title}</a> <span style="color:#aaa;">(${a.year})</span></td></tr>`;
  };

  const sectionHeader = (title, count, color) => `
    <div style="margin:28px 0 16px;padding-bottom:8px;border-bottom:2px solid ${color};">
      <span style="font-size:17px;font-weight:700;color:${color};">${title}</span>
      <span style="margin-left:10px;background:${color};color:#fff;border-radius:100px;font-size:11px;font-weight:700;padding:2px 10px;">${count}</span>
    </div>`;

  const subject = `Melatonin Literature Digest — ${new Date().toLocaleDateString("en-GB")} — ${high.length} high priority`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0ec;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0ec;padding:24px 0;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

  <!-- HEADER -->
  <tr><td style="background:#0d2b1f;border-radius:8px 8px 0 0;padding:28px 32px;">
    <div style="display:flex;align-items:center;">
      <div>
        <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:4px;">AGB-Pharma · Medical Affairs</div>
        <div style="font-size:22px;font-weight:700;color:#ffffff;line-height:1.2;">Melatonin Literature Monitor</div>
        <div style="font-size:13px;color:#4db87a;margin-top:4px;">Weekly Digest &nbsp;·&nbsp; ${date}</div>
      </div>
    </div>
  </td></tr>

  <!-- SUMMARY BAR -->
  <tr><td style="background:#1a6b3c;padding:14px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;border-right:1px solid rgba(255,255,255,0.2);padding:0 16px 0 0;">
        <div style="font-size:24px;font-weight:700;color:#ffffff;">${articles.length}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.6);">Papers</div>
      </td>
      <td style="text-align:center;border-right:1px solid rgba(255,255,255,0.2);padding:0 16px;">
        <div style="font-size:24px;font-weight:700;color:#ff8a80;">${high.length}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.6);">High Priority</div>
      </td>
      <td style="text-align:center;border-right:1px solid rgba(255,255,255,0.2);padding:0 16px;">
        <div style="font-size:24px;font-weight:700;color:#ffd180;">${medium.length}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.6);">Needs Review</div>
      </td>
      <td style="text-align:center;padding:0 0 0 16px;">
        <div style="font-size:24px;font-weight:700;color:rgba(255,255,255,0.4);">${low.length}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.6);">Low Relevance</div>
      </td>
    </tr></table>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:24px 32px;border-radius:0 0 8px 8px;">

    ${high.length > 0 ? sectionHeader("High Priority — Action May Be Required", high.length, "#c0392b") + high.map(renderCard).join("") : ""}
    ${medium.length > 0 ? sectionHeader("Needs Review", medium.length, "#b7770d") + medium.map(renderCard).join("") : ""}
    ${low.length > 0 ? `
      ${sectionHeader("Low Relevance", low.length, "#aaa")}
      <table width="100%" cellpadding="0" cellspacing="0">${low.map(renderShortRow).join("")}</table>
    ` : ""}
    ${high.length === 0 && medium.length === 0 ? `<div style="text-align:center;padding:40px 20px;color:#888;font-size:14px;">No significant papers found this week.</div>` : ""}

    <!-- DISCLAIMER -->
    <div style="margin-top:32px;padding:14px 16px;background:#f4f8f5;border-radius:4px;border:1px solid #d0e8d8;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#1a6b3c;font-weight:700;margin-bottom:4px;">Disclaimer</div>
      <div style="font-size:11px;color:#666;line-height:1.6;">This digest is AI-generated for informational purposes only. All high-priority papers must be reviewed by a qualified medical or regulatory professional before any action is taken. This tool does not constitute pharmacovigilance signal detection under GVP Module VI.</div>
    </div>

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:16px 32px;text-align:center;">
    <div style="font-size:10px;color:#aaa;line-height:1.8;">
      AGB-Pharma AB &nbsp;·&nbsp; Medical Affairs &nbsp;·&nbsp; AI Literature Monitor<br>
      Compounds monitored: melatonin, ramelteon, tasimelteon, agomelatine<br>
      Generated automatically every Monday at 07:00
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}

async function sendEmail(subject, html) {
  console.log(`[Email] Sending via Resend to ${CONFIG.emailTo}...`);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.resendKey}` },
    body: JSON.stringify({ from: "AGB-Pharma Lit Monitor <onboarding@resend.dev>", to: [CONFIG.emailTo], subject, html }),
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
      await sendEmail("Melatonin Digest — No new papers this week", "<p>No new melatonin/agonist papers found in PubMed this period.</p>");
      return;
    }
    const assessments = await triageWithClaude(articles);
    const { subject, html } = buildEmailHtml(articles, assessments);
    await sendEmail(subject, html);
    console.log(`[Monitor] Done. ${articles.length} papers processed.`);
  } catch (err) {
    console.error("[Monitor] Error:", err.message);
  }
}

app.get("/", (req, res) => res.json({ status: "AGB-Pharma Lit Monitor running", schedule: CONFIG.cronSchedule, compounds: SEARCH_TERMS }));
app.get("/run", async (req, res) => {
  console.log("[Manual] /run triggered");
  res.json({ message: "Monitor started — check your email in ~3 minutes" });
  runMonitor();
});

cron.schedule(CONFIG.cronSchedule, () => { console.log("[Cron] Scheduled run"); runMonitor(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] AGB-Pharma Lit Monitor on port ${PORT}`);
  console.log(`[Server] Schedule: ${CONFIG.cronSchedule}`);
});
