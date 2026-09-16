import { foundationScenarios } from "../foundation/fixtures.js";
import { evaluateScenario } from "../foundation/scenario-checker.js";

const results = foundationScenarios.map(evaluateScenario);
const failed = results.filter((result) => !result.passed);

for (const result of results) {
  const status = result.passed ? "PASS" : "FAIL";
  const signals = result.detectedSignals.length > 0 ? result.detectedSignals.join(", ") : "sem sinais";
  console.log(`[${status}] ${result.scenarioId}: ${signals}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
  throw new Error(`${failed.length} cenário(s) falharam.`);
}

console.log(`\n${results.length} cenários executados com sucesso.`);
