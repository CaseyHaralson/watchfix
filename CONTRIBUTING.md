# Contributing to watchfix

Thank you for your interest in contributing to watchfix! This document provides guidelines and instructions for contributing.

## Prerequisites

- Node.js 18 or higher
- npm

## Development Setup

1. Clone the repository:

```bash
git clone https://github.com/your-org/watchfix.git
cd watchfix
```

2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

4. Run tests:

```bash
npm test
```

## Code Style

This project uses:

- **TypeScript** with strict mode enabled
- **ESLint** for linting
- **Prettier** for code formatting

Before submitting a PR, ensure your code passes linting:

```bash
npm run lint
```

You can auto-format code with:

```bash
npm run format
```

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). All commit messages must follow this format:

```
type(scope): description
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (formatting, etc.)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools

### Examples

```
feat(watcher): add docker log source support
fix(cli): handle missing config file gracefully
docs(readme): add installation instructions
refactor(parser): simplify error pattern matching
test(dedup): add tests for similarity scoring
chore(deps): update typescript to 5.4
```

## Testing

Run the test suite before submitting any changes:

```bash
npm test
```

All tests must pass for a PR to be merged.

## Pull Request Process

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** following the code style guidelines
3. **Add tests** for any new functionality
4. **Run the full test suite** to ensure nothing is broken
5. **Update documentation** if you're changing user-facing behavior
6. **Submit a pull request** with a clear description of your changes

### PR Checklist

- [ ] Code follows the project's style guidelines
- [ ] Tests pass locally (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Commit messages follow Conventional Commits format
- [ ] Documentation updated (if applicable)

## Review Process

- All PRs require at least one approving review before merge
- Maintainers may request changes or ask questions
- Please respond to feedback in a timely manner

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.
