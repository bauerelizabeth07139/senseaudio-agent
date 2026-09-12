/* SenseAudio Agent 前端逻辑 */
"use strict";

/* ================= 计价常量（元，优惠后价） ================= */
const LLM_PRICES = {
  "senseaudio-s2": [5, 30], "senseaudio-s1": [5, 30],
  "senseaudio-s2-flash": [2, 12], "senseaudio-s2-lite": [1, 6],
  "senseaudio-vl-1.0-260319": [5, 30], "senseaudio-vl-lite-1.0-260319": [1, 6],
  "sensenova-6.8-flash-lite": [5, 30],
  "qwen3.8-27b": [3, 12], "qwen3.6-35b-a3b": [1.8, 10.8],
  "deepseek-v4-flash-0731": [3, 9], "kimi-k2.6": [6.5, 27],
  "glm-5.3-flash": [0.8, 2.8], "glm-5.2": [6, 24],
  "minimax-m2.7": [2.1, 8.4], "doubao-seed-2-0-pro-260215": [3.2, 16],
};
const IMAGE_PRICES = {
  "senseaudio-image-2.0-260319": 0.5,
  "doubao-seedream-5-0-260128": 0.22,
  "sensenova-u1-fast": 0.5,
};
const IMAGE_SIZES = {
  "senseaudio-image-2.0-260319": ["1024x1024", "1536x864", "864x1536", "2048x1024", "1024x2048", "2048x1152", "1152x2048", "2688x1344", "1344x2688", "3840x2160", "2160x3840"],
  "doubao-seedream-5-0-260128": ["2048x2048", "2304x1728", "1728x2304", "2496x1664", "1664x2496", "3072x3072", "3456x2592", "2592x3456", "4096x2304", "2304x4096"],
  "sensenova-u1-fast": ["2048x2048", "1664x2496", "2496x1664", "1760x2368", "2368x1760", "2752x1536", "1536x2752"],
};
const VIDEO_PRICES = { "480p": 0.5, "720p": 1.0, "1080p": 3.1 };  // 元/秒，原价 1 / 2 / 6.2
const MUSIC_PRICE = 0.5;   // 元/首
const SFX_PRICE = 0.08;    // 元/组

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => "¥" + Number(n).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");

/* ================= Toast ================= */
function toast(msg, type) {
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.textContent = msg;
  $("toastWrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 4200);
}

/* ================= 页面导航 ================= */
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    item.classList.add("active");
    $("page-" + item.dataset.page).classList.add("active");
    if (item.dataset.page === "usage") refreshUsage();
  });
});

/* ================= 用量 ================= */
async function refreshUsage() {
  try {
    const r = await fetch("/api/usage");
    const u = await r.json();
    $("totalSpend").textContent = (u.total || 0).toFixed(4);
    $("totalCalls").textContent = u.count || 0;
    renderUsagePage(u);
    return u;
  } catch (e) { /* 忽略 */ }
}

const MODULE_ICONS = { "对话": "💬", "图片": "🖼️", "视频": "🎬", "音乐": "🎵", "语音合成": "🎙️", "音效": "🔊", "其他": "📦" };
function renderUsagePage(u) {
  if (!u) return;
  const cards = $("usageCards");
  let html = `<div class="usage-card"><div class="uc-label"><span>累计消耗</span><span class="uc-emoji">💰</span></div><div class="uc-value">¥${(u.total || 0).toFixed(4)}</div></div>
  <div class="usage-card"><div class="uc-label"><span>调用次数</span><span class="uc-emoji">📈</span></div><div class="uc-value">${u.count || 0}</div></div>`;
  for (const [mod, cost] of Object.entries(u.by_module || {})) {
    html += `<div class="usage-card"><div class="uc-label"><span>${mod}</span><span class="uc-emoji">${MODULE_ICONS[mod] || "📦"}</span></div><div class="uc-value">¥${cost.toFixed(4)}</div></div>`;
  }
  cards.innerHTML = html;
  const tb = $("usageTbody");
  tb.innerHTML = (u.entries || []).map((e) => {
    const t = new Date(e.ts * 1000);
    const ts = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return `<tr><td>${ts}</td><td><span class="tag">${e.module}</span></td><td>${e.model}</td><td>${e.desc}</td><td class="cost">¥${e.cost.toFixed(4)}</td></tr>`;
  }).join("") || '<tr><td colspan="5" style="color:var(--text-dim)">暂无调用记录，去各个模块试试吧</td></tr>';
}

