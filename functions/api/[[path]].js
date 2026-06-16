const KEYS = {
  caseIndex: "cases:index",
  projects: "projects:data",
  regulations: "regulations:index",
  graph: "causal_graph:data"
};

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  try {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/api/bootstrap" && request.method === "GET") return json(await bootstrap(context, url.searchParams));
    if (url.pathname === "/api/projects" && request.method === "POST") return json(await createProject(context, await readJson(request)));
    if (url.pathname === "/api/cases" && request.method === "POST") return json(await createCase(context, await readJson(request)));
    if (url.pathname.startsWith("/api/cases/") && request.method === "PUT") {
      return json(await updateCase(context, decodeURIComponent(url.pathname.split("/").pop()), await readJson(request)));
    }
    if (url.pathname.startsWith("/api/cases/") && request.method === "DELETE") {
      return json(await deleteCase(context, decodeURIComponent(url.pathname.split("/").pop())));
    }
    if (url.pathname === "/api/regulations" && request.method === "GET") return json(await listRegulations(context, url.searchParams));
    if (url.pathname === "/api/regulations" && request.method === "POST") return json(await uploadRegulation(context, await readJson(request)));
    if (url.pathname === "/api/export" && request.method === "GET") return exportCases(context, url.searchParams);
    if (url.pathname === "/api/causal-graph/rebuild" && request.method === "POST") return json(await rebuildGraph(context));

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Server error" }, 500);
  }
}

async function bootstrap(context, params) {
  const page = Math.max(1, Number(params.get("page") || 1));
  const pageSize = [10, 20, 50].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 10;
  const all = await allCases(context);
  const filtered = filterCases(all, {
    project: params.get("project") || "",
    q: params.get("q") || "",
    date: params.get("date") || "",
    risk: params.get("risk") || ""
  });
  const start = (page - 1) * pageSize;

  return {
    projects: (await getProjects(context)).projects || [],
    pagination: {
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize))
    },
    cases: filtered.slice(start, start + pageSize).map(caseToApp),
    stats: buildStats(filtered),
    regulations: (await listRegulations(context, params)).documents,
    graph: await getGraph(context)
  };
}

async function createProject(context, input) {
  requireWritable(context);
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Project name is required.");
  const data = await getProjects(context);
  const project = {
    id: name,
    name,
    engineeringName: input.engineeringName || name,
    type: input.type || "",
    contractor: input.contractor || "",
    createdDate: today(),
    description: input.description || ""
  };
  data.projects = [...(data.projects || []), project];
  await putJson(context.env.MS_DATA, KEYS.projects, data);
  return { project };
}

async function createCase(context, payload) {
  requireWritable(context);
  const index = await getCaseIndex(context);
  const id = nextCaseId(index);
  const ext = imageExt(payload.imageName || "", payload.imageType || "");
  const imagePath = payload.imageBase64 ? `storage/images/${id}${ext}` : "";
  if (payload.imageBase64) await putMedia(context, imagePath, payload.imageBase64, payload.imageType || contentTypeFromName(imagePath));

  const record = appToStorageCase(payload.case || {}, id, imagePath);
  await putJson(context.env.MS_DATA, `cases:${id}`, record);
  await writeCaseIndex(context, { ...index, cases: unique([...(index.cases || []), id]) });
  const graph = await updateGraph(context);
  return { case: caseToApp(record), index: await getCaseIndex(context), graph };
}

async function updateCase(context, id, input) {
  requireWritable(context);
  const existing = await getCase(context, id);
  if (!existing) throw new Error("Case not found.");
  const updated = appToStorageCase(input, id, existing.image_path || "");
  updated.created_at = existing.created_at || today();
  await putJson(context.env.MS_DATA, `cases:${id}`, updated);
  const graph = await updateGraph(context);
  return { case: caseToApp(updated), graph };
}

async function deleteCase(context, id) {
  requireWritable(context);
  const existing = await getCase(context, id);
  if (existing?.image_path && context.env.MS_MEDIA) await context.env.MS_MEDIA.delete(stripStorage(existing.image_path));
  await context.env.MS_DATA.delete(`cases:${id}`);
  const index = await getCaseIndex(context);
  await writeCaseIndex(context, { ...index, cases: (index.cases || []).filter(item => item !== id) });
  const graph = await updateGraph(context);
  return { ok: true, index: await getCaseIndex(context), graph };
}

