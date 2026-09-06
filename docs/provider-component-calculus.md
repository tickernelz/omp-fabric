# Provider component calculus

Component ownership preserves the names and action refs of every non-kernel first-party provider. The component plane then controls provider lifetime through staged publication and rolling replacement.

This calculus extends the [component calculus](component-calculus.md). It applies DeepSeek's component and fiber rules to provider namespaces that `fabric_exec` can call.

## 1. Objects

Let $N$ be the finite set of provider names. Let $A_n$ be the action names under $n \in N$. A public ref is the pair $n.a$, where $a \in A_n$.

### Definition 1. Provider

A provider is the tuple

$$
P = \langle n, \delta, D, I, Q \rangle
$$

with these fields:

- $n \in N$ is the public namespace.
- $\delta$ is the public provider description.
- $D : A_n \rightharpoonup \mathrm{Descriptor}$ maps each action to its public descriptor.
- $I : A_n \times \mathrm{Args} \times \mathrm{Invocation} \to \mathrm{Result}$ invokes an action.
- $Q$ closes provider-owned resources.

A descriptor contains its description, input schema, output schema, risk, namespace metadata, and effect metadata. Write $H(D(a))$ for its stable descriptor hash.

### Definition 2. Provider equivalence

Two provider instances are semantically equivalent, written $P \simeq_p P'$, when they satisfy these conditions:

$$
\begin{aligned}
&\mathrm{name}(P) = \mathrm{name}(P') \\
&\mathrm{description}(P) = \mathrm{description}(P') \\
&A_{\mathrm{name}}(P) = A_{\mathrm{name}}(P') \\
&\forall a.\ H(D_P(a)) = H(D_{P'}(a)) \\
&\forall a, x, c.\ I_P(a, x, c) \simeq_{\mathrm{obs}} I_{P'}(a, x, c)
\end{aligned}
$$

The provider author chooses the relation $\simeq_{\mathrm{obs}}$. It covers every value and event produced by the action call.

### Definition 3. Provider componentization

The componentization map $C$ sends a provider factory $F$ to

$$
C(F) = \langle d, p, e \rangle
$$

where

$$
\begin{aligned}
d &= \text{declared action requirements} \\
p &= \{ \mathrm{name}(F()) \} \\
e &= \text{create} \to \text{stage} \to \text{commit}
\end{aligned}
$$

The inverse of $e$ retires the staged or active binding and releases its owner lease. $Q$ runs after owner release when the binding has zero retainers and zero in-flight calls.

The direct and component-owned mount paths form this square:

```text
provider factory F ──create──▶ provider P
       │                           │
       │ C                         │ register
       ▼                           ▼
component C(F) ──activate──▶ ActionRegistry
```

The square commutes when $C(F)$ publishes the same $P$ that direct registration would publish.

### Definition 4. Binding

A binding is

$$
b = \langle \mathrm{id}, n, \mathrm{generation}, P, \mathrm{state}, \mathrm{owner}, \mathrm{retainers}, \mathrm{inFlight} \rangle
$$

The state belongs to

$$
\{ \mathrm{staged},\ \mathrm{active},\ \mathrm{retiring},\ \mathrm{closed} \}
$$

The binding ID is a fresh atom. Generation increases for each new binding under the same namespace.

### Definition 5. Live provider projection

For runtime state $\gamma$, define

$$
\Sigma_\gamma : N \rightharpoonup \mathrm{Binding}
$$

where $\Sigma_\gamma(n) = b$ exactly when $b$ is the current active binding for $n$.

$\Sigma_\gamma$ contains current active bindings. A retained committed view can address a retiring binding by its ID.

### Definition 6. Public action projection

The public projection is

$$
\OMP(\gamma) = \{ n.a \mapsto \langle D_b(a), H(D_b(a)) \rangle \mid \Sigma_\gamma(n) = b \}
$$

The public projection omits binding IDs, generations, component IDs, and lifecycle states. The `components.*` surface can expose component state as a control-plane value.

### Definition 7. Pinned manifest

A pinned manifest is a finite map

$$
B : \mathrm{ComponentId} \rightharpoonup \mathrm{ComponentName}
$$

Pinned manifest entries remain in the loader target across user configuration reconciliation. Built-in entries use names of the form `fabric.provider.<namespace>`. The host reserves this definition prefix at the eager and discovery registration boundaries.

The complete loader target is

$$
T = B \uplus U
$$

where $U$ is the user component map. The disjoint union requires unique IDs. Both collision checks run inside the loader serialization queue.

### Definition 8. Catalog revision

The component catalog maps each component name to

$$
\rho(\mathrm{name}) = \langle \mathrm{definition}, \mathrm{revision} \rangle
$$

Registering a replacement increments `revision`. Every enabled pinned or user entry that names the definition becomes a replacement target.

## 2. Operational rules

### Rule P-Insert

A pinned entry enters $B$ when its ID is fresh and its provision is disjoint from every admitted fiber provision.

$$
\frac{\mathrm{id} \notin \mathrm{dom}(T) \qquad p \cap \mathrm{provisions}(T) = \varnothing}{T \mapsto T[\, \mathrm{id} \mapsto \mathrm{component} \,]} \quad \text{P-Insert}
$$

### Rule P-Begin

Activation creates a provider and mounts its binding as `staged`.

$$
\frac{F() = P \qquad \mathrm{name}(P) \in p \qquad \mathrm{target}(\mathrm{id}, \gamma) \neq \bot}{\gamma \mapsto \gamma[\, b.\mathrm{state} \mapsto \mathrm{staged} \,]} \quad \text{P-Begin}
$$

A factory that returns another namespace closes that provider and fails the transition.

### Rule P-Commit

The component commits all staged provider bindings together after activation settles and the target remains equal to its committed view.

$$
\frac{\mathrm{allDeclaredMounted} \qquad \mathrm{target}(\mathrm{id}, \gamma) = \omega}{b.\mathrm{state} \mapsto \mathrm{active} \qquad \Sigma_\gamma(\mathrm{name}(b)) \mapsto b} \quad \text{P-Commit}
$$

$\OMP(\gamma)$ contains active provider actions.

### Rule P-Leave

Retirement removes the provider from the live namespace before its inverse runs. A target change, explicit reload, replacement, or stop request can start this rule.

$$
\frac{\mathrm{current}(\mathrm{name}(b)) = b \qquad \mathrm{leaveRequested}(\mathrm{id}, \gamma)}{\Sigma_\gamma \mapsto \Sigma_\gamma \setminus \mathrm{name}(b) \qquad b.\mathrm{state} \mapsto \mathrm{retiring}} \quad \text{P-Leave}
$$

$\mathrm{leaveRequested}$ covers target drift, explicit reload, replacement, and stop. Dependent fibers see their target change and unload first.

### Rule P-Close

A retiring provider closes after all ownership and use counts reach zero.

$$
\frac{\mathrm{state} = \mathrm{retiring} \qquad \mathrm{owner} = \mathrm{released} \qquad \mathrm{retainers} = 0 \qquad \mathrm{inFlight} = 0}{Q(P) \qquad \mathrm{state} \mapsto \mathrm{closed}} \quad \text{P-Close}
$$

### Rule P-Revise

A catalog revision retires the active fiber and starts the new definition under the same component ID.

$$
\frac{\rho(\mathrm{name}) = \langle \mathrm{definition}_v, v \rangle \qquad \rho'(\mathrm{name}) = \langle \mathrm{definition}_{v+1}, v+1 \rangle}{\mathrm{fiber}_v \mapsto \mathrm{unloading} \mapsto \mathrm{fiber}_{v+1}} \quad \text{P-Revise}
$$

The provider namespace stays equal by the provision declaration.

### Rule P-Restore

A failed candidate with successful cleanup restores the prior definition.

$$
\frac{\mathrm{activate}(v+1) = \mathrm{failure} \qquad \mathrm{cleanup}(v+1) = \mathrm{success}}{\mathrm{fiber}_{v+1} \mapsto \mathrm{fiber}_{v+2}\ \text{using}\ \mathrm{definition}_v} \quad \text{P-Restore}
$$

The revision increases again because restoration is a new lifecycle episode. Cleanup failure enters `quarantined` state and reports the inverse failure as its final outcome.

## 3. Rolling replacement

Let $b_v$ be the active provider binding for definition revision $v$. A rolling replacement follows this path:

```text
catalog revision v+1
        │
        ▼
retire b_v ──▶ unload dependents ──▶ run inverse_v
        │
        │ retained by committed views
        ▼
create b_v+1 ──▶ stage ──▶ commit ──▶ reload dependents
```

A committed view $\omega_v$ keeps $b_v$ callable during retirement. Uncommitted resolution follows $\Sigma_\gamma$, which moves to $b_{v+1}$ at commit. `P-Commit` publishes the full binding set in one synchronous operation. A commit observer may request immediate retirement, which yields a short complete episode. The public projection contains complete binding sets.

These rules govern rolling replacement. During the interval between retirement and candidate commit, an uncommitted concurrent call reports that the provider is unavailable. A `fabric_exec` call that invokes `components.reload` waits for the replacement result.

## 4. Theorems

### Theorem 1. Namespace preservation

Let $\gamma_d$ be a quiet runtime that directly registers provider family $(P_i)$. Let $\gamma_c$ be a quiet runtime that activates $(C(F_i))$, with $F_i() \simeq_p P_i$. Then

$$
\begin{aligned}
\mathrm{dom}(\OMP(\gamma_d)) &= \mathrm{dom}(\OMP(\gamma_c)) \\
\forall r \in \mathrm{dom}(\OMP).\ \mathrm{descriptor}_d(r) &= \mathrm{descriptor}_c(r) \\
\forall r \in \mathrm{dom}(\OMP).\ \mathrm{hash}_d(r) &= \mathrm{hash}_c(r)
\end{aligned}
$$

Proof sketch: `P-Begin` keeps a staged binding in component state until `P-Commit` inserts it under the declared provider name. Provision disjointness leaves one active binding per name, and provider equivalence supplies equal descriptor maps and hashes.

### Theorem 2. `fabric_exec` observational equivalence

Take equal guest code, strings, invocation context, policy state, and action arguments. Under the premises of Theorem 1, every call outside `components.*` has equal registry observations:

$$
\begin{aligned}
\mathrm{providers}_d &= \mathrm{providers}_c \\
\mathrm{catalog}_d &= \mathrm{catalog}_c \\
\mathrm{search}_d &= \mathrm{search}_c \\
\mathrm{describe}_d &= \mathrm{describe}_c \\
\mathrm{invoke}_d &\simeq_{\mathrm{obs}} \mathrm{invoke}_c
\end{aligned}
$$

Proof sketch: discovery and invocation read `ActionRegistry` through $\OMP$ and the provider descriptions $\delta$. Component fields belong to the control plane. After binding resolution, each call uses the same registry pipeline and host policy.

### Theorem 3. Committed-view continuity

If $\omega_v$ retains $b_v$, then `P-Leave` preserves that binding until $\omega_v$ releases it during normal runtime operation. Calls through $\omega_v$ resolve to the same binding atom and descriptor hash during a replacement.

Proof sketch: committed view acquisition increments $\mathrm{retainers}$, which keeps `P-Close` blocked. Invocation increments $\mathrm{inFlight}$, and descriptor drift fails before the provider call. Final registry shutdown releases view retainers and owner retention. The in-flight gate remains active until the last settling call closes its binding. Host shutdown quiescence lies outside the rolling lifecycle relation.

### Theorem 4. Rolling replacement safety

Assume the old and candidate factories satisfy the declared namespace and every transition settles. `P-Revise` reaches one of these explicit outcomes:

$$
\begin{cases}
\text{candidate active under the same namespace} \\
\text{prior definition restored under the same namespace after clean candidate recovery} \\
\text{failed or quarantined status with an explicit replacement and rollback error}
\end{cases}
$$

The public projection contains a complete candidate binding set.

Proof sketch: candidate bindings stay staged through activation, then `P-Commit` publishes the full set. Failure applies the candidate inverse and releases its provider. `P-Restore` runs the previous definition as another guarded episode. A failed restoration reports its final state through the component status.

### Theorem 5. Dependency withdrawal order

If component $m$ commits a view that maps requirement $n.a$ to provider component $k$, then $m$ unloads before $k$ runs its provider inverse.

Proof sketch: retiring $k$ removes its provision from the live target, so the supervisor finds committed views that name $k$'s binding and awaits their unload. `P-Close` then applies the residual lease and invocation guard.

### Theorem 6. Startup quiescence

Runtime initialization installs every enabled pinned provider component before it creates the execution service and emits provider discovery. When initialization resolves, each enabled built-in namespace is active or initialization has failed.

Proof sketch: `installPinned` uses the serialized loader queue and awaits supervisor reconciliation. Runtime construction awaits each manifest extension, then the completeness guard requires an active registry binding for every enabled namespace. The runtime creates the execution service after that guard passes.

### Theorem 7. Terminal confluence

For finite fibers, disjoint provisions, settling transitions, pairwise independent effects, and conforming managed-provider factories, any fair lifecycle schedule reaches the same quiet public projection for one catalog and one target manifest.

Proof sketch: independent activation steps commute under the stated premise, and provision uniqueness removes namespace races. Target comparison withdraws stale fibers before reload, so the final catalog revision and manifest determine the quiet bindings. A conforming factory reports its provisions and obeys the effect-independence premise. The runtime checks provision collisions and accepts effect independence as the author's witness.

## 5. Runtime correspondence

| Calculus object | Runtime object |
| --- | --- |
| $P$ | `FabricProvider` |
| $C(F)$ | `createProviderComponent(spec)` |
| $B$ | `FabricComponentLoader.#pinned` |
| $U$ | configured `components` entries |
| $\rho$ | `FabricComponentCatalog` revision |
| $b$ | `FabricProviderBinding` |
| $\Sigma_\gamma$ | `FabricProviderBindings.#current` |
| $\OMP(\gamma)$ | ActionRegistry providers, descriptors, and hashes |
| $\omega$ | `FabricCommittedCapabilityView` |
| P-Commit | `activateProviderBindings()` |
| P-Revise | catalog event followed by `supervisor.replace()` |
| P-Restore | loader and supervisor transactional rollback |

## 6. Kernel boundary

The component system depends on a finite kernel:

- `ActionRegistry` and provider bindings.
- Component catalog, loader, supervisor, and effect scopes.
- Execution validation, authorization, approval, audit, and output bounds.
- Trusted host configuration and package discovery.
- The `components.*` diagnostics provider.

The pinned first-party provider set is

$$
\{ \text{omp},\ \text{extensions},\ \text{mcp},\ \text{mesh},\ \text{state},\ \text{schema},\ \text{compact},\ \text{agents},\ \text{memory} \}
$$

Configuration gates can omit `omp`, `extensions`, `mesh`, `state`, or `memory`. The registry keeps explicit unavailable-provider messages for gated `mesh`, `state`, and `memory` namespaces. Full-code gating controls the guest visibility of `omp` and `extensions`.

Fabric treats host managers for mesh storage and participant control as trusted kernel services. Actor scheduling and schema state use the same boundary. Each provider component controls its public action surface and its provider's resource lifetime.

## 7. Compatibility boundary

The model-visible compatibility condition is

$$
\begin{aligned}
\OMP_{\mathrm{before}} &= \OMP_{\mathrm{after}} \\
\delta_{\mathrm{before}} &= \delta_{\mathrm{after}}
\end{aligned}
$$

Under this condition, provider descriptions and ref names stay stable. Action descriptors, guest globals, discovery results, result shapes, error shapes, and the policy path keep the same values.

`components.*` adds lifecycle diagnostics to the surface. The component graph includes each built-in provider component.

After startup, ordinary action calls use the direct `ActionRegistry` branch. Component work runs at initialization, reload, provider change, and shutdown boundaries.

## 8. Verification anchors

| Law | Source check | Test |
| --- | --- | --- |
| Pinned entries survive config reconciliation | `FabricComponentLoader.#targetEntries()` | `component-loader.test.ts` |
| Pinned and configured IDs stay disjoint under concurrency | loader serialization queue | `component-loader.test.ts` |
| Catalog revision rolls a pinned fiber | catalog subscription and `supervisor.replace()` | `component-loader.test.ts` |
| Provider namespace stays stable | `createProviderComponent()` name check | `provider-components.test.ts` |
| Staged providers stay hidden | `FabricProviderBindings.mount()` | `provider-bindings.test.ts` |
| Committed calls retain old generation | binding retainers | `provider-components.test.ts` |
| In-flight calls delay rolling close | binding in-flight count | `provider-components.test.ts` |
| Dependency withdrawal precedes provider inverse | supervisor dependent scan | `component-supervisor.test.ts` |
| Dependents repin after provider replacement | supervisor reconciliation | `provider-components.test.ts` |
| Failed provider candidates restore their namespace | `supervisor.replace()` | `provider-components.test.ts` |
| Commit diversion withdraws the short provider episode | post-commit epoch check | `provider-components.test.ts` |
| Startup manifest requires active namespaces | `FabricProviderComponentManifest.assertActive()` | `provider-components.test.ts` |
| Execution and discovery follow active built-ins | `FabricRuntimeState.initialize()` | `fabric-runtime-components.test.ts` |
| Discovery rejects a reserved built-in definition | `registerExternalComponent()` | `fabric-runtime-components.test.ts` |
| Independent insertion reaches one projection | supervisor reconciliation | `component-laws.test.ts` |
| `components.reload` reaches pinned fibers | loader `#loaded` map | `components-provider.test.ts` |
| `components.reload` reports rollback and preserves the namespace | loader reload diagnostics | `components-provider.test.ts` |
| Default descriptors and hashes stay fixed | `actionDescriptorHash()` | `default-path-compatibility.test.ts` |
| Full runtime behavior stays green | package quality gate | `bun run check` |