/* ================= 对话助手 ================= */
const chatMessages = [];
(function initChatModels() {
  const groups = {
    "SenseAudio 系列": ["senseaudio-s2", "senseaudio-s2-flash", "senseaudio-s2-lite", "senseaudio-s1"],
    "视觉理解": ["senseaudio-vl-1.0-260319", "senseaudio-vl-lite-1.0-260319"],
    "第三方模型": ["deepseek-v4-flash-0731", "glm-5.3-flash", "glm-5.2", "kimi-k2.6", "qwen3.8-27b", "qwen3.6-35b-a3b", "minimax-m2.7", "doubao-seed-2-0-pro-260215", "sensenova-6.8-flash-lite"],
  };
  const sel = $("chatModel");
  for (const [g, models] of Object.entries(groups)) {
    const og = document.createElement("optgroup"); og.label = g;
    models.forEach((m) => { const o = document.createElement("option"); o.value = m; o.textContent = m; og.appendChild(o); });
    sel.appendChild(og);
  }
  sel.value = "senseaudio-s2-flash";
  sel.addEventListener("change", updateChatPricing);
})();
function chatPrice(model) { return LLM_PRICES[model] || [5, 30]; }
function updateChatPricing() {
  const [pi, po] = chatPrice($("chatModel").value);
  $("chatPricing").textContent = `计价：输入 ¥${pi}/百万 tokens · 输出 ¥${po}/百万 tokens（优惠价），按实际 token 用量计费`;
}
updateChatPricing();

function addMsg(role, content, meta) {
  $("chatList").querySelector(".chat-empty")?.remove();
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = `<div class="avatar">${role === "user" ? "🧑" : "🤖"}</div><div><div class="bubble"></div><div class="msg-meta"></div></div>`;
  div.querySelector(".bubble").textContent = content;
  if (meta) div.querySelector(".msg-meta").textContent = meta;
  $("chatList").appendChild(div);
  $("chatList").scrollTop = $("chatList").scrollHeight;
  return div;
}

let chatBusy = false;
async function sendChat() {
  if (chatBusy) return;
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; input.style.height = "auto";
  chatMessages.push({ role: "user", content: text });
  addMsg("user", text);
  chatBusy = true; $("chatSend").disabled = true;

  const model = $("chatModel").value;
  const div = addMsg("assistant", "");
  div.querySelector(".bubble").innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';

  try {
    const resp = await fetch("/api/proxy/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: chatMessages, stream: true, stream_options: { include_usage: true } }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || err.message || JSON.stringify(err));
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "", usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            div.querySelector(".bubble").textContent = full;
            $("chatList").scrollTop = $("chatList").scrollHeight;
          }
          if (obj.usage) usage = obj.usage;
        } catch (e) { /* 跳过不完整行 */ }
      }
    }
    let meta = model;
    let cost = 0;
    if (usage) {
      const [pi, po] = chatPrice(model);
      cost = (usage.prompt_tokens || 0) / 1e6 * pi + (usage.completion_tokens || 0) / 1e6 * po;
      meta = `${model} · ${usage.prompt_tokens}入/${usage.completion_tokens}出 tokens · ≈${fmtMoney(cost)}`;
    }
    div.querySelector(".msg-meta").textContent = meta;
    chatMessages.push({ role: "assistant", content: full });
    refreshUsage();
  } catch (e) {
    div.querySelector(".bubble").textContent = "⚠️ 请求失败：" + e.message;
    div.querySelector(".bubble").style.color = "var(--red)";
  } finally {
    chatBusy = false; $("chatSend").disabled = false;
  }
}
$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$("chatInput").addEventListener("input", function () { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 140) + "px"; });
$("chatClear").addEventListener("click", () => {
  chatMessages.length = 0;
  $("chatList").innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div><h3>开始与模型对话</h3><p>支持 senseaudio-s2 / flash / lite、DeepSeek、GLM、Kimi、Qwen 等模型</p></div>';
});

