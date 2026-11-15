// Electron latches Node mode before evaluating modules. Never pass that mode to tools.
export function stripElectronNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "electron_run_as_node") delete env[key];
  }
  return env;
}

stripElectronNodeEnv(process.env);
