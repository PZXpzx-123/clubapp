// 部署热更新到 Supabase Storage（顺序 APAA.html → sw.js → version.json 最后）+ 广播「检测到新版本」通知
// 用法：SROLE=<service_role_key> node _deploy.js
const fs = require("fs");
const crypto = require("crypto");
const SROLE = process.env.SROLE;
if (!SROLE) { console.error("缺少 SROLE 环境变量"); process.exit(1); }
const URL = "https://qstrmmaihqyguttnkyvt.supabase.co";
const BUCKET = "app";

// 1. 从 APAA.html 解析版本号
function parseVersion() {
  const html = fs.readFileSync("APAA.html", "utf8");
  const m = html.match(/const\s+APP_VERSION\s*=\s*['"]([\d.]+)['"]/);
  if (!m) { console.error("无法从 APAA.html 解析 APP_VERSION"); process.exit(1); }
  return m[1];
}

// 2. 计算 APAA.html 的 sha256（客户端往返算法：bytes → utf8 字符串(去BOM) → utf8 字节 → SHA-256）
function computeSha256() {
  let buf = fs.readFileSync("APAA.html");
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3); // 去 BOM
  const str = buf.toString("utf8");
  return crypto.createHash("sha256").update(Buffer.from(str, "utf8")).digest("hex");
}

// 3. 生成/更新 version.json
function writeVersionJson(v, sha) {
  const content = JSON.stringify({ v: v, sha256: sha });
  fs.writeFileSync("version.json", content);
  return content;
}

async function upload(name, type, content) {
  const data = content !== undefined ? Buffer.from(content, "utf8") : fs.readFileSync(name);
  const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${name}`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + SROLE,
      "apikey": SROLE,
      "x-upsert": "true",
      "Content-Type": type,
    },
    body: data,
  });
  const txt = await r.text().catch(() => "");
  return { name, status: r.status, body: txt.slice(0, 200) };
}

// 4. 广播「检测到新版本 vX」通知到 app_logs（发布的一瞬间广播，成员信息面板自动出现）
async function broadcastVersion(v) {
  const r = await fetch(`${URL}/rest/v1/app_logs`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + SROLE,
      "apikey": SROLE,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      category: "version",
      level: "info",
      operator: "系统",
      action: "version",
      message: "检测到新版本 v" + v,
      detail: { table: "system", version: v },
    }),
  });
  const txt = await r.text().catch(() => "");
  return { status: r.status, body: txt.slice(0, 200) };
}

(async () => {
  const v = parseVersion();
  const sha = computeSha256();
  const versionContent = writeVersionJson(v, sha);
  console.log("版本:", v, "· sha256:", sha);

  const FILES = [
    { name: "APAA.html", type: "text/html; charset=utf-8" },
    { name: "sw.js",     type: "application/javascript; charset=utf-8" },
  ];
  for (const f of FILES) {
    const res = await upload(f.name, f.type);
    console.log("upload", res.name, "->", res.status, res.body ? "| " + res.body : "");
    if (res.status !== 200) { console.error("上传失败，中止（不继续后续文件）"); process.exit(1); }
  }
  // version.json 最后上传（内容已更新为最新 sha256）
  const vRes = await upload("version.json", "application/json; charset=utf-8", versionContent);
  console.log("upload version.json ->", vRes.status, vRes.body ? "| " + vRes.body : "");
  if (vRes.status !== 200) { console.error("version.json 上传失败"); process.exit(1); }

  // 广播通知（发布的一瞬间广播；失败不影响已上传的更新文件，只告警）
  const bRes = await broadcastVersion(v);
  console.log("broadcast 检测到新版本 v" + v, "->", bRes.status, bRes.body ? "| " + bRes.body : "");
  if (!(bRes.status >= 200 && bRes.status < 300)) { console.warn("⚠ 广播通知失败（不影响已上传的更新文件）"); }

  // 部署完成后验证：带缓存戳拉 version.json 确认版本号与哈希
  const ver = await fetch(`${URL}/storage/v1/object/${BUCKET}/version.json?t=${Date.now()}`, { headers: { apikey: SROLE } });
  console.log("verify version.json ->", ver.status, await ver.text());
})();
