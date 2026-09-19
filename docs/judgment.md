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
