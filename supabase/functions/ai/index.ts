// КБЖУ — посредник между приложением и Google Gemini.
// Работает на Supabase Edge Functions (регион Франкфурт), поэтому Google видит европейский адрес
// и телефону не нужен VPN. Ключ Gemini хранится только в секретах Supabase.
//
// Секреты (Supabase → Edge Functions → Secrets, либо автоматически из GitHub Actions):
//   GEMINI_KEY — ключ из aistudio.google.com
//   APP_TOKEN  — пароль приложения; тот же вписывается в КБЖУ → Настройки → ИИ
//
// Приложение шлёт POST { path, body } с заголовком x-app-token.
// Разрешены только два пути Gemini API: список моделей и generateContent.

const GEMINI_KEY = Deno.env.get("GEMINI_KEY") ?? "";
const APP_TOKEN = Deno.env.get("APP_TOKEN") ?? "";
const REGION = Deno.env.get("SB_REGION") ?? "";
const GOOGLE = Deno.env.get("GEMINI_BASE") ?? "https://generativelanguage.googleapis.com/v1beta/"; // GEMINI_BASE — только для локальной проверки

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
function fail(status: number, message: string): Response {
  return reply({ error: { code: status, message, source: "proxy" } }, status);
}

// сравнение токена без утечки по времени
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const LIST_RE = /^models(\?pageSize=\d{1,3}(&pageToken=[\w\-.~%]+)?)?$/;
const GEN_RE = /^models\/[\w.\-]+:generateContent$/;
const MAX_BODY = 4_000_000; // ~4 МБ: фото уже сжато приложением до ~200 КБ

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Только POST");

  // ВРЕМЕННО: диагностика доступности GigaChat из региона функции (без секретов, ничего не тратит)
  if (new URL(req.url).searchParams.get("diag") === "giga") {
    const probe = async (url: string, init: RequestInit = {}) => {
      const t = Date.now();
      try {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
        return { url, status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 160) };
      } catch (e) {
        return { url, ms: Date.now() - t, error: e instanceof Error ? e.name + ": " + e.message : String(e) };
      }
    };
    const out: Record<string, unknown> = { region: REGION, createHttpClient: typeof (Deno as any).createHttpClient };
    out.oauth = await probe("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "RqUID": crypto.randomUUID(), "Authorization": "Basic ZHVtbXk6ZHVtbXk=" },
      body: "scope=GIGACHAT_API_PERS",
    });
    out.api = await probe("https://gigachat.devices.sberbank.ru/api/v1/models");
    out.cert = await probe("https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt");
    return reply(out);
  }

  if (!GEMINI_KEY || !APP_TOKEN) return fail(500, "На сервере не заданы секреты GEMINI_KEY и APP_TOKEN");
  if (!same(req.headers.get("x-app-token") ?? "", APP_TOKEN)) return fail(401, "Неверный токен приложения");

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return fail(413, "Слишком большой запрос (фото?)");

  let path = "", body: unknown = null;
  try {
    const j = await req.json();
    path = String(j.path ?? "");
    body = j.body ?? null;
  } catch {
    return fail(400, "Неверный формат запроса");
  }

  let upstream: Response;
  try {
    if (LIST_RE.test(path) && body === null) {
      upstream = await fetch(GOOGLE + path, { headers: { "x-goog-api-key": GEMINI_KEY } });
    } else if (GEN_RE.test(path) && body && typeof body === "object") {
      upstream = await fetch(GOOGLE + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify(body),
      });
    } else {
      return fail(400, "Этот запрос посредник не пропускает");
    }
  } catch (e) {
    return fail(502, "Посредник не смог связаться с Google: " + (e instanceof Error ? e.message : String(e)));
  }

  // ответ Google отдаём как есть (вместе с кодом ошибки), чтобы приложение само решало: повтор, другая модель и т.д.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "x-fn-region": REGION },
  });
});
