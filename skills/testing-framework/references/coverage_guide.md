<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Coverage Analysis Guide

## Understanding Coverage Reports

### Coverage Metrics

- **Line coverage**: Percentage of code lines executed during tests
- **Branch coverage**: Percentage of decision branches taken
- **Function coverage**: Percentage of functions called

### Reading pytest-cov Output

```
Name                      Stmts   Miss  Cover   Missing
-------------------------------------------------------
app/models.py                45      5    89%   23-25, 67-68
app/services.py              78     12    85%   34-40, 89-94
app/utils.py                 32      0   100%
-------------------------------------------------------
TOTAL                       155     17    89%
```

- **Stmts**: Total statements in file
- **Miss**: Statements not executed
- **Cover**: Percentage covered
- **Missing**: Line numbers not covered

## Prioritizing What to Test

### High Priority (Test First)

1. **Complex functions** (cyclomatic complexity > 5)
2. **Functions with many parameters**
3. **Error handling code**
4. **Security-related functions**
5. **Data transformation logic**

### Medium Priority

1. **CRUD operations**
2. **Validation functions**
3. **Utility functions with logic**

### Low Priority (Test Last)

1. **Simple property accessors**
2. **Logging statements**
3. **Configuration loading**
4. **Framework boilerplate**

## Improving Coverage

### Finding Gaps

```bash
# Run with detailed missing lines
pytest --cov=app --cov-report=term-missing

# Generate HTML report for visual inspection
pytest --cov=app --cov-report=html
```

### Common Uncovered Patterns

**Exception handlers**

```python
try:
    result = risky_operation()
except SpecificError:
    # Often uncovered - need to trigger the exception
    handle_error()
```

**Early returns**

```python
def process(data):
    if not data:  # Easy to miss this branch
        return None
    # ... rest of function
```

**Default parameters**

```python
def fetch(url, timeout=30):  # Default value path often untested
    ...
```

## Setting Coverage Thresholds

### In pytest.ini or pyproject.toml

```toml
[tool.pytest.ini_options]
addopts = "--cov=app --cov-fail-under=80"
```

### Recommended Thresholds

- New projects: Start at 60%, increase over time
- Established projects: 80% minimum
- Critical systems: 90%+

## Coverage Anti-Patterns

### Don't Do This

- Writing tests just to increase coverage numbers
- Testing trivial code to hit 100%
- Ignoring branch coverage for line coverage
- Excluding files to artificially raise percentage

### Do This Instead

- Focus on testing behavior, not lines
- Prioritize critical code paths
- Use coverage to find gaps, not as a goal
- Review uncovered lines for actual risk