/* ================= 图片生成 ================= */
(function initImageModels() {
  const sel = $("imgModel");
  const labels = { "senseaudio-image-2.0-260319": "SenseAudio-Image-2.0", "doubao-seedream-5-0-260128": "Doubao-Seedream-5.0-Lite", "sensenova-u1-fast": "SenseNova-U1-Fast" };
  Object.keys(IMAGE_PRICES).forEach((m) => { const o = document.createElement("option"); o.value = m; o.textContent = labels[m] || m; sel.appendChild(o); });
  sel.addEventListener("change", () => { fillSizes(); updateImgNote(); });
  fillSizes();
})();
function fillSizes() {
  const sizes = IMAGE_SIZES[$("imgModel").value] || [];
  $("imgSize").innerHTML = sizes.map((s) => `<option>${s}</option>`).join("");
}
function updateImgNote() {
  const m = $("imgModel").value;
  $("imgPriceNote").textContent = `计价：¥${IMAGE_PRICES[m].toFixed(2)} / 张（${m}）`;
}
updateImgNote();

$("imgGen").addEventListener("click", async () => {
  const prompt = $("imgPrompt").value.trim();
  if (!prompt) return toast("请输入提示词", "err");
  const body = { model: $("imgModel").value, prompt, size: $("imgSize").value };
  const ref = $("imgRef").value.trim();
  if (ref) body.reference = ref;
  if ($("imgSeed").value) body.seed = parseInt($("imgSeed").value, 10);

  const btn = $("imgGen"); btn.disabled = true; btn.textContent = "生成中，请稍候（同步接口，可能需要 30s+）…";
  $("imgStage").innerHTML = '<div class="empty-hint">🎨 正在生成…</div>';
  $("imgCost").textContent = "";
  try {
    const r = await fetch("/api/proxy/v1/image/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || JSON.stringify(data));
    const url = data.url || data.data?.url || data.data?.[0]?.url;
    if (!url) throw new Error("未返回图片 URL：" + JSON.stringify(data));
    $("imgStage").innerHTML = `<img src="${url}" alt="生成结果"><div class="dl-row"><a class="btn ghost sm" href="${url}" target="_blank" rel="noopener">原图查看 / 右键另存</a></div>`;
    $("imgCost").textContent = "本次 ≈ " + fmtMoney(IMAGE_PRICES[body.model]);
    toast("图片生成完成 " + fmtMoney(IMAGE_PRICES[body.model]), "ok");
    refreshUsage();
  } catch (e) {
    $("imgStage").innerHTML = '<div class="empty-hint">生成失败</div>';
    toast("图片生成失败：" + e.message, "err");
  } finally { btn.disabled = false; btn.textContent = "生成图片"; }
});

/* ================= 视频生成 ================= */
(function initVideo() {
  const sel = $("vidResolution");
  const labels = { "480p": "480p（¥0.5/秒）", "720p": "720p（¥1/秒）", "1080p": "1080p（¥3.1/秒）" };
  for (const [v, l] of Object.entries(labels)) { const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o); }
  sel.value = "720p";
  $("vidDuration").addEventListener("input", function () { $("vidDurVal").textContent = this.value + "s"; updateVidNote(); });
  sel.addEventListener("change", updateVidNote);
  updateVidNote();
})();
function updateVidNote() {
  const dur = parseInt($("vidDuration").value, 10);
  const price = VIDEO_PRICES[$("vidResolution").value];
  $("vidPriceNote").textContent = `计价：${$("vidResolution").value} ¥${price}/秒 × ${dur}秒 ≈ ¥${(dur * price).toFixed(2)}（原价 ¥${{ "480p": 1, "720p": 2, "1080p": 6.2 }[$("vidResolution").value]}/秒）`;
}

