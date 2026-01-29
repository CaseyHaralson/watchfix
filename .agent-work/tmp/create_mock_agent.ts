const createMockAgentScript = async (rootDir: string): Promise<string> => {
  const analysisYaml = readFixture('agent-responses/analysis-valid.yaml');
  const fixYaml = readFixture('agent-responses/fix-valid.yaml');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');

    const prompt = process.argv.slice(2).join(' ');
    if (!prompt) {
      console.error('No prompt provided');
      process.exit(1);
    }

    const match = prompt.match(/\.watchfix[\\/]context[\\/][^\s"]+/);
    if (!match) {
      console.error('No context path found in prompt');
      process.exit(1);
    }

    const contextPath = match[0].split(' ')[0];
    const resolved = path.isAbsolute(contextPath)
      ? contextPath
      : path.resolve(process.cwd(), contextPath);

    if (!fs.existsSync(resolved)) {
      console.error('Context file missing at:', resolved);
      process.exit(1);
    }

    const isAnalyze = contextPath.endsWith('-analyze.md');
    const isFix = contextPath.endsWith('-fix.md');
    
    const outputPath = isAnalyze
      ? resolved.replace('-analyze.md', '-analysis.yaml')
      : resolved.replace('-fix.md', '-result.yaml');

    const response = isAnalyze
      ? ${JSON.stringify(analysisYaml)}
      : ${JSON.stringify(fixYaml)};

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, response, 'utf8');
  `;

  return await writeTempFile(rootDir, 'mock-agent.js', script);
};