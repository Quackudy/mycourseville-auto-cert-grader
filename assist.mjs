import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MYCOURSEVILLE_HOME = "https://www.mycourseville.com/";
const PROFILE_DIR = path.resolve(".browser-profile");
const TESSDATA_DIR = path.resolve("tessdata");
const OUTPUT_DIR = path.resolve("assist-reports");

function parseArgs(argv) {
  const options = { url: "", limit: Infinity, previewOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--limit") options.limit = Number(argv[++i]);
    else if (argv[i] === "--preview-only") options.previewOnly = true;
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
    .map((match) => match[1].trim().replace(/\s+/g, " "))
    .filter((name) => normalizeName(name).split(" ").length >= 2);
  if (parenthesized.length) return parenthesized.at(-1);
  const candidates = text
    .replace(/\b\d{8,12}\b/g, " ")
    .split(/[\n|]/)
    .map((name) => name.trim().replace(/\s+/g, " "))
    .filter((name) => normalizeName(name).split(" ").length >= 2);
  return candidates.at(-1) ?? "";
}

function hasExactNameMatch(ocrText, englishName) {
  const expected = normalizeName(englishName);
  return expected.split(" ").length >= 2 && normalizeName(ocrText).includes(expected);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeReport(reportPath, rows) {
  const columns = ["student_id", "name", "status", "reason", "grading_url", "submitted_url"];
  const csv = [columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\n");
  await writeFile(reportPath, `${csv}\n`, "utf8");
}

async function promptForReady(page) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nA dedicated browser window is open.");
  console.log("Log in and navigate to the submissions list for the assignment/module you want to grade.");
  console.log("After assisted mode starts, only your own click on MyCourseVille's Submit button can save a grade.\n");
  await terminal.question("Press Enter when the submissions table is visible... ");
  terminal.close();
  await page.bringToFront();
}

async function findSubmissionTable(page) {
  const tables = page.locator("table");
  for (let i = 0; i < (await tables.count()); i += 1) {
    const table = tables.nth(i);
    const text = (await table.innerText()).toLowerCase();
    if (text.includes("submission") && text.includes("grading") && text.includes("operations")) return table;
  }
  throw new Error("Could not find the submissions table. Nothing was changed.");
}

async function collectRows(page) {
  const table = await findSubmissionTable(page);
  const headers = (await table.locator("tr").first().locator("th,td").allInnerTexts()).map((value) =>
    value.trim().toLowerCase(),
  );
  const index = {
    id: headers.findIndex((value) => value === "id"),
    name: headers.findIndex((value) => value === "name"),
    submission: headers.findIndex((value) => value.includes("submission")),
    grading: headers.findIndex((value) => value.includes("grading")),
  };
  if (Object.values(index).some((value) => value < 0)) {
    throw new Error(`Unexpected table columns: ${headers.join(", ")}`);
  }

  const result = [];
  const rows = table.locator("tr").filter({ has: page.locator("td") });
  for (let i = 0; i < (await rows.count()); i += 1) {
    const cells = rows.nth(i).locator("td");
    if ((await cells.count()) <= Math.max(...Object.values(index))) continue;
    const submissionText = (await cells.nth(index.submission).innerText()).trim();
    const gradingText = (await cells.nth(index.grading).innerText()).trim();
    if (!submissionText || submissionText.toLowerCase() === "x") continue;
    if (gradingText && gradingText !== "-") continue;

    const anchor = cells.nth(index.grading).locator("a").first();
    result.push({
      id: (await cells.nth(index.id).innerText()).trim(),
      listName: (await cells.nth(index.name).innerText()).trim().replace(/\s+/g, " "),
      href: (await anchor.count()) ? await anchor.getAttribute("href") : null,
    });
  }
  return result;
}

async function extractDetail(page, fallbackName) {
  const bodyText = await page.locator("body").innerText();
  const heading = bodyText
    .split("\n")
    .filter((line) => /the work of/i.test(line))
    .join("\n");
  const englishName = extractEnglishName(heading) || extractEnglishName(fallbackName);

  const values = [];
  const controls = page.locator("textarea, input[type='text'], input:not([type])");
  for (let i = 0; i < (await controls.count()); i += 1) {
    const value = (await controls.nth(i).inputValue().catch(() => "")).trim();
    if (/^https?:\/\//i.test(value)) values.push(value);
  }
  const textUrls = bodyText.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const urls = [...new Set([...values, ...textUrls])].map((url) => url.replace(/[),.;]+$/, ""));
  if (!englishName) return { reason: "English name not found" };
  if (urls.length !== 1) {
    return { englishName, reason: urls.length ? `Found ${urls.length} URLs` : "Submission URL not found" };
  }
  return { englishName, url: urls[0], reason: "" };
}

async function downloadDirectImage(context, url, destination) {
  let response;
  try {
    response = await context.request.get(url, { timeout: 30_000, failOnStatusCode: false });
  } catch (error) {
    return { reason: `Link failed: ${error.message}` };
  }
  if (response.status() < 200 || response.status() >= 300) return { reason: `HTTP ${response.status()}` };
  const contentType = (response.headers()["content-type"] ?? "").split(";")[0].toLowerCase();
  if (!contentType.startsWith("image/")) return { reason: `Not a direct image (${contentType || "unknown"})` };
  const bytes = await response.body();
  if (bytes.length < 1_000) return { reason: "Image is unexpectedly small" };
  await writeFile(destination, bytes);
  return { bytes, contentType, reason: "" };
}

async function runOcr(imagePath, workDir) {
  const outputBase = path.join(workDir, "ocr");
  await execFileAsync(
    "tesseract",
    [imagePath, outputBase, "--tessdata-dir", TESSDATA_DIR, "-l", "eng", "--psm", "3"],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return (await readFile(`${outputBase}.txt`, "utf8")).trim();
}

async function findScoreInput(page) {
  const inputs = page.locator("input[type='number'], input[type='text'], input:not([type])");
  for (let i = 0; i < (await inputs.count()); i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible()) || !(await input.isEnabled())) continue;
    const info = await input.evaluate((element) => {
      let container = element;
      for (let depth = 0; depth < 5 && container; depth += 1) {
        const text = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
        if (/points awarded/i.test(text)) {
          return {
            nearbyText: text,
            max: element.getAttribute("max") || "",
            name: element.getAttribute("name") || "",
            value: element.value || "",
          };
        }
        container = container.parentElement;
      }
      return null;
    });
    if (!info) continue;
    const isOutOfOne = info.max === "1" || /\/\s*1(?:\D|$)/.test(info.nearbyText);
    if (isOutOfOne) return { locator: input, ...info };
  }
  return null;
}

async function findSubmitButton(page) {
  const candidates = page.locator("button, input[type='submit'], input[type='button']");
  for (let i = 0; i < (await candidates.count()); i += 1) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible()) || !(await candidate.isEnabled())) continue;
    const label = await candidate.evaluate((element) =>
      (element.innerText || element.value || element.getAttribute("aria-label") || "").trim(),
    );
    if (/^submit$/i.test(label)) return candidate;
  }
  return null;
}

