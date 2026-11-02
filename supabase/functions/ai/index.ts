// КБЖУ — посредник между приложением и ИИ (GigaChat или Google Gemini).
// Работает на Supabase Edge Functions (регион Франкфурт). Телефону не нужен VPN,
// ключи ИИ хранятся только в секретах Supabase.
//
// Секреты (заливаются из GitHub Actions):
//   APP_TOKEN    — пароль приложения; тот же вписывается в КБЖУ → Настройки → ИИ
//   GIGACHAT_KEY — Authorization Key из developers.sber.ru (если задан — используется GigaChat)
//   GEMINI_KEY   — ключ Gemini (используется, если GigaChat не задан)
// Необязательные: GIGACHAT_SCOPE (по умолчанию GIGACHAT_API_PERS), GIGACHAT_MODELS (через запятую)
//
// Приложение шлёт POST { op:"chat", system, text, maxTokens, json } или { op:"ping" } с заголовком x-app-token.
// Ответ: { text, model, backend } или { error:{ code, message, source, raw } }.

const APP_TOKEN = (Deno.env.get("APP_TOKEN") ?? "").trim();
const GIGA_KEY = (Deno.env.get("GIGACHAT_KEY") ?? "").trim().replace(/^Basic\s+/i, "");
const GIGA_SCOPE = (Deno.env.get("GIGACHAT_SCOPE") ?? "GIGACHAT_API_PERS").trim();
const GIGA_MODELS = (Deno.env.get("GIGACHAT_MODELS") ?? "GigaChat-2-Max,GigaChat-2-Pro,GigaChat-2")
  .split(",").map((s) => s.trim()).filter(Boolean);
const GEMINI_KEY = (Deno.env.get("GEMINI_KEY") ?? "").trim();
const REGION = Deno.env.get("SB_REGION") ?? "";
// GIGA_BASE / GEMINI_BASE / GIGA_OAUTH — только для локальной проверки
const GIGA_OAUTH = Deno.env.get("GIGA_OAUTH") ?? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const GIGA_BASE = Deno.env.get("GIGA_BASE") ?? "https://gigachat.devices.sberbank.ru/api/v1/";
const GEMINI_BASE = Deno.env.get("GEMINI_BASE") ?? "https://generativelanguage.googleapis.com/v1beta/";
// Корневой сертификат Минцифры: им подписаны серверы GigaChat
const RU_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-app-token, x-region, authorization, apikey, x-client-info",
  "Access-Control-Expose-Headers": "x-fn-region",
  "Access-Control-Max-Age": "86400",
};
function reply(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "x-fn-region": REGION },
  });
}
class ApiErr extends Error {
  constructor(message: string, public status = 500, public raw = "", public source = "proxy") { super(message); }
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- GigaChat ---------------- */
// deno-lint-ignore no-explicit-any
let gigaClient: any = null;
async function gclient() {
  if (gigaClient) return gigaClient;
  if (Deno.env.get("GIGA_NO_CA")) return undefined; // только для локальной проверки с заглушкой
  let pem = "";
  try {
    pem = await (await fetch(RU_CA_URL, { signal: AbortSignal.timeout(10000) })).text();
  } catch { /* ниже ошибка */ }
  if (!pem.includes("BEGIN CERTIFICATE")) throw new ApiErr("Не удалось загрузить сертификат Минцифры для GigaChat", 502, "", "giga");
  // deno-lint-ignore no-explicit-any
  gigaClient = (Deno as any).createHttpClient({ caCerts: [pem] });
  return gigaClient;
}
let gTok = { v: "", exp: 0 };
async function gigaToken(force = false): Promise<string> {
  if (!force && gTok.v && Date.now() < gTok.exp - 60_000) return gTok.v;
  const r = await fetch(GIGA_OAUTH, {
    method: "POST",
    client: await gclient(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
      "RqUID": crypto.randomUUID(),
      "Authorization": "Basic " + GIGA_KEY,
    },
    body: "scope=" + encodeURIComponent(GIGA_SCOPE),
    signal: AbortSignal.timeout(20000),
    // deno-lint-ignore no-explicit-any
  } as any);
  const t = await r.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(t); } catch { /* */ }
  if (!r.ok || !j.access_token) {
    const msg = r.status === 400 || r.status === 401
      ? "GigaChat не принял ключ авторизации — проверь секрет GIGACHAT_KEY (Authorization Key целиком)"
      : "GigaChat: не удалось получить доступ (" + r.status + ")";
    throw new ApiErr(msg, r.status, t.slice(0, 300), "giga");
  }
  gTok = { v: String(j.access_token), exp: Number(j.expires_at) || Date.now() + 25 * 60_000 };
  return gTok.v;
}
async function gigaChat(system: string, text: string, maxTokens: number) {
  let last: ApiErr | null = null;
  for (const model of GIGA_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await gigaToken(attempt > 0 && last?.status === 401);
      const r = await fetch(GIGA_BASE + "chat/completions", {
        method: "POST",
        client: await gclient(),
        headers: { "content-type": "application/json", "accept": "application/json", "Authorization": "Bearer " + tok },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: text }],
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(60000),
        // deno-lint-ignore no-explicit-any
      } as any);
      const raw = await r.text();
      // deno-lint-ignore no-explicit-any
      let j: any = {};
      try { j = JSON.parse(raw); } catch { /* */ }
      if (r.ok) {
        const out = j?.choices?.[0]?.message?.content ?? "";
        if (out) return { text: String(out), model: String(j.model || model) };
        last = new ApiErr("Пустой ответ GigaChat", 502, raw.slice(0, 300), "giga");
        break;
      }
      last = new ApiErr("GigaChat: ошибка " + r.status, r.status, raw.slice(0, 300), "giga");
      if (r.status === 401 && attempt === 0) continue; // токен протух — обновим
      if (r.status >= 500 && attempt === 0) { await sleep(1500); continue; }
      if ([402, 403, 404, 429].includes(r.status) || r.status >= 500) break; // следующая модель
      throw last;
    }
  }
  if (last?.status === 402) last.message = "Закончились бесплатные токены GigaChat на всех моделях";
  if (last?.status === 429) last.message = "Слишком много запросов к GigaChat — подожди минуту";
  throw last ?? new ApiErr("GigaChat не ответил", 502, "", "giga");
}

