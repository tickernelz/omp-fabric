import ts from "typescript";
import { stableJsonHash } from "../core/stable-hash.js";
import { guestOmpArgs } from "./guest-args.js";
import type { FabricSpeculationCandidate } from "./types.js";

// Root namespaces the model can call from a fabric program. Calls are emitted
// as candidates regardless of action so the tap can apply its eligibility
// policy in one place; args must still be fully literal.
const ROOTS = new Set(["omp", "memory", "state", "schema", "compact", "components", "mcp"]);

const LITERAL_FAIL = Symbol("literal-fail");

type LiteralResult = { ok: true; value: unknown } | { ok: false };

const literalOk = (value: unknown): LiteralResult => ({ ok: true, value });
const LITERAL_FAIL_RESULT: LiteralResult = { ok: false };

// Accept only values that survive a JSON round trip unchanged in structure so
// the speculation key (stableJsonHash over prepared args) cannot drift from
// what the real invocation produces.
const isJsonShape = (value: unknown): boolean => {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonShape);
      const record = value as Record<string, unknown>;
      return Object.values(record).every(isJsonShape);
    }
    default:
      return false;
  }
};

const evalLiteral = (node: ts.Expression): LiteralResult => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return literalOk(node.text);
  }
  if (ts.isNumericLiteral(node)) {
    if (node.text.endsWith("n")) return LITERAL_FAIL_RESULT; // bigint
    const value = Number(node.text);
    return Number.isFinite(value) ? literalOk(value) : LITERAL_FAIL_RESULT;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    if (node.operand.text.endsWith("n")) return LITERAL_FAIL_RESULT;
    const value = Number(node.operand.text);
    if (!Number.isFinite(value)) return LITERAL_FAIL_RESULT;
    return literalOk(node.operator === ts.SyntaxKind.MinusToken ? -value : value);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return literalOk(true);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return literalOk(false);
  if (node.kind === ts.SyntaxKind.NullKeyword) return literalOk(null);
  if (ts.isArrayLiteralExpression(node)) {
    const items: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return LITERAL_FAIL_RESULT;
      const item = evalLiteral(element);
      if (!item.ok) return item;
      items.push(item.value);
    }
    return literalOk(items);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const record: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return LITERAL_FAIL_RESULT;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return LITERAL_FAIL_RESULT;
      const value = evalLiteral(property.initializer);
      if (!value.ok) return value;
      record[name.text] = value.value;
    }
    return literalOk(record);
  }
  return LITERAL_FAIL_RESULT;
};

const collectBoundNames = (name: ts.BindingName, into: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBoundNames(element.name, into);
  }
};

/** Property-access chain as segments, e.g. mcp.exa.search -> ["mcp","exa","search"]. */
const accessChain = (node: ts.Expression): string[] | undefined => {
  const segments: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  segments.unshift(current.text);
  return segments;
};

const refFromChain = (segments: string[], tainted: Set<string>): string | undefined => {
  const root = segments[0]!;
  if (!ROOTS.has(root) || tainted.has(root)) return undefined;
  if (segments.length === 2) return `${segments[0]}.${segments[1]}`;
  if (segments.length === 3 && root === "mcp") return segments.join(".");
  return undefined;
};

/**
 * Scans a growing partial TypeScript program for completed calls on the spec
 * namespaces whose arguments are all literals. Reparses the full prefix only
 * when newly appended text contains a ")" — which is the earliest point a call
 * expression can complete — so streaming deltas inside string payloads cost a
 * substring scan, not an AST build.
 */
export class LiteralCallScanner {
  #scannedLength = 0;
  readonly #tainted = new Set<string>();
  readonly #emitted = new Set<string>();

  push(code: string): FabricSpeculationCandidate[] {
    const appended = code.slice(this.#scannedLength);
    const forceScan = code.length < this.#scannedLength;
    if (!forceScan && !appended.includes(")")) return [];
    this.#scannedLength = code.length;

    const source = ts.createSourceFile(
      "speculation.ts",
      code,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );

    // A local/declared binding that shares a namespace root makes dotted calls
    // ambiguous (e.g. `const omp = { read: () => ... }`); taint that root for
    // the rest of the stream.
    for (const statement of source.statements) {
      this.#collectStatementBindings(statement, this.#tainted);
    }

    const candidates: FabricSpeculationCandidate[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const segments = accessChain(node.expression);
        if (segments) {
          const ref = refFromChain(segments, this.#tainted);
          if (ref) {
            const args = this.#literalArgs(ref, node);
            if (args !== undefined) {
              const key = `${ref}\n${stableJsonHash(args)}`;
              if (!this.#emitted.has(key)) {
                this.#emitted.add(key);
                candidates.push({ ref, args });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return candidates;
  }

  #literalArgs(ref: string, node: ts.CallExpression): Record<string, unknown> | undefined {
    if (node.arguments.length === 0) return {};
    const values: unknown[] = [];
    for (const argument of node.arguments) {
      if (ts.isSpreadElement(argument)) return undefined;
      const value = evalLiteral(argument);
      if (!value.ok || !isJsonShape(value.value)) return undefined;
      values.push(value.value);
    }
    if (ref.startsWith("omp.")) {
      const args = guestOmpArgs(ref.slice("omp.".length), values);
      return args !== undefined && isJsonShape(args) ? args : undefined;
    }
    if (values.length !== 1) return undefined;
    const only = values[0];
    if (typeof only !== "object" || only === null || Array.isArray(only)) return undefined;
    return only as Record<string, unknown>;
  }

  #collectStatementBindings(node: ts.Node, into: Set<string>): void {
    const visit = (current: ts.Node): void => {
      if (ts.isVariableDeclaration(current)) collectBoundNames(current.name, into);
      else if (
        (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) &&
        current.name
      ) {
        into.add(current.name.text);
      } else if (
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        for (const parameter of current.parameters) collectBoundNames(parameter.name, into);
      } else if (ts.isImportDeclaration(current) && current.importClause) {
        const clause = current.importClause;
        if (clause.name) into.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            into.add(clause.namedBindings.name.text);
          } else {
            for (const element of clause.namedBindings.elements) into.add(element.name.text);
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
  }
}
