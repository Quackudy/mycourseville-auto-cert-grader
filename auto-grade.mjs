import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
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
} from "./assist.mjs";

const HOME_URL = "https://www.mycourseville.com/";
const PROFILE_DIR = path.resolve(".browser-profile");
const OUTPUT_DIR = path.resolve("auto-grade-reports");
const OFFICIAL_CERT_HOST = "mycourseville-default.s3.ap-southeast-1.amazonaws.com";
const MIN_IMAGE_BYTES = 100_000;
const MAX_IMAGE_BYTES = 1_000_000;
const REQUIRED_WIDTH = 2400;
const REQUIRED_HEIGHT = 1600;

function parseArgs(argv) {
  const options = {
    url: "",
    courseCode: "",
    moduleNumber: "",
    offset: 0,
    limit: Infinity,
    delayMs: 3000,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--course") options.courseCode = argv[++i];
    else if (argv[i] === "--module") options.moduleNumber = argv[++i];
    else if (argv[i] === "--offset") options.offset = Number(argv[++i]);
    else if (argv[i] === "--limit") options.limit = Number(argv[++i]);
    else if (argv[i] === "--delay-ms") options.delayMs = Number(argv[++i]);
    else if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.help && ((!Number.isFinite(options.limit) && options.limit !== Infinity) || options.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  if (!options.help && (!Number.isInteger(options.offset) || options.offset < 0)) {
    throw new Error("--offset must be a non-negative integer");
  }
  if (!options.help && options.moduleNumber && !/^[1-9]\d*$/.test(options.moduleNumber)) {
    throw new Error("--module must be a positive integer");
  }
  if (!options.help && options.courseCode && !/^\d{7}$/.test(options.courseCode)) {
    throw new Error("--course must be exactly seven digits");
  }
  if (!options.help && (!Number.isInteger(options.delayMs) || options.delayMs < 1000 || options.delayMs > 30_000)) {
    throw new Error("--delay-ms must be an integer between 1000 and 30000");
  }
  return options;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactToken(text, token) {
  return new RegExp(`(?:^|\\D)${escapeRegex(token)}(?:\\D|$)`).test(text);
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function validateCertificateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "Malformed URL";
  }
  if (url.protocol !== "https:") return "Certificate URL is not HTTPS";
  if (url.hostname !== OFFICIAL_CERT_HOST) return `Unapproved certificate host: ${url.hostname}`;
  if (url.username || url.password || url.port) return "Certificate URL contains credentials or a custom port";
  const pathPattern = /^\/system_course_files\/\d{4}_\d+\/\d+\/cvcert_usercert\/certificate_[A-Za-z0-9_-]+\.jpg$/;
  if (!pathPattern.test(url.pathname)) return "URL is not an official generated-certificate path";
  if (url.search || url.hash) return "Certificate URL contains unexpected query or fragment data";
  return "";
}

async function downloadStrictCertificate(context, url, destination) {
  const urlProblem = validateCertificateUrl(url);
  if (urlProblem) return { reason: urlProblem };

  let response;
  try {
    response = await context.request.get(url, {
      timeout: 30_000,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
  } catch (error) {
    return { reason: `Certificate request failed: ${error.message}` };
  }
  if (response.status() !== 200) return { reason: `Certificate returned HTTP ${response.status()}` };
  const contentType = (response.headers()["content-type"] ?? "").split(";")[0].toLowerCase();
  if (contentType !== "image/jpeg") return { reason: `Expected JPEG, received ${contentType || "unknown type"}` };
  const declaredLength = Number(response.headers()["content-length"] || 0);
  if (declaredLength && (declaredLength < MIN_IMAGE_BYTES || declaredLength > MAX_IMAGE_BYTES)) {
    return { reason: `Unexpected declared image size: ${declaredLength} bytes` };
  }

  const bytes = await response.body();
  if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) {
    return { reason: `Unexpected image size: ${bytes.length} bytes` };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    return { reason: "JPEG magic bytes or end marker are invalid" };
  }
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== REQUIRED_WIDTH || dimensions.height !== REQUIRED_HEIGHT) {
    return {
      reason: `Unexpected image dimensions: ${dimensions ? `${dimensions.width}x${dimensions.height}` : "unreadable"}`,
    };
  }
  await writeFile(destination, bytes);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    reason: "",
  };
}

async function detectAssignment(page, requestedModuleNumber, requestedCourseCode) {
  const bodyText = await page.locator("body").innerText();
  const moduleMatches = [...bodyText.matchAll(/(?:certificate\s+)?module\s*(\d+)/gi)].map((match) => match[1]);
  const moduleNumbers = [...new Set(moduleMatches)];
  if (requestedModuleNumber && !moduleNumbers.includes(requestedModuleNumber)) {
    throw new Error(
      `Selected page does not mention requested Module ${requestedModuleNumber} (found: ${moduleNumbers.join(", ") || "none"})`,
    );
  }
  if (!requestedModuleNumber && moduleNumbers.length !== 1) {
    throw new Error(`Could not identify exactly one module number (found: ${moduleNumbers.join(", ") || "none"})`);
  }

  const courseHomeMatch = bodyText.match(/(?:^|\n)\s*(\d{7})\s*\(\d{4}\/\d+\)\s*\|\s*Home\b/i);
  const selectedOptions = await page.locator("select:visible option:checked").allInnerTexts();
  const preferredCourseCodes = selectedOptions.flatMap((text) => text.match(/\b\d{7}\b/g) ?? []);
  const bodyCourseCodes = bodyText.match(/\b\d{7}\b/g) ?? [];
  if (requestedCourseCode && !bodyCourseCodes.includes(requestedCourseCode)) {
    throw new Error(`Selected page does not mention requested course ${requestedCourseCode}`);
  }
  const courseCodes = [
    ...new Set(
      requestedCourseCode
        ? [requestedCourseCode]
        : courseHomeMatch
        ? [courseHomeMatch[1]]
        : preferredCourseCodes.length
          ? preferredCourseCodes
          : bodyCourseCodes,
    ),
  ];
  if (courseCodes.length !== 1) {
    throw new Error(`Could not identify exactly one 7-digit course code (found: ${courseCodes.join(", ") || "none"})`);
  }
  const assignmentLine = bodyText.split("\n").find((line) => /assignment:/i.test(line))?.trim() || "";
  return { moduleNumber: requestedModuleNumber || moduleNumbers[0], courseCode: courseCodes[0], assignmentLine };
}

function validateOcr({ ocrText, englishName, studentId, moduleNumber, courseCode }) {
  const normalized = normalizeName(ocrText);
  const requiredPhrases = [
    "certificate of completion",
    "this certificate is awarded to",
    "in recognition for the completion of",
    "a self paced online course module of",
  ];
  for (const phrase of requiredPhrases) {
    if (!normalized.includes(phrase)) return `Missing certificate phrase: ${phrase}`;
  }
  if (!normalized.includes(normalizeName(englishName))) return "Exact English full name not found";
  if (!isExactToken(ocrText, studentId)) return "Exact student ID not found";
  if (!isExactToken(ocrText, courseCode)) return "Exact course code not found";
  if (!new RegExp(`\\bmodule\\s+${escapeRegex(moduleNumber)}(?:\\D|$)`, "i").test(ocrText)) {
    return `Exact Module ${moduleNumber} marker not found`;
  }
  return "";
}

async function promptForPage(page) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nNavigate to the submissions list for the certificate module you want to process.");
  await terminal.question("Press Enter when the correct submissions table is visible... ");
  terminal.close();
  await page.bringToFront();
}