async function showOverlay(page, { englishName, imageBytes, contentType, previewOnly, progress }) {
  const imageData = `data:${contentType};base64,${imageBytes.toString("base64")}`;
  await page.evaluate(
    ({ name, src, isPreviewOnly, progressText }) => {
      document.getElementById("mcv-assist-panel")?.remove();
      const panel = document.createElement("aside");
      panel.id = "mcv-assist-panel";
      panel.innerHTML = `
        <style>
          #mcv-assist-panel { position:fixed; inset:38px auto 12px 8px; width:40vw; z-index:2147483647;
            background:#fff; border:3px solid #138ad1; border-radius:8px; box-shadow:0 8px 30px #0005;
            display:flex; flex-direction:column; font:14px/1.35 Arial,sans-serif; color:#18202a; }
          #mcv-assist-panel header { padding:10px 12px; background:#eaf7ff; border-bottom:1px solid #9bd5f5; }
          #mcv-assist-panel .mcv-name { font-size:22px; font-weight:700; margin:3px 0; }
          #mcv-assist-panel .mcv-safe { color:#087b35; font-weight:700; }
          #mcv-assist-panel .mcv-image { flex:1; min-height:0; padding:8px; background:#222; text-align:center; overflow:auto; }
          #mcv-assist-panel img { max-width:100%; min-width:70%; height:auto; background:white; }
          #mcv-assist-panel footer { padding:8px 10px; display:flex; gap:8px; align-items:center; }
          #mcv-assist-panel button { padding:7px 12px; cursor:pointer; }
          #mcv-assist-panel .mcv-stop { margin-left:auto; }
        </style>
        <header>
          <div>${progressText}</div>
          <div class="mcv-name"></div>
          <div class="mcv-safe">Direct image + exact OCR name match</div>
          <div>${isPreviewOnly ? "PREVIEW ONLY — score was not filled" : "Score 1 is prefilled. Inspect the certificate, then click MyCourseVille’s native Submit button."}</div>
        </header>
        <div class="mcv-image"><img alt="Submitted certificate"></div>
        <footer>
          <button type="button" data-action="skip">Skip for manual review</button>
          <button type="button" data-action="open">Open original image</button>
          <button type="button" data-action="stop" class="mcv-stop">Stop assistant</button>
        </footer>`;
      panel.querySelector(".mcv-name").textContent = name;
      panel.querySelector("img").src = src;
      panel.querySelector('[data-action="open"]').addEventListener("click", () => window.open(src, "_blank"));
      panel.querySelector('[data-action="skip"]').addEventListener("click", () => window.__mcvAssistEvent("skip"));
      panel.querySelector('[data-action="stop"]').addEventListener("click", () => window.__mcvAssistEvent("stop"));
      document.body.appendChild(panel);
    },
    { name: englishName, src: imageData, isPreviewOnly: previewOnly, progressText: progress },
  );
}

