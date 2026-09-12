# -*- coding: utf-8 -*-
"""SenseAudio Agent 后端服务。

纯标准库实现（无第三方依赖）：
- 托管前端静态页面
- 将前端请求代理到 SenseAudio API（API Key 仅在服务端 config.json 配置一次）
- 对 SSE 流式请求做透明转发
- 按官方计费规则对每次调用自动估算费用并持久化到 usage.json
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _app_dir():
    """配置与账本所在目录：打包成 exe 时取 exe 同级目录，脚本运行时取脚本目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _resource_dir():
    """打包内置资源（public/）所在目录：PyInstaller onefile 解压到 sys._MEIPASS。"""
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        bundled = os.path.join(sys._MEIPASS, "public")
        if os.path.isdir(bundled):
            return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _app_dir()
PUBLIC_DIR = os.path.join(_resource_dir(), "public")
USAGE_FILE = os.path.join(BASE_DIR, "usage.json")

with open(os.path.join(BASE_DIR, "config.json"), encoding="utf-8") as _f:
    _CONFIG = json.load(_f)
API_BASE = _CONFIG["api_base"].rstrip("/")
API_KEY = _CONFIG["api_key"]

_LOCK = threading.Lock()

# ---------------------------------------------------------------- 计价表（元）
# LLM：元 / 百万 tokens（优惠后价），(输入, 输出)
LLM_PRICES = {
    "senseaudio-s2": (5, 30),
    "senseaudio-s1": (5, 30),
    "senseaudio-s2-flash": (2, 12),
    "senseaudio-s2-lite": (1, 6),
    "senseaudio-vl-1.0-260319": (5, 30),
    "senseaudio-vl-lite-1.0-260319": (1, 6),
    "sensenova-6.8-flash-lite": (5, 30),
    "qwen3.8-27b": (3, 12),
    "qwen3.6-35b-a3b": (1.8, 10.8),
    "deepseek-v4-flash-0731": (3, 9),
    "kimi-k2.6": (6.5, 27),
    "glm-5.3-flash": (0.8, 2.8),
    "glm-5.2": (6, 24),
    "minimax-m2.7": (2.1, 8.4),
    "doubao-seed-2-0-pro-260215": (3.2, 16),
}

# 图片：元 / 张（优惠后价）
IMAGE_PRICES = {
    "senseaudio-image-2.0-260319": 0.5,
    "doubao-seedream-5-0-260128": 0.22,
    "sensenova-u1-fast": 0.5,
}

# 视频 doubao-seedance-2.0：元 / 秒（优惠后价，原价 1 / 2 / 6.2）
VIDEO_PRICES = {"480p": 0.5, "720p": 1.0, "1080p": 3.1}
VIDEO_MODEL = "doubao-seedance-2-0-260128"

MUSIC_PRICE_PER_SONG = 0.5      # senseaudio-music-2.0，原价 1 元/首
SFX_PRICE_PER_GROUP = 0.08      # senseaudio-sfx-1.0
TTS_ZH_PER_10K = 3.5            # 中文字符 元/万字符
TTS_OTHER_PER_10K = 1.75        # 非中文字符 元/万字符


def estimate_tts_cost(text):
    zh = sum(1 for ch in (text or "") if "\u4e00" <= ch <= "\u9fff")
    other = len(text or "") - zh
    return zh / 10000.0 * TTS_ZH_PER_10K + other / 10000.0 * TTS_OTHER_PER_10K


# ---------------------------------------------------------------- 用量账本
def _load_usage():
    if os.path.exists(USAGE_FILE):
        try:
            with open(USAGE_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and "entries" in data:
                return data
        except Exception:
            pass
    return {"entries": [], "counted_music": []}


def _save_usage(data):
    tmp = USAGE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, USAGE_FILE)


def add_entry(module, model, desc, cost):
    cost = round(float(cost), 4)
    with _LOCK:
        data = _load_usage()
        data["entries"].append({
            "ts": time.time(), "module": module,
            "model": model, "desc": desc, "cost": cost,
        })
        data["entries"] = data["entries"][-500:]
        _save_usage(data)
    return cost


