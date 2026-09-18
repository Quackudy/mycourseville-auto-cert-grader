# MyCourseVille certificate grader

Grades MyCourseVille certificate assignments worth `1/1`. The recommended
workflow is to run strict automatic grading first, then use assisted mode for
anything left unresolved.

## Setup

```bash
npm install
curl -L -o tessdata/eng.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
```

You log into MyCourseVille manually in the browser opened by the tool. Login
credentials are never stored in the repository.

## 1. Run auto-grade first

```bash
npm run auto-grade -- --url 'https://www.mycourseville.com/?q=courseville/course/81802/submission_2084329' --module 5 --course 2110204
```

Change the URL, module, and course code for the assignment being graded.

Auto-grade awards `1/1` only when every strict check passes:

- The score is blank and the item is worth `/1`.
- The URL is an official generated MyCourseVille certificate JPEG.
- The file signature and expected `2400x1600` dimensions match.
- OCR finds the exact English name, student ID, course code, module number, and
  certificate wording.
- The certificate is not a duplicate encountered earlier in the run.

Anything invalid, unusual, already graded, or uncertain is left unchanged. It
never assigns `0`, adds comments, announces grades, or changes locks.

Each accepted certificate is displayed beside the grading form before it is
submitted. Press Escape or click **STOP IMMEDIATELY** to halt. The default
countdown is 1.5 seconds; override it with `--delay-ms 1000` to
`--delay-ms 30000`.

For a no-change test, add `--dry-run`.

## 2. Run assist afterward

```bash
npm run assist -- --url 'https://www.mycourseville.com/?q=courseville/course/81802/submission_2084329'
```

Assist skips existing grades and walks through the remaining submissions. It
shows the certificate beside the form and prefills `1`, but you click Submit.
Broken, indirect, or unrecognized links are shown as manual-review cases and
remain ungraded unless you handle them yourself.

## Reports and privacy

Audit reports and certificate evidence are stored locally under `reports/`,
`assist-reports/`, and `auto-grade-reports/`. These folders and the authenticated
browser profile are excluded from Git because they contain student or session
data.
