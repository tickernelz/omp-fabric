import { describe, expect, test } from "vitest";
import { OMP_CORE_TOOL_NAMES, ompChildToolName } from "../src/core/omp-tools.js";

describe("the tool names a child omp is launched with", () => {
	test("a core tool that the host renames keeps the host's name", () => {
		expect(ompChildToolName("find")).toBe("glob");
	});

	test("every other core tool is passed through unchanged", () => {
		const passThrough = OMP_CORE_TOOL_NAMES.filter((name) => name !== "find" && name !== "ls");
		for (const name of passThrough) expect(ompChildToolName(name)).toBe(name);
	});

	test("ls has no host built-in, so a child is given no entry for it", () => {
		expect(ompChildToolName("ls")).toBeUndefined();
	});

	test("a tool fabric does not own, such as an extension, is left alone", () => {
		expect(ompChildToolName("fabric_exec")).toBe("fabric_exec");
		expect(ompChildToolName("task")).toBe("task");
	});
});