async function showIssueOverlay(page, { englishName, reason, submittedUrl, imageBytes, contentType, progress }) {
  const imageData = imageBytes ? `data:${contentType};base64,${imageBytes.toString("base64")}` : "";
  await page.evaluate(
    ({ name, issue, url, src, progressText }) => {
      document.getElementById("mcv-assist-panel")?.remove();
      const panel = document.createElement("aside");
      panel.id = "mcv-assist-panel";
      panel.innerHTML = `
        <style>
          #mcv-assist-panel { position:fixed; inset:38px auto 12px 8px; width:40vw; z-index:2147483647;
            background:#fff; border:4px solid #d97904; border-radius:8px; box-shadow:0 8px 30px #0005;
            display:flex; flex-direction:column; font:14px/1.35 Arial,sans-serif; color:#18202a; }
          #mcv-assist-panel header { padding:10px 12px; background:#fff3df; border-bottom:1px solid #e5b66f; }
          #mcv-assist-panel .mcv-name { font-size:22px; font-weight:700; margin:3px 0; }
          #mcv-assist-panel .mcv-issue { color:#9b3f00; font-size:17px; font-weight:700; }
          #mcv-assist-panel .mcv-url { margin-top:6px; overflow-wrap:anywhere; font-size:12px; }
          #mcv-assist-panel .mcv-image { flex:1; min-height:0; padding:8px; background:#222; text-align:center; overflow:auto; }
          #mcv-assist-panel img { max-width:100%; min-width:70%; height:auto; background:white; }
          #mcv-assist-panel .mcv-empty { flex:1; padding:30px 15px; font-size:22px; text-align:center; color:#9b3f00; }
          #mcv-assist-panel footer { padding:8px 10px; display:flex; gap:8px; align-items:center; }
          #mcv-assist-panel button { padding:8px 12px; cursor:pointer; }
          #mcv-assist-panel .mcv-stop { margin-left:auto; }
        </style>
        <header>
          <div>${progressText} · MANUAL REVIEW REQUIRED</div>
          <div class="mcv-name"></div>
          <div class="mcv-issue"></div>
          <div class="mcv-url"></div>
        </header>
        ${src ? '<div class="mcv-image"><img alt="Submitted certificate"></div>' : '<div class="mcv-empty">Certificate image cannot be displayed automatically.</div>'}
        <footer>
          <button type="button" data-action="next">Leave ungraded and continue</button>
          <button type="button" data-action="open">Open submitted link</button>
          <button type="button" data-action="stop" class="mcv-stop">Stop assistant</button>
        </footer>`;
      panel.querySelector(".mcv-name").textContent = name || "Student name unavailable";
      panel.querySelector(".mcv-issue").textContent = issue;
      panel.querySelector(".mcv-url").textContent = url || "No submitted URL was detected.";
      const image = panel.querySelector("img");
      if (image) image.src = src;
      const openButton = panel.querySelector('[data-action="open"]');
      if (!url) openButton.disabled = true;
      openButton.addEventListener("click", () => {
        if (url) window.open(url, "_blank", "noopener");
      });
      panel.querySelector('[data-action="next"]').addEventListener("click", () => window.__mcvAssistEvent("skip"));
      panel.querySelector('[data-action="stop"]').addEventListener("click", () => window.__mcvAssistEvent("stop"));
      document.body.appendChild(panel);
    },
    {
      name: englishName,
      issue: reason,
      url: submittedUrl,
      src: imageData,
      progressText: progress,
    },
  );
}

