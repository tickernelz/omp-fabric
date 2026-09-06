import { describe, expect, it } from "vitest";
import { fabricExecTitleHint } from "../src/ui/fabric-code-parser.js";
import { fabricExecTitleHintCached } from "../src/ui/fabric-title-hint.js";

const cases: [name: string, code: string, expected: string | undefined][] = [
  [
    "single read",
    "return await omp.read({ path: 'src/ui/fabric-code-parser.ts', offset: 1, limit: 80 });",
    "Read fabric-code-parser.ts",
  ],
  [
    "grep lexeme plus read",
    "const [h, c] = await Promise.all([omp.grep({ pattern: 'fallback', path: 'src', limit: 20 }), omp.read({ path: 'src/config.ts', offset: 520, limit: 60 })]); return { h, c };",
    "Search \"fallback\" in src + Read config.ts",
  ],
  [
    "coalesced edit",
    "await omp.edit({ path: 'src/config.ts', edits: [{ old: \"a\", new: \"b\" }] }); return 'ok';",
    "Edit config.ts",
  ],
  [
    "write via named string",
    "const r = await omp.write({ path: 'src/ui/title.ts', text: omp.title }); return r.output;",
    "Write title.ts",
  ],
  [
    "bash command",
    "return await omp.bash({ cmd: 'pnpm run check', timeout: 180 });",
    "Shell pnpm run check",
  ],
  [
    "long bash command clipped",
    "return await omp.bash({ cmd: 'pnpm vitest run src/ui/title.test.ts', settle: true });",
    "Shell pnpm vitest run src/ui/title.…",
  ],
  [
    "mcp call",
    "return await mcp.github.get_issue({ owner: 'x', repo: 'y', issue_number: 12 });",
    "Mcp github.get_issue",
  ],
  [
    "memory pair collapses on shared key",
    "await memory.set({ key: 'plan', value: v }); return await memory.get({ key: 'plan' });",
    "Memory plan ×2",
  ],
  [
    "distinct same-verb targets collapse to a count",
    "const [a, b, c] = await Promise.all([omp.read('/x/a.ts'), omp.read('/x/b.ts'), omp.read('/x/c.ts')]); return [a, b, c];",
    "Read a.ts +2",
  ],
  [
    "segment assembly stops at the char budget",
    `const g = await omp.grep({ pattern: 'renderCall', path: 'src/fabric-exec-tool.ts' });
const r = await omp.read({ path: 'src/fabric-exec-tool.ts', offset: 240, limit: 30 });
await omp.edit({ path: 'src/fabric-exec-tool.ts', edits: [{ old: 'x', new: 'y' }] });
const b = await omp.bash({ cmd: 'pnpm run build', timeout: 120 });
return { g, r, b };`,
    "Search \"renderCall\" in fabric-exec-tool.ts + Read fabric-exec-tool.ts +…",
  ],
  [
    "search sweep keeps first-occurrence order under one verb",
    "return await Promise.all([omp.grep({pattern:'TODO',path:'src'}), omp.find({pattern:'*.ts',path:'src'}), omp.ls('src')]);",
    "Search \"TODO\" in src +2",
  ],
  [
    "bare directory qualifies a grep",
    "return await omp.grep({ pattern: 'TODO', path: 'src', ignoreCase: true });",
    "Search \"TODO\" in src",
  ],
  [
    "agent task clipped as target",
    "return await agents({ task: 'fix the lint errors in src/ui' });",
    "Agent fix the lint errors in src/ui",
  ],
  [
    "tools discovery counted",
    "const d = await tools.search({ query: 'github issues' }); return await tools.call({ ref: d[0].ref, args: {} });",
    "Tools ×2",
  ],
  [
    "regex pattern never quoted, path wins",
    "return await omp.grep({ pattern: '\\\\.name\\\\?\\\\.trim', path: 'src/fabric-exec-tool.ts', limit: 5 });",
    "Search fabric-exec-tool.ts",
  ],
  [
    "glob head with directory qualifier",
    "return await omp.find({ pattern: '*.test.ts', path: 'src/ui', limit: 10 });",
    "Search *.test.ts in src/ui",
  ],
  [
    "no fabric calls stays neutral",
    "const xs = [1, 2, 3]; return xs.reduce((a, b) => a + b, 0);",
    undefined,
  ],
  [
    "aliased calls are statically invisible",
    "const t = { r: omp.read }; return await t.r('src/config.ts');",
    undefined,
  ],
  [
    "dynamic template yields no target",
    'return await omp.bash({ cmd: `pnpm vitest run ${name}.test.ts` });',
    "Shell",
  ],
  [
    "comments are never counted",
    "// omp.write({ path: 'nope.ts' })\n/* omp.bash({ cmd: 'rm -rf /' }) */\nreturn await omp.read({ path: 'src/real.ts' });",
    "Read real.ts",
  ],
  [
    "unknown omp verb is humanized",
    "return await omp.forgeWorkspace({ path: 'src/x.ts' });",
    "Forge Workspace x.ts",
  ],
  [
    "named-string payload never surfaces",
    "const md = payloads['docs/secret.md']; return await omp.bash({ cmd: 'ls' });",
    "Shell ls",
  ],
];

describe("fabricExecTitleHint", () => {
  for (const [name, code, expected] of cases) {
    it(name, () => {
      expect(fabricExecTitleHint(code)).toBe(expected);
    });
  }
});

describe("fabricExecTitleHintCached", () => {
  for (const [name, code, expected] of cases) {
    it(`mirrors the pure hint: ${name}`, () => {
      expect(fabricExecTitleHintCached(code)).toBe(expected);
      expect(fabricExecTitleHintCached(code)).toBe(expected);
    });
  }
});
