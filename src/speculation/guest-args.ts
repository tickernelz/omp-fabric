const STRING_FIELDS: Readonly<Record<string, string>> = {
  bash: "command",
  read: "path",
  ls: "path",
  grep: "pattern",
  find: "pattern"
};

const POSITIONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  grep: [
    "pattern",
    "path",
    "skip"
  ],
  find: [
    "pattern",
    "path",
    "limit"
  ],
  write: [
    "path",
    "content"
  ],
  edit: [
    "path",
    "oldText",
    "newText"
  ]
};

const NUMERIC_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: [
    "offset",
    "limit"
  ],
  bash: [
    "timeout"
  ],
  grep: [
    "skip",
    "context"
  ],
  find: [
    "limit"
  ],
  ls: [
    "limit"
  ]
};

const OPTIONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: [
    "offset",
    "limit"
  ],
  grep: [
    "path",
    "glob",
    "ignoreCase",
    "literal",
    "context",
    "limit"
  ],
  find: [
    "path",
    "limit"
  ],
  ls: [
    "path",
    "limit"
  ]
};

const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bash: {
    cmd: "command",
    shell: "command",
    cmdline: "command",
    script: "command",
    commandLine: "command",
    workdir: "cwd",
    directory: "cwd",
    workingDirectory: "cwd"
  },
  find: {
    query: "pattern",
    regex: "pattern",
    search: "pattern",
    name: "pattern",
    filename: "pattern",
    glob: "pattern",
    expression: "pattern",
    include: "pattern",
    max: "limit"
  },
  grep: {
    query: "pattern",
    regex: "pattern",
    search: "pattern",
    q: "pattern",
    expression: "pattern",
    text: "pattern",
    ic: "ignoreCase",
    caseInsensitive: "ignoreCase",
    globPattern: "glob",
    ctx: "context"
  },
  read: {
    file: "path",
    absolutePath: "path",
    file_path: "path",
    filePath: "path",
    filepath: "path",
    pathname: "path",
    target_file: "path",
    targetFile: "path",
    absolute_path: "path",
    fileAbsolutePath: "path",
    max: "limit",
    start: "offset"
  },
  ls: {
    dir: "path",
    file: "path",
    folder: "path",
    absolutePath: "path",
    file_path: "path",
    filePath: "path",
    filepath: "path",
    pathname: "path",
    target_file: "path",
    targetFile: "path",
    absolute_path: "path",
    fileAbsolutePath: "path",
    directory: "path",
    directoryPath: "path",
    max: "limit"
  },
  edit: {
    file: "path",
    absolutePath: "path",
    file_path: "path",
    filePath: "path",
    filepath: "path",
    pathname: "path",
    target_file: "path",
    targetFile: "path",
    absolute_path: "path",
    fileAbsolutePath: "path",
    old: "oldText",
    old_string: "oldText",
    oldString: "oldText",
    old_str: "oldText",
    oldStr: "oldText",
    from: "oldText",
    old_value: "oldText",
    old_text: "oldText",
    oldContent: "oldText",
    old_content: "oldText",
    new: "newText",
    replacement: "newText",
    new_string: "newText",
    newString: "newText",
    new_str: "newText",
    newStr: "newText",
    to: "newText",
    new_value: "newText",
    new_text: "newText",
    newContent: "newText",
    new_content: "newText"
  },
  write: {
    file: "path",
    absolutePath: "path",
    file_path: "path",
    filePath: "path",
    filepath: "path",
    pathname: "path",
    target_file: "path",
    targetFile: "path",
    absolute_path: "path",
    fileAbsolutePath: "path",
    contents: "content",
    body: "content",
    text: "content",
    data: "content",
    fileContent: "content"
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positionalToArgs = (name: string, rest: readonly unknown[]): unknown => {
  const first = rest[0];
  const second = rest[1];
  const primaryField = STRING_FIELDS[name];
  if (
    rest.length === 2 &&
    typeof first === "string" &&
    primaryField !== undefined &&
    isPlainObject(second)
  ) {
    return { ...second, [primaryField]: first };
  }
  const order = POSITIONAL_FIELDS[name];
  if (!order) return rest.length > 0 ? first : {};
  const out: Record<string, unknown> = {};
  for (let index = 0; index < rest.length && index < order.length; index += 1) {
    const value = rest[index];
    if (value !== undefined) out[order[index]!] = value;
  }
  return out;
};

const normalizeOmpArgs = (name: string, args: unknown): unknown => {
  const field = STRING_FIELDS[name];
  if (typeof args === "string" && field) return { [field]: args };
  if (!isPlainObject(args)) return args;
  let out: Record<string, unknown> = args;
  const copy = (): void => {
    if (out === args) out = { ...args };
  };
  if (name === "bash" && "timeoutMs" in out) {
    copy();
    if (!("timeout" in out)) {
      const timeoutMs = out.timeoutMs;
      if (timeoutMs !== null && timeoutMs !== undefined) {
        out.timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) / 1000 : timeoutMs;
      }
    }
    delete out.timeoutMs;
  }
  if (name === "bash" && "settle" in out) {
    copy();
    delete out.settle;
  }
  const aliases = ARG_ALIASES[name];
  if (aliases) {
    for (const alias of Object.keys(aliases)) {
      const canonical = aliases[alias]!;
      if (!(alias in out)) continue;
      copy();
      if (!(canonical in out)) out[canonical] = out[alias];
      delete out[alias];
    }
  }
  const numerics = NUMERIC_FIELDS[name];
  if (numerics) {
    for (const key of numerics) {
      const value = out[key];
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        copy();
        out[key] = Number(value);
      }
    }
  }
  const optionals = OPTIONAL_FIELDS[name];
  if (optionals) {
    for (const key of optionals) {
      if (out[key] !== null && out[key] !== undefined) continue;
      if (!(key in out)) continue;
      copy();
      delete out[key];
    }
  }
  if (name === "edit" && Array.isArray(out.edits)) {
    let changed = false;
    const editAliases = ARG_ALIASES.edit!;
    const edits = out.edits.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      let edit: Record<string, unknown> = entry;
      for (const alias of Object.keys(editAliases)) {
        const canonical = editAliases[alias]!;
        if (canonical !== "oldText" && canonical !== "newText") continue;
        if (!(alias in edit)) continue;
        if (edit === entry) edit = { ...entry };
        if (!(canonical in edit)) edit[canonical] = edit[alias];
        delete edit[alias];
        changed = true;
      }
      return edit;
    });
    if (changed) {
      copy();
      out.edits = edits;
    }
  }
  if (name === "edit" && !Array.isArray(out.edits) && ("oldText" in out || "newText" in out)) {
    copy();
    const edit: Record<string, unknown> = {};
    if ("oldText" in out) edit.oldText = out.oldText;
    if ("newText" in out) edit.newText = out.newText;
    out.edits = [edit];
    delete out.oldText;
    delete out.newText;
  }
  return out;
};

export const guestOmpArgs = (
  name: string,
  literalArguments: readonly unknown[],
): Record<string, unknown> | undefined => {
  const raw = literalArguments.length <= 1
    ? (literalArguments.length === 1 ? literalArguments[0] : undefined)
    : positionalToArgs(name, literalArguments);
  const args = raw === undefined ? {} : raw;
  const normalized = normalizeOmpArgs(name, args);
  return isPlainObject(normalized) ? normalized : undefined;
};
