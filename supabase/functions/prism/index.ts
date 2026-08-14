// ================================================================
// ClubApp · 棱镜 Prism — AI 代理 Edge Function（DeepSeek）
// 作用：把 DeepSeek 的 key 藏在服务端，前端只调本函数，不直接接触 key。
// 部署：supabase functions deploy prism  （或 Supabase dashboard 新建函数粘贴本文件）
// 环境变量（在 dashboard → Project Settings → Edge Functions → Secrets 里配）：
//   DEEPSEEK_API_KEY = sk-xxxxxxxx
// ================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GUEST_QUOTA = 2; // 游客最多 2 次 AI 提问（按游客账号计，user.id 不可伪造）
const MONTH_CAP = parseInt(Deno.env.get("AI_MONTH_CAP") || "5000", 10); // 全站月度请求上限，防成本失控

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function getMonth() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`; // YYYY-MM
}

// ---- 日志升级 v2.5.0：读取客户端真实 IP + 归属地（前端登录后调用一次）----
function getClientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || null;
}

const _geoCache = new Map<string, string | null>();

async function geoLookup(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  if (_geoCache.has(ip)) return _geoCache.get(ip) ?? null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // ipapi.co 免费 HTTPS、免注册，返回 city/region_name/country_name（城市级）
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { _geoCache.set(ip, null); return null; }
    const d = await r.json();
    if (d && !d.error) {
      const parts = [d.country_name, d.region_name, d.city].filter(Boolean);
      const geo = parts.length ? parts.join("·") : null;
      _geoCache.set(ip, geo);
      return geo;
    }
    _geoCache.set(ip, null);
    return null;
  } catch {
    _geoCache.set(ip, null);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // 新增路由：GET /ip → { ip, geo }（轻量，仅需有效登录令牌）
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ip")) {
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
      );
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ error: "未登录" }, 401);
      const { data: userData, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !userData || !userData.user) return json({ error: "令牌无效或已过期" }, 401);
      const ip = getClientIp(req);
      const geo = await geoLookup(ip);
      return json({ ip, geo });
    } catch {
      return json({ ip: null, geo: null });
    }
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "未登录" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    // 校验 JWT（真实签名校验，防止伪造令牌刷 DeepSeek key）
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData || !userData.user) {
      return json({ error: "令牌无效或已过期" }, 401);
    }
    const user = userData.user;
    // 角色判定 fail-closed：只有 app_members 里存在该用户才视为正式成员；
    // 否则一律按游客限制（避免 app_metadata.role 漏配时 fail-open 导致越权/无限 AI）。
    const { data: _memberRow } = await supabase
      .from("app_members").select("is_admin").eq("user_id", user.id).maybeSingle();
    const isMember = !!_memberRow;
    const isGuest = !isMember;

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "请求体需为 JSON" }, 400); }
    const mode = body.mode || "chat"; // patrol | search | chat
    const system = typeof body.system === "string" ? body.system : "";
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];

    // 巡逻仅正式成员（游客不可触发巡逻）
    if (mode === "patrol" && isGuest) {
      return json({ error: "游客不可使用巡逻" }, 403);
    }

    // 全站月度请求上限（防止成本失控）
    const { data: _usageRow } = await supabase
      .from("ai_usage").select("requests").eq("id", getMonth()).maybeSingle();
    if (_usageRow && (_usageRow.requests || 0) >= MONTH_CAP) {
      return json({ error: "本月 AI 用量已达上限，请下月再试" }, 429);
    }

    // 游客提问配额：按 user.id（不可伪造）原子「判断+累加」，服务端兜底
    if (isGuest && mode !== "patrol") {
      const { data: _allowed, error: _qErr } = await supabase.rpc(
        "try_increment_ai_guest_quota", { p_device: user.id, p_limit: GUEST_QUOTA }
      );
      if (_qErr || !_allowed) {
        return json({ error: "游客 AI 提问已达上限（2 次）" }, 429);
      }
    }

    if (!messages.length) return json({ error: "缺少消息" }, 400);

    const key = Deno.env.get("DEEPSEEK_API_KEY");
    if (!key) return json({ error: "AI 未配置（缺少 DEEPSEEK_API_KEY）" }, 500);

    const msgs = (system ? [{ role: "system", content: system }] : []).concat(
      messages.map((m: any) => {
        const role = (m.role === "assistant" || m.role === "tool") ? m.role : "user";
        const out: any = { role, content: String(m.content || "") };
        if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
        if (role === "tool" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      })
    );

    let dsResp;
    try {
      dsResp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: msgs,
          temperature: 0.3,
          max_tokens: 1200,
          ...(tools.length ? { tools } : {}),
        }),
      });
    } catch (e) {
      return json({ error: "调用 DeepSeek 失败：" + (e as Error).message }, 502);
    }

    const dsJson = await dsResp.json().catch(() => null);
    if (!dsResp.ok) {
      const em = (dsJson && (dsJson.error?.message || dsJson.error?.type)) || ("DeepSeek " + dsResp.status);
      return json({ error: em }, 502);
    }

    const dsMsg = dsJson.choices?.[0]?.message || {};
    const answer = dsMsg.content || "";
    const tool_calls = Array.isArray(dsMsg.tool_calls) && dsMsg.tool_calls.length ? dsMsg.tool_calls : null;
    const usage = dsJson.usage || {};
    const promptT = usage.prompt_tokens || 0;
    const completionT = usage.completion_tokens || 0;
    const operator =
      (user.user_metadata && (user.user_metadata.nickname || user.user_metadata.full_name)) ||
      user.email ||
      "unknown";
    // 实时费用：DeepSeek deepseek-chat 定价 ≈ ¥1/M 输入 + ¥2/M 输出
    const cost = promptT / 1e6 * 1 + completionT / 1e6 * 2;

    // 记录用量（按月累计）；失败仅告警，不阻断回复
    const _u = await supabase.rpc("increment_ai_usage", {
      p_month: getMonth(),
      p_prompt: promptT,
      p_completion: completionT,
    });
    if (_u.error) console.error("[prism] increment_ai_usage failed:", _u.error.message);

    // 记录调用明细（实时费用，永久保存云端）
    const _l = await supabase.rpc("log_ai_request", {
      p_month: getMonth(),
      p_mode: mode,
      p_operator: operator,
      p_is_guest: isGuest,
      p_prompt: promptT,
      p_completion: completionT,
      p_cost: cost,
    });
    if (_l.error) console.error("[prism] log_ai_request failed:", _l.error.message);

    return json({
      answer,
      tool_calls,
      usage: { prompt_tokens: promptT, completion_tokens: completionT },
    });
  } catch (e) {
    return json({ error: (e as Error).message || "内部错误" }, 500);
  }
});
