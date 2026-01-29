import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('No prompt provided');
  process.exit(1);
}

const contextMatch = prompt.match(/\.watchfix\/context\/[^\s"]+/);
if (!contextMatch) {
  console.error('No context path found in prompt');
  process.exit(1);
}

const contextPath = contextMatch[0];
const resolvedContextPath = path.isAbsolute(contextPath)
  ? contextPath
  : path.resolve(process.cwd(), contextPath);

try {
  fs.readFileSync(resolvedContextPath, 'utf8');
} catch (error) {
  console.error('Failed to read context file:', error);
  process.exit(1);
}

const isAnalyze = contextPath.endsWith('-analyze.md');
const isFix = contextPath.endsWith('-fix.md');
if (!isAnalyze && !isFix) {
  console.error('Context path must end with -analyze.md or -fix.md');
  process.exit(1);
}

const outputPath = isAnalyze
  ? resolvedContextPath.replace('-analyze.md', '-analysis.yaml')
  : resolvedContextPath.replace('-fix.md', '-result.yaml');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../fixtures/agent-responses');
const responseFile = isAnalyze ? 'analysis-valid.yaml' : 'fix-valid.yaml';

let response = '';
try {
  response = fs.readFileSync(path.join(fixturesDir, responseFile), 'utf8');
} catch (error) {
  console.error('Failed to read mock response:', error);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, response);