let vidPolling = false;
$("vidGen").addEventListener("click", async () => {
  if (vidPolling) return toast("已有任务在进行中", "err");
  const prompt = $("vidPrompt").value.trim();
  const firstFrame = $("vidFirstFrame").value.trim();
  if (!prompt && !firstFrame) return toast("请输入提示词或提供首帧图片", "err");
  const content = [];
  if (prompt) content.push({ type: "text", text: prompt });
  if (firstFrame) content.push({ type: "image", url: firstFrame, role: "first_frame" });
  const resolution = $("vidResolution").value;
  const body = {
    model: "doubao-seedance-2-0-260128",
    content, duration: parseInt($("vidDuration").value, 10),
    resolution, ratio: $("vidRatio").value,
    watermark: $("vidWatermark").checked,
    provider_specific: { generate_audio: $("vidAudio").checked },
  };
  const est = body.duration * VIDEO_PRICES[resolution];
  $("vidCost").textContent = "";
  $("vidStage").innerHTML = '<div class="empty-hint">🎬 任务创建中…</div>';
  setVidStatus("正在创建任务…");
  try {
    const r = await fetch("/api/proxy/v1/video/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || JSON.stringify(data));
    const taskId = data.task_id || data.id;
    setVidStatus("任务已创建：" + taskId);
    pollVideo(taskId, est, body.duration);
  } catch (e) {
    $("vidStage").innerHTML = '<div class="empty-hint">创建失败</div>';
    setVidStatus("创建失败：" + e.message, "err");
  }
});
function setVidStatus(msg, cls) { const el = $("vidStatus"); el.textContent = msg; el.className = "task-status " + (cls || ""); }
async function pollVideo(taskId, estCost, duration) {
  vidPolling = true;
  $("vidProgress").classList.remove("hidden");
  try {
    while (true) {
      await new Promise((r) => setTimeout(r, 5000));
      const r = await fetch("/api/proxy/v1/video/status?id=" + encodeURIComponent(taskId));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || JSON.stringify(data));
      const st = data.status || (data.data && data.data.status);
      const prog = data.progress != null ? data.progress : (data.data && data.data.progress) || 0;
      $("vidProgressBar").style.width = prog + "%";
      setVidStatus(`状态：${st}（${prog}%）`);
      if (st === "completed") {
        const url = data.video_url || (data.data && data.data.video_url);
        $("vidStage").innerHTML = `<video src="${url}" controls autoplay loop></video>`;
        $("vidProgressBar").style.width = "100%";
        $("vidProgress").classList.add("hidden");
        setVidStatus("✅ 生成完成", "ok");
        $("vidCost").textContent = "本次 ≈ " + fmtMoney(estCost);
        toast("视频生成完成 " + fmtMoney(estCost), "ok");
        refreshUsage();
        break;
      }
      if (st === "failed") {
        throw new Error(data.error_message || (data.data && data.data.error_message) || "任务失败");
      }
    }
  } catch (e) {
    setVidStatus("❌ " + e.message, "err");
    $("vidStage").innerHTML = '<div class="empty-hint">生成失败</div>';
    $("vidProgress").classList.add("hidden");
    vidPolling = false;
  }
  vidPolling = false;
}

