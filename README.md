# SenseAudio Agent · 多模态创作平台

一个带精致 Web 前端的 SenseAudio 开放平台 Agent 应用，完整覆盖平台内的模型能力：
**对话（LLM）、图片生成、视频生成、音乐创作、语音合成（TTS）、音效生成**，并内置**计价展示与消耗费用自动记账**。

![tech](https://img.shields.io/badge/backend-Python%203.8%2B%20stdlib-blue) ![tech](https://img.shields.io/badge/frontend-vanilla%20JS%20%2B%20CSS-purple)

## 功能

| 模块 | 能力 | 计价（优惠价） |
|---|---|---|
| 对话助手 | 19 个 LLM（s2 全系列 / VL / DeepSeek / GLM / Kimi / Qwen 等），流式输出，token 用量与费用实时显示 | ¥1–6.5 入 / ¥6–30 出 每百万 tokens |
| 图片生成 | SenseAudio-Image-2.0、Doubao-Seedream-5.0-Lite、SenseNova-U1-Fast，尺寸按模型联动，支持参考图 | ¥0.22–0.5 / 张 |
| 视频生成 | Doubao-Seedance-2.0 文生视频 / 首帧图生视频，时长 / 分辨率 / 比例 / 水印 / 音频，异步轮询进度条 | 480p ¥0.5、720p ¥1、1080p ¥3.1 每秒 |
| 音乐创作 | Music-2.0 演唱 / 纯器乐 / 自定义歌词，出片含封面、播放器、歌词 | ¥0.5 / 首 |
| 语音合成 | TTS 1.5 / 2.0，系统音色列表、语速 / 音量 / 音调滑杆、hex 音频播放下载 | 中文 ¥3.5、其他 ¥1.75 每万字符 |
| 音效生成 | 1–4 变体、智能 / 固定时长 | ¥0.08 / 组 |
| 费用中心 | 按模块统计 + 全部调用明细 + 官方计价速查 | — |

- 每个生成模块的提示词输入框旁有 **✨ AI 补全**按钮：输入粗略想法，由 `glm-5.3-flash` 自动扩写成专业提示词。
- 所有费用按官方计费页的优惠后价格自动估算并持久化到 `usage.json`，侧边栏与费用中心实时显示累计消耗。
- API Key 仅在服务端配置一次（`config.json`），前端不接触密钥。

## 快速开始

### 方式一：下载 exe（推荐）

从 [Releases](https://github.com/bauerelizabeth07139/senseaudio-agent/releases) 下载 `SenseAudio-Agent-win64.zip` 并解压，双击 `SenseAudio-Agent.exe`，程序会自动打开浏览器。

- **没配置过 key 也不会闪退**：应用会自动进入「设置」页，粘贴 API Key（sk- 开头）→ 点「验证并保存」，验证通过立即生效
- 也可以手动把 `config.example.json` 复制为 `config.json`（与 exe 同目录）填入 key

### 方式二：源码运行

```bash
# 1. 复制配置文件并填入你的 SenseAudio API Key（或者不填，启动后到界面「设置」页配置）
cp config.example.json config.json

# 2. 启动（纯 Python 标准库，无需安装依赖）
python server.py

# 3. 浏览器打开
# http://127.0.0.1:8790
```

## 设置页

侧边栏「设置」页可随时更换 API Key / API 地址：

- 保存前自动调用 `GET /v1/models` 验证 Key 有效性，无效 Key 不会被保存
- 保存后热更新立即生效，无需重启
- 页面只显示掩码（如 `sk-zS7...21E3`），不回传明文

## 项目结构

```
senseaudio-agent/
├── server.py          # 后端：静态托管 + API 代理 + SSE 流式转发 + 自动计费
├── config.json        # 本地配置（不入库）：api_base + api_key
├── config.example.json
├── usage.json         # 消耗账本（自动生成，不入库）
└── public/
    ├── index.html     # 单页应用
    ├── style.css      # 暗色玻璃拟态主题
    └── app.js         # 交互逻辑 + 计价展示
```

## 计费来源

计价数据来自 SenseAudio 官方文档：<https://docs.senseaudio.cn/guides/account/billing>
