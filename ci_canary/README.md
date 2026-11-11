# CI canary (do not merge)

Deliberate failures for testing the CI pipeline on a pull request. Each one
targets a single job:

| Change                                            | Job that should fail                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| `ci_canary/badly_formatted.py`                    | `format-lint` (ruff format)                          |
| `install_script/__tests__/unit/ciCanary.test.js`  | `js-tests`                                           |
| `tests/unit/test_ci_canary_skip.py`               | `python-tests` (required-skip check, not pytest)     |
| `ci_canary/shell_injection.py`                    | `ash-scan` (bandit B602) and the code-scanning check |
| `lodash@4.17.20` in `install_script/package.json` | `dependency-review` (and ASH npm-audit/grype)        |