async function confirmBatch(count, assignment) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nSTRICT AUTO-GRADE SUMMARY");
  console.log(`Assignment: ${assignment.assignmentLine || "(title unavailable)"}`);
  console.log(`Course: ${assignment.courseCode}; module: ${assignment.moduleNumber}`);
  console.log(`Passing untouched submissions ready for 1/1: ${count}`);
  console.log("All other submissions will remain unchanged. No 0 scores, comments, or announcements will be made.");
  const expected = `SUBMIT ${count}`;
  const answer = await terminal.question(`Type ${expected} to authorize this exact batch: `);
  terminal.close();
  return answer.trim() === expected;
}

async function writeReport(reportPath, rows, assignment) {
  const columns = [
    "student_id",
    "name",
    "status",
    "reason",
    "grading_url",
    "submitted_url",
    "sha256",
    "evidence_image",
    "ocr_text",
  ];
  const csv = [
    `# course=${assignment.courseCode},module=${assignment.moduleNumber},assignment=${csvCell(assignment.assignmentLine)}`,
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
  ].join("\n");
  await writeFile(reportPath, `${csv}\n`, "utf8");
}

async function showCertificateOverlay(page, { candidate, imageBytes, assignment, status }) {
  const imageData = `data:image/jpeg;base64,${imageBytes.toString("base64")}`;
  await page.evaluate(
    ({ item, src, courseCode, moduleNumber, statusText }) => {
      document.getElementById("mcv-auto-panel")?.remove();
      const panel = document.createElement("aside");
      panel.id = "mcv-auto-panel";
      panel.innerHTML = `
        <style>
          #mcv-auto-panel { position:fixed; inset:38px auto 12px 8px; width:40vw; z-index:2147483647;
            background:#fff; border:4px solid #7a3cff; border-radius:8px; box-shadow:0 8px 30px #0007;
            display:flex; flex-direction:column; font:14px/1.35 Arial,sans-serif; color:#18202a; }
          #mcv-auto-panel header { padding:10px 12px; background:#f3edff; border-bottom:1px solid #cbb6ff; }
          #mcv-auto-panel .mcv-auto-name { font-size:22px; font-weight:700; margin:3px 0; }
          #mcv-auto-panel .mcv-auto-meta { font-weight:700; }
          #mcv-auto-panel .mcv-auto-status { margin-top:5px; color:#6b25d8; font-size:16px; font-weight:700; }
          #mcv-auto-panel .mcv-auto-image { flex:1; min-height:0; padding:8px; background:#222; text-align:center; overflow:auto; }
          #mcv-auto-panel img { max-width:100%; min-width:70%; height:auto; background:white; }
          #mcv-auto-panel footer { padding:9px 10px; display:flex; gap:8px; align-items:center; }
          #mcv-auto-panel button { padding:9px 16px; cursor:pointer; font-weight:700; }
          #mcv-auto-panel .mcv-auto-stop { margin-left:auto; color:white; background:#b00020; border:0; border-radius:5px; }
        </style>
        <header>
          <div>STRICT AUTOMATIC CERTIFICATE CHECK</div>
          <div class="mcv-auto-name"></div>
          <div class="mcv-auto-meta"></div>
          <div class="mcv-auto-status"></div>
        </header>
        <div class="mcv-auto-image"><img alt="Submitted certificate"></div>
        <footer>
          <span>Press Esc or Stop to halt before the next submission.</span>
          <button type="button" class="mcv-auto-stop">STOP IMMEDIATELY</button>
        </footer>`;
      panel.querySelector(".mcv-auto-name").textContent = `${item.name} (${item.student_id})`;
      panel.querySelector(".mcv-auto-meta").textContent = `Course ${courseCode} · Module ${moduleNumber}`;
      panel.querySelector(".mcv-auto-status").textContent = statusText;
      panel.querySelector("img").src = src;
      panel.querySelector(".mcv-auto-stop").addEventListener("click", () => window.__mcvAutoStop());
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") window.__mcvAutoStop();
        },
        { capture: true },
      );
      document.body.appendChild(panel);
    },
    {
      item: { name: candidate.name, student_id: candidate.student_id },
      src: imageData,
      courseCode: assignment.courseCode,
      moduleNumber: assignment.moduleNumber,
      statusText: status,
    },
  );
}

