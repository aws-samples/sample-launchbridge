<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Python Test Patterns Reference

## Test Type Definitions

### Unit Tests

- Test individual functions/methods in isolation
- Mock external dependencies (databases, APIs, file systems)
- Fast execution (milliseconds per test)
- High volume (many tests per module)

```python
# Example unit test
def test_calculate_total_with_discount():
    result = calculate_total(100, discount=0.1)
    assert result == 90.0

def test_calculate_total_no_discount():
    result = calculate_total(100)
    assert result == 100.0
```

### Functional Tests

- Test component interactions
- May use real databases (test instances) or fixtures
- Medium execution time
- Test business logic flows

```python
# Example functional test
def test_user_registration_flow(db_session):
    user = create_user(db_session, email="test@example.com")
    assert user.id is not None
    assert user.email_verified is False

    verify_email(db_session, user.id)
    assert user.email_verified is True
```

### E2E Tests (Placeholder)

- Test complete user workflows
- Use browser automation (Playwright/Selenium)
- Slowest execution
- Fewest in number

## Pytest Best Practices

### File Organization

```
.lb_workspace/tests/
├── unit/
│   ├── test_models.py
│   ├── test_utils.py
│   └── test_validators.py
├── functional/
│   ├── test_api_endpoints.py
│   └── test_workflows.py
├── e2e/  # placeholder
│   └── .gitkeep
└── conftest.py  # shared fixtures
```

### Naming Conventions

- Test files: `test_<module>.py` or `<module>_test.py`
- Test functions: `test_<what>_<condition>_<expected>`
- Test classes: `Test<ClassName>`

### Fixtures

```python
# conftest.py
import pytest

@pytest.fixture
def sample_user():
    return {"id": 1, "name": "Test User", "email": "test@example.com"}

@pytest.fixture
def mock_database(mocker):
    return mocker.patch("app.db.get_connection")
```

### Parametrized Tests

```python
@pytest.mark.parametrize("input,expected", [
    (0, 0),
    (1, 1),
    (2, 4),
    (3, 9),
])
def test_square(input, expected):
    assert square(input) == expected
```

### Mocking Patterns

```python
from unittest.mock import Mock, patch

# Patch a module-level function
@patch("app.services.send_email")
def test_registration_sends_email(mock_send):
    register_user("test@example.com")
    mock_send.assert_called_once()

# Mock an object method
def test_api_call(mocker):
    mock_response = Mock()
    mock_response.json.return_value = {"status": "ok"}
    mocker.patch("requests.get", return_value=mock_response)

    result = fetch_status()
    assert result == "ok"
```

## Coverage Guidelines

### Target Coverage by Type

- Unit tests: Aim for 80%+ line coverage
- Functional tests: Focus on critical paths
- Combined: 70%+ is a reasonable target

### What to Prioritize

1. Business logic functions
2. Data validation
3. Error handling paths
4. Edge cases in calculations
5. Security-sensitive code

### What to Skip

- Simple getters/setters
- Framework-generated code
- Third-party library wrappers (test integration instead)
