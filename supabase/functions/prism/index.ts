// ================================================================
// ClubApp · 棱镜 Prism — AI 代理 Edge Function（DeepSeek）
// 作用：把 DeepSeek 的 key 藏在服务端，前端只调本函数，不直接接触 key。
// 部署：supabase functions deploy prism  （或 Supabase dashboard 新建函数粘贴本文件）
// 环境变量（在 dashboard → Project Settings → Edge Functions → Secrets 里配）：
//   DEEPSEEK_API_KEY = sk-xxxxxxxx
// ================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GUEST_QUOTA = 2; // 游客每台设备最多 2 次 AI 提问

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

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
    const role = (user.app_metadata && user.app_metadata.role) || null;

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "请求体需为 JSON" }, 400); }
    const mode = body.mode || "chat"; // patrol | search | chat
    const deviceId = String(body.deviceId || "unknown");
    const system = typeof body.system === "string" ? body.system : "";
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // 巡逻仅正式成员（游客不可触发巡逻）
    if (mode === "patrol" && role === "guest") {
      return json({ error: "游客不可使用巡逻" }, 403);
    }

    // 游客提问配额（按设备号，服务端兜底，防止清缓存绕过）
    if (role === "guest" && mode !== "patrol") {
      const { data: q } = await supabase
        .from("ai_guest_quota").select("count").eq("device_id", deviceId).maybeSingle();
      if (q && (q.count || 0) >= GUEST_QUOTA) {
        return json({ error: "游客 AI 提问已达上限（2 次）" }, 429);
      }
    }

    if (!messages.length) return json({ error: "缺少消息" }, 400);

    const key = Deno.env.get("DEEPSEEK_API_KEY");
    if (!key) return json({ error: "AI 未配置（缺少 DEEPSEEK_API_KEY）" }, 500);

    const msgs = (system ? [{ role: "system", content: system }] : []).concat(
      messages.map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }))
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

    const answer = (dsJson.choices?.[0]?.message?.content) || "";
    const usage = dsJson.usage || {};
    const promptT = usage.prompt_tokens || 0;
    const completionT = usage.completion_tokens || 0;
    const isGuest = role === "guest";
    const operator =
      (user.user_metadata && (user.user_metadata.nickname || user.user_metadata.full_name)) ||
      user.email ||
      "unknown";
    // 实时费用：DeepSeek deepseek-chat 定价 ≈ ¥1/M 输入 + ¥2/M 输出
    const cost = promptT / 1e6 * 1 + completionT / 1e6 * 2;

    // 游客配额 +1（正式成员不计入配额）；用 RPC 原子累加，避免并发丢失
    if (role === "guest" && mode !== "patrol") {
      await supabase.rpc("increment_ai_guest_quota", { p_device: deviceId });
    }

    // 记录用量（按月累计）
    await supabase.rpc("increment_ai_usage", {
      p_month: getMonth(),
      p_prompt: promptT,
      p_completion: completionT,
    });

    // 记录调用明细（实时费用，永久保存云端）
    await supabase.rpc("log_ai_request", {
      p_month: getMonth(),
      p_mode: mode,
      p_operator: operator,
      p_is_guest: isGuest,
      p_prompt: promptT,
      p_completion: completionT,
      p_cost: cost,
    });

    return json({
      answer,
      usage: { prompt_tokens: promptT, completion_tokens: completionT },
    });
  } catch (e) {
    return json({ error: (e as Error).message || "内部错误" }, 500);
  }
});