/* ================= 音乐创作 ================= */
let musPolling = false;
$("musGen").addEventListener("click", async () => {
  if (musPolling) return toast("已有任务在进行中", "err");
  const mode = $("musMode").value;
  const prompt = $("musPrompt").value.trim();
  const lyrics = $("musLyrics").value.trim();
  if (!prompt && !lyrics) return toast("请输入主题描述或自定义歌词", "err");
  const body = { model: "senseaudio-music-2.0-260626", mode, prompt };
  if (lyrics) body.lyrics = lyrics;
  if ($("musStyle").value.trim()) body.style = $("musStyle").value.trim();
  body.vocal_settings = { gender: $("musVocal").value };
  body.audio_settings = { format: $("musFormat").value };
  const d = parseInt($("musDuration").value, 10);
  if (d >= 10 && d <= 600) body.lyrics_settings = { expect_duration: d };

  $("musList").innerHTML = '<div class="empty-hint">🎵 正在创建任务…</div>';
  setMusStatus("正在创建任务…");
  $("musCost").textContent = "";
  try {
    const r = await fetch("/api/proxy/v2/music/song/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || JSON.stringify(data));
    setMusStatus("任务已创建：" + (data.task_id || data.id));
    pollMusic(data.task_id || data.id);
  } catch (e) {
    $("musList").innerHTML = '<div class="empty-hint">创建失败</div>';
    setMusStatus("创建失败：" + e.message, "err");
  }
});
function setMusStatus(msg, cls) { const el = $("musStatus"); el.textContent = msg; el.className = "task-status " + (cls || ""); }
async function pollMusic(taskId) {
  musPolling = true;
  let ticks = 0;
  try {
    while (true) {
      await new Promise((r) => setTimeout(r, 5000));
      ticks++;
      const r = await fetch("/api/proxy/v1/music/song/pending/" + encodeURIComponent(taskId));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || JSON.stringify(data));
      const st = data.status || (data.response && data.response.status);
      setMusStatus(`状态：${st}（已等待 ${ticks * 5} 秒）`);
      if (st === "SUCCESS" || (data.response && Array.isArray(data.response.data) && data.response.data.length)) {
        const songs = (data.response && data.response.data) || [];
        if (!songs.length) { setMusStatus("任务成功但未返回曲目", "err"); break; }
        $("musList").innerHTML = songs.map((s, i) => `
          <div class="song-card">
            <img class="song-cover" src="${s.cover_url || ""}" onerror="this.style.visibility='hidden'">
            <div class="song-info">
              <div class="song-title">${i + 1}. ${s.title || "未命名"} </div>
              <div class="song-dur">时长 ${s.duration || "?"} 秒 · ${fmtMusicCost(songs.length)} / 首</div>
              <audio src="${s.audio_url}" controls></audio>
              ${s.lyrics ? `<div class="song-lyrics">${esc(s.lyrics)}</div>` : ""}
            </div>
          </div>`).join("");
        setMusStatus("✅ 创作完成，共 " + songs.length + " 首", "ok");
        $("musCost").textContent = "本次 ≈ " + fmtMusicCost(songs.length);
        toast("音乐创作完成 " + $("musCost").textContent, "ok");
        refreshUsage();
        break;
      }
      if (st === "FAILED") throw new Error(data.fail_reason || "任务失败");
    }
  } catch (e) {
    setMusStatus("❌ " + e.message, "err");
    $("musList").innerHTML = '<div class="empty-hint">生成失败</div>';
  }
  musPolling = false;
}
function fmtMusicCost(n) { return "¥" + (n * MUSIC_PRICE).toFixed(2); }
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ================= 语音合成 ================= */
function ttsText() { return $("ttsText").value; }
function ttsCostEstimate() {
  const text = ttsText();
  let zh = 0; for (const ch of text) if (ch >= "\u4e00" && ch <= "\u9fff") zh++;
  const other = text.length - zh;
  return zh / 10000 * 3.5 + other / 10000 * 1.75;
}
$("ttsText").addEventListener("input", () => {
  const t = ttsText();
  $("ttsCharCount").textContent = t.length + " 字符";
  $("ttsPriceNote").textContent = `本次预计 ≈ ¥${ttsCostEstimate().toFixed(4)}（中文 ¥3.5/万字符 · 其他 ¥1.75/万字符）`;
});
$("ttsSpeed").addEventListener("input", function () { $("ttsSpeedVal").textContent = Number(this.value).toFixed(2); });
$("ttsVol").addEventListener("input", function () { $("ttsVolVal").textContent = Number(this.value).toFixed(2); });
$("ttsPitch").addEventListener("input", function () { $("ttsPitchVal").textContent = this.value; });

