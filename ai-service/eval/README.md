# DevForge-Bench

14 small bug-fix and feature tasks (Python and JavaScript). Each task is a tiny repo with visible tests; a hidden test file decides pass or fail.
Not SWE-bench: use it to compare models and catch regressions in DevForge.

    python eval/run_bench.py --list
    LLM_PROVIDER=gemini GEMINI_API_KEY=... python eval/run_bench.py --limit 3
    python eval/run_bench.py            # all tasks

Results go to `eval/results/latest.json` and `REPORT.md`; the web app's Benchmarks page reads `latest.json`.
The committed result is from the offline mock model (0/14). Run it with a real key for a meaningful score.
