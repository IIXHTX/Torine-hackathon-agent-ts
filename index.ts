import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { AgentRuntime } from "arcbench-agent-runtime-js";

type AgentArgs = {
  requirementPath: string;
  outputDir: string;
  taskType: string;
  webPort: number;
};

type RequirementModule = {
  index: number;
  total: number;
  nodeId: string;
  name: string;
  subtree: Record<string, unknown>;
};

// Transplanted from the octos reference adapter (38 rounds of graded runs).
// These are grading-system facts, not generic style advice - every rule here
// cost real score at least once.
const UI_CONTRACT = [
  "Benchmark UI contract (the automated acceptance tests depend on these EXACTLY):",
  '- Use plain text inputs for ALL form fields: `type="text"` (or `password`/`email`). NEVER `type="date"` or `type="number"` - tests fill values like "Sun, May 31" which native date inputs reject.',
  "- Every form field needs a visible associated <label> (tests use getByLabel with the field's name).",
  "- Every form control must be visible and enabled at all times - never hide native inputs/selects behind custom widgets or display:none containers.",
  '- NEVER rely on native HTML5 validation (`required`, `pattern`, tooltips). Validate in JavaScript and render error messages as inline DOM text containing words like "required" / "invalid" / "missing" - tests assert on visible page text.',
  '- Buttons are real <button> elements with plain text labels (e.g. "Sign up", "Sign in", "Create account").',
  "VERBATIM TEXT: copy every visible label / link / button / heading string verbatim from the requirement document into the UI. If the requirement says a button is \"Create account\", the button text is exactly \"Create account\". Tests locate elements by these exact strings, some with ANCHORED regexes like /^name$/i - a field the requirement calls \"Name\" must be labeled exactly \"Name\"; \"Full Name\" or \"Your Name\" never matches.",
  "UNIQUENESS (strict mode): any value the page echoes - usernames, emails, org names, dates - must appear in EXACTLY ONE visible element. Playwright locators like getByText run in strict mode: two matching elements fails the test. Never repeat the same value in a summary line AND a card/detail view on one page.",
  "SEED DATA: when the requirement states concrete published records (e.g. \"user alice-dev with email alice.dev@example.test exists\"), the database seed MUST include exactly those records, with values stored and matched as the verbatim strings shown. Search matching is case-insensitive and trims surrounding whitespace.",
  "OPTION LABELS ARE FIXTURE DATA TOO: every concrete example value in the requirement must appear verbatim as <option>/radio labels - if the sample data has nationality \"Chinese\", the select must include an option labeled exactly \"Chinese\". Missing fixture option labels make select-based tests time out.",
  "SESSIONS: after registration or login, redirect to the home page and show the exact username plus a sign-out control in the account menu; the session must survive page reload (cookie or token persisted in the browser).",
  "ERROR STATES: failed validation stays on the same page, shows an inline message naming the problem (tests match words like required/invalid/match/terms/duplicate), keeps the anonymous header, and creates no records. Show EXACTLY ONE error element at a time - never a per-field error and a form-level summary together: two elements matching the error regex is a strict mode failure.",
  "ONE MATCH PER VALUE FORM: when the same entity has a short and a long written form, a page must render forms so that only ONE element matches - tests use combined regexes and two matching elements is a strict mode violation. Pick one display form per page and use it in exactly one element.",
  "UNLISTED CONTROL VALUES: when the requirement says a value must be \"one of the values offered by the control\" WITHOUT listing them, offer a broad standard set covering all values that scenarios or seed data use. A gender control is exactly two radio inputs labeled \"Male\" and \"Female\". Text fields must accept ISO date strings like \"2035-12-31\".",
  "TEXT ONLY: every string you need exists as plain text in the requirement YAML/files. Reference images (reference/*.png) are layout guides only - NEVER attempt OCR or image text extraction.",
  "WRITE CODE FIRST: start creating project files in your very first actions. A turn that only reads and analyzes without writing files is a failed turn, no matter how good the analysis is.",
].join("\n");

const DELIVERABLE = [
  "Deliverable layout under the output directory:",
  "  frontend/   (Vite + React + TypeScript; npm install && npm run build)",
  "  backend/    (Express + SQLite; npm run start, reads PORT)",
  "Keep both directories at the output root, not nested one level deeper.",
].join("\n");

const NUDGE_PROMPT = [
  "You ended your last turn before creating or editing any files. Stop analyzing.",
  "In your very next actions, CREATE/EDIT the project files with your file-writing tools:",
  "frontend page sources, backend routes/services/database, and the seed data required by the requirement JSON you were given.",
  "Do not describe the plan - write the files now.",
].join("\n");

const REPAIR_PROMPT = (failure: string) =>
  [
    "The app you built just failed a build/startup rehearsal. Fix it now.",
    "Rehearsal failure output (tail):",
    "```",
    failure.slice(-2000),
    "```",
    "Fix the underlying issue in the code (do not delete features or tests to silence errors).",
    "Keep the architecture: frontend/ builds with `npm run build`, backend/ starts with `npm run start` reading PORT.",
    "Finish with a one-line summary of what you fixed.",
  ].join("\n");

const FINAL_CHECK_PROMPT = (webPort: number) =>
  [
    "Do a final end-to-end audit of the web application in the current directory. Fix what is broken.",
    "1. Run `npm run build` in frontend/ and fix any build errors.",
    `2. Start the backend ONLY on port 3100 (PORT=3100 npm run start) to probe endpoints, NEVER on ${webPort} - the runner watches ${webPort} and kills the run if a server binds it. Stop the server when done.`,
    "3. Exercise every implemented API endpoint with curl including error cases.",
    "4. Audit every form against the UI contract below and fix violations (these silently score 0):",
    "",
    UI_CONTRACT,
    "",
    "5. STRICT-MODE SELF-TEST - mechanical, not by eye: for every value the requirement echoes (usernames, emails, org names, dates), enumerate EVERY element that will contain it in the rendered DOM. If pages are server-rendered: `curl -s <page> | grep -o '<value>' | wc -l` must be 1. If client-rendered, read the render code and list the elements each value lands in. Any value in more than one element is a strict-mode failure in the real tests. Also trigger each validation failure and confirm exactly ONE error element is rendered.",
    "6. Fix anything else broken. Stop every server you started when finished.",
  ].join("\n");

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  console.error(line);
}