async function uploadRegulation(context, payload) {
  requireWritable(context);
  if (!payload.fileBase64) throw new Error("No regulation file uploaded.");
  const safeName = safeFileName(payload.fileName || `regulation_${Date.now()}.txt`);
  const path = `storage/regulations/${safeName}`;
  await putMedia(context, path, payload.fileBase64, payload.fileType || contentTypeFromName(safeName));
  const meta = await getRegulations(context);
  const document = {
    id: crypto.randomUUID(),
    name: safeName,
    category: String(payload.category || "").trim(),
    project: String(payload.project || "").trim(),
    path,
    created_at: today()
  };
  meta.documents = [...(meta.documents || []), document];
  await putJson(context.env.MS_DATA, KEYS.regulations, meta);
  return { document };
}

async function listRegulations(context, params) {
  const meta = await getRegulations(context);
  const project = params.get("project") || "";
  return { documents: (meta.documents || []).filter(doc => !project || doc.project === project) };
}

async function exportCases(context, params) {
  const format = params.get("format") || "json";
  const filtered = filterCases(await allCases(context), {
    project: params.get("project") || "",
    q: params.get("q") || "",
    date: params.get("date") || "",
    risk: params.get("risk") || ""
  });
  const filename = `cases_export_${Date.now()}.${format === "excel" ? "xls" : format}`;
  if (format === "csv" || format === "excel") {
    return new Response("\ufeff" + toCsv(filtered), {
      headers: {
        "Content-Type": format === "excel" ? "application/vnd.ms-excel; charset=utf-8" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });
  }
  return new Response(JSON.stringify(filtered, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
}

async function rebuildGraph(context) {
  requireWritable(context);
  return { graph: await updateGraph(context), rebuilt: true };
}

async function updateGraph(context) {
  const graph = buildCausalGraph(await allCases(context));
  await putJson(context.env.MS_DATA, KEYS.graph, graph);
  return graph;
}

async function allCases(context) {
  const index = await getCaseIndex(context);
  const rows = await Promise.all((index.cases || []).map(id => getCase(context, id)));
  return rows.filter(Boolean);
}

async function getCaseIndex(context) {
  const data = await getJson(context, KEYS.caseIndex, "/storage/cases/index.json", { total_cases: 0, last_updated: today(), cases: [] });
  return { ...data, cases: data.cases || [] };
}

async function writeCaseIndex(context, index) {
  index.cases = unique(index.cases || []);
  index.total_cases = index.cases.length;
  index.last_updated = today();
  await putJson(context.env.MS_DATA, KEYS.caseIndex, index);
}

async function getCase(context, id) {
  return getJson(context, `cases:${id}`, `/storage/cases/${id}.json`, null);
}

async function getProjects(context) {
  const data = await getJson(context, KEYS.projects, "/storage/projects/projects.json", { projects: [] });
  return { projects: data.projects || [] };
}

async function getRegulations(context) {
  const data = await getJson(context, KEYS.regulations, "/storage/regulations/index.json", { documents: [] });
  return { documents: data.documents || [] };
}

async function getGraph(context) {
  return getJson(context, KEYS.graph, "/storage/causal_graph/graph_data.json", { nodes: [], edges: [], updated_at: today() });
}

async function getJson(context, key, assetPath, fallback) {
  if (context.env.MS_DATA) {
    const stored = await context.env.MS_DATA.get(key, "json");
    if (stored) return stored;
  }
  if (assetPath && context.env.ASSETS) {
    const assetUrl = new URL(assetPath, context.request.url);
    const response = await context.env.ASSETS.fetch(new Request(assetUrl));
    if (response.ok) return response.json();
  }
  return fallback;
}

async function putJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function putMedia(context, path, base64, contentType) {
  if (context.env.MS_MEDIA) {
    const bytes = base64ToArrayBuffer(base64);
    await context.env.MS_MEDIA.put(stripStorage(path), bytes, {
      httpMetadata: { contentType: contentType || "application/octet-stream" }
    });
    return;
  }
  if (!context.env.MS_DATA) throw new Error("Cloudflare KV binding MS_DATA is not configured.");
  await putJson(context.env.MS_DATA, `media:${stripStorage(path)}`, {
    body: String(base64).replace(/^data:[^,]+,/, ""),
    contentType: contentType || "application/octet-stream",
    updatedAt: new Date().toISOString()
  });
}

function appToStorageCase(app, id, imagePath) {
  const fixed = app.fixedSummary || app.fixed_summary || {};
  const factors = normalizeStoredRiskFactors(app.factors || []);
  const likelihood = clampScore(app.likelihood || app.risk_assessment?.likelihood || 3);
  const severity = clampScore(app.severity || app.risk_assessment?.severity || 3);
  return {
    id,
    project: app.project || app.projectName || "",
    title: app.title || app.fileName || id,
    description: app.description || app.aiSummary || "",
    strategy: app.strategy || app.prompt_strategy || app.promptStrategy || "",
    image_path: imagePath,
    created_at: app.created_at || today(),
    analysis: {
      hazard_summary: fixed.hazardIdentification || app.aiSummary || "",
      potential_accident: fixed.potentialAccidentScenario?.possibleAccident || "",
      injury_prediction: fixed.potentialInjuries?.injuries?.join(" / ") || "",
      legal_penalty: fixed.possiblePenalties?.occupationalAccident || "",
      improvement_suggestion: fixed.improvementSuggestions?.immediate?.join(" / ") || app.suggestions?.engineering?.join(" / ") || ""
    },
    risk_factors: factors,
    risk_assessment: {
      likelihood,
      severity,
      score: Number(app.score || likelihood * severity),
      risk_level: app.level || app.risk_level || ""
    },
    causal_path: app.chain || app.causal_path || [],
    suggestions: app.suggestions || {},
    fixed_summary: app.fixedSummary || app.fixed_summary || null,
    analysis_duration: Number(app.analysisDuration || app.analysis_duration || 0),
    analysis_metrics: app.analysisMetrics || app.analysis_metrics || null,
    likelihood_reason: app.likelihoodReason || app.likelihood_reason || "",
    severity_reason: app.severityReason || app.severity_reason || "",
    case_reference: app.caseReference || app.case_reference || "",
    regulation_basis: app.regulationBasis || app.regulation_basis || "",
    legal_reference: (app.citations || app.legal_reference || []).map(item => ({
      regulation: item.lawName || item.regulation || "",
      article: item.article || "",
      content: item.quote || item.content || ""
    }))
  };
}

function caseToApp(item) {
  const factors = (item.risk_factors || []).map(factor => ({
    name: factor.name,
    causalLevel: factor.causal_level,
    riskCategory: factor.category,
    description: factor.description
  }));
  const grouped = groupFactorNames(factors);
  return {
    id: item.id,
    project: item.project,
    title: item.title,
    description: item.description,
    fileName: basename(item.image_path || item.title || ""),
    image_path: item.image_path,
    uploadTime: item.created_at,
    strategy: item.strategy || item.prompt_strategy || "",
    direct: grouped[0] || [],
    indirect: grouped[1] || [],
    potential: grouped[2] || [],
    factors,
    likelihood: item.risk_assessment?.likelihood || 3,
    severity: item.risk_assessment?.severity || 3,
    score: item.risk_assessment?.score || 9,
    level: item.risk_assessment?.risk_level || "",
    chain: item.causal_path || [],
    citations: (item.legal_reference || []).map(ref => ({
      lawName: ref.regulation,
      article: ref.article,
      quote: ref.content,
      confidence: 0
    })),
    aiSummary: item.analysis?.hazard_summary || "",
    fixedSummary: item.fixed_summary || null,
    analysisDuration: item.analysis_duration || 0,
    analysisMetrics: item.analysis_metrics || null,
    suggestions: normalizeSuggestions(item.suggestions, item.analysis?.improvement_suggestion),
    likelihoodReason: item.likelihood_reason || "",
    severityReason: item.severity_reason || "",
    caseReference: item.case_reference || item.description || "",
    regulationBasis: item.regulation_basis || (item.legal_reference || []).map(ref => `${ref.regulation}${ref.article}`).join(" / ")
  };
}

function normalizeStoredRiskFactors(factors) {
  return factors.map(factor => {
    const source = typeof factor === "string" ? { name: factor } : factor;
    return {
      name: String(source.name || "").trim(),
      causal_level: source.causalLevel || source.causal_level || "",
      category: source.riskCategory || source.category || "",
      description: source.description || ""
    };
  }).filter(factor => factor.name);
}

function groupFactorNames(factors) {
  const levels = [];
  for (const factor of factors) {
    if (!levels.includes(factor.causalLevel)) levels.push(factor.causalLevel);
  }
  return levels.map(level => factors.filter(factor => factor.causalLevel === level).map(factor => factor.name));
}

function normalizeSuggestions(value, fallback = "") {
  if (value && typeof value === "object") {
    return {
      engineering: normalizeList(value.engineering),
      management: normalizeList(value.management),
      training: normalizeList(value.training),
      ppe: normalizeList(value.ppe)
    };
  }
  return { engineering: normalizeList(fallback), management: [], training: [], ppe: [] };
}

function buildStats(items) {
  const factors = items.flatMap(item => item.risk_factors || []);
  const riskFactorStats = summarizeRiskFactorStats(factors);
  const levelCounts = new Map();
  for (const factor of factors) levelCounts.set(factor.causal_level, (levelCounts.get(factor.causal_level) || 0) + 1);
  const counts = [...levelCounts.values()];
  return {
    total: items.length,
    factorTotal: factors.length,
    uniqueFactors: riskFactorStats.length,
    direct: counts[0] || 0,
    indirect: counts[1] || 0,
    potential: counts[2] || 0,
    highRiskFactors: items.filter(item => (item.risk_assessment?.score || 0) >= 15).reduce((sum, item) => sum + (item.risk_factors?.length || 0), 0),
    avgScore: items.length ? items.reduce((sum, item) => sum + (item.risk_assessment?.score || 0), 0) / items.length : 0,
    latestDate: items.map(item => item.created_at).sort().at(-1) || "-",
    topFactor: riskFactorStats[0] || null,
    riskFactorStats
  };
}

function summarizeRiskFactorStats(factors) {
  const map = new Map();
  for (const factor of factors) {
    const name = String(factor.name || "").trim();
    if (!name) continue;
    const item = map.get(name) || { name, count: 0, category: factor.category || "", causalLevels: [] };
    item.count += 1;
    if (factor.causal_level && !item.causalLevels.includes(factor.causal_level)) item.causalLevels.push(factor.causal_level);
    if (!item.category && factor.category) item.category = factor.category;
    map.set(name, item);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildCausalGraph(items) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  for (const item of items) {
    const path = normalizeList(item.causal_path);
    for (const [index, name] of path.entries()) {
      const node = nodeMap.get(name) || { id: name, label: name, count: 0, caseIds: [] };
      node.count += 1;
      if (!node.caseIds.includes(item.id)) node.caseIds.push(item.id);
      nodeMap.set(name, node);
      if (index > 0) {
        const source = path[index - 1];
        const key = `${source}->${name}`;
        const edge = edgeMap.get(key) || { source, target: name, weight: 0, caseIds: [] };
        edge.weight += 1;
        if (!edge.caseIds.includes(item.id)) edge.caseIds.push(item.id);
        edgeMap.set(key, edge);
      }
    }
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], updated_at: today(), total_cases: items.length };
}

function filterCases(items, { project, q, date, risk }) {
  const keyword = String(q || "").toLowerCase();
  return items.filter(item => {
    const text = JSON.stringify(item).toLowerCase();
    return (!project || item.project === project)
      && (!date || item.created_at === date)
      && (!risk || item.risk_assessment?.risk_level === risk)
      && (!keyword || text.includes(keyword));
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
}

function toCsv(items) {
  const rows = [["id", "project", "title", "created_at", "risk_level", "score", "analysis", "risk_factors", "legal_reference"]];
  for (const item of items) {
    rows.push([
      item.id,
      item.project,
      item.title,
      item.created_at,
      item.risk_assessment?.risk_level || "",
      item.risk_assessment?.score || "",
      Object.values(item.analysis || {}).join(" / "),
      (item.risk_factors || []).map(f => `${f.name}(${f.causal_level}/${f.category})`).join("; "),
      (item.legal_reference || []).map(r => `${r.regulation}${r.article}:${r.content}`).join("; ")
    ]);
  }
  return rows.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

async function readJson(request) {
  return request.json().catch(() => ({}));
}

function json(body, status = 200) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  }));
}

function cors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

function requireWritable(context) {
  if (!context.env.MS_DATA) throw new Error("Cloudflare KV binding MS_DATA is not configured.");
}

function nextCaseId(index) {
  const max = (index.cases || []).reduce((value, id) => Math.max(value, Number(String(id).replace("case_", "")) || 0), 0);
  return `case_${String(max + 1).padStart(4, "0")}`;
}

function imageExt(name, type) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".png") || type === "image/png") return ".png";
  if (lower.endsWith(".webp") || type === "image/webp") return ".webp";
  if (lower.endsWith(".gif") || type === "image/gif") return ".gif";
  return ".jpg";
}

function contentTypeFromName(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function base64ToArrayBuffer(base64) {
  const binary = atob(String(base64).replace(/^data:[^,]+,/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 120);
}

function stripStorage(path) {
  return String(path).replace(/^\/?storage\//, "");
}

function basename(path) {
  return String(path).split("/").pop() || "";
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(/[;,\n/]+/).map(item => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clampScore(value) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return 3;
  return Math.min(5, Math.max(1, number));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