/* ---------------- Gemini (запасной вариант) ---------------- */
let gemModels: string[] = [];
async function gem(path: string, body?: unknown) {
  const r = await fetch(GEMINI_BASE + path, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body) }
    : { headers: { "x-goog-api-key": GEMINI_KEY } });
  const raw = await r.text();
  // deno-lint-ignore no-explicit-any
  let j: any = {};
  try { j = JSON.parse(raw); } catch { /* */ }
  if (!r.ok) {
    const m = j?.error?.message ?? "";
    const msg = r.status === 401 || /api key/i.test(m) ? "Google не принял ключ Gemini (секрет GEMINI_KEY)"
      : r.status === 429 ? "Лимит Gemini исчерпан" : "Gemini: ошибка " + r.status;
    throw new ApiErr(msg, r.status, (m || raw).slice(0, 300), "gemini");
  }
  return j;
}
async function geminiChat(system: string, text: string, image: string, maxTokens: number, json: boolean) {
  if (!gemModels.length) {
    const j = await gem("models?pageSize=200");
    const score = (n: string) => {
      const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash(.*)$/);
      if (!m || /image|tts|audio|live|embed|thinking|computer|robotics/.test(m[2])) return -1;
      let s = parseFloat(m[1]) * 100;
      if (/lite/.test(m[2])) s -= 50;
      if (/preview|exp/.test(m[2])) s -= 40;
      return s;
    };
    // deno-lint-ignore no-explicit-any
    gemModels = (j.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      // deno-lint-ignore no-explicit-any
      .map((m: any) => String(m.name).replace(/^models\//, "")).filter((n: string) => score(n) >= 0)
      .sort((a: string, b: string) => score(b) - score(a)).slice(0, 4);
    if (!gemModels.length) throw new ApiErr("Нет подходящей модели Gemini", 502, "", "gemini");
  }
  // deno-lint-ignore no-explicit-any
  const parts: any[] = [];
  if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
  parts.push({ text });
  // deno-lint-ignore no-explicit-any
  const cfg: any = { temperature: 0.2, maxOutputTokens: Math.max(maxTokens, 2048) };
  if (json) cfg.responseMimeType = "application/json";
  let last: ApiErr | null = null;
  for (const model of gemModels) {
    try {
      const j = await gem(`models/${model}:generateContent`, {
        system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig: cfg,
      });
      // deno-lint-ignore no-explicit-any
      const out = (j?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
      if (out) return { text: out, model };
      last = new ApiErr("Пустой ответ Gemini", 502, "", "gemini");
    } catch (e) {
      last = e as ApiErr;
      if (![429, 404, 500, 503].includes(last.status)) throw last;
    }
  }
  throw last!;
}

/* ---------------- обработчик ---------------- */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: { code: 405, message: "Только POST", source: "proxy" } }, 405);
  try {
    if (!APP_TOKEN) throw new ApiErr("На сервере не задан секрет APP_TOKEN", 500);
    if (!same(req.headers.get("x-app-token") ?? "", APP_TOKEN)) throw new ApiErr("Неверный токен приложения", 401);
    if (Number(req.headers.get("content-length") ?? "0") > 4_000_000) throw new ApiErr("Слишком большой запрос", 413);

    // deno-lint-ignore no-explicit-any
    let b: any;
    try { b = await req.json(); } catch { throw new ApiErr("Неверный формат запроса", 400); }
    const op = String(b.op ?? "");
    const backend = GIGA_KEY ? "gigachat" : GEMINI_KEY ? "gemini" : "";
    if (!backend) throw new ApiErr("На сервере не задан ни GIGACHAT_KEY, ни GEMINI_KEY", 500);

    let system = "", text = "", image = "", maxTokens = 1500, json = false;
    if (op === "ping") {
      system = "Отвечай одним словом.";
      text = "Скажи: работает";
      maxTokens = 20;
    } else if (op === "chat") {
      system = String(b.system ?? "").slice(0, 20000);
      text = String(b.text ?? "").slice(0, 4000);
      image = typeof b.image === "string" ? b.image : "";
      maxTokens = Math.min(Math.max(Number(b.maxTokens) || 1500, 50), 4000);
      json = !!b.json;
      if (!text.trim() && !image) throw new ApiErr("Пустой запрос", 400);
    } else {
      throw new ApiErr("Неизвестная операция", 400);
    }

    if (backend === "gigachat") {
      if (image && !text.trim()) throw new ApiErr("GigaChat через этот сервер принимает только текст — опиши еду словами", 400);
      const r = await gigaChat(system, text, maxTokens);
      return reply({ ...r, backend, photoIgnored: !!image });
    }
    const r = await geminiChat(system, text, image, maxTokens, json);
    return reply({ ...r, backend });
  } catch (e) {
    const err = e instanceof ApiErr ? e : new ApiErr(e instanceof Error ? e.message : String(e), 500);
    console.error("[kbju-ai]", err.source, err.status, err.message, err.raw);
    return reply({ error: { code: err.status, message: err.message, source: err.source, raw: err.raw } }, err.status >= 400 && err.status < 600 ? err.status : 500);
  }
});