def usage_summary():
    with _LOCK:
        data = _load_usage()
    entries = data["entries"]
    total = sum(e.get("cost", 0) for e in entries)
    by_module = {}
    for e in entries:
        m = by_module.setdefault(e.get("module", "其他"), 0.0)
        by_module[e.get("module", "其他")] = m + e.get("cost", 0)
    return {
        "total": round(total, 4),
        "count": len(entries),
        "by_module": {k: round(v, 4) for k, v in by_module.items()},
        "entries": list(reversed(entries[-200:])),
    }


# ---------------------------------------------------------------- 计费估算
def _llm_model_price(model):
    model = model or ""
    if model in LLM_PRICES:
        return LLM_PRICES[model]
    for k, v in LLM_PRICES.items():
        if model.startswith(k) or k.startswith(model):
            return v
    return (5, 30)


def estimate_cost(path, req_body, resp_body):
    """根据端点 + 请求/响应估算本次调用费用（元）。返回 (module, cost, desc)。"""
    try:
        if "/chat/completions" in path or path.endswith("/v1/messages") or path.endswith("/v1/responses"):
            usage = (resp_body or {}).get("usage") or {}
            pt = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            ct = usage.get("completion_tokens") or usage.get("output_tokens") or 0
            model = (req_body or {}).get("model") or (resp_body or {}).get("model") or "senseaudio-s2"
            pin, pout = _llm_model_price(model)
            cost = pt / 1e6 * pin + ct / 1e6 * pout
            return "对话", cost, "%d 入 / %d 出 tokens" % (pt, ct)

        if "/image/sync" in path or "/image/async" in path:
            model = (req_body or {}).get("model") or ""
            price = IMAGE_PRICES.get(model, 0.5)
            return "图片", price, "1 张 (%s)" % model

        if "/video/create" in path:
            model = (req_body or {}).get("model") or VIDEO_MODEL
            res = (req_body or {}).get("resolution") or "720p"
            dur = int((req_body or {}).get("duration") or 0)
            price = VIDEO_PRICES.get(res.lower(), 1.0)
            return "视频", dur * price, "%ds @ %s (%s)" % (dur, res, model)

        # 音乐在创建任务时不计费，等轮询到 SUCCESS 按实际歌曲数量计费
        if "/music/song/create" in path:
            return "音乐", 0.0, ""

        if "/t2a_v2" in path:
            text = (req_body or {}).get("text") or ""
            model = (req_body or {}).get("model") or "sensenova-tts-2.0"
            return "语音合成", estimate_tts_cost(text), "%d 字符 (%s)" % (len(text), model)

        if "/sound-effects/generations" in path:
            n = int((req_body or {}).get("variants_count") or 4)
            n_done = None
            items = (resp_body or {}).get("items")
            if isinstance(items, list) and items:
                n_done = sum(1 for it in items if it.get("status") == "completed")
            n = n_done if n_done else n
            return "音效", n * SFX_PRICE_PER_GROUP, "%d 个变体" % n
    except Exception:
        pass
    return "其他", 0.0, path


