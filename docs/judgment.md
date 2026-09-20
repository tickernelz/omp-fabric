# Judgment

Fabric asks calibrated questions. `judgment.ask` evaluates one state and returns typed answers with probabilities: a `choice` picks one label and reports the distribution across them, a `bool` returns the probability of yes, a `score` returns a probability-weighted position on ordered levels. Nothing is generated; the answer space is the one the caller declared.

The backend is the host's judge, resolved lazily at first use: TypeSafe System One when a credential exists, otherwise keyword prompts to the `tiny`/`smol` chat chain. `providers.judgmentProvider` in OMP settings selects between them, so Fabric inherits the host's choice and holds no second one. A host without the judgment module leaves the lane inert, and `judgment.ask` answers `{ ok: false, reason: "unsupported" }`.

```ts
const verdict = await judgment.ask({
  state: { command, cwd, recentFailures },
  questions: {
    destructive: { type: "bool", instructions: "Does running this destroy state that cannot be recovered?" },
    blast: {
      type: "score",
      instructions: "How far does the worst plausible outcome reach?",
      criteria: ["this working tree", "this machine", "shared or production systems"],
    },
  },
});
if (verdict.ok && verdict.answers.destructive.type === "bool" && verdict.answers.destructive.bool > 0.8) {
  // ask the human first
}
```

## One state, one request

Every question in a request sees the same state, and questions are answered independently, so unrelated judgments about one piece of evidence belong in one call. Callers that do not know about each other still share the wire: judgments over an identical state inside `judgment.coalesceMs` merge into a single backend request and the answers are split back by caller.

Measured against the live API, three questions raised by two independent callers cost **one request and 440 input tokens**; the same three asked one at a time cost **three requests and 1,038 input tokens**. The saving is the state, which every extra request re-sends.

Only an identical state merges. The wire format carries one state per request, so two different states are two requests no matter how close together they arrive.

## Refusals are answers

`judgment.ask` never throws for an operational reason. It returns `{ ok: false, reason }`, where `reason` is one of:

| `reason` | Meaning |
| --- | --- |
| `unsupported` | no judgment backend resolved; `detail` carries the resolver's error when there was one |
| `refused` | the ask carried no questions, crossed `maxQuestionsPerRequest` or `maxStateBytes`, or carried a state `JSON.stringify` cannot take; `detail` says which |
| `failed` | the backend errored, or answered without covering every question |
| `timeout` | no answer within `judgment.timeoutMs`, including a backend that ignores the abort |
| `aborted` | the caller's signal fired |
| `disabled` | the lane is off; unreachable through the provider, which is not registered at all when `judgment.enabled` is false |

This is deliberate. A judgment exists to inform a decision the program would otherwise make blind, so a judgment that cannot be obtained degrades to that same blind decision, and never becomes a new way for a turn to fail.

Two failures throw. A malformed question (a choice with one option, a score with one level, an unknown `type`) is a programming error, reported with the offending question id. And `judgment.ask` is declared `risk: "network"`, so an operator who moves `approvals.network` off its `allow` default gets the usual approval prompt or denial from the registry before the lane is reached.

An oversized state is refused, never truncated. Silently cutting the evidence changes the answer while reporting nothing, and the caller is the only party that knows which part of its state is expendable.

## Budgets

`judgment.maxStateBytes` defaults to 64 KiB, roughly 16k tokens at four bytes each. TypeSafe publishes a 64k-token ceiling per request for `jev-latest`, of which the state plus the longest question may use 32k, so the default leaves room for the questions themselves; a chat-model backend carries its own context limit instead.

`judgment.maxQuestionsPerRequest` defaults to 32 and bounds both a single ask and a merged batch; a batch that would cross it flushes early, while a single ask that crosses it is refused. `judgment.maxConcurrent` defaults to 8 and bounds the backend requests in flight, because distinct states never merge: judging a hundred items in parallel would otherwise open a hundred requests at once. A batch beyond the limit waits for a slot, and its deadline starts when it does.

`judgment.stats` reports requests, batched requests, merged callers, questions, refusals, failures, timeouts, the backend that answered last, and the last error.

## Gates

The lane also serves Fabric itself. Four gates read it, and every one ships off:

| Key | What it judges | When it runs |
| --- | --- | --- |
| `judgment.gates.toolExec` | a core or captured tool call, before it runs | per call |
| `judgment.gates.toolOutput` | fetched text, before it enters the model's context | per MCP call, captured web search, and remote-URL read |
| `judgment.gates.delegation` | which agent kind and effort a delegated run takes | per spawn |
| `judgment.gates.skills` | which skill, if any, the turn needs | per turn |

They ship off so their effects stay separable. Turn on two at once and a behaviour change has two suspects; turn on one and the next day's difference belongs to it.

Every gate fails open. A refusal from the lane leaves the code on the path it would have taken with no judgment at all, which is what makes a gate safe to leave on.

Two limits are worth knowing before an attribution run. The tool-call gate escalates by raising the call's risk class into the approval path that already exists, and **Fabric ships every approval class on `allow`**, so on a stock configuration the gate forms a verdict on every non-read call and has nothing to escalate to. It is silent until the operator moves an approval class off `allow`, and the same holds for a class already approved for this session. And the delegation gate's confidence floor only bites on the TypeSafe backend: the chat bridge in `@oh-my-pi/pi-ai` builds a one-hot answer with `confidence: 1`, so every answer clears any floor by construction.

The gates are inert inside the residency host. That process runs without an OMP session, so there is no model registry or settings object for the host judge to resolve from, and a lane there would answer `unsupported` to everything. Runs delegated through a resident host keep the configured defaults.

### What the skill gate costs

Measured on this machine's roster of 765 skills, over a 14-case fixture with `bun run benchmark:skill-router`:

- top-1 on the nine labelled cases: **6/9**
- suggested a skill on a turn that needed none: **0/5**, including two prompts written to sound procedural with no skill behind them
- added latency, cases run one at a time: **p50 1.1 s, p90 1.4 s, max 1.9 s per turn**

Latency is the number that decides whether the gate earns its place. An earlier run of this harness fired all cases at once and reported 3.5 to 4.4 seconds; that figure was queue time behind other cases, not the cost of one turn, and the harness now runs serially for exactly that reason. It also excludes any case the backend failed to answer from every figure, because the gate fails open and a dead backend would otherwise read as a perfect false-suggestion score.

TypeSafe rejects a Choice carrying more than 255 options, so 765 skills travel as sharded questions in one request, and a second request then reads the shortlist. Two of the three misses name a skill that overlaps the labelled answer on its own terms, so the fixture is as much under test as the ranker.

The harness measures the ranker, not the agent: it reports which skill the router names, not whether the model then loads it. Only an end-to-end agent run shows the second thing.


## Helper runtime API

Guest programs and batch scripts access the lane through `globalThis.judge`.

- `judge.bool(state, instructions, options?)`: returns the probability of yes as a number, or the configured fallback when the backend fails.
- `judge.choice(state, options, instructions, config?)`: returns the chosen label string from an array or criteria map.
- `judge.score(state, criteria, instructions, config?)`: returns the score index from ordered levels.
- `judge.filter(items, instructions, options?)`: evaluates an array in bounded chunks of up to 25 items per request. When a request fails, it preserves all chunk items under `onFail: "keep-all"`.
- `judge.classify(items, categories, instructions, options?)`: assigns a category to each item across bounded chunks.
- `judge.ask(state, questions)`: direct access for custom question maps.