$("ttsLoadVoices").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/proxy/v1/get_voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice_type: "system" }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || JSON.stringify(data));
    const voices = data.system_voice || data.data?.system_voice || [];
    if (!voices.length) throw new Error("未返回系统音色");
    $("voiceList").innerHTML = voices.map((v) => `<option value="${v.voice_id}">${v.voice_name || ""}</option>`).join("");
    $("ttsVoiceInfo").textContent = `共 ${voices.length} 个系统音色，点击输入框下拉选择（当前：${(voices.find((v) => v.voice_id === $("ttsVoice").value) || {}).voice_name || "自定义"}）`;
    toast(`已加载 ${voices.length} 个系统音色，点击输入框下拉选择`, "ok");
  } catch (e) { toast("获取音色失败：" + e.message, "err"); }
});

$("ttsGen").addEventListener("click", async () => {
  const text = ttsText().trim();
  if (!text) return toast("请输入合成文本", "err");
  const body = {
    model: $("ttsModel").value, text, stream: false,
    voice_setting: {
      voice_id: $("ttsVoice").value.trim(),
      speed: parseFloat($("ttsSpeed").value),
      vol: parseFloat($("ttsVol").value),
      pitch: parseInt($("ttsPitch").value, 10),
    },
    audio_setting: {
      format: $("ttsFormat").value,
      sample_rate: parseInt($("ttsSampleRate").value, 10),
      bitrate: 128000, channel: 1,
    },
  };
  const est = ttsCostEstimate();
  const btn = $("ttsGen"); btn.disabled = true; btn.textContent = "合成中…";
  $("ttsStage").innerHTML = '<div class="empty-hint">🎙️ 正在合成…</div>';
  $("ttsCost").textContent = "";
  try {
    const r = await fetch("/api/proxy/v1/t2a_v2", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || JSON.stringify(data));
    if (data.base_resp && data.base_resp.status_code !== 0) throw new Error(data.base_resp.status_msg || ("status_code=" + data.base_resp.status_code));
    const hex = data.data?.audio;
    if (!hex) throw new Error("未返回音频数据：" + JSON.stringify(data).slice(0, 200));
    const bytes = new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    const mime = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", pcm: "audio/wav" }[body.audio_setting.format];
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const chars = data.extra_info?.word_count || text.length;
    $("ttsStage").innerHTML = `
      <div class="audio-row">
        <div class="audio-row-title"><span>合成语音（${body.voice_setting.voice_id}）</span><span>${data.extra_info?.audio_length || ""}</span></div>
        <audio src="${url}" controls autoplay></audio>
      </div>
      <div class="dl-row"><a class="btn ghost sm" href="${url}" download="tts.${body.audio_setting.format}">下载音频</a></div>`;
    $("ttsCost").textContent = `本次 ≈ ${fmtMoney(est)}（${chars} 字符）`;
    toast("语音合成完成 " + fmtMoney(est), "ok");
    refreshUsage();
  } catch (e) {
    $("ttsStage").innerHTML = '<div class="empty-hint">合成失败</div>';
    toast("语音合成失败：" + e.message, "err");
  } finally { btn.disabled = false; btn.textContent = "开始合成"; }
});

