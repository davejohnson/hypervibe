import type { Reporter, TestModule } from 'vitest/node';

/** Prints the slowest test files after a CI run so slow tests stay visible. */
export default class SlowestReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const files = modules
      .map((module) => ({ file: module.relativeModuleId, seconds: module.diagnostic().duration / 1000 }))
      .sort((a, b) => b.seconds - a.seconds);
    const total = files.reduce((sum, file) => sum + file.seconds, 0);
    const top = files.slice(0, 25);
    console.log(`\nSlowest test files (${top.reduce((sum, file) => sum + file.seconds, 0).toFixed(0)}s of ${total.toFixed(0)}s across ${files.length} files):`);
    for (const { file, seconds } of top) console.log(`${seconds.toFixed(1).padStart(7)}s  ${file}`);
  }
}