async function setScoreWithoutEvents(scoreInput) {
  return scoreInput.locator.evaluate((element) => {
    if (String(element.value || "").trim()) return false;
    // Deliberately do not dispatch input/change events. This updates only the
    // visible form value; the website receives it only if the user clicks Submit.
    element.value = "1";
    element.style.outline = "3px solid #1aa34a";
    element.style.background = "#effff3";
    return true;
  });
}

async function attachManualSubmitListener(page, submitButton) {
  await submitButton.evaluate((element) => {
    element.style.outline = "3px solid #138ad1";
    element.addEventListener(
      "click",
      () => {
        window.__mcvAssistEvent("submit-click");
      },
      { once: true, capture: true },
    );
  });
}

function watchForSaveResponse(page, scoreFieldName) {
  return page
    .waitForResponse(
      (response) => {
        const request = response.request();
        if (request.method() !== "POST") return false;
        const url = request.url();
        if (url.includes("courseville/ajax/refreshsider") || url.includes("/cdn-cgi/rum")) return false;
        const data = request.postData() || "";
        if (!scoreFieldName) return true;
        return data.includes(encodeURIComponent(scoreFieldName)) || data.includes(scoreFieldName);
      },
      { timeout: 30_000 },
    )
    .catch(() => null);
}

async function waitForSave(page, responsePromise, previousUpdatedText) {
  const response = await responsePromise;
  if (!response || response.status() >= 400) return { ok: false, reason: "No successful grade-saving response detected" };
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const updated = bodyText.match(/Grading updated at[^\n]*/i)?.[0] ?? "";
  if (!updated || updated === previousUpdatedText) {
    return { ok: false, reason: "MyCourseVille did not show a new grading confirmation" };
  }
  return { ok: true, reason: updated };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run assist -- [--url ASSIGNMENT_SUBMISSIONS_URL] [--limit N] [--preview-only]");
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, `${timestamp()}.csv`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcv-assist-"));
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
  const page = context.pages()[0] ?? (await context.newPage());
  let resolveUiEvent = null;
  await page.exposeBinding("__mcvAssistEvent", (_source, type) => {
    if (resolveUiEvent) resolveUiEvent(type);
  });

  const report = [];
  try {
    await page.goto(options.url || MYCOURSEVILLE_HOME, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await promptForReady(page);
    const listUrl = page.url();
    console.log(`Selected assignment page: ${listUrl}`);
    const rows = (await collectRows(page)).slice(0, options.limit);
    console.log(`Assisted queue: ${rows.length} submitted, apparently ungraded row(s).`);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const base = {
        student_id: row.id,
        name: row.listName,
        status: "SKIPPED",
        reason: "",
        grading_url: "",
        submitted_url: "",
      };
      const skip = async (reason) => {
        report.push({ ...base, reason });
        await writeReport(reportPath, report);
        console.log(`[${index + 1}/${rows.length}] skipped ${row.id}: ${reason}`);
      };
      const reviewIssue = async (reason, image = null) => {
        const uiEventPromise = new Promise((resolve) => {
          resolveUiEvent = resolve;
        });
        await showIssueOverlay(page, {
          englishName: base.name,
          reason,
          submittedUrl: base.submitted_url,
          imageBytes: image?.bytes,
          contentType: image?.contentType,
          progress: `${index + 1} of ${rows.length}`,
        });
        console.log(`[${index + 1}/${rows.length}] manual review: ${row.id}: ${reason}`);
        const event = await uiEventPromise;
        resolveUiEvent = null;
        report.push({
          ...base,
          status: event === "stop" ? "STOPPED" : "MANUAL_REVIEW_REQUIRED",
          reason,
        });
        await writeReport(reportPath, report);
        return event;
      };

      if (!row.href) {
        const event = await reviewIssue("No grading-page link found");
        if (event === "stop") break;
        continue;
      }
      const gradingUrl = new URL(row.href, listUrl).href;
      base.grading_url = gradingUrl;
      await page.goto(gradingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const detail = await extractDetail(page, row.listName);
      base.name = detail.englishName || row.listName;
      base.submitted_url = detail.url || "";
      if (detail.reason) {
        const event = await reviewIssue(detail.reason);
        if (event === "stop") break;
        continue;
      }

      // Avoid link downloads and OCR for rows that have already been graded.
      const earlyScoreInput = await findScoreInput(page);
      if (earlyScoreInput && String(earlyScoreInput.value || "").trim()) {
        await skip("Score field is already populated; refusing to overwrite it");
        continue;
      }

      const imagePath = path.join(tempRoot, `${row.id.replace(/[^A-Za-z0-9_-]/g, "_")}.img`);
      const image = await downloadDirectImage(context, detail.url, imagePath);
      if (image.reason) {
        const event = await reviewIssue(image.reason);
        if (event === "stop") break;
        continue;
      }
      let ocrText;
      try {
        const ocrDir = await mkdtemp(path.join(tempRoot, "ocr-"));
        ocrText = await runOcr(imagePath, ocrDir);
      } catch (error) {
        const event = await reviewIssue(`OCR failed: ${error.message}`, image);
        if (event === "stop") break;
        continue;
      }
      if (!hasExactNameMatch(ocrText, detail.englishName)) {
        const event = await reviewIssue("Exact English full name not found by OCR", image);
        if (event === "stop") break;
        continue;
      }

      const scoreInput = earlyScoreInput ?? (await findScoreInput(page));
      const submitButton = await findSubmitButton(page);
      if (!scoreInput) {
        const event = await reviewIssue("Blank /1 score field not found safely", image);
        if (event === "stop") break;
        continue;
      }
      if (!submitButton) {
        const event = await reviewIssue("Native Submit button not found safely", image);
        if (event === "stop") break;
        continue;
      }

      const previousBody = await page.locator("body").innerText();
      const previousUpdatedText = previousBody.match(/Grading updated at[^\n]*/i)?.[0] ?? "";
      await showOverlay(page, {
        englishName: detail.englishName,
        imageBytes: image.bytes,
        contentType: image.contentType,
        previewOnly: options.previewOnly,
        progress: `${index + 1} of ${rows.length}`,
      });
      if (!options.previewOnly) {
        const filled = await setScoreWithoutEvents(scoreInput);
        if (!filled) {
          await skip("Score changed before prefill; refusing to overwrite it");
          continue;
        }
      } else {
        await submitButton.evaluate((element) => {
          element.disabled = true;
          element.title = "Disabled during assisted preview-only test";
        });
      }
      const uiEventPromise = new Promise((resolve) => {
        resolveUiEvent = resolve;
      });
      const saveResponsePromise = options.previewOnly
        ? null
        : watchForSaveResponse(page, scoreInput.name);
      if (!options.previewOnly) await attachManualSubmitListener(page, submitButton);
      console.log(`[${index + 1}/${rows.length}] ready for your review: ${row.id} ${detail.englishName}`);

      const event = await uiEventPromise;
      resolveUiEvent = null;
      if (event === "stop") {
        report.push({ ...base, status: "STOPPED", reason: "Stopped by user before submission" });
        await writeReport(reportPath, report);
        console.log("Stopped by user.");
        break;
      }
      if (event === "skip") {
        await skip("Skipped manually during visual review");
        continue;
      }
      if (options.previewOnly) {
        await skip("Preview-only mode; submission was not tracked");
        continue;
      }

      const save = await waitForSave(page, saveResponsePromise, previousUpdatedText);
      if (!save.ok) {
        report.push({ ...base, status: "SAVE_UNCONFIRMED", reason: save.reason });
        await writeReport(reportPath, report);
        await page.evaluate((message) => {
          const panel = document.getElementById("mcv-assist-panel");
          if (panel) {
            panel.querySelector(".mcv-safe").textContent = `STOPPED: ${message}`;
            panel.querySelector(".mcv-safe").style.color = "#b00020";
          }
        }, save.reason);
        console.error(`Save not confirmed for ${row.id}: ${save.reason}`);
        break;
      }

      report.push({ ...base, status: "USER_SUBMITTED_1", reason: save.reason });
      await writeReport(reportPath, report);
      console.log(`[${index + 1}/${rows.length}] save confirmed; opening next eligible student.`);
    }
    console.log(`Report: ${reportPath}`);
    console.log("Assisted session finished.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await context.close();
  }
}

export {
  collectRows,
  csvCell,
  extractDetail,
  findScoreInput,
  findSubmitButton,
  normalizeName,
  runOcr,
  timestamp,
  waitForSave,
  watchForSaveResponse,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nStopped safely: ${error.message}`);
    process.exitCode = 1;
  });
}
