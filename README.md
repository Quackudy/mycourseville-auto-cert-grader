# MyCourseVille certificate reader

This is a read-only dry-run scanner. It never enters a score, submits a form,
adds a comment, announces a grade, or changes a lock. After manual login, a
network guard blocks all `POST`, `PUT`, `PATCH`, and `DELETE` requests.

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
unexpected form structures are skipped and logged under `assist-reports/`.

To test the visual panel without pre-filling scores, use:

```bash
npm run assist -- --limit 3 --preview-only
```

## Strict automatic certificate mode

`auto-grade` is only for objective certificate assignments worth `1/1`. It
never assigns `0`, comments, announces, or changes locks. It scans every row
first and accepts only official generated MyCourseVille JPEG certificates with
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
npm run auto-grade -- --module 4 --dry-run
```

To inspect a later segment during testing, use for example:

```bash
npm run auto-grade -- --dry-run --offset 20 --limit 20
```

For a live run:

```bash
npm run auto-grade
```

After scanning, the tool prints the exact candidate count and requires a
one-time `SUBMIT N` authorization for that batch. It then submits `1/1` only for
those candidates and verifies MyCourseVille's visible save confirmation after
every submission. Any unconfirmed save stops the entire run. Evidence and an
audit CSV are retained under `auto-grade-reports/`.

## Safety properties

- No code exists for locating or filling score/comment controls.
- No code clicks grade, submit, announce, or lock controls.
- Only grading-page links are read from the grading column.
- State-changing HTTP methods are blocked after login.
- Unexpected table structure causes the scan to stop.
- Results are labels for review, not grades.