/* ================= 音效生成 ================= */
$("sfxGen").addEventListener("click", async () => {
  const text = $("sfxText").value.trim();
  if (!text) return toast("请输入音效描述", "err");
  const body = {
    model: "senseaudio-sfx-1.0-260626",
    text, variants_count: parseInt($("sfxVariants").value, 10),
    smart_duration: true, output_format: $("sfxFormat").value,
  };
  const fixed = parseInt($("sfxDuration").value, 10);
  if (fixed >= 1 && fixed <= 10) { body.duration_seconds = fixed; delete body.smart_duration; }
  const btn = $("sfxGen"); btn.disabled = true; btn.textContent = "生成中…";
  $("sfxList").innerHTML = '<div class="empty-hint">🔊 正在生成…</div>';
  $("sfxCost").textContent = "";
  try {
    const r = await fetch("/api/proxy/v1/sound-effects/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data.message || JSON.stringify(data));
    const items = (data.items || []).filter((it) => it.audio_url);
    if (!items.length) throw new Error("未生成任何音效：" + JSON.stringify(data).slice(0, 200));
    $("sfxList").innerHTML = items.map((it, i) => `
      <div class="audio-row">
        <div class="audio-row-title"><span>#${i + 1} ${it.name || "音效 " + (it.variant_index + 1)}</span><span>${it.duration_seconds || "?"}s</span></div>
        <audio src="${it.audio_url}" controls></audio>
      </div>`).join("") + `<div class="dl-row"><a class="btn ghost sm" href="${items[0].audio_url}" target="_blank" rel="noopener">打开第一条</a></div>`;
    const cost = items.length * SFX_PRICE;
    $("sfxCost").textContent = "本次 ≈ " + fmtMoney(cost);
    toast("音效生成完成 " + fmtMoney(cost), "ok");
    refreshUsage();
  } catch (e) {
    $("sfxList").innerHTML = '<div class="empty-hint">生成失败</div>';
    toast("音效生成失败：" + e.message, "err");
  } finally { btn.disabled = false; btn.textContent = "生成音效"; }
});

/* ================= AI 提示词补全 ================= */
const AI_COMPLETE = {
  img: { target: "imgPrompt", sys: "你是文生图提示词专家。把用户的粗略想法扩写成一段详细的中文文生图提示词：包含主体、场景、构图、光影、色调、艺术风格、画质等要素，80-150 字。直接输出提示词本身，不要任何解释、引号或前缀。" },
  vid: { target: "vidPrompt", sys: "你是文生视频提示词专家。把用户的粗略想法扩写成一段详细的中文视频提示词：包含画面主体、场景环境、镜头运动、光线氛围、动态节奏等要素，80-150 字。直接输出提示词本身，不要任何解释、引号或前缀。" },
  mus: { target: "musPrompt", sys: "你是音乐创作策划。把用户的粗略想法扩写成一段中文歌曲主题描述：包含音乐风格、情绪氛围、节奏速度、配器、演唱方式、场景意象等，60-120 字。直接输出描述本身，不要任何解释、引号或前缀。" },
  tts: { target: "ttsText", sys: "你是播音文案编辑。把用户给出的粗略内容润色扩写成一段适合语音合成的朗读文本：语句自然流畅、口语化、节奏适中、有适当的换气停顿点，60-150 字。直接输出文本本身，不要任何解释、引号或前缀。" },
  sfx: { target: "sfxText", sys: "You are a sound-effect prompt expert. Expand the user's rough idea into a vivid English sound-effect description: include the sound elements, environment, layering and dynamic changes, 30-60 words. Output only the description itself, no explanation, quotes or prefix." },
};
document.querySelectorAll(".ai-btn").forEach((btn) => btn.addEventListener("click", () => aiComplete(btn.dataset.ai, btn)));
async function aiComplete(kind, btn) {
  const cfg = AI_COMPLETE[kind];
  const ta = $(cfg.target);
  const rough = ta.value.trim();
  if (!rough) return toast("请先输入粗略想法，再点 AI 补全", "err");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "补全中…";
  try {
    const r = await fetch("/api/proxy/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "system", content: cfg.sys }, { role: "user", content: rough }], max_tokens: 600, temperature: 0.8 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || JSON.stringify(data));
    const out = data.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error("未返回内容");
    ta.value = out;
    ta.dispatchEvent(new Event("input"));
    const tokens = data.usage?.total_tokens;
    toast(`✨ AI 补全完成${tokens ? `（${tokens} tokens）` : ""}`, "ok");
    refreshUsage();
  } catch (e) {
    toast("AI 补全失败：" + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

/* ================= 启动 ================= */
refreshUsage();