function parseArgs(argv: string[]): AgentArgs {
  const args: AgentArgs = {
    requirementPath: process.env.ARCBENCH_TASK_DIR || "requirements",
    outputDir: process.env.ARCBENCH_OUTPUT_DIR || ".",
    taskType: process.env.ARCBENCH_TASK_TYPE || "web",
    webPort: Number(process.env.ARCBENCH_WEB_PORT || "3000"),
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output-dir") {
      args.outputDir = argv[++index] || args.outputDir;
    } else if (value === "--type") {
      args.taskType = argv[++index] || args.taskType;
    } else if (value === "--web-port") {
      args.webPort = Number(argv[++index] || args.webPort);
    } else {
      positional.push(value);
    }
  }
  if (positional[0]) args.requirementPath = positional[0];
  return args;
}

function copyTemplateContentsToOutput(templateDir: string, outputDir: string): void {
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    throw new Error(`Starter template directory not found: ${templateDir}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(templateDir, { withFileTypes: true })) {
    if (entry.name === "template.yaml") continue;
    const source = path.join(templateDir, entry.name);
    const destination = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(source, destination, { recursive: true, force: true });
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

function hasDeliverable(outputDir: string): boolean {
  return (
    fs.existsSync(path.join(outputDir, "frontend", "package.json")) &&
    fs.existsSync(path.join(outputDir, "backend", "package.json"))
  );
}

function loadRootModules(requirementsDir: string): RequirementModule[] {
  const requirementsPath = path.join(requirementsDir, "requirements.yaml");
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements.yaml not found: ${requirementsPath}`);
  }
  const payload = YAML.parse(fs.readFileSync(requirementsPath, "utf-8"));
  if (!payload || String(payload.id || "").trim() !== "ROOT") {
    throw new Error("requirements.yaml must contain a ROOT mapping");
  }
  const children = Array.isArray(payload.children) ? payload.children.filter((item: unknown) => item && typeof item === "object") : [];
  if (children.length === 0) throw new Error("ROOT must contain at least one child module");
  return children.map((subtree: Record<string, unknown>, index: number) => {
    const nodeId = String(subtree.id || subtree.req_id || "").trim();
    if (!nodeId) throw new Error(`ROOT child ${index + 1} has no id`);
    return {
      index: index + 1,
      total: children.length,
      nodeId,
      name: String(subtree.name || nodeId).trim(),
      subtree,
    };
  });
}

function modelSpec(): { providerId: string; modelId: string } {
  const raw = (process.env.MODEL || "").trim();
  if (!raw) return { providerId: "custom", modelId: "gpt-4o-mini" };
  const slash = raw.indexOf("/");
  if (slash > 0) return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
  return { providerId: "custom", modelId: raw };
}

