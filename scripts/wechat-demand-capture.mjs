import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";
import { chromium } from "playwright";

const ROOT = process.cwd();
const RUNTIME_DIR = path.join(ROOT, ".runtime", "wechat-capture");
const PROFILE_DIR = path.join(RUNTIME_DIR, "profile");
const SCREENSHOT_DIR = path.join(RUNTIME_DIR, "screenshots");
const STATE_FILE = path.join(RUNTIME_DIR, "state.json");

function parseEnvText(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadLocalEnv() {
  const envPaths = [path.join(ROOT, ".env"), path.join(ROOT, ".env.local")];
  const merged = {};
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    const text = await readFile(envPath, "utf8");
    Object.assign(merged, parseEnvText(text));
  }
  return { ...merged, ...process.env };
}

function boolFromEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function intFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(message) {
  console.log(`[${stamp()}] ${message}`);
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function messageFingerprint(msg) {
  return sha1(`${msg.time}|${msg.sender}|${msg.content}`);
}

function sanitizeFilePart(text) {
  return String(text || "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function mimeFromFilePath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function extractJsonArray(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenced =
    text.match(/```json\s*([\s\S]*?)\s*```/i) ??
    text.match(/```\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1]?.trim() || text;
  const first = candidate.indexOf("[");
  const last = candidate.lastIndexOf("]");
  if (first !== -1 && last !== -1 && last > first) {
    return candidate.slice(first, last + 1);
  }
  return null;
}

function coerceMessageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeChatCompletionResponse(resp) {
  if (typeof resp !== "string") return resp;
  const text = resp.trim();
  if (!text) return resp;
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.includes("<title>")) {
    return resp;
  }
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith('"') && text.endsWith('"'))) {
    try {
      return JSON.parse(text);
    } catch {
      return resp;
    }
  }
  return resp;
}

async function ensureRuntimeDirs() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

async function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { seenHashes: {} };
  }
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      seenHashes: typeof parsed?.seenHashes === "object" && parsed.seenHashes ? parsed.seenHashes : {},
    };
  } catch {
    return { seenHashes: {} };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 把同一个 sender 在时间窗口（默认 10 分钟）内的连续消息归并为一段"会话"。
 * 只要 sender 与前一条相同、且时间差 < gap，就追加到同一段。
 * 返回 [{sender, startTime, endTime, messages[], combinedText, domIndices[]}]
 */
function mergeSessionMessages(messages, gapMinutes = 10) {
  if (!messages.length) return [];

  function parseTime(str) {
    const full = str.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
    if (full) return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]).getTime();
    const short = str.match(/^(\d{2}):(\d{2})$/);
    if (short) {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), +short[1], +short[2]).getTime();
    }
    return 0;
  }

  const sessions = [];
  let cur = null;

  for (const msg of messages) {
    const ts = parseTime(msg.time);
    if (
      cur &&
      cur.sender === msg.sender &&
      ts - cur._lastTs < gapMinutes * 60_000
    ) {
      cur.messages.push(msg);
      cur.endTime = msg.time;
      cur.domIndices.push(msg.domIndex);
      cur._lastTs = ts;
    } else {
      if (cur) {
        cur.combinedText = cur.messages.map((m) => m.content).join("\n");
        delete cur._lastTs;
        sessions.push(cur);
      }
      cur = {
        sender: msg.sender,
        startTime: msg.time,
        endTime: msg.time,
        messages: [msg],
        domIndices: [msg.domIndex],
        source: msg.source || "企业微信",
        _lastTs: ts,
      };
    }
  }
  if (cur) {
    cur.combinedText = cur.messages.map((m) => m.content).join("\n");
    delete cur._lastTs;
    sessions.push(cur);
  }
  return sessions;
}

/**
 * buildSessionAnalyzer — 对归并后的会话片段进行需求识别 + 多需求拆分。
 * 输入：sessions（mergeSessionMessages 返回的数组）
 * 返回：[{sessionIndex, demands: [{title, reason}], is_valid}]
 * 如果一段会话包含多个需求，demands 数组里会有多条。
 */
function buildSessionAnalyzer(client, model) {
  return async function analyzeSessions(sessions) {
    const sessionLines = sessions.map((s, idx) => {
      const textPreview = s.combinedText.replace(/\s+/g, " ").slice(0, 800);
      return `[${idx}] 发送者: ${s.sender} | 时间段: ${s.startTime} ~ ${s.endTime} | 消息条数: ${s.messages.length} | 内容:\n${textPreview}`;
    });

    const prompt = [
      '你是一个需求分析助手，专门为"像素蛋糕（PixCake）"二次元修图产品筛选用户需求。',
      "",
      "下面每一段 [编号] 是同一用户在一段时间内的所有聊天消息汇总。",
      "你的任务：",
      "1. 判断这段发言是否包含有效需求（is_valid=true/false）。",
      "2. 如果包含，请拆解出所有独立的需求（一段话可能包含多个需求）。",
      "3. 对每个需求给出简短标题（title，<=15字）。",
      "",
      "保留的标准：",
      "- Bug 反馈",
      '- 功能建议或功能请求（如"希望加个xx功能"、"能不能支持xx"）',
      '- 使用问题或疑问（如"xx功能怎么用"、"为什么xx不行"）',
      '- 付费意向（如"这个多少钱"、"怎么充值"）',
      "- 二次元修图相关需求（画头发、美瞳、辉光、特效、预设等）",
      "",
      "丢弃的标准：",
      "- 纯表情、纯图片描述",
      "- 闲聊、打招呼、斗图",
      '- 无意义短句（如"好的"、"收到"、"哈哈"）',
      "- 系统公告、推广链接、活动通知",
      "- 视频号分享、转发内容",
      "- 运营人员自己发的工作通知",
      "",
      "返回 JSON 数组，每个元素包含：",
      "- session_index: 对应会话编号",
      "- is_valid: true/false（是否包含需求）",
      '- demands: [{title, reason}] 拆解出的需求列表（无需求时空数组）',
      "",
      "只返回纯 JSON 数组。",
      "",
      ...sessionLines,
    ].join("\n");

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你必须只返回纯 JSON 数组，不要 Markdown，不要解释，不要前后多余文本。",
          },
          { role: "user", content: prompt },
        ],
      });

      resp = normalizeChatCompletionResponse(resp);

      const rawContent = resp?.choices?.[0]?.message?.content ?? "";
      const raw = coerceMessageContentToText(rawContent).trim();

      if (!raw) {
        if (attempt < maxAttempts) {
          log(`AI 返回空内容（第 ${attempt} 次），${2 * attempt} 秒后重试...`);
          await sleep(2000 * attempt);
          continue;
        }
        throw new Error("AI 连续返回空内容，请检查 API 网关配置");
      }

      const arrayText = extractJsonArray(raw);
      if (!arrayText) {
        throw new Error(`LLM 返回结果不是 JSON 数组: ${String(raw).slice(0, 200)}`);
      }
      const parsed = JSON.parse(arrayText);
      if (!Array.isArray(parsed)) {
        throw new Error("LLM 返回的 JSON 不是数组");
      }
      return parsed;
    }
    throw new Error("AI 分析重试次数已耗尽");
  };
}

async function extractMessages(page) {
  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".msgList-item-content"));
    const messages = [];
    const debugItems = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const parentRow = item.closest(".ant-row");
      if (!parentRow) {
        debugItems.push({ i, skip: "no-parentRow" });
        continue;
      }

      const className = parentRow.className || "";
      const isSelf = className.includes("ant-row-space-between");
      const isOther = className.includes("ant-row-start");
      if (!isSelf && !isOther) {
        debugItems.push({ i, skip: "no-self-or-other", className: className.slice(0, 80) });
        continue;
      }

      const wrap = item.querySelector(".msgList-item__wrap");
      if (!wrap) {
        debugItems.push({ i, skip: "no-wrap", isSelf, childClasses: Array.from(item.children).map(c => c.className).slice(0, 5) });
        continue;
      }

      const wrapText = (wrap.textContent || "").trim();
      let sender = "";
      let time = "";
      let content = "";

      const timePattern = /(?:\d{4}\/\d{2}\/\d{2}\s+)?\d{2}:\d{2}/;

      if (isSelf) {
        const match = wrapText.match(new RegExp("(" + timePattern.source + ")\\s+(.+?)（.+?）([\\s\\S]*)"));
        if (match) {
          time = match[1];
          sender = match[2];
          content = match[3].trim();
        }
      } else {
        const userDiv = item.children[0];
        sender = userDiv
          ? (userDiv.textContent || "")
              .trim()
              .replace("所属：无", "")
              .replace("@微信", "")
              .trim()
          : "unknown";

        const match = wrapText.match(new RegExp("(.+?)\\s+(" + timePattern.source + ")\\s+([\\s\\S]*)"));
        if (match) {
          time = match[2];
          content = match[3].trim();
        }
      }

      if (!content || !time) {
        debugItems.push({ i, skip: "no-content-or-time", isSelf, sender: sender.slice(0, 20), wrapSnippet: wrapText.slice(0, 150) });
        continue;
      }

      let fullTime = time;
      if (/^\d{2}:\d{2}$/.test(time)) {
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        fullTime = `${y}/${mo}/${d} ${time}`;
      }

      messages.push({
        domIndex: i,
        time: fullTime,
        sender: sender || "unknown",
        content,
        isSelf,
        source: "企业微信-青柠",
      });
    }

    return {
      bodyText: document.body?.innerText || "",
      messages,
      debugItems: debugItems.slice(0, 10),
    };
  });
}

async function captureScreenshot(page, domIndex, titleHint) {
  const locator = page.locator(".msgList-item-content").nth(domIndex);
  const exists = await locator.count();
  if (!exists) return null;
  const filename = `${Date.now()}-${sanitizeFilePart(titleHint || "message")}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  await locator.screenshot({ path: filePath });
  return filePath;
}

function buildDetailText(message) {
  return `[来源: ${message.source}] [时间: ${message.time}]\n\n原文：${message.content}`;
}

async function submitFeedback(
  apiUrl,
  operatorName,
  { sender, combinedText, startTime, source, screenshotPath, demandTitle },
  targetGroupName
) {
  const form = new FormData();
  form.append("user_nickname", sender);
  form.append("operator_name", operatorName);
  form.append("note", combinedText);
  form.append("source", "企业微信聚合网页");
  form.append("source_group", targetGroupName);
  form.append("source_time", startTime);
  form.append("source_sender", sender);
  form.append("auto_analyze", "true");
  if (demandTitle) {
    form.append("title", demandTitle);
  }

  if (screenshotPath && existsSync(screenshotPath)) {
    const bytes = await readFile(screenshotPath);
    const blob = new Blob([bytes], { type: mimeFromFilePath(screenshotPath) });
    form.append("screenshots", blob, path.basename(screenshotPath));
  }

  const res = await fetch(apiUrl, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`提交失败 HTTP ${res.status}: ${text}`);
  }
  return await res.json();
}

async function confirmPrompt(rl, text) {
  if (!rl) {
    log("当前不是交互终端，自动跳过提交确认并视为未确认。");
    return false;
  }
  const answer = (await rl.question(`${text} `)).trim().toLowerCase();
  return ["y", "yes"].includes(answer);
}

async function waitForManualReady(rl) {
  if (!rl) {
    log("当前不是交互终端，跳过手动确认提示，直接进行只读扫描。");
    return;
  }
  await rl.question("完成手动登录并打开目标群聊后，按 Enter 开始扫描...");
}

async function main() {
  await ensureRuntimeDirs();
  const env = await loadLocalEnv();

  const targetUrl = env.WECHAT_WORKBENCH_URL || "https://www.xunjinet.com.cn/app/quan-msgv2/";
  const targetGroupName = env.TARGET_GROUP_NAME || "";
  const feedbackApiUrl = env.FEEDBACK_API_URL || "http://127.0.0.1:3001/api/feedback";
  const operatorName = env.OPERATOR_NAME || "青柠";
  const dryRun = boolFromEnv(env.DRY_RUN, true);
  const requireConfirm = boolFromEnv(env.REQUIRE_CONFIRM, true);
  const singleRun = boolFromEnv(env.SINGLE_RUN, false);
  const pollIntervalMs = intFromEnv(env.POLL_INTERVAL_MS, 5 * 60 * 1000);
  const maxScanMessages = intFromEnv(env.MAX_SCAN_MESSAGES, 80);
  const classifyBatchSize = intFromEnv(env.CLASSIFY_BATCH_SIZE, 10);

  if (!["乌木", "青柠"].includes(operatorName)) {
    throw new Error('OPERATOR_NAME 只能是 "乌木" 或 "青柠"');
  }

  const apiKey = env.AI_API_KEY;
  const baseURL = env.AI_BASE_URL;
  const model = env.AI_MODEL || "gpt-4o";
  if (!apiKey || !baseURL) {
    throw new Error("缺少 AI_API_KEY 或 AI_BASE_URL，请先在 .env.local 中配置");
  }

  const sessionGapMinutes = intFromEnv(env.SESSION_GAP_MINUTES, 10);

  const client = new OpenAI({ apiKey, baseURL });
  const analyzeSessions = buildSessionAnalyzer(client, model);
  const state = await loadState();
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = isInteractive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  log(`启动半自动安全版脚本。DRY_RUN=${dryRun ? "true" : "false"}，REQUIRE_CONFIRM=${requireConfirm ? "true" : "false"}`);
  log(`目标页面: ${targetUrl}`);
  log(`目标群聊: ${targetGroupName}`);
  log("脚本不会自动发消息，也不会自动点开其他群。请你手动登录并手动打开目标群聊。");

  const systemProxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const launchOptions = {
    headless: false,
    viewport: null,
    ignoreHTTPSErrors: true,
    args: [
      "--ignore-certificate-errors",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  };
  if (systemProxy) {
    launchOptions.proxy = { server: systemProxy };
    log(`检测到系统代理: ${systemProxy}，已传递给浏览器。`);
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);

  const page = context.pages()[0] || (await context.newPage());

  const cleanup = async () => {
    try {
      await context.close();
    } catch {}
    rl?.close();
  };

  process.on("SIGINT", async () => {
    log("收到中断信号，正在安全退出...");
    await cleanup();
    process.exit(0);
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    log(
      `自动打开目标网页失败：${error instanceof Error ? error.message : String(error)}。你可以在打开的浏览器里手动进入该页面后继续扫描。`
    );
  }
  await waitForManualReady(rl);

  async function waitForPageReady(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log(`等待页面加载（第 ${attempt}/${maxRetries} 次）...`);
      try {
        await page.waitForSelector(".msgList-item-content", { timeout: 15000 });
        log("检测到消息元素，页面已就绪。");
        return true;
      } catch {
        const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        if (bodyText.includes("请求超时") || bodyText.includes("网络连接")) {
          log("页面显示网络超时，自动刷新重试...");
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await sleep(3000);
        } else if (attempt < maxRetries) {
          log("未检测到消息元素，等待后重试...");
          await sleep(5000);
        }
      }
    }
    log("页面加载超时，将尝试用当前状态继续扫描。");
    return false;
  }

  await waitForPageReady();

  while (true) {
    try {
      await waitForPageReady(2);

      const pageUrl = page.url();
      const pageTitle = await page.title().catch(() => "(unknown)");
      log(`[debug] URL: ${pageUrl}  title: ${pageTitle}`);

      const debugScreenPath = path.join(RUNTIME_DIR, "debug-page.png");
      await page.screenshot({ path: debugScreenPath, fullPage: false }).catch(() => {});

      const extracted = await extractMessages(page);

      if (extracted.debugItems?.length > 0) {
        log(`[debug] 消息提取诊断（${extracted.debugItems.length} 条被跳过）:`);
        for (const d of extracted.debugItems.slice(0, 5)) {
          log(`[debug]   #${d.i}: ${JSON.stringify(d)}`);
        }
      }
      log(`[debug] 成功提取 ${extracted.messages.length} 条消息`);
      if (targetGroupName) {
        const normalizedBody = extracted.bodyText.replace(/\s+/g, "");
        const normalizedGroup = targetGroupName.replace(/\s+/g, "");
        if (!normalizedBody.includes(normalizedGroup)) {
          log(`未在当前页面检测到群名"${targetGroupName}"。请确认你已经手动打开正确群聊。`);
        }
      }

      const recentMessages = extracted.messages.slice(-maxScanMessages);
      const unseen = recentMessages
        .filter((msg) => !msg.isSelf)
        .filter((msg) => !state.seenHashes[messageFingerprint(msg)]);

      if (unseen.length === 0) {
        log("没有发现新的未处理消息。");
      } else {
        log(`发现 ${unseen.length} 条新消息，开始归并会话并分析。`);
      }

      // ① 把所有未处理消息标记为已见
      for (const msg of unseen) {
        state.seenHashes[messageFingerprint(msg)] = new Date().toISOString();
      }

      // ② 归并同用户连续消息为会话
      const sessions = mergeSessionMessages(unseen, sessionGapMinutes);
      log(`归并为 ${sessions.length} 段用户会话。`);

      // ③ 分批发给 AI 做需求识别 + 多需求拆分
      const validCandidates = [];
      for (let start = 0; start < sessions.length; start += classifyBatchSize) {
        const batch = sessions.slice(start, start + classifyBatchSize);
        if (batch.length === 0) continue;
        try {
          const batchResult = await analyzeSessions(batch);
          for (const item of batchResult) {
            const sIdx = Number(item?.session_index);
            if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= batch.length) continue;
            if (!item?.is_valid) continue;
            const session = batch[sIdx];
            const demands = Array.isArray(item.demands) ? item.demands : [];
            if (demands.length === 0) continue;

            // 对第一个 DOM 节点尝试截图（可选，失败也不阻塞）
            let screenshotPath = null;
            if (session.domIndices.length > 0) {
              try {
                screenshotPath = await captureScreenshot(
                  page,
                  session.domIndices[0],
                  session.sender
                );
              } catch { /* 截图失败不影响提交 */ }
            }

            for (const demand of demands) {
              validCandidates.push({
                session,
                demandTitle: String(demand?.title || "").trim() || "待人工确认",
                reason: String(demand?.reason || "").trim(),
                screenshotPath,
              });
            }
          }
        } catch (err) {
          log(`AI 分析批次失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await saveState(state);

      if (validCandidates.length === 0) {
        log("没有识别出新的有效需求。");
      } else if (dryRun) {
        log(`识别到 ${validCandidates.length} 条有效需求（当前只预览，不提交）。`);
        for (const c of validCandidates) {
          console.log("");
          console.log("----- 预览 -----");
          console.log(`发送者: ${c.session.sender}`);
          console.log(`时间段: ${c.session.startTime} ~ ${c.session.endTime}`);
          console.log(`消息数: ${c.session.messages.length}`);
          console.log(`拆解标题: ${c.demandTitle}`);
          console.log(`理由: ${c.reason || "（无）"}`);
          console.log(`合并文本: ${c.session.combinedText.slice(0, 300)}`);
          console.log(`截图: ${c.screenshotPath || "无（纯文字提交）"}`);
        }
      } else {
        log(`识别到 ${validCandidates.length} 条需求，准备提交到本地后台。`);
        let shouldSubmit = true;
        if (requireConfirm) {
          shouldSubmit = await confirmPrompt(
            rl,
            `确认提交这 ${validCandidates.length} 条需求到本地后台吗？输入 y 确认:`
          );
        }
        if (!shouldSubmit) {
          log("你取消了本次提交。已处理的消息不会重复提交。");
        } else {
          for (const c of validCandidates) {
            try {
              const res = await submitFeedback(
                feedbackApiUrl,
                operatorName,
                {
                  sender: c.session.sender,
                  combinedText: c.session.combinedText,
                  startTime: c.session.startTime,
                  source: c.session.source,
                  screenshotPath: c.screenshotPath,
                  demandTitle: c.demandTitle,
                },
                targetGroupName
              );
              log(`提交成功: ${c.demandTitle} -> ${res?.item?.id || "unknown-id"}`);
            } catch (err) {
              log(`提交失败: ${c.demandTitle} - ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } catch (error) {
      log(`本轮扫描失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (singleRun) {
      log("SINGLE_RUN=true，脚本执行一次后退出。");
      break;
    }

    log(`等待 ${Math.round(pollIntervalMs / 1000)} 秒后进行下一轮扫描...`);
    await sleep(pollIntervalMs);
  }

  await cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