async function updateOverlayStatus(page, status) {
  await page
    .evaluate((statusText) => {
      const element = document.querySelector("#mcv-auto-panel .mcv-auto-status");
      if (element) element.textContent = statusText;
    }, status)
    .catch(() => {});
}

async function safetyCountdown(page, delayMs, isStopped) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    if (isStopped()) return false;
    const remainingMs = delayMs - (Date.now() - startedAt);
    await updateOverlayStatus(page, `All checks passed · automatic 1/1 in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`);
    await page.waitForTimeout(Math.min(250, Math.max(1, remainingMs)));
  }
  return !isStopped();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run auto-grade -- [--url SUBMISSIONS_URL] [--course CODE] [--module N] [--offset N] [--limit N] [--delay-ms N] [--dry-run]");
    return;
  }

  const runDir = path.join(OUTPUT_DIR, timestamp());
  const imageDir = path.join(runDir, "images");
  const ocrDir = path.join(runDir, "ocr");
  const reportPath = path.join(runDir, "results.csv");
  await mkdir(imageDir, { recursive: true });
  await mkdir(ocrDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcv-auto-grade-"));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
  const page = context.pages()[0] ?? (await context.newPage());
  const results = [];
  let stopRequested = false;
  await page.exposeBinding("__mcvAutoStop", () => {
    stopRequested = true;
    console.error("Emergency stop requested. No further submissions will be started.");
  });
  try {
    await page.goto(options.url || HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await promptForPage(page);
    const listUrl = page.url();
    const assignment = await detectAssignment(page, options.moduleNumber, options.courseCode);
    const allRows = await collectRows(page);
    const end = options.limit === Infinity ? undefined : options.offset + options.limit;
    const rows = allRows.slice(options.offset, end);
    console.log(`Scanning ${rows.length} submitted, apparently ungraded row(s) without changing grades...`);

    const candidates = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const result = {
        student_id: row.id,
        name: row.listName,
        status: "SKIPPED",
        reason: "",
        grading_url: "",
        submitted_url: "",
        sha256: "",
        evidence_image: "",
        ocr_text: "",
      };
      const skip = async (reason) => {
        result.reason = reason;
        results.push(result);
        await writeReport(reportPath, results, assignment);
        console.log(`[${index + 1}/${rows.length}] skip ${row.id}: ${reason}`);
      };

      if (!row.href) {
        await skip("No grading-page link found");
        continue;
      }
      result.grading_url = new URL(row.href, listUrl).href;
      await page.goto(result.grading_url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const detail = await extractDetail(page, row.listName);
      result.name = detail.englishName || row.listName;
      result.submitted_url = detail.url || "";
      if (detail.reason) {
        await skip(detail.reason);
        continue;
      }

      const imageFilename = `${row.id.replace(/[^A-Za-z0-9_-]/g, "_")}.jpg`;
      const imagePath = path.join(imageDir, imageFilename);
      const image = await downloadStrictCertificate(context, detail.url, imagePath);
      if (image.reason) {
        await skip(image.reason);
        continue;
      }
      result.sha256 = image.sha256;
      result.evidence_image = `images/${imageFilename}`;

      const studentTemp = await mkdtemp(path.join(tempRoot, "ocr-"));
      let ocrText;
      try {
        ocrText = await runOcr(imagePath, studentTemp);
      } catch (error) {
        await skip(`OCR failed: ${error.message}`);
        continue;
      }
      const ocrFilename = `${row.id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
      await writeFile(path.join(ocrDir, ocrFilename), `${ocrText}\n`, "utf8");
      result.ocr_text = `ocr/${ocrFilename}`;
      const ocrProblem = validateOcr({
        ocrText,
        englishName: detail.englishName,
        studentId: row.id,
        moduleNumber: assignment.moduleNumber,
        courseCode: assignment.courseCode,
      });
      if (ocrProblem) {
        await skip(ocrProblem);
        continue;
      }

      const scoreInput = await findScoreInput(page);
      const submitButton = await findSubmitButton(page);
      if (!scoreInput || !submitButton) {
        await skip("Expected blank /1 score form was not found safely");
        continue;
      }
      if (String(scoreInput.value || "").trim()) {
        await skip("Score is already populated; refusing to overwrite it");
        continue;
      }

      await showCertificateOverlay(page, {
        candidate: { ...result, name: detail.englishName },
        imageBytes: image.bytes,
        assignment,
        status: "Strict checks passed · read-only scan phase",
      });
      await page.waitForTimeout(350);
      if (stopRequested) {
        result.status = "STOPPED";
        result.reason = "Stopped by user during read-only scan; grade unchanged";
        results.push(result);
        await writeReport(reportPath, results, assignment);
        console.log("Stopped during read-only scan. No grades were changed by this run.");
        return;
      }

      result.status = "CANDIDATE";
      result.reason = "Passed all strict certificate checks; grade not yet changed";
      results.push(result);
      candidates.push(result);
      await writeReport(reportPath, results, assignment);
      console.log(`[${index + 1}/${rows.length}] strict candidate ${row.id}`);
    }

    const byHash = new Map();
    for (const candidate of candidates) {
      const matches = byHash.get(candidate.sha256) ?? [];
      matches.push(candidate);
      byHash.set(candidate.sha256, matches);
    }
    for (const matches of byHash.values()) {
      if (matches.length < 2) continue;
      for (const candidate of matches) {
        candidate.status = "SKIPPED";
        candidate.reason = `Duplicate certificate bytes detected across ${matches.length} submissions`;
      }
    }
    const eligible = candidates.filter((candidate) => candidate.status === "CANDIDATE");
    await writeReport(reportPath, results, assignment);
    console.log(`\nScan complete: ${eligible.length} strict candidate(s), ${results.length - eligible.length} untouched skip(s).`);
    console.log(`Audit report: ${reportPath}`);

    if (options.dryRun || eligible.length === 0) {
      console.log(options.dryRun ? "Dry run complete. No grades were changed." : "No eligible grades to submit.");
      return;
    }
    if (!(await confirmBatch(eligible.length, assignment))) {
      console.log("Authorization text did not match. No grades were changed.");
      return;
    }

    for (let index = 0; index < eligible.length; index += 1) {
      const candidate = eligible[index];
      if (stopRequested) {
        console.log("Stopped before starting the next submission.");
        break;
      }
      await page.goto(candidate.grading_url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const detail = await extractDetail(page, candidate.name);
      if (detail.reason || detail.url !== candidate.submitted_url) {
        candidate.status = "SKIPPED";
        candidate.reason = "Submission changed after scan; left untouched";
        await writeReport(reportPath, results, assignment);
        continue;
      }
      const scoreInput = await findScoreInput(page);
      const submitButton = await findSubmitButton(page);
      if (!scoreInput || !submitButton || String(scoreInput.value || "").trim()) {
        candidate.status = "SKIPPED";
        candidate.reason = "Score form changed, missing, or already populated; left untouched";
        await writeReport(reportPath, results, assignment);
        continue;
      }

      const evidencePath = path.join(runDir, candidate.evidence_image);
      const evidenceBytes = await readFile(evidencePath);
      await showCertificateOverlay(page, {
        candidate,
        imageBytes: evidenceBytes,
        assignment,
        status: "Preparing safety countdown",
      });
      const continueSubmission = await safetyCountdown(page, options.delayMs, () => stopRequested);
      if (!continueSubmission) {
        candidate.status = "STOPPED_BEFORE_SUBMIT";
        candidate.reason = "Emergency stop requested before score entry; grade unchanged";
        await writeReport(reportPath, results, assignment);
        console.log(`Stopped safely before submitting ${candidate.student_id}.`);
        break;
      }

      const previousBody = await page.locator("body").innerText();
      const previousUpdatedText = previousBody.match(/Grading updated at[^\n]*/i)?.[0] ?? "";
      const saveResponsePromise = watchForSaveResponse(page, scoreInput.name);
      const filled = await scoreInput.locator.evaluate((element) => {
        if (String(element.value || "").trim()) return false;
        element.value = "1";
        return element.value === "1";
      });
      if (!filled) {
        candidate.status = "SKIPPED";
        candidate.reason = "Score field refused safe 1 prefill; left untouched";
        await writeReport(reportPath, results, assignment);
        continue;
      }

      if (stopRequested) {
        await scoreInput.locator.evaluate((element) => {
          element.value = "";
        });
        candidate.status = "STOPPED_BEFORE_SUBMIT";
        candidate.reason = "Emergency stop requested after prefill; score cleared and not submitted";
        await writeReport(reportPath, results, assignment);
        console.log(`Stopped safely before clicking Submit for ${candidate.student_id}.`);
        break;
      }

      // This is the only programmatic state-changing action in auto mode.
      // The selected element is the site's native Submit control; no other
      // grading, comment, lock, or announcement control is touched.
      await updateOverlayStatus(page, "Submitting 1/1 now…");
      await submitButton.click();
      const save = await waitForSave(page, saveResponsePromise, previousUpdatedText);
      if (!save.ok) {
        candidate.status = "SAVE_UNCONFIRMED";
        candidate.reason = save.reason;
        await writeReport(reportPath, results, assignment);
        throw new Error(`Stopped after unconfirmed save for ${candidate.student_id}: ${save.reason}`);
      }
      candidate.status = "AUTO_SUBMITTED_1";
      candidate.reason = save.reason;
      await writeReport(reportPath, results, assignment);
      await updateOverlayStatus(page, "Confirmed saved: 1/1");
      console.log(`[${index + 1}/${eligible.length}] confirmed 1/1 for ${candidate.student_id}`);
      await page.waitForTimeout(400);
    }
    console.log(`\nFinished. Audit report: ${reportPath}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await context.close();
  }
}

main().catch((error) => {
  console.error(`\nStopped safely: ${error.message}`);
  process.exitCode = 1;
});
