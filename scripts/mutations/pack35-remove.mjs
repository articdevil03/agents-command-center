export const pack35RemoveMutations = [
  [
    "p35-remove-confirm",
    "server/settings/cli-install.ts",
    "if (true !== value.confirm) throw new Error(\"Removal confirmation is required.\");",
    "/* mutation: confirmation omitted */"
  ],
  [
    "p35-remove-in-use",
    "server/settings/cli-install.ts",
    "if (inUse()) return Promise.reject(new Error(\"Stop the chats and seats that use it first, then try again.\"));",
    "/* mutation: in-use refusal omitted */"
  ],
  [
    "p35-remove-name",
    "server/settings/opencode/remove.ts",
    "/^install-[a-f0-9-]+$/.test(name)",
    "name.startsWith(\"install-\")"
  ],
  [
    "p35-remove-link",
    "server/settings/opencode/remove.ts",
    "    assertNoLinks(path);\n    return path;\n  }\n  async function info(path: string) {\n    return lstat(checked(path)).catch",
    "    return path;\n  }\n  async function info(path: string) {\n    return import(\"node:fs/promises\").then(({ stat }) => stat(checked(path))).catch"
  ],
  [
    "p35-remove-outside",
    "server/settings/opencode/remove.ts",
    "await removeFile(descriptor); // Deactivate FIRST, including partial cleanup failures.",
    "await removeFile(descriptor); await io.unlink(join(root, \"..\", tool === \"copilot\" ? \"opencode\" : \"copilot\", \"keep\")); // mutation: delete outside managed root"
  ],
  [
    "p35-remove-descriptor-last",
    "server/settings/opencode/remove.ts",
    "  await removeFile(descriptor); // Deactivate FIRST, including partial cleanup failures.\n  if (failed) throw new Error(PARTIAL_REMOVAL);\n  async function removeTree(path: string): Promise<void> {\n    try {\n      if (!(await info(path))?.isDirectory()) throw new Error(\"Unsafe installation entry.\");\n      for (const name of await readdir(checked(path))) {\n        const child = join(path, name), stat = await info(child);\n        if (stat?.isDirectory()) await removeTree(child);\n        else if (stat?.isFile()) await removeFile(child);\n        else if (stat) throw new Error(\"Unsafe installation entry.\");\n      }\n      if (!(await readdir(checked(path))).length) await rmdir(checked(path));\n    } catch { failed = true; }\n  }\n  for (const dir of dirs) await removeTree(dir);\n",
    "  if (failed) throw new Error(PARTIAL_REMOVAL);\n  async function removeTree(path: string): Promise<void> {\n    try {\n      if (!(await info(path))?.isDirectory()) throw new Error(\"Unsafe installation entry.\");\n      for (const name of await readdir(checked(path))) {\n        const child = join(path, name), stat = await info(child);\n        if (stat?.isDirectory()) await removeTree(child);\n        else if (stat?.isFile()) await removeFile(child);\n        else if (stat) throw new Error(\"Unsafe installation entry.\");\n      }\n      if (!(await readdir(checked(path))).length) await rmdir(checked(path));\n    } catch { failed = true; }\n  }\n  for (const dir of dirs) await removeTree(dir);\n  await removeFile(descriptor);\n"
  ]
];
pack35RemoveMutations.push(
  ["p35-remove-owner-mapping", "server/settings/cli-availability.ts", 'const cli = kind.startsWith("acp:") ? catalogOwner({ id: kind.slice(4) })?.id ?? kind : kind;', 'const cli = kind;'],
  ["p35-remove-saved-signature", "server/main/managed-tool-use.ts", '    const signature = fixedLeaderSettings.get(tabId);\n    if (signature) {\n      try { if (matches(JSON.parse(signature).assignment?.cli)) return true; }\n      catch { return true; } // Unknown live assignment: do not delete its executable.\n    }', '    /* mutation: saved live assignment ignored */'],
  ["p35-remove-install-provenance", "server/settings/cli-install.ts", 'this.deps.state.catalogTools[op.id].managedInstall = true;', '/* mutation: publication omits managed install provenance */'],
  ["p35-remove-builtin-launch", "server/settings/cli-availability.ts", 'if (state.catalogTools[cli]?.action?.kind === "remove" && state.catalogTools[cli].action?.status === "running") throw new Error(REMOVING_MESSAGE);', '/* mutation: built-in launch allowed during removal */'],
  ["p35-remove-acp-launch", "server/settings/catalog-acp.ts", 'if (facts[entry.id]?.action?.kind === "remove" && facts[entry.id].action?.status === "running") return false;', '/* mutation: ACP launch allowed during removal */'],
);
export const pack35RemoveCatchMap = Object.fromEntries(pack35RemoveMutations.map(([id]) => [id, 'test/pack35-remove.test.ts']));
export const pack35DefaultMutations = [
  [
    "p35-default-model-preference",
    "server/fixed-crew/assignment.ts",
    "firstRun && cli.id === \"opencode\" && seat.slot === \"leader\" ? FIRST_RUN_OPENCODE_MODELS",
    "false ? FIRST_RUN_OPENCODE_MODELS"
  ]
];
export const pack35DefaultCatchMap = { 'p35-default-model-preference': 'test/pack35-default-model.test.ts' };
