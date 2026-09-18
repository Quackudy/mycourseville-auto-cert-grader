import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_URL =
  "https://www.mycourseville.com/?q=courseville/course/81802/submission_2084330";
const OUTPUT_DIR = path.resolve("reports");
const PROFILE_DIR = path.resolve(".browser-profile");
const TESSDATA_DIR = path.resolve("tessdata");

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, limit: Infinity, keepImages: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--limit") options.limit = Number(argv[++i]);
    else if (argv[i] === "--no-images") options.keepImages = false;
    else if (argv[i] === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.help && ((!Number.isFinite(options.limit) && options.limit !== Infinity) || options.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  return options;
}

function normalizeName(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractEnglishName(text) {
  const parenthesized = [...text.matchAll(/\(([A-Za-z][A-Za-z .'-]{2,})\)/g)]
    .map((match) => normalizeName(match[1]))
    .filter((name) => name.split(" ").length >= 2);
  if (parenthesized.length) return parenthesized.at(-1);

  const withoutId = text.replace(/\b\d{8,12}\b/g, " ");
  const candidates = withoutId
    .split(/[\n|]/)
    .map(normalizeName)
    .filter((name) => name.split(" ").length >= 2);
  return candidates.at(-1) ?? "";
}

function hasConservativeNameMatch(ocrText, englishName) {
  const expected = normalizeName(englishName);
  const actual = normalizeName(ocrText);
  if (!expected || expected.split(" ").length < 2) return false;
  return actual.includes(expected);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function promptForReady(page) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nA browser window is open.");
  console.log("1. Log in manually if needed.");
  console.log("2. Navigate to the assignment submissions list.");
  console.log("3. Return here. The scanner will not make any website changes.\n");
  await terminal.question("Press Enter when the submissions table is visible... ");
  terminal.close();
  await page.bringToFront();
}

async function installReadOnlyGuard(context) {
  await context.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.continue();
      return;
    }
    console.error(`BLOCKED ${method} ${route.request().url()}`);
    await route.abort("blockedbyclient");
  });
}

async function findSubmissionTable(page) {
  const tables = page.locator("table");
  for (let i = 0; i < (await tables.count()); i += 1) {
    const table = tables.nth(i);
    const text = (await table.innerText()).toLowerCase();
    if (text.includes("submission") && text.includes("grading") && text.includes("operations")) {
      return table;
    }
  }
  throw new Error("Could not find the submissions table. No pages were scanned.");
}

async function collectRows(page) {
  const table = await findSubmissionTable(page);
  const headers = (await table.locator("tr").first().locator("th,td").allInnerTexts()).map((v) =>
    v.trim().toLowerCase(),
  );
  const index = {
    id: headers.findIndex((v) => v === "id"),
    name: headers.findIndex((v) => v === "name"),
    submission: headers.findIndex((v) => v.includes("submission")),
    grading: headers.findIndex((v) => v.includes("grading")),
  };
  if (Object.values(index).some((value) => value < 0)) {
    throw new Error(`Unexpected table columns: ${headers.join(", ")}`);
  }

  const result = [];
  const rows = table.locator("tr").filter({ has: page.locator("td") });
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    if ((await cells.count()) <= Math.max(...Object.values(index))) continue;

    const id = (await cells.nth(index.id).innerText()).trim();
    const listName = (await cells.nth(index.name).innerText()).trim().replace(/\s+/g, " ");
    const submissionText = (await cells.nth(index.submission).innerText()).trim();
    const gradingText = (await cells.nth(index.grading).innerText()).trim();
    const submitted = submissionText !== "" && submissionText.toLowerCase() !== "x";
    const ungraded = gradingText === "" || gradingText === "-";
    if (!submitted || !ungraded) continue;

    const gradingCell = cells.nth(index.grading);
    const anchor = gradingCell.locator("a").first();
    const href = (await anchor.count()) ? await anchor.getAttribute("href") : null;
    result.push({ id, listName, submissionText, href });
  }
  return result;
}

async function extractDetail(page, fallback) {
  const bodyText = await page.locator("body").innerText();
  const headingLines = bodyText
    .split("\n")
    .filter((line) => /the work of/i.test(line));
  const englishName = extractEnglishName(headingLines.join("\n")) || extractEnglishName(fallback.listName);

  const controls = page.locator("textarea, input[type='text'], input:not([type])");
  const values = [];
  for (let i = 0; i < (await controls.count()); i += 1) {
    const value = (await controls.nth(i).inputValue().catch(() => "")).trim();
    if (/^https?:\/\//i.test(value)) values.push(value);
  }
  const textUrls = bodyText.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const urls = [...new Set([...values, ...textUrls])].map((url) => url.replace(/[),.;]+$/, ""));

  if (!englishName) return { englishName: "", url: "", reason: "English name not found" };
  if (urls.length !== 1) {
    return {
      englishName,
      url: urls[0] ?? "",
      reason: urls.length ? `Ambiguous: found ${urls.length} URLs` : "Submission URL not found",
    };
  }
  return { englishName, url: urls[0], reason: "" };
}

async function downloadDirectImage(context, url, destination) {
  let response;
  try {
    response = await context.request.get(url, { timeout: 30_000, failOnStatusCode: false });
  } catch (error) {
    return { ok: false, reason: `Link request failed: ${error.message}` };
  }
  const status = response.status();
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `Link returned HTTP ${status}` };
  }
  const contentType = (response.headers()["content-type"] ?? "").split(";")[0].toLowerCase();
  if (!contentType.startsWith("image/")) {
    return { ok: false, reason: `Not a direct image (${contentType || "unknown content type"})` };
  }
  const bytes = await response.body();
  if (bytes.length < 1_000) return { ok: false, reason: "Image response is unexpectedly small" };
  await writeFile(destination, bytes);
  return { ok: true, contentType, bytes: bytes.length };
}

async function runOcr(imagePath, workDir) {
  const outputBase = path.join(workDir, "ocr");
  try {
    await execFileAsync(
      "tesseract",
      [imagePath, outputBase, "--tessdata-dir", TESSDATA_DIR, "-l", "eng", "--psm", "3"],
      {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      },
    );
    return (await readFile(`${outputBase}.txt`, "utf8")).trim();
  } catch (error) {
    throw new Error(`OCR failed: ${error.stderr?.trim() || error.message}`);
  }
}

async function scanOne(context, listPage, row, runDir, tempRoot) {
  const base = {
    student_id: row.id,
    list_name: row.listName,
    english_name: "",
    submitted_url: "",
    result: "MANUAL_REVIEW",
    reason: "",
    image_file: "",
    ocr_text_file: "",
  };
  if (!row.href) return { ...base, reason: "No grading-page link found in row" };

  const detailPage = await context.newPage();
  try {
    const detailUrl = new URL(row.href, listPage.url()).href;
    await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const detail = await extractDetail(detailPage, row);
    base.english_name = detail.englishName;
    base.submitted_url = detail.url;
    if (detail.reason) return { ...base, reason: detail.reason };

    const safeId = row.id.replace(/[^A-Za-z0-9_-]/g, "_") || createHash("sha256").update(row.listName).digest("hex").slice(0, 12);
    const imagePath = path.join(runDir, "images", `${safeId}.img`);
    const download = await downloadDirectImage(context, detail.url, imagePath);
    if (!download.ok) return { ...base, reason: download.reason };

    const studentTemp = await mkdtemp(path.join(tempRoot, `${safeId}-`));
    let ocrText;
    try {
      ocrText = await runOcr(imagePath, studentTemp);
    } catch (error) {
      return { ...base, image_file: path.relative(runDir, imagePath), reason: error.message };
    }
    const ocrPath = path.join(runDir, "ocr", `${safeId}.txt`);
    await writeFile(ocrPath, `${ocrText}\n`, "utf8");
    base.image_file = path.relative(runDir, imagePath);
    base.ocr_text_file = path.relative(runDir, ocrPath);

    if (!hasConservativeNameMatch(ocrText, detail.englishName)) {
      return { ...base, reason: "Exact normalized English full name not found by OCR" };
    }
    return {
      ...base,
      result: "ELIGIBLE_FOR_1_REVIEW",
      reason: "Direct readable image; exact normalized English full name found by OCR",
    };
  } catch (error) {
    return { ...base, reason: `Scanner error: ${error.message}` };
  } finally {
    await detailPage.close();
  }
}

async function writeReports(runDir, metadata, rows) {
  await writeFile(path.join(runDir, "results.json"), JSON.stringify({ metadata, rows }, null, 2));
  const columns = [
    "student_id",
    "list_name",
    "english_name",
    "result",
    "reason",
    "submitted_url",
    "image_file",
    "ocr_text_file",
  ];
  const csv = [columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\n");
  await writeFile(path.join(runDir, "results.csv"), `${csv}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run scan -- [--url URL] [--limit N] [--no-images]");
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const runDir = path.join(OUTPUT_DIR, timestamp());
  await mkdir(path.join(runDir, "images"), { recursive: true });
  await mkdir(path.join(runDir, "ocr"), { recursive: true });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcv-cert-reader-"));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  try {
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await promptForReady(page);

    // Installed only after login so authentication can proceed normally. From this
    // point onward, every state-changing HTTP method is blocked at browser level.
    await installReadOnlyGuard(context);
    const rows = (await collectRows(page)).slice(0, options.limit);
    console.log(`Found ${rows.length} submitted, apparently ungraded row(s).`);

    const results = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      process.stdout.write(`[${i + 1}/${rows.length}] ${row.id} ${row.listName} ... `);
      const result = await scanOne(context, page, row, runDir, tempRoot);
      results.push(result);
      console.log(`${result.result}: ${result.reason}`);
      await writeReports(
        runDir,
        { created_at: new Date().toISOString(), source_url: page.url(), read_only: true },
        results,
      );
    }

    if (!options.keepImages) await rm(path.join(runDir, "images"), { recursive: true, force: true });
    const eligible = results.filter((row) => row.result === "ELIGIBLE_FOR_1_REVIEW").length;
    console.log(`\nDone. ${eligible} eligible candidate(s); ${results.length - eligible} manual review.`);
    console.log(`Report: ${path.join(runDir, "results.csv")}`);
  } finally {
    await context.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\nStopped safely: ${error.message}`);
  process.exitCode = 1;
});
