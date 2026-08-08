# Contributing Guide

Thank you for wanting to improve AI Classroom Monitor! 🎉

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/ai-classroom-monitor.git
   cd ai-classroom-monitor/classroom_monitor
   ```
3. Create a **virtual environment** and install deps:
   ```bash
   python -m venv venv
   venv\Scripts\activate   # Windows
   pip install -r requirements.txt
   ```

## Branch Naming Convention

| Type | Branch name |
|------|-------------|
| New feature | `feature/short-description` |
| Bug fix | `fix/short-description` |
| Docs | `docs/short-description` |
| Refactor | `refactor/short-description` |

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add hand-raise detection
fix: prevent duplicate admit messages
docs: update setup instructions
refactor: extract chart builder into helper
```

## Code Style

- Follow [PEP 8](https://peps.python.org/pep-0008/)
- Max line length: **120 characters**
- Run `flake8 . --max-line-length=120` before committing

## Pull Request Checklist

- [ ] My code follows the style guidelines
- [ ] I have added comments where the logic is non-obvious
- [ ] I have tested the change locally with both teacher and student roles
- [ ] I have updated `README.md` if I changed setup steps or API endpoints
- [ ] No large binaries are included (use `.gitignore`)

## Reporting Bugs

Open an [issue](../../issues/new) and include:
- Python version
- Browser and OS
- Steps to reproduce
- Error message / screenshot