# ---------------------------------------------------------------- HTTP 服务
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers
    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        fname = os.path.normpath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not fname.startswith(PUBLIC_DIR) or not os.path.isfile(fname):
            self._send_json(404, {"error": "not found"})
            return
        ext = os.path.splitext(fname)[1].lower()
        with open(fname, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- routes
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/usage"):
            self._send_json(200, usage_summary())
            return
        if path.startswith("/api/proxy/"):
            self._proxy_get(path[len("/api/proxy/"):], parsed.query)
            return
        self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/proxy/"):
            self._proxy_post(path[len("/api/proxy/"):])
            return
        self._send_json(404, {"error": "not found"})

    # ---- proxy
    def _proxy_get(self, sub, query):
        url = API_BASE + "/" + sub + (("?" + query) if query else "")
        req = urllib.request.Request(url, method="GET", headers={
            "Authorization": "Bearer " + API_KEY,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
            resp_body = json.loads(raw.decode("utf-8"))

            # 音乐任务轮询到 SUCCESS 时，按实际返回歌曲数计费（按 task_id 去重）
            if sub.startswith("v1/music/song/pending/"):
                try:
                    st = resp_body.get("status") or (resp_body.get("response") or {}).get("status")
                    songs = (resp_body.get("response") or {}).get("data") or []
                    if st == "SUCCESS" and songs:
                        with _LOCK:
                            data = _load_usage()
                            counted = set(data.get("counted_music", []))
                            task_id = sub.rsplit("/", 1)[-1]
                            if task_id not in counted:
                                cost = round(len(songs) * MUSIC_PRICE_PER_SONG, 4)
                                data.setdefault("counted_music", []).append(task_id)
                                data["entries"].append({
                                    "ts": time.time(), "module": "音乐",
                                    "model": "senseaudio-music-2.0-260626",
                                    "desc": "%d 首歌曲" % len(songs), "cost": cost,
                                })
                                data["entries"] = data["entries"][-500:]
                                _save_usage(data)
                except Exception:
                    pass

            self._send_json(200, resp_body)
        except urllib.error.HTTPError as e:
            self._relay_error(e)
        except Exception as e:
            self._send_json(502, {"error": "proxy failed: %s" % e})

    def _relay_error(self, e):
        try:
            raw = e.read()
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            obj = {"error": "upstream %s" % e.code}
        self._send_json(e.code, obj)

    def _proxy_post(self, sub):
        body = self._read_body()
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b""
        url = API_BASE + "/" + sub
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

        is_stream = bool(isinstance(body, dict) and body.get("stream"))
        try:
            resp = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            self._relay_error(e)
            return
        except Exception as e:
            self._send_json(502, {"error": "proxy failed: %s" % e})
            return

        if is_stream:
            self._proxy_stream(sub, body, resp)
            return

        try:
            raw = resp.read()
            resp_body = json.loads(raw.decode("utf-8"))
        except Exception:
            resp_body = None
        try:
            resp.close()
        except Exception:
            pass

        if isinstance(resp_body, dict) and not resp_body.get("_no_track", False):
            module, cost, desc = estimate_cost(sub, body, resp_body)
            if cost > 0:
                model = (body or {}).get("model") or "-"
                add_entry(module, model, desc, cost)

        self._send_json(200, resp_body if resp_body is not None else {})

    def _proxy_stream(self, sub, req_body, resp):
        """SSE 透传：边转发边累积，结束后按 usage chunk 计费。"""
        self.send_response(200)
        self.send_header("Content-Type", resp.headers.get("Content-Type", "text/event-stream"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        buf = b""
        usage = None
        try:
            while True:
                chunk = resp.read(1024)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > 2 * 1024 * 1024:
                    buf = buf[-2 * 1024 * 1024:]
                out = b"%x\r\n%s\r\n" % (len(chunk), chunk)
                self.wfile.write(out)
                self.wfile.flush()
        except Exception:
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

        # 从累积的 SSE 中解析 usage
        try:
            text = buf.decode("utf-8", "ignore")
            for line in text.splitlines():
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    if payload and payload != "[DONE]":
                        obj = json.loads(payload)
                        if isinstance(obj, dict) and obj.get("usage"):
                            usage = obj["usage"]
        except Exception:
            pass

        if usage:
            usage.pop("_no_track", None)
            module, cost, desc = estimate_cost(sub, req_body, {"usage": usage})
            if cost > 0:
                model = (req_body or {}).get("model") or "-"
                add_entry(module, model, desc, cost)


def main():
    port = int(os.environ.get("PORT", "8790"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    url = "http://127.0.0.1:%d" % port
    print("SenseAudio Agent running at %s" % url)
    print("Config: %s (config.json) | Usage ledger: %s" % (BASE_DIR, USAGE_FILE))
    if getattr(sys, "frozen", False):
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
