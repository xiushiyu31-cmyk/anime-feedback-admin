import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import XLSX from "xlsx";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, ".runtime", "accuracy-eval");

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、“”"'\-_[\]（）()：:；;,.!?！？]/g, "");
}

function parseBool(value, fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(text);
}

function ngramSet(str, n) {
  const s = new Set();
  for (let i = 0; i <= str.length - n; i++) s.add(str.slice(i, i + n));
  return s;
}

function setJaccard(sa, sb) {
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const item of sa) if (sb.has(item)) intersection++;
  return intersection / (sa.size + sb.size - intersection);
}

function lcsRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return (2 * prev[n]) / (m + n);
}

function softMatch(actual, expected) {
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  if (!a && !e) return true;
  if (!a || !e) return false;
  if (a === e || a.includes(e) || e.includes(a)) return true;

  const bigramJ = setJaccard(ngramSet(a, 2), ngramSet(e, 2));
  if (bigramJ >= 0.3) return true;

  const charJ = setJaccard(new Set(a), new Set(e));
  if (charJ >= 0.35) return true;

  return lcsRatio(a, e) >= 0.45;
}

function toRows(datasetPath) {
  const ext = path.extname(datasetPath).toLowerCase();
  if (ext === ".csv") {
    return readCsvRows(datasetPath);
  }
  const workbook = XLSX.readFile(datasetPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function splitCsvLogicalLines(raw) {
  const lines = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      if (current.trim()) lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function readCsvRows(datasetPath) {
  const raw = readFileSync(datasetPath, "utf8").replace(/^\uFEFF/, "");
  const lines = splitCsvLogicalLines(raw);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = cells[i] ?? "";
    }
    return row;
  });
}

