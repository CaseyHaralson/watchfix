# Context File Format

## Directory Structure

```
.watchfix/context/
├── {date}-error-{id}-attempt-{n}-analyze.md     # Analysis phase input
├── {date}-error-{id}-attempt-{n}-analysis.yaml  # Analysis phase output
├── {date}-error-{id}-attempt-{n}-fix.md         # Fix phase input
└── {date}-error-{id}-attempt-{n}-result.yaml    # Fix phase output
```

Date format: `YYYY-MM-DD` (date context file is created, not error detection date)

## Analysis Phase Input

`.watchfix/context/{date}-error-{id}-attempt-{n}-analyze.md`:

```markdown
# WatchFix Task

## Mode
analyze

## Project
- Name: {project.name}
- Root: {absolute_path_to_project}

## Error Details
- ID: {error.id}
- Source: {error.source}
- Type: {error.error_type}
- Detected: {error.timestamp}
- Fix Attempts: {error.fix_attempts}

### Message
{error.message}

### Stack Trace
{error.stack_trace}

### Context (surrounding log lines)
{context_lines_before}
---ERROR---
{error_line_and_stack_trace}
---END ERROR---
{context_lines_after}

## Instructions

1. Investigate the project structure to understand the codebase
2. Identify the root cause of this error
3. Determine what files need to be modified
4. Assess your confidence in the fix

Write your analysis to: `.watchfix/context/{date}-error-{id}-attempt-{n}-analysis.yaml`

Use this exact YAML format:
```yaml
summary: One sentence summary of the problem
root_cause: |
  Detailed explanation of root cause
  Can be multiple lines
suggested_fix: |
  What changes to make
  Step by step if needed
files_to_modify:
  - path/to/file1
  - path/to/file2
confidence: high | medium | low
```

## Constraints
- Do NOT modify any files during analysis
- If you cannot determine the cause, set confidence to "low"
- Be specific about file paths relative to project root
- WARNING: If a fix fails and is retried, any file modifications from previous attempts will persist
```

## Analysis Phase Output

`.watchfix/context/{date}-error-{id}-attempt-{n}-analysis.yaml`:

```yaml
summary: PostgreSQL container not starting due to port conflict
root_cause: |
  Port 5432 is already bound by the host PostgreSQL service.
  The Docker container cannot acquire the port.
suggested_fix: |
  Change docker-compose.yaml port mapping from 5432:5432 to 5433:5432.
  Update DATABASE_URL in .env to use port 5433.
files_to_modify:
  - docker-compose.yaml
  - .env
confidence: high
```

**Required fields:** `summary`, `root_cause`, `suggested_fix`, `files_to_modify`, `confidence`

## Fix Phase Input

`.watchfix/context/{date}-error-{id}-attempt-{n}-fix.md`:

```markdown
# WatchFix Task

## Mode
fix

## Project
- Name: {project.name}
- Root: {absolute_path_to_project}

## Error Details
- ID: {error.id}
- Source: {error.source}
- Type: {error.error_type}
- Detected: {error.timestamp}
- Fix Attempts: {error.fix_attempts}

### Message
{error.message}

### Stack Trace
{error.stack_trace}

## Previous Analysis
{analysis_yaml_content}

## Instructions

1. Read the previous analysis above
2. Implement the suggested fix
3. Follow existing code style and conventions
4. Make minimal, targeted changes

Write your results to: `.watchfix/context/{date}-error-{id}-attempt-{n}-result.yaml`

Use this exact YAML format:
```yaml
success: true | false
summary: One sentence describing what was done
files_changed:
  - path: relative/path/to/file
    change: Description of change made
notes: |
  Optional additional notes
  Can be multiple lines
```

## Constraints
- Make the smallest change that resolves the issue
- Do NOT change unrelated code
- If the fix cannot be applied, set success to false and explain in notes
- WARNING: If this fix fails verification, the modified files will remain changed for the next retry attempt
```

## Fix Phase Output

`.watchfix/context/{date}-error-{id}-attempt-{n}-result.yaml`:

```yaml
success: true
summary: Updated PostgreSQL port mapping to 5433
files_changed:
  - path: docker-compose.yaml
    change: Changed port mapping from "5432:5432" to "5433:5432"
  - path: .env
    change: Updated DATABASE_URL to use port 5433
notes: |
  Application will now connect on port 5433.
  No other configuration changes needed.
```

**Required fields:** `success`, `summary`
**Optional fields:** `files_changed`, `notes`

## Size Limits

Context files are limited to `cleanup.context_max_size_kb` (default: 256KB).

If content exceeds this:
1. First, truncate the stack trace to 32KB maximum, keeping the first and last 16KB with `[...truncated...]` in between
2. If still over limit, remove lines from the **beginning** of the raw log (oldest context first)
3. Insert at the start: `[...{N} lines truncated due to size limit...]`
4. Keep the error line intact

## Encoding

- UTF-8 encoding
- Non-UTF8 characters replaced with Unicode replacement character (U+FFFD)
