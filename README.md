# MyCourseVille certificate grader

This toolkit provides three modes: a read-only scanner, a strict automatic
certificate grader, and an assisted manual-review workflow. None of the modes
ever assigns `0`, adds comments, announces grades, or changes locks.

The read-only `scan` mode never enters a score or submits a form. After manual
login, a network guard blocks all `POST`, `PUT`, `PATCH`, and `DELETE` requests.

The scanner considers a submission a candidate for human approval only when:

1. The student has submitted and appears ungraded in the submissions table.
2. The submitted URL returns image content successfully.
3. Local Tesseract OCR finds the exact normalized English full name shown on
   the student's detail page.

Everything else is marked `MANUAL_REVIEW`. The scanner does not award grades.

## First run

```bash
cd mycourseville-grader
npm install
curl -L -o tessdata/eng.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
npm run scan -- --limit 10
```

A Chromium window opens. Log in manually, navigate to the assignment's
submissions list, then return to the terminal and press Enter.

Use another assignment URL with:

```bash
npm run scan -- --url 'https://www.mycourseville.com/?q=...'
```

Reports are written under `reports/<timestamp>/results.csv`. Certificate images
and OCR text are kept beside the report for manual verification. They contain
student data and should be deleted when no longer needed.

English OCR uses the project-local `tessdata/eng.traineddata` file, so it does
not depend on system-installed language packs.

## Recommended workflow

Run the strict automatic grader first:

```bash
npm run auto-grade
```

For the safest and most reproducible run, explicitly provide the assignment's
submissions URL, expected module, and course code. Example:

```bash
npm run auto-grade -- --url 'https://www.mycourseville.com/?q=courseville/course/81802/submission_2084333' --module 1 --course 2110204 --delay-ms 1000
```

Always copy the URL from the module you actually intend to grade and update the
module/course values to match. `--delay-ms` is measured in milliseconds and
must be between `1000` and `30000`; use `10000` for a ten-second delay. Quote
the URL so the shell passes it unchanged.

It awards `1/1` only to certificates that pass every strict check and leaves
all invalid, unusual, or uncertain submissions untouched. Use the visible Stop
button or Escape if anything looks wrong.

After auto-grade finishes, run assisted mode on the same assignment:

```bash
npm run assist
```

Assisted mode skips existing grades and walks through the submissions left for
manual review. It displays valid images beside the form and shows a clear
manual-review panel for broken, indirect, or unrecognized links. In short:
**auto-grade the high-confidence certificates first, then use assist for the
remaining edge cases.**

## Assisted manual grading

```bash
cd mycourseville-grader
npm run assist
```

The browser opens at MyCourseVille. Navigate to the submissions list for the
assignment or module you want, then press Enter in the terminal. Assisted mode
uses that page; it is not tied to Module 4.

Alternatively, provide the submissions-list URL directly:

```bash
npm run assist -- --url 'https://www.mycourseville.com/?q=courseville/course/COURSE/submission_ASSIGNMENT'
```

Assisted mode processes submitted, apparently ungraded rows in order. For a
direct image whose OCR text contains the exact English full name, it displays
the certificate in a large panel and pre-populates a blank score field with
`1`. It does not dispatch input/change events and contains no code that clicks
Submit. The grade reaches MyCourseVille only when the instructor clicks the
site's native Submit button.

After a user-initiated submission, assisted mode advances only if it observes
the score-bearing POST response and a new visible `Grading updated at`
confirmation. Broken links, HTML pages, OCR mismatches, existing grades, and
unexpected form structures are never graded. For an unopenable or uncertain
submission, assisted mode displays a manual-review panel with the reason and
submitted link; choose **Leave ungraded and continue** or stop the session.

To test the visual panel without pre-filling scores, use:

```bash
npm run assist -- --limit 3 --preview-only
```

## Strict automatic certificate mode

`auto-grade` is only for objective certificate assignments worth `1/1`. It
never assigns `0`, comments, announces, or changes locks. It processes rows in
order and accepts only official generated MyCourseVille JPEG certificates with
the expected path, file signature, 2400x1600 dimensions, exact English name,
student ID, course code, module number, and fixed certificate wording. Exact
duplicate files and every anomaly are left untouched.

Always validate a selected module with a dry run first:

```bash
npm run auto-grade -- --dry-run
```

You may explicitly enter the expected module number. The selected assignment
page must mention the same module or the run stops:

```bash
npm run auto-grade -- --course 2110204 --module 4 --dry-run
```

To inspect a later segment during testing, use for example:

```bash
npm run auto-grade -- --dry-run --offset 20 --limit 20
```

For a live run:

```bash
npm run auto-grade
```

Each strict match is submitted after its visible safety countdown; there is no
batch authorization prompt. The tool verifies MyCourseVille's visible save
confirmation after every submission before proceeding. Any unconfirmed save
stops the entire run. Evidence and an audit CSV are retained under
`auto-grade-reports/`.

Auto mode displays every passing certificate beside the grading form. Before
each submission it shows a 1.5-second countdown. Click **STOP IMMEDIATELY** or
press Escape to halt before the next Submit action. The delay can be increased,
for example with `--delay-ms 5000`.

## Read-only scanner safety properties

- No code exists for locating or filling score/comment controls.
- No code clicks grade, submit, announce, or lock controls.
- Only grading-page links are read from the grading column.
- State-changing HTTP methods are blocked after login.
- Unexpected table structure causes the scan to stop.
- Results are labels for review, not grades.