async function fileToDataUrl(filePath) {
  const bytes = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function analyzeOne(analyzeApiUrl, row) {
  const screenshotPath = String(row.screenshot_path ?? "").trim();
  const note = String(row.note ?? "").trim();

  const images = [];
  if (screenshotPath) {
    if (!existsSync(screenshotPath)) {
      throw new Error(`截图不存在: ${screenshotPath}`);
    }
    const dataUrl = await fileToDataUrl(screenshotPath);
    images.push({ type: "data_url", data_url: dataUrl });
  }

  if (images.length === 0 && !note) {
    throw new Error("该样本既没有截图也没有文字 (note)，无法评测");
  }

  let res;
  try {
    res = await fetch(analyzeApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, images }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接评测接口 ${analyzeApiUrl}：${msg}`);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/**
 * 把 expected_title / expected_category / expected_essence_key 里的多行或
 * "1、xxx\n2、yyy" 格式拆成数组，用于和 AI 返回的 demands 数组逐条对比。
 */
function splitExpected(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text
    .split(/\n/)
    .map((line) => line.replace(/^\d+[、.)\]]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * 对比一组期望需求和 AI 预测的 demands 数组。
 * 使用贪心匹配：对每条期望，在预测 demands 中找到最佳匹配（标题软匹配）。
 */
function compareDemands(expectedTitles, expectedCategories, expectedEssences, predictedDemands) {
  const demands = predictedDemands || [];
  const matched = new Set();
  const perDemand = [];
  const maxLen = Math.max(expectedTitles.length, 1);

  for (let i = 0; i < maxLen; i++) {
    const expTitle = expectedTitles[i] || "";
    const expCat = expectedCategories[i] || expectedCategories[0] || "";
    const expEss = expectedEssences[i] || "";

    let bestIdx = -1;
    let bestScore = -1;
    for (let j = 0; j < demands.length; j++) {
      if (matched.has(j)) continue;
      const d = demands[j];
      let score = 0;
      if (softMatch(d.summary || "", expTitle)) score += 3;
      if (normalizeText(d.category) === normalizeText(expCat)) score += 2;
      if (softMatch(d.essenceKey || "", expEss)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    const pred = bestIdx >= 0 ? demands[bestIdx] : null;
    if (bestIdx >= 0) matched.add(bestIdx);

    const titleOk = pred ? softMatch(pred.summary || "", expTitle) : false;
    const catOk = pred ? normalizeText(pred.category) === normalizeText(expCat) : false;
    const essOk = !expEss || (pred ? softMatch(pred.essenceKey || "", expEss) : false);

    perDemand.push({
      expected: { title: expTitle, category: expCat, essence_key: expEss },
      predicted: pred
        ? { title: pred.summary, category: pred.category, essence_key: pred.essenceKey }
        : null,
      title_matched: titleOk,
      category_matched: catOk,
      essence_matched: essOk,
    });
  }

  return perDemand;
}

async function main() {
  const datasetArg = process.argv[2];
  if (!datasetArg) {
    console.error("用法: npm run eval:analyze -- <dataset.csv|dataset.xlsx>");
    process.exit(1);
  }

  const datasetPath = path.isAbsolute(datasetArg) ? datasetArg : path.join(ROOT, datasetArg);
  if (!existsSync(datasetPath)) {
    console.error(`数据集文件不存在: ${datasetPath}`);
    process.exit(1);
  }

  const analyzeApiUrl = process.env.ANALYZE_API_URL || "http://127.0.0.1:3001/api/analyze";
  const rows = toRows(datasetPath);
  const enabledRows = rows.filter((row) => parseBool(row.enabled, true));
  const demandRows = enabledRows.filter((row) => parseBool(row.expected_is_demand, false));
  const nonDemandRows = enabledRows.filter((row) => !parseBool(row.expected_is_demand, false));

  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];
  let totalExpectedDemands = 0;
  let titlePass = 0;
  let categoryPass = 0;
  let essencePass = 0;
  let demandCountMatch = 0;
  let nonDemandCorrectlyFiltered = 0;

  console.log(`评测接口: ${analyzeApiUrl}`);
  console.log(`数据集: ${datasetPath}`);
  console.log(`启用样本数: ${enabledRows.length}`);
  console.log(`需求样本数: ${demandRows.length}`);
  console.log(`非需求样本数: ${nonDemandRows.length}`);
  console.log("");

  // 评测非需求样本：AI 应该返回空 demands
  for (const row of nonDemandRows) {
    const caseId = String(row.case_id ?? "").trim() || "(未命名)";
    try {
      const predicted = await analyzeOne(analyzeApiUrl, row);
      const demands = predicted.demands || [];
      const correct = demands.length === 0;
      if (correct) nonDemandCorrectlyFiltered += 1;

      results.push({
        case_id: caseId,
        type: "non_demand",
        pass: correct,
        predicted_demand_count: demands.length,
      });
      console.log(`${correct ? "PASS" : "FAIL"} ${caseId} (非需求, AI返回${demands.length}条)`);
    } catch (error) {
      results.push({
        case_id: caseId,
        type: "non_demand",
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`ERROR ${caseId}`);
    }
  }

  // 评测需求样本
  for (const row of demandRows) {
    const caseId = String(row.case_id ?? "").trim() || "(未命名)";
    try {
      const predicted = await analyzeOne(analyzeApiUrl, row);
      const demands = predicted.demands || [];

      const expTitles = splitExpected(row.expected_title);
      const expCats = splitExpected(row.expected_category);
      const expEssences = splitExpected(row.expected_essence_key);
      const expectedCount = Math.max(expTitles.length, 1);
      totalExpectedDemands += expectedCount;

      if (demands.length === expectedCount) demandCountMatch += 1;

      const comparison = compareDemands(expTitles, expCats, expEssences, demands);
      let allPass = true;
      for (const c of comparison) {
        if (c.title_matched) titlePass += 1;
        if (c.category_matched) categoryPass += 1;
        if (c.essence_matched) essencePass += 1;
        if (!c.title_matched || !c.category_matched) allPass = false;
      }

      results.push({
        case_id: caseId,
        type: "demand",
        pass: allPass,
        expected_demand_count: expectedCount,
        predicted_demand_count: demands.length,
        comparison,
      });
      console.log(
        `${allPass ? "PASS" : "FAIL"} ${caseId} (期望${expectedCount}条, AI返回${demands.length}条)`
      );
    } catch (error) {
      results.push({
        case_id: caseId,
        type: "demand",
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`ERROR ${caseId}`);
    }
  }

  const demandCount = demandRows.length;
  const nonDemandCount = nonDemandRows.length;

  const summary = {
    dataset: datasetPath,
    analyze_api_url: analyzeApiUrl,
    enabled_rows: enabledRows.length,
    demand_rows: demandCount,
    non_demand_rows: nonDemandCount,
    total_expected_demands: totalExpectedDemands,
    demand_count_match_rate: demandCount
      ? Number((demandCountMatch / demandCount).toFixed(4))
      : 0,
    title_soft_accuracy: totalExpectedDemands
      ? Number((titlePass / totalExpectedDemands).toFixed(4))
      : 0,
    category_exact_accuracy: totalExpectedDemands
      ? Number((categoryPass / totalExpectedDemands).toFixed(4))
      : 0,
    essence_soft_accuracy: totalExpectedDemands
      ? Number((essencePass / totalExpectedDemands).toFixed(4))
      : 0,
    non_demand_filter_accuracy: nonDemandCount
      ? Number((nonDemandCorrectlyFiltered / nonDemandCount).toFixed(4))
      : 0,
  };

  const report = {
    summary,
    failures: results.filter((r) => !r.pass),
    results,
    generated_at: new Date().toISOString(),
  };

  const reportPath = path.join(OUTPUT_DIR, "latest-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("");
  console.log("===== 评测结果 =====");
  console.log(JSON.stringify(summary, null, 2));

  const failures = report.failures.slice(0, 10);
  if (failures.length > 0) {
    console.log("");
    console.log("前 10 条失败样本:");
    for (const failure of failures) {
      console.log(`- ${failure.case_id}: ${failure.error ?? "字段不匹配"}`);
      if (failure.comparison) {
        for (const c of failure.comparison) {
          console.log(`  期望: ${c.expected.title} [${c.expected.category}]`);
          console.log(
            `  预测: ${c.predicted?.title ?? "(无)"} [${c.predicted?.category ?? "(无)"}]`
          );
          console.log(
            `  标题${c.title_matched ? "✓" : "✗"} 分类${c.category_matched ? "✓" : "✗"} 本质${c.essence_matched ? "✓" : "✗"}`
          );
        }
      }
    }
  }

  console.log("");
  console.log(`完整报告已写入: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