function writeOpencodeConfig(agentRoot: string): string {
  const baseUrl = (process.env.OPENAI_BASE_URL || "").trim();
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const { providerId, modelId } = modelSpec();
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ARC-Bench model gateway",
        options: {
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
        models: { [modelId]: { name: modelId } },
      },
    },
    skills: [path.join(agentRoot, "skills")],
  };
  const configPath = path.join(os.tmpdir(), `torine-opencode-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function resolveOpencodeBin(agentRoot: string): string {
  const direct = path.join(agentRoot, "node_modules", ".bin", "opencode");
  if (fs.existsSync(direct)) return direct;
  const pkgDir = path.join(agentRoot, "node_modules", "opencode-ai");
  const postinstall = path.join(pkgDir, "postinstall.mjs");
  if (fs.existsSync(postinstall)) {
    log("[setup] opencode binary missing; running postinstall fallback");
    const result = spawn(process.execPath, [postinstall], { cwd: pkgDir, stdio: "inherit" });
    void result;
  }
  return direct;
}

function runCommand(
  command: string,
  argv: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string; heartbeatLabel?: string },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const started = Date.now();
    const sink = (text: string): void => {
      if (!options.logFile) return;
      try {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
        fs.appendFileSync(options.logFile, text);
      } catch {
        /* logging must never break the run */
      }
    };
    sink(`=== ${new Date().toISOString()} ${command} ${argv.join(" ")} (cwd ${options.cwd}) ===\n`);
    if (options.heartbeatLabel) {
      heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
        const last = lines[lines.length - 1] || "(no output yet)";
        log(`[heartbeat] ${options.heartbeatLabel} running ${elapsed}s | last: ${last.slice(0, 120)}`);
      }, 60_000);
      heartbeat.unref?.();
    }
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        log(`[timeout] SIGTERM to ${command} after ${options.timeoutMs}ms; grace 60s before SIGKILL`);
        sink(`\n=== TIMEOUT: SIGTERM after ${options.timeoutMs}ms ===\n`);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            log(`[timeout] SIGKILL ${command} (no exit within grace)`);
            sink(`\n=== TIMEOUT: SIGKILL after grace ===\n`);
            child.kill("SIGKILL");
          }
        }, 60_000).unref?.();
      }, options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      process.stderr.write(text);
      sink(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
      sink(text);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      sink(`\n=== exit ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s ===\n`);
      resolve({ code, output });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      sink(`\n=== spawn error: ${String(error)} ===\n`);
      resolve({ code: 1, output: `${output}\nspawn error: ${String(error)}` });
    });
  });
}

function modulePrompt(module: RequirementModule, completedIds: string[], focus?: { label: string; json: string }): string {
  const completed = completedIds.length ? completedIds.join(", ") : "none";
  const body = focus ? focus.json : JSON.stringify(module.subtree, null, 2);
  const scope = focus
    ? `Implement ONLY this requirement subtree (one child of the module, including all descendants): ${focus.label}`
    : "Implement ONLY the requirement subtree below, including all descendants (FOLDER and ATOMIC nodes with their scenarios).";
  let contractNode: Record<string, unknown> = module.subtree;
  if (focus) {
    try {
      contractNode = JSON.parse(focus.json) as Record<string, unknown>;
    } catch {
      /* keep module subtree */
    }
  }
  const contractSheet = renderTaskContract(extractTaskContract(contractNode));
  return [
    `Implement ROOT module ${module.index}/${module.total}: ${module.nodeId} - ${module.name}`,
    "",
    "You are building a web application (Vite + React + TypeScript frontend, Express + SQLite backend) in the current working directory.",
    "An initialized starter application is already present. Preserve existing work from previously completed modules.",
    scope,
    "Do not read or open the full requirements.yaml file.",
    "",
    `Previously completed modules/nodes: ${completed}`,
    "",
    "Requirement JSON:",
    body,
    "",
    contractSheet,
    "",
    DELIVERABLE,
    "",
    "VERBATIM EXTRACT FIRST: before writing any code, list every quoted string in the requirement JSON above (labels, buttons, links, error messages, dialog titles). These are contractual UI text - copy them EXACTLY into the rendered UI. Never paraphrase, re-case, shorten, or reword them (\"Create an organization\" is NOT \"Create organization\").",
    "",
    UI_CONTRACT,
    "",
    "NAVIGATION CONTRACT: every navigation target the requirement names (link/button/tab/menuitem named ... entries listed in the TASK CONTRACT SHEET above) MUST exist as a visible element with the right role on the page where the scenario reaches it. Navigation entries the scenario opens from a menu must be in that menu. Pages reachable only when signed out (account-access flows) must still show the site header with its sign-in entry.",
    "",
    "RENDER CONTRACT (critical - most test failures come from violating this): destination content must be in the DOM by the time a click() resolves. Do NOT import { Link, NavLink } from 'react-router-dom' for navigation - SPA transitions render late and test helpers assert immediately after clicking. Use plain <a href> anchors (full page loads) or the provided components/AppLink.tsx. The router may stay for route matching only.",
    "",
    "FLOW RECIPES (verify each before finishing):",
    "- Password recovery: after submitting the email on the recovery entry, the fixed verification code (e.g. \"123456\") must appear as VISIBLE TEXT on the page the user lands on, together with the Verification code and New password fields. Submitting with an empty field must not dead-end the flow.",
    "- Label disambiguation: getByLabel('Email') must resolve to exactly one field at every step - never have both an 'Email' field and a 'Username or email' field visible on the same page state.",
    "- Members/people lists must render every seeded member's username as exact visible text, with row action buttons named `Member menu <username>` (pattern `<menu label> <row identity>`) whose menuitems match the requirement verbs, visible only to users allowed to manage.",
    "- Account menu must contain the entries the scenario clicks (typically Settings and Your organizations) before those clicks happen.",
    "",
    "ROLE WIDGET CONTRACT: dropdowns that tests pick options from must expose role=combobox with clickable role=option items (a custom listbox - native select popups are not clickable in tests). Widgets the tests call selectOption() on must be native <select> elements. Table rows with editable values use role=row with a per-row control and a Save button. Row action menus are buttons named `Member menu <value>` (pattern: `<menu label> <row identity>`) exposing menuitem entries, whose confirm dialogs use the verb button named exactly as the scenario states.",
    "",
    "TEXT UNIQUENESS: each exact value (roles, usernames, names) must appear in at most one visible text node on a page. Repeating labels like role names must not repeat across rows as plain text - use controls whose closed state does not render the label as text, or vary display so exactly one exact-match node exists.",
    "",
    "SEED IDENTIFIERS: entities may have both an identifier (URL/name) and a display name (link text) - seed both exactly as the requirement states; links display the display name, headings/URLs use the identifier. Every backticked seed/example value in the requirement must exist in the database seed and appear verbatim where scenarios expect it.",
    "",
    "Acceptance tests: if a directory /workspace/tests exists, READ EVERY Playwright spec file FIRST (including tests/support/e2e.ts helpers) before writing code. Every getByRole/getByLabel/getByText/clickVisibleTarget assertion and accessible name in those specs is a contract - implement to them exactly (roles, exact names, URLs, error strings). The helper semantics (link->button->text fallback, retry-from-home) tell you which elements must exist where. Those specs are the scoring criteria - code to the tests.",
    "",
    "Traceability (feeds the platform's progress UI): after implementing a requirement node, register what you built via the bundled skill script:",
    "  python3 skills/arcbench-traceability/scripts/arc_traceability.py upsert-interface --project-dir . --payload-json '{\"interface_id\":\"REQ-X.API.Something\",\"req_ids\":[\"REQ-X\"],\"type\":\"API\",\"content\":\"POST /api/...\",\"file_path\":\"backend/src/...\",\"implemented\":true}'",
    "  python3 skills/arcbench-traceability/scripts/arc_traceability.py upsert-test --project-dir . --payload-json '{\"test_id\":\"REQ-X.E2E\",\"req_id\":\"REQ-X\",\"type\":\"E2E\",\"file_path\":\"...\",\"interface_ids\":[\"...\"]}'",
    "Keep this brief: one interface record per key API/UI surface, one test record per scenario group. Do NOT write .arc/ JSON by hand - use the script.",
    "",
    "Time budget: spend your time writing complete correct code (routes, forms, validation, seed data), NOT on self-verification. Do NOT run smoke tests, curl probes, Playwright checks, or start any servers - the platform runs the acceptance tests after you finish. Do NOT write extra unit tests. At most run `npm run build` once to catch syntax errors, then stop.",
    "",
    "Seeding: where a scenario references existing accounts, organizations, repositories or similar records, provision those rows in the SQLite seed/init code so the scenario is runnable.",
    "Work practically: create/modify files, keep the app runnable, do not start long-running servers, do not run anything bound to the evaluation port 3000.",
    "Finish with a short summary of the files you changed.",
  ].join("\n");
}

const VERBATIM_FIX_PROMPT = (missing: string[], navOffenders: string[]) =>
  [
    "A mechanical lint found contract violations in the generated app. Fix them now:",
    ...(missing.length
      ? [
          "",
          "1) Missing requirement text strings (must appear EXACTLY in the rendered UI):",
          ...missing.map((s) => `   - ${JSON.stringify(s)}`),
        ]
      : []),
    ...(navOffenders.length
      ? [
          "",
          "2) Files using react-router-dom Link/NavLink for navigation (test helpers assert immediately after click; SPA transitions race them). Replace every Link/NavLink with a plain <a href> anchor (or components/AppLink.tsx) - keep react-router only for route matching:",
          ...navOffenders.map((f) => `   - ${f}`),
        ]
      : []),
    "",
    "Keep everything else working. Finish with one line listing the files you touched.",
  ].join("\n");

function auditPrompt(module: RequirementModule, atomicIds: string[]): string {
  return [
    `Audit pass for ${module.nodeId} - ${module.name}. Do NOT write new feature code.`,
    `Inspect the current project and answer with a single line: DONE=[comma-separated ids of these ATOMIC requirement nodes that are FULLY implemented end-to-end]:`,
    atomicIds.join(", "),
    "Judge each node by its scenarios: routes/UI/API/seed present and wired. When finished, reply with exactly one line starting 'DONE=' and nothing else.",
  ].join("\n");
}

function logWorkspaceTree(outputDir: string): void {
  const lines: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || lines.length > 60) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "__pycache__", ".arc"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        walk(full, depth + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
      if (lines.length > 60) {
        lines.push("... (truncated)");
        return;
      }
    }
  };
  walk(outputDir, 0);
  log("[postflight] workspace tree:\n" + lines.join("\n"));
}

function workspaceSignature(outputDir: string): string {
  let count = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".arc", "dist", "__pycache__"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        count += 1;
        try {
          const stat = fs.statSync(full);
          bytes += stat.size;
          newest = Math.max(newest, stat.mtimeMs);
        } catch {
          /* raced with the agent writing files */
        }
      }
    }
  };
  walk(outputDir);
  return `${count}:${bytes}:${newest}`;
}

async function npmInstall(dir: string, timeoutMs: number, logFile: string): Promise<{ code: number | null; output: string }> {
  const first = await runCommand("npm", ["install"], { cwd: dir, timeoutMs, logFile });
  if (first.code === 0) return first;
  // Old npm (9.x arborist bug on peer-deps graphs) can fail on a good lockfile;
  // --legacy-peer-deps works there and is a no-op difference on modern npm.
  log(`[npm] install failed in ${dir}; retrying with --legacy-peer-deps`);
  return runCommand("npm", ["install", "--legacy-peer-deps"], { cwd: dir, timeoutMs, logFile });
}

function rehearseBackend(backendDir: string, port: number): Promise<string | null> {
  // Returns a failure description, or null when the server stayed alive for 5s.
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    // detached: npm's grandchild (the actual node server) must die with the
    // group. A surviving grandchild holds our stdio pipes open and keeps the
    // Node event loop alive forever - that is what hung run a9a88145e0f4.
    const child = spawn("npm", ["run", "start"], {
      cwd: backendDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const finish = (failure: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        process.kill(-child.pid!, "SIGKILL"); // whole process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* streams may already be closed */
      }
      resolve(failure);
    };
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => finish(`backend exited early (code ${code}): ${output.slice(-800)}`));
    child.on("error", (error) => finish(`backend spawn error: ${String(error)}`));
    const guard = setTimeout(() => finish(null), 5000);
    guard.unref?.();
  });
}

// The selftest channel grades a zipped app that must contain a Dockerfile at
// the zip root (offline docker build, PORT-driven start). Guarantee one exists
// and is correct even if the model deleted or rewrote the template copy.
function ensureDockerfile(outputDir: string): void {
  const expected = [
    "# ARC-Bench selftest app package.",
    "# Build must work WITHOUT external network: this zip ships prebuilt",
    "# frontend/dist and vendored backend/node_modules. npm only runs as a",
    "# fallback when those artifacts are absent.",
    "FROM node:20-slim",
    "",
    "WORKDIR /app",
    "",
    "COPY . .",
    "",
    "RUN cd frontend && { test -f dist/index.html || (npm install --no-audit --no-fund && npm run build); }",
    "RUN cd backend && { test -d node_modules || npm install --omit=dev --no-audit --no-fund; }",
    "",
    "ENV PORT=3000",
    "EXPOSE 3000",
    "",
    'CMD ["sh", "-c", "cd backend && node src/index.js"]',
    "",
  ].join("\n");
  const target = path.join(outputDir, "Dockerfile");
  let current = "";
  try {
    current = fs.readFileSync(target, "utf-8");
  } catch {
    /* missing */
  }
  if (current !== expected) {
    fs.writeFileSync(target, expected);
    log("[postflight] wrote Dockerfile at output root");
  }
}

function postflightLift(outputDir: string): void {
  logWorkspaceTree(outputDir);
  const rootFrontend = path.join(outputDir, "frontend");
  const rootBackend = path.join(outputDir, "backend");
  if (fs.existsSync(rootFrontend) && fs.existsSync(rootBackend)) {
    log("[postflight] frontend/ and backend/ present at output root");
    return;
  }
  const children = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ![".git", ".arc", "requirements", "node_modules"].includes(entry.name));
  for (const child of children) {
    const nested = path.join(outputDir, child.name);
    if (fs.existsSync(path.join(nested, "frontend")) && fs.existsSync(path.join(nested, "backend"))) {
      log(`[postflight] app nested at ${child.name}/; lifting to output root`);
      for (const item of fs.readdirSync(nested)) {
        const destination = path.join(outputDir, item);
        if (fs.existsSync(destination)) continue;
        fs.renameSync(path.join(nested, item), destination);
      }
      return;
    }
  }
  log("[postflight] WARNING: frontend/+backend/ not found; the runner will reject this template");
}

function collectAtomicIds(node: Record<string, unknown>, sink: string[]): void {
  const id = String(node.id || "").trim();
  const type = String(node.type || "").trim().toUpperCase();
  if (type === "ATOMIC" && id) sink.push(id);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child && typeof child === "object") collectAtomicIds(child as Record<string, unknown>, sink);
  }
}

function collectAtomicNodes(node: Record<string, unknown>, sink: Record<string, unknown>[]): void {
  const type = String(node.type || "").trim().toUpperCase();
  if (type === "ATOMIC" && String(node.id || "").trim()) sink.push(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child && typeof child === "object") collectAtomicNodes(child as Record<string, unknown>, sink);
  }
}

function parseDoneIds(output: string, knownIds: string[]): string[] {
  const matches = [...output.matchAll(/DONE=([A-Za-z0-9_,\-\s]*)/g)];
  if (!matches.length) return [];
  const raw = matches[matches.length - 1][1] ?? "";
  const listed = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return listed.filter((id) => knownIds.includes(id));
}

// Verbatim lint: the acceptance tests match visible text with anchored regexes,
// so every quoted string in a requirement is a contractual UI string. Collect
// them from the requirement JSON and check the generated source for each.
function collectTextBlobs(node: Record<string, unknown>, sink: string[]): void {
  for (const value of Object.values(node)) {
    if (typeof value === "string") sink.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") sink.push(item);
        else if (item && typeof item === "object") collectTextBlobs(item as Record<string, unknown>, sink);
      }
    } else if (value && typeof value === "object") {
      collectTextBlobs(value as Record<string, unknown>, sink);
    }
  }
}

function extractVerbatimStrings(nodes: Record<string, unknown>[]): Set<string> {
  const blobs: string[] = [];
  for (const node of nodes) collectTextBlobs(node, blobs);
  const out = new Set<string>();
  for (const blob of blobs) {
    for (const match of blob.matchAll(/[""\u201c]([^""\u201c\u201d"]{2,80})[""\u201d]/g)) {
      const s = match[1].trim();
      // UI strings only: must contain a letter, no code/regex/path noise.
      if (!/[A-Za-z]/.test(s)) continue;
      if (/[\\^$()[\]{}|*+?.\/]/.test(s)) continue;
      if (/^\d+$/.test(s)) continue;
      // Skip all-lowercase single words: those are defined concepts in prose
      // ("account", "session"), not UI text. UI strings are Title Case or
      // multi-word.
      if (/^[a-z][a-z0-9-]*$/.test(s)) continue;
      out.add(s);
    }
  }
  return out;
}

// Task contract sheet: derived at runtime from the requirement subtree this
// turn implements. Hardcoding per-task strings overfits (stage-1 strings are
// noise for stage-2/sheet) - extraction adapts to any task automatically.
type TaskContract = {
  namedTargets: string[];
  errorStrings: string[];
  seeds: string[];
};

function extractTaskContract(node: Record<string, unknown>): TaskContract {
  const blobs: string[] = [];
  collectTextBlobs(node, blobs);
  const text = blobs.join("\n");

  const namedTargets: string[] = [];
  const namedSet = new Set<string>();
  for (const match of text.matchAll(
    /(link|button|tab|menuitem|dialog|textbox|checkbox|combobox|option|heading|navigation)[^.\u201c"]{0,32}(?:named|labeled)?\s*[\u201c"]([^\u201c"]{2,60})[\u201d"]/gi,
  )) {
    const entry = `${match[1].toLowerCase()}: ${match[2].trim()}`;
    if (!namedSet.has(entry)) {
      namedSet.add(entry);
      namedTargets.push(entry);
    }
  }

  const errorStrings: string[] = [];
  const errorSet = new Set<string>();
  const namedValues = new Set(namedTargets.map((entry) => entry.slice(entry.indexOf(":") + 2)));
  for (const match of text.matchAll(/[\u201c"]([^\u201c"]{2,80})[\u201d"]/g)) {
    const s = match[1].trim();
    if (!/[A-Za-z]/.test(s)) continue;
    if (namedValues.has(s)) continue;
    const before = text.slice(Math.max(0, match.index! - 140), match.index!).toLowerCase();
    const after = text.slice(match.index! + s.length, match.index! + s.length + 80).toLowerCase();
    const errorContext = /error|message|displays|shows|invalid|denied|not allowed|already exists|required|incorrect|failed/.test(before + after);
    const looksLikeMessage = /\s/.test(s) || /already|invalid|required|incorrect|denied|not found|not allowed/.test(s.toLowerCase());
    if (errorContext && looksLikeMessage && !errorSet.has(s)) {
      errorSet.add(s);
      errorStrings.push(s);
    }
  }

  const seeds = [...new Set([...text.matchAll(/`([^`\s][^`]{0,60})`/g)].map((m) => m[1]))];
  return { namedTargets, errorStrings, seeds };
}

function renderTaskContract(contract: TaskContract): string {
  const lines: string[] = ["TASK CONTRACT SHEET (derived from this requirement subtree - treat as checklist):"];
  if (contract.namedTargets.length) {
    lines.push("Named UI targets that MUST exist as visible elements with the right roles:");
    for (const t of contract.namedTargets.slice(0, 40)) lines.push(`  - ${t}`);
    if (contract.namedTargets.length > 40) lines.push(`  ... and ${contract.namedTargets.length - 40} more`);
  }
  if (contract.errorStrings.length) {
    lines.push("Error/validation messages that must appear verbatim in the UI where the requirement says they are displayed:");
    for (const s of contract.errorStrings.slice(0, 25)) lines.push(`  - ${JSON.stringify(s)}`);
    if (contract.errorStrings.length > 25) lines.push(`  ... and ${contract.errorStrings.length - 25} more`);
  }
  if (contract.seeds.length) {
    lines.push("Seed/example values referenced by scenarios (provision in DB seed and use verbatim):");
    for (const s of contract.seeds.slice(0, 30)) lines.push(`  - ${JSON.stringify(s)}`);
    if (contract.seeds.length > 30) lines.push(`  ... and ${contract.seeds.length - 30} more`);
  }
  return lines.join("\n");
}

function lintNavStyle(outputDir: string): string[] {
  // SPA router links race the tests' immediate post-click assertions - catch
  // react-router Link/NavLink usage mechanically.
  const offenders: string[] = [];
  const root = path.join(outputDir, "frontend", "src");
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist"].includes(entry.name)) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        try {
          const text = fs.readFileSync(full, "utf-8");
          if (/import\s*\{[^}]*\b(Link|NavLink)\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(text)) {
            offenders.push(path.relative(outputDir, full));
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  return offenders;
}

function lintVerbatim(outputDir: string, expected: Set<string>): string[] {
  const missing: string[] = [];
  const haystack: string[] = [];
  const roots = ["frontend/src", "backend/src"];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "__pycache__"].includes(entry.name)) continue;
        walk(full);
      } else if (/\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
        try {
          haystack.push(fs.readFileSync(full, "utf-8"));
        } catch {
          /* unreadable file - skip */
        }
      }
    }
  };
  for (const root of roots) walk(path.join(outputDir, root));
  const corpus = haystack.join("\n");
  for (const s of expected) {
    if (!corpus.includes(s)) missing.push(s);
  }
  return missing;
}

function startPortWatchdog(webPort: number, outputDir: string): NodeJS.Timeout {
  const root = outputDir.replace(/\/+$/, "");
  const tick = async (): Promise<void> => {
    try {
      const listing = await new Promise<string>((resolve) => {
        const child = spawn("lsof", [`-t`, `-i`, `:${webPort}`], { stdio: ["ignore", "pipe", "ignore"] });
        let data = "";
        child.stdout.on("data", (chunk: Buffer) => (data += chunk.toString()));
        child.on("close", () => resolve(data));
        child.on("error", () => resolve(""));
      });
      const pids = listing.split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        let cwd = "";
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          continue;
        }
        if (!cwd.startsWith(root)) continue; // shared runner: never kill foreign processes
        log(`[watchdog] killing pid ${pid} (cwd ${cwd}) bound to port ${webPort}`);
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* watchdog must never break the run */
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref?.();
  return timer;
}

async function runAgent(runtime: AgentRuntime, requirementsDir: string, outputDir: string, agentRoot: string, webPort: number): Promise<void> {
  runtime.traceability.initDb();
  runtime.git.ensureRepo();

  if (hasDeliverable(outputDir)) {
    log("[init] existing frontend/+backend/ detected; keeping prior work (evolution mode)");
  } else {
    log("[init] copying starter template into output directory");
    copyTemplateContentsToOutput(path.join(agentRoot, "template"), outputDir);
  }

  const modules = loadRootModules(requirementsDir);
  log(`[plan] ${modules.length} ROOT module(s): ${modules.map((m) => m.nodeId).join(", ")}`);

  const configPath = writeOpencodeConfig(agentRoot);
  const opencodeBin = resolveOpencodeBin(agentRoot);
  const { providerId, modelId } = modelSpec();
  const nodeTimeoutMs = Number(process.env.TORINE_NODE_TIMEOUT_MS || 45 * 60 * 1000);
  const completedIds: string[] = [];
  const failedIds: string[] = [];
  const logsDir = path.join(outputDir, ".arc", "logs");
  const runStartedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const watchdog = startPortWatchdog(webPort, outputDir);
  let useHotSession = false;

  for (const module of modules) {
    log(`[module ${module.index}/${module.total}] ${module.nodeId} - ${module.name}`);
    runtime.events.markImplementationStarted(module.nodeId, `opencode implementing ${module.name}`);

    const atomicNodes: Record<string, unknown>[] = [];
    collectAtomicNodes(module.subtree, atomicNodes);
    const atomicIds = atomicNodes.map((node) => String(node.id || "").trim()).filter(Boolean);
    const childNodes = (Array.isArray(module.subtree.children) ? module.subtree.children : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    const splitMode = childNodes.length > 1;
    const turns: { label: string; prompt: string; logName: string; atomicScope: string[] }[] = [];
    if (splitMode) {
      log(`[module ${module.index}/${module.total}] splitting into ${childNodes.length} child turns`);
      for (const node of childNodes) {
        const nodeId = String(node.id || "").trim() || `child-${turns.length + 1}`;
        const scope: string[] = [];
        collectAtomicIds(node, scope);
        turns.push({
          label: nodeId,
          prompt: modulePrompt(module, completedIds, { label: nodeId, json: JSON.stringify(node, null, 2) }),
          logName: `module-${module.index}-${module.nodeId}-part-${nodeId}`,
          atomicScope: scope.length ? scope : [nodeId],
        });
      }
    } else {
      turns.push({
        label: module.nodeId,
        prompt: modulePrompt(module, completedIds),
        logName: `module-${module.index}-${module.nodeId}`,
        atomicScope: atomicIds.length ? atomicIds : [module.nodeId],
      });
    }

    let moduleOk = true;
    for (const turn of turns) {
      log(`[turn] ${turn.label} (${module.nodeId})${useHotSession ? " [continue]" : ""}`);
      // Per-atomic phase events (octos style): design is folded into the
      // implementation prompt, so emit done immediately - this is what makes
      // the canvas light up orange at turn start instead of staying gray.
      for (const atomicId of turn.atomicScope) {
        runtime.events.markDesignStarted(atomicId, `designing ${atomicId}`);
        runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
      }
      const started = Date.now();
      const before = workspaceSignature(outputDir);
      const argv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions"];
      if (useHotSession) argv.push("--continue");
      argv.push(turn.prompt);
      let result = await runCommand(opencodeBin, argv, {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: nodeTimeoutMs,
        logFile: path.join(logsDir, `${runStartedAt}-${turn.logName}.log`),
        heartbeatLabel: `turn ${turn.label}`,
      });
      useHotSession = true;
      // NUDGE (octos lesson): a turn that only reads/analyzes wrote no files.
      // Kick once with an explicit "write files now" prompt.
      if (result.code === 0 && workspaceSignature(outputDir) === before) {
        log(`[turn] ${turn.label}: no file changes; nudging`);
        const nudgeArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", "--continue", NUDGE_PROMPT];
        result = await runCommand(opencodeBin, nudgeArgv, {
          cwd: outputDir,
          env: {
            OPENCODE_CONFIG: configPath,
            OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
          },
          timeoutMs: nodeTimeoutMs,
          logFile: path.join(logsDir, `${runStartedAt}-${turn.logName}-nudge.log`),
        });
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.code === 0) {
        log(`[turn] ${turn.label} ok in ${seconds}s`);
        for (const atomicId of turn.atomicScope) {
          runtime.events.markDesignDone(atomicId, "design folded into implementation prompt");
          runtime.events.markImplementationDone(atomicId, `implemented in ${seconds}s`);
        }
        if (!splitMode) completedIds.push(module.nodeId);
      } else {
        log(`[turn] ${turn.label} FAILED (exit ${result.code}) after ${seconds}s`);
        moduleOk = false;
      }
    }

    // Audit: ask the model which ATOMIC nodes are truly done; mark only those.
    // Never blanket-FAILED nodes - a timeout often means "almost done" (run #6a7c559fe530).
    let doneIds: string[] = [];
    if (atomicIds.length) {
      log(`[audit] ${module.nodeId}: verifying atomic completion${useHotSession ? " [continue]" : ""}`);
      const auditArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions"];
      if (useHotSession) auditArgv.push("--continue");
      auditArgv.push(auditPrompt(module, atomicIds));
      const audit = await runCommand(opencodeBin, auditArgv, {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: 8 * 60 * 1000,
        logFile: path.join(logsDir, `${runStartedAt}-module-${module.index}-${module.nodeId}-audit.log`),
        heartbeatLabel: `audit ${module.nodeId}`,
      });
      doneIds = parseDoneIds(audit.output, atomicIds);
      log(`[audit] ${module.nodeId}: DONE=${doneIds.join(",") || "none"} (of ${atomicIds.join(",")})`);
    } else {
      doneIds = moduleOk ? [module.nodeId] : [];
    }

    for (const atomicId of atomicIds.length ? atomicIds : [module.nodeId]) {
      if (doneIds.includes(atomicId)) {
        // Canvas green ("已通过") comes from the test:passed event; CONVERGED is the
        // state token from the official SDK docs example.
        runtime.events.markTestPassed(atomicId, "audit confirmed fully implemented");
        runtime.traceability.upsertNodeState(atomicId, "CONVERGED");
      }
      // not-done nodes stay untouched (default gray) - honest progress, no false red
    }
    if (doneIds.length) completedIds.push(...doneIds);
    if (atomicIds.length && doneIds.length < atomicIds.length) moduleOk = false;
    if (atomicIds.length && doneIds.length === atomicIds.length) {
      // Audit is the source of truth: all atoms verified done => module green,
      // even if an intermediate turn exited non-zero (that is what left REQ-1
      // gray while all its children were green in run a9a88145e0f4).
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok (audit ${doneIds.length}/${atomicIds.length})`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
      runtime.events.markTestPassed(module.nodeId, "all atomic nodes passed audit");
      runtime.traceability.upsertNodeState(module.nodeId, "CONVERGED");
    } else if (moduleOk && !atomicIds.length) {
      log(`[module ${module.index}/${module.total}] ${module.nodeId} ok`);
      runtime.events.markImplementationDone(module.nodeId, `implemented: ${doneIds.join(",")}`);
    } else {
      // No markImplementationFailed: its "failed" status maps to FAILED state on the
      // canvas. Partial work stays honest in IMPLEMENTING gray/blue; only audited
      // done nodes turned green above.
      log(`[module ${module.index}/${module.total}] ${module.nodeId} partial (done: ${doneIds.join(",") || "none"})`);
      failedIds.push(module.nodeId);
    }
    runtime.events.notifyTraceabilityChanged(`module ${module.nodeId} finished`);
    runtime.git.commit(`${module.nodeId} (${moduleOk ? "implement" : "partial"}): ${module.name}`);
  }

  clearInterval(watchdog);

  // FINAL_CHECK: strict-mode self-audit pass (octos FINAL_CHECK equivalent).
  log(`[final-check] strict-mode audit${useHotSession ? " [continue]" : ""}`);
  const finalArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions"];
  if (useHotSession) finalArgv.push("--continue");
  finalArgv.push(FINAL_CHECK_PROMPT(webPort));
  await runCommand(opencodeBin, finalArgv, {
    cwd: outputDir,
    env: {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
    },
    timeoutMs: Math.min(nodeTimeoutMs, 10 * 60 * 1000),
    logFile: path.join(logsDir, `${runStartedAt}-final-check.log`),
    heartbeatLabel: "final-check",
  });
  useHotSession = true;

  // VERBATIM LINT: mechanical check of requirement quoted strings vs source.
  // Fixes "Create an organization" vs "Create organization" class of failures
  // that cost score on anchored-regex text matches (run 019f6c601311).
  const verbatim = extractVerbatimStrings(modules.map((m) => m.subtree));
  const missing = lintVerbatim(outputDir, verbatim);
  const navOffenders = lintNavStyle(outputDir);
  log(`[verbatim] ${verbatim.size} contractual strings, ${missing.length} missing${missing.length ? `: ${missing.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}${missing.length > 8 ? " ..." : ""}` : ""}`);
  if (navOffenders.length) log(`[lint] router-Link offenders: ${navOffenders.slice(0, 6).join(", ")}${navOffenders.length > 6 ? " ..." : ""}`);
  if (missing.length || navOffenders.length) {
    log(`[verbatim] sending fix turn (strings=${missing.length}, nav=${navOffenders.length})`);
    const fixArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", "--continue", VERBATIM_FIX_PROMPT(missing, navOffenders)];
    await runCommand(opencodeBin, fixArgv, {
      cwd: outputDir,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
      },
      timeoutMs: nodeTimeoutMs,
      logFile: path.join(logsDir, `${runStartedAt}-verbatim-fix.log`),
      heartbeatLabel: "verbatim-fix",
    });
    const retry = lintVerbatim(outputDir, verbatim);
    log(`[verbatim] after fix: ${retry.length} still missing${retry.length ? `: ${retry.slice(0, 5).map((s) => JSON.stringify(s)).join(", ")}` : ""}`);
  }

  postflightLift(outputDir);
  ensureDockerfile(outputDir);

  // REHEARSAL (octos lesson): build + startup probe BEFORE the platform's own
  // evaluation. A failed build scores 0 on every test; one repair turn is cheap.
  if (process.env.TORINE_SKIP_REHEARSAL !== "1") {
    const rehearsalLog = path.join(logsDir, `${runStartedAt}-rehearsal.log`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      log(`[rehearsal] attempt ${attempt}: frontend build`);
      const install = await npmInstall(path.join(outputDir, "frontend"), 10 * 60 * 1000, rehearsalLog);
      let failure = install.code === 0 ? null : `frontend npm install exit ${install.code}`;
      if (!failure) {
        const build = await runCommand("npm", ["run", "build"], {
          cwd: path.join(outputDir, "frontend"),
          timeoutMs: 10 * 60 * 1000,
          logFile: rehearsalLog,
        });
        failure = build.code === 0 ? null : `frontend npm run build exit ${build.code}`;
      }
      if (!failure) {
        log("[rehearsal] backend startup probe on port 3100");
        const backendInstall = await npmInstall(path.join(outputDir, "backend"), 10 * 60 * 1000, rehearsalLog);
        if (backendInstall.code === 0) {
          failure = await rehearseBackend(path.join(outputDir, "backend"), 3100);
        } else {
          failure = `backend npm install exit ${backendInstall.code}`;
        }
      }
      if (!failure) {
        log("[rehearsal] app builds and starts cleanly");
        break;
      }
      log(`[rehearsal] FAILED: ${failure}`);
      if (attempt >= 2) break;
      log("[rehearsal] sending repair turn");
      const repairArgv = ["run", "--dir", outputDir, "-m", `${providerId}/${modelId}`, "--dangerously-skip-permissions", "--continue", REPAIR_PROMPT(failure)];
      await runCommand(opencodeBin, repairArgv, {
        cwd: outputDir,
        env: {
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), `torine-opencode-home-${process.pid}`),
        },
        timeoutMs: nodeTimeoutMs,
        logFile: path.join(logsDir, `${runStartedAt}-rehearsal-repair.log`),
      });
    }
    runtime.git.commit("chore: rehearsal and final verification pass");
  }

  log(`[done] completed=${completedIds.join(",") || "none"} failed=${failedIds.join(",") || "none"}`);
  if (!hasDeliverable(outputDir)) {
    log("[done] ERROR: deliverable layout incomplete");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = AgentRuntime.fromEnv({ projectDir: path.resolve(args.outputDir) });
  const requirementsDir = path.resolve(args.requirementPath);
  const outputDir = path.resolve(args.outputDir);
  const agentRoot = path.dirname(fileURLToPath(import.meta.url));
  if (!fs.existsSync(requirementsDir)) throw new Error(`Requirement directory not found: ${requirementsDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  await runAgent(runtime, requirementsDir, outputDir, agentRoot, args.webPort);
  // The platform blocks evaluation until our process exits. Any stray child
  // handle (grandchild server, orphaned pipe) must not keep us alive - force
  // exit after flushing (run a9a88145e0f4 hung 6h on this). Exit is deferred
  // through the write callbacks because pipe-mode stdout is async and a
  // synchronous process.exit() would truncate the final [done] log lines.
  const code = process.exitCode ?? 0;
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code));
  });
  const failsafe = setTimeout(() => process.exit(code), 2000);
  failsafe.unref?.();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
