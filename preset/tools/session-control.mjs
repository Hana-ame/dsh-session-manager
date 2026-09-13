/**
 * Session-management tools for the `session-manager` agent preset.
 *
 * Why this file lives inside the preset directory:
 * `@deepseek-ai/dsh-agent-presets` resolves a row whose specifier starts with
 * "." against the composition's own directory, so the file travels with the
 * preset and needs no package install. A bare package name would instead
 * resolve from the harness install, which this directory cannot reach.
 *
 * Why it is `.mjs`:
 * the preset directory carries no package.json declaring `"type": "module"`, so
 * a `.js` file would be loaded as CommonJS. A bare `import '@deepseek-ai/dsh-*'`
 * inside this file would be resolved by Node from THIS directory, not from the
 * harness — so this file imports NO packages. `node:*` builtins are the one
 * exception: they resolve as builtins anywhere, so reading and writing the
 * private note file below needs no dependency at all.
 *
 * Plane: these tools consume the host-plane `sessionController` / `agents`
 * services and publish none of their own, so the composition row sits loose —
 * putting it behind an `isolate` realm would hide the host registries it must
 * reach.
 *
 * Lineage labels: a subagent child always records `origin: "subagent"`, while a
 * fork records only `parentSession` (`isSeeded`). So `parentSession` alone does
 * NOT mean "owned by another session" — a fork keeps a durable parent but is
 * NOT subagent-owned at runtime, which is exactly why it stays manageable here.
 *
 * Per-session notes (`session_describe`): kept in THIS plugin's own JSON file at
 * `<DSH_HOME>/session-manager/descriptions.json`. A note is deliberately not a
 * session title: it is never appended to any session log, so the session list,
 * the sidebar, the trajectory view and every other consumer of that session
 * never see it. Only this preset's tools read it. It is not a secrecy boundary —
 * the file sits in the DSH home and any process could open it — it is a
 * provenance boundary: nothing else writes or reads it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

let requestSeq = 0;

/** Mint one prompt correlation id for `sessionController.prompt`. */
const nextRequestId = () => `preset-session-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

/**
 * `sessionController.prompt()` calls `signal.throwIfAborted()` unconditionally,
 * so it needs a signal-shaped argument; nothing here is cancellable.
 */
const callerSignal = {
  aborted: false,
  throwIfAborted() {},
  addEventListener() {},
  removeEventListener() {},
};

/**
 * Output contract. An empty schema is the enforced subset's unconstrained
 * node, so any lossless JSON value validates and `render` owns what the model
 * reads. The registry validates every successful value against this schema.
 */
const OUTPUT = {
  schema: {},
  render(_args, value) {
    const text = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '(no output)';
    return [{ type: 'text', text }];
  },
};

const ok = (text) => ({ ok: true, text });
const fail = (text) => ({ ok: false, text });
const messageOf = (error) => (error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error));
const codeOf = (error) => (error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined);
const asString = (value) => (typeof value === 'string' ? value : '');
const asInt = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
/** Clip one display string, marking the elision. */
const clip = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}…` : text);
/** Shorten one opaque id to its distinguishing tail. */
const shortId = (id) => (id.length > 10 ? `…${id.slice(id.length - 8)}` : id);

// ── per-session notes, owned by this plugin ─────────────────────────────────

const NOTE_FILE_VERSION = 1;
const NOTE_MAX_CHARS = 200;

/** `<DSH_HOME>/session-manager/descriptions.json`, resolving DSH_HOME the way the harness does. */
const notePath = () => {
  const configured = process.env.DSH_HOME;
  const home = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : join(homedir(), '.dsh');
  return join(home, 'session-manager', 'descriptions.json');
};

let noteCache = null;
let noteChain = Promise.resolve();

/** Load the note table once; a missing or corrupt file simply means "no notes". */
const loadNotes = async () => {
  if (noteCache !== null) return noteCache;
  try {
    const parsed = JSON.parse(await readFile(notePath(), 'utf8'));
    const byId = parsed !== null && typeof parsed === 'object' && parsed.byId !== null && typeof parsed.byId === 'object' ? parsed.byId : {};
    noteCache = { byId };
  } catch (error) {
    noteCache = { byId: {} };
  }
  return noteCache;
};

const saveNotes = async (state) => {
  const path = notePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: NOTE_FILE_VERSION, byId: state.byId }, null, 2)}\n`, 'utf8');
};

/** Serialize mutations so two concurrent tool calls cannot interleave a read-modify-write. */
const withNotes = (operation) => {
  const run = noteChain.then(operation);
  noteChain = run.then(() => undefined, () => undefined);
  return run;
};

/** The current note for one session, or null. */
const noteOf = async (sessionId) => {
  const state = await loadNotes();
  const entry = state.byId[sessionId];
  return entry !== null && entry !== undefined && typeof entry.description === 'string' ? entry.description : null;
};

/** Set (non-empty) or clear (empty string) one session's note, rolling the cache back on a failed write. */
const writeNote = (sessionId, description) => withNotes(async () => {
  const state = await loadNotes();
  const previous = state.byId[sessionId];
  if (description.length === 0) delete state.byId[sessionId];
  else state.byId[sessionId] = { description, updatedAt: Date.now() };
  try {
    await saveNotes(state);
  } catch (error) {
    if (previous === undefined) delete state.byId[sessionId];
    else state.byId[sessionId] = previous;
    throw error;
  }
  return description.length === 0 ? null : description;
});

// ── transcript readers ──────────────────────────────────────────────────────

/** Read one session's current title projection, or null when unset. */
const titleOf = async (controller, sessionId) => {
  try {
    const listed = await controller.list({}, undefined);
    const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];
    for (const item of items) {
      if (item === null || typeof item !== 'object' || item.sessionId !== sessionId) continue;
      const projections = item.projections;
      if (projections === null || projections === undefined || typeof projections !== 'object') continue;
      const values = projections.values;
      if (values !== null && values !== undefined && typeof values === 'object' && typeof values.title === 'string' && values.title.length > 0) return values.title;
    }
  } catch (error) {
    return null;
  }
  return null;
};

/** Normalize one { provider, model, reasoningEffort? } selection, or null. */
const selectionOf = (value) => {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
  return {
    provider: value.provider,
    model: value.model,
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null,
  };
};

/** Read the wired `modelSelection` projection view ({ lastUsed, next }) off one session-list row. */
const routeFromProjection = (value) => {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  return { lastUsed: selectionOf(value.lastUsed), next: selectionOf(value.next) };
};

/**
 * The model route of one session, cold-safe and without resuming it: prefer the
 * wired `modelSelection` projection carried by the session list, and fall back to
 * folding the log ourselves when that session has no projection cache entry.
 * `next` is what the NEXT request will use (a pending switch), `lastUsed` is the
 * route the last recorded request actually ran on.
 */
const routeOf = async (controller, sessionId) => {
  try {
    const listed = await controller.list({}, undefined);
    const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];
    for (const item of items) {
      if (item === null || typeof item !== 'object' || item.sessionId !== sessionId) continue;
      const projections = item.projections;
      if (projections === null || projections === undefined || typeof projections !== 'object') break;
      const values = projections.values;
      if (values === null || values === undefined || typeof values !== 'object') break;
      const route = routeFromProjection(values.modelSelection);
      if (route !== null) return route;
      break;
    }
  } catch (error) {
    // fall through to folding the log
  }
  const inspection = await controller.inspect(sessionId, undefined);
  const events = inspection !== null && inspection !== undefined && Array.isArray(inspection.events) ? inspection.events : [];
  let lastUsed = null;
  let pending = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'model/selection') {
      const picked = selectionOf(event.data);
      if (picked !== null) pending = picked;
    } else if (event.type === 'request/header') {
      const data = event.data;
      const header = data !== null && typeof data === 'object' ? data.header : undefined;
      const used = selectionOf(header !== null && header !== undefined ? header.config : undefined);
      if (used !== null) {
        lastUsed = used;
        if (pending !== null && pending.provider === used.provider && pending.model === used.model && pending.reasoningEffort === used.reasoningEffort) pending = null;
      }
    }
  }
  return { lastUsed, next: pending !== null ? pending : lastUsed };
};

/** Collect the readable text of one content-block list, eliding the noisy kinds. */
const textOf = (blocks, includeReasoning) => {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
    else if (block.type === 'reasoning' && includeReasoning === true && typeof block.text === 'string') out += `\n[reasoning] ${block.text}`;
    else if (block.type === 'image') out += '[image]';
    else if (block.type === 'file') out += '[file]';
    else if (block.type === 'tool-call') out += `[tool ${String(block.name)}]`;
    else if (block.type === 'tool-result') out += '[tool result]';
  }
  return out;
};

/** Unwrap a tool-result message: its payload lives inside tool-result blocks. */
const textOfToolResult = (message) => {
  if (message === null || message === undefined || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  let out = '';
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'tool-result' && Array.isArray(block.content)) out += textOf(block.content, false);
    else if (block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
};

export default {
  name: 'session-control',
  inject: ['tools'],
  apply(ctx) {
    // Resolved per call so a late host provider is still picked up.
    const runtime = () => ({
      controller: ctx.get('sessionController'),
      agents: ctx.get('agents'),
    });

    /** The calling agent's durable id and workspace cwd, read defensively. */
    const callerOf = (exec) => {
      const found = { id: null, cwd: null };
      const agent = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent : null;
      if (agent === null || agent === undefined) return found;
      if (typeof agent.id === 'string') found.id = agent.id;
      const session = agent.session;
      if (session !== null && session !== undefined && session.header !== null && session.header !== undefined && typeof session.header.cwd === 'string') {
        found.cwd = session.header.cwd;
      }
      if (found.cwd === null && found.id !== null) {
        const { agents } = runtime();
        const live = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(found.id) : undefined;
        const liveSession = live !== undefined && live !== null ? live.session : undefined;
        if (liveSession !== undefined && liveSession !== null && liveSession.header !== undefined && liveSession.header !== null && typeof liveSession.header.cwd === 'string') {
          found.cwd = liveSession.header.cwd;
        }
      }
      return found;
    };

    const requireController = () => {
      const { controller } = runtime();
      return controller === undefined || controller === null ? null : controller;
    };

    const listTool = {
      name: 'session_list',
      description: "List the sessions this DSH process knows about — live and persisted — with id, working directory, title, running state, lineage (top-level, fork of another session, or a subagent child) and any private note this preset attached. Caller itself is always excluded. Defaults to the caller's own working directory; scope \"all\" lists every session in the process. Use this first to pick a sessionId for session_read, session_send, session_stop, session_fork or session_describe.",
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['workspace', 'all'], description: '"workspace" (default) or "all".' },
          cwd: { type: 'string', description: 'Absolute working directory to match when scope is workspace; omit for the caller cwd.' },
          runningOnly: { type: 'boolean', description: 'Only sessions with an active turn. Defaults to false.' },
          limit: { type: 'integer', description: 'Maximum rows, 1-200. Defaults to 40, newest activity first.' },
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const scope = input.scope === 'all' ? 'all' : 'workspace';
        const explicitCwd = asString(input.cwd);
        const caller = callerOf(exec);
        const targetCwd = explicitCwd.length > 0 ? explicitCwd : caller.cwd;
        if (scope === 'workspace' && targetCwd === null) {
          return fail('The caller has no working directory to scope to, so a workspace listing would be silently empty. Pass an absolute `cwd`, or call again with scope="all".');
        }
        const runningOnly = input.runningOnly === true;
        const limit = clamp(asInt(input.limit, 40), 1, 200);

        let listed;
        try {
          listed = await controller.list({}, undefined);
        } catch (error) {
          return fail(`Could not list sessions: ${messageOf(error)}`);
        }
        const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];
        const notes = (await loadNotes()).byId;

        const rows = [];
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue;
          const id = typeof item.sessionId === 'string' ? item.sessionId : null;
          if (id === null || id === caller.id) continue;
          const cwd = typeof item.cwd === 'string' ? item.cwd : null;
          if (scope === 'workspace' && (targetCwd === null || cwd !== targetCwd)) continue;
          if (runningOnly && item.running !== true) continue;
          let title = null;
          let route = null;
          const projections = item.projections;
          if (projections !== null && projections !== undefined && typeof projections === 'object') {
            const values = projections.values;
            if (values !== null && values !== undefined && typeof values === 'object') {
              if (typeof values.title === 'string' && values.title.length > 0) title = values.title;
              route = routeFromProjection(values.modelSelection);
            }
          }
          const parentId = typeof item.parentSessionId === 'string' ? item.parentSessionId : null;
          const isSubagent = item.origin === 'subagent';
          let updatedAt = null;
          if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) {
            try {
              updatedAt = new Date(item.updatedAt).toISOString();
            } catch (error) {
              updatedAt = null;
            }
          }
          const entry = notes[id];
          rows.push({
            id,
            cwd,
            title,
            route,
            running: item.running === true,
            isSubagent,
            isFork: !isSubagent && parentId !== null,
            parentId,
            updatedAt,
            note: entry !== null && entry !== undefined && typeof entry.description === 'string' ? entry.description : null,
          });
          if (rows.length >= limit) break;
        }

        const where = scope === 'workspace' ? ` in ${targetCwd === null ? '(no caller cwd)' : targetCwd}` : ' across the whole process';
        const lines = [];
        if (rows.length === 0) {
          lines.push(`No other sessions${where}.`);
        } else {
          lines.push(`${rows.length} other session(s)${where}, newest activity first:`);
          for (const row of rows) {
            const lineage = row.isSubagent
              ? `subagent child of ${String(row.parentId)} (not manageable here)`
              : (row.isFork ? `fork of ${String(row.parentId)}` : 'top-level');
            lines.push(
              `- ${row.id} | ${row.running ? 'running' : 'idle'}`
              + ` | ${lineage}`
              + ` | ${row.title === null ? '(untitled)' : row.title}`
              + ` | updated ${row.updatedAt === null ? 'unknown' : row.updatedAt}`
              + ` | cwd ${row.cwd === null ? '(none)' : row.cwd}`
              + ` | model ${row.route === null ? '(unknown)' : row.route.next === null ? '(unset)' : `${row.route.next.provider}/${row.route.next.model}`}`
              + (row.note === null ? '' : `\n    note: ${row.note}`),
            );
          }
          lines.push('session_read shows what one of them has been doing (detail="tools"/"all" includes tool calls, results and reasoning); session_send delivers into it; session_stop cancels its active turn; session_fork branches one into a separately managed copy; session_model reads or switches its model mid-run; session_describe attaches a private note only this preset can see. A subagent child cannot be driven by these tools (only its live parent session owns it); a fork can, and is fully independent.');
        }
        return ok(lines.join('\n'));
      },
    };

    const readTool = {
      name: 'session_read',
      description: 'Read the most recent events of one session, oldest first, newest last. detail="text" (default) returns user and assistant prose only; detail="tools" adds tool calls and their results; detail="all" also adds system/context messages, reasoning text and title changes. Reading never wakes the session, never writes to it, and works on cold persisted sessions as well as live ones.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable session id, from session_list.' },
          detail: { type: 'string', enum: ['text', 'tools', 'all'], description: '"text" (default) = prose only; "tools" = also tool calls, results and errors; "all" = also system messages, reasoning and titles.' },
          limit: { type: 'integer', description: 'How many of the newest events to return, 1-40. Defaults to 8 (with detail="tools"/"all" one tool call and its result count separately).' },
          maxChars: { type: 'integer', description: 'Per-event character cap, 200-4000. Defaults to 1200.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const detail = input.detail === 'all' ? 'all' : (input.detail === 'tools' ? 'tools' : 'text');
        const withTools = detail === 'tools' || detail === 'all';
        const withAll = detail === 'all';
        const limit = clamp(asInt(input.limit, 8), 1, 40);
        const maxChars = clamp(asInt(input.maxChars, 1200), 200, 4000);

        let inspection;
        try {
          inspection = await controller.inspect(sessionId, undefined);
        } catch (error) {
          const hint = codeOf(error) === 'session/not-found' ? ' No persisted session has that id.' : '';
          return fail(`Reading ${sessionId} failed: ${messageOf(error)}${hint}`);
        }
        const events = inspection !== null && inspection !== undefined && Array.isArray(inspection.events) ? inspection.events : [];

        const picked = [];
        let total = 0;
        for (let index = events.length - 1; index >= 0 && picked.length < limit; index--) {
          const event = events[index];
          if (event === null || typeof event !== 'object') continue;
          let role = null;
          let text = '';
          if (event.type === 'user/message') {
            const data = event.data;
            if (data !== null && typeof data === 'object' && data.source !== null && typeof data.source === 'object' && data.source.kind === 'user') {
              role = 'user';
              text = textOf(data.content, false);
            }
          } else if (event.type === 'assistant/message') {
            const data = event.data;
            const message = data !== null && typeof data === 'object' ? data.message : undefined;
            role = 'assistant';
            text = textOf(message !== null && message !== undefined ? message.content : undefined, withAll);
          } else if (withTools && event.type === 'tool/call') {
            const data = event.data;
            if (data !== null && typeof data === 'object' && typeof data.name === 'string') {
              const raw = typeof data.arguments === 'string' ? data.arguments : '';
              role = 'tool-call';
              text = `${data.name}(${raw.length > 400 ? `${raw.slice(0, 400)}…` : raw})`;
            }
          } else if (withTools && event.type === 'tool/result') {
            const data = event.data;
            const message = data !== null && typeof data === 'object' ? data.message : undefined;
            const error = data !== null && typeof data === 'object' ? data.error : undefined;
            role = 'tool-result';
            text = textOfToolResult(message);
            if (error !== null && error !== undefined && typeof error === 'object') {
              const name = typeof error.name === 'string' ? error.name : 'error';
              const code = typeof error.code === 'string' && error.code.length > 0 ? `: ${error.code}` : '';
              text = `${text}\n[failed ${name}${code}]`;
            }
          } else if (withAll && event.type === 'system/message') {
            const data = event.data;
            const message = data !== null && typeof data === 'object' ? data.message : undefined;
            role = 'system';
            text = textOf(message !== null && message !== undefined ? message.content : undefined, false);
          } else if (withAll && event.type === 'session/title') {
            const data = event.data;
            if (data !== null && typeof data === 'object' && typeof data.title === 'string') {
              role = 'title';
              text = data.title;
            }
          }
          if (role === null) continue;
          const clean = text.trim();
          if (clean.length === 0) continue;
          const clipped = clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
          total += clipped.length;
          let time = 0;
          if (typeof event.time === 'number' && Number.isFinite(event.time)) time = event.time;
          picked.push({ role, time, text: clipped });
          if (total >= 12000) break;
        }
        picked.reverse();

        const meta = inspection !== null && inspection !== undefined ? inspection.meta : undefined;
        const cwd = meta !== null && meta !== undefined && typeof meta.cwd === 'string' ? meta.cwd : '(unknown)';
        const header = `session ${sessionId} | cwd ${cwd} | ${events.length} event(s) | detail=${detail} | showing the last ${picked.length} matching event(s)`;
        if (picked.length === 0) {
          return ok(`${header}\n\n(nothing matched — the session may be blank, or hold only events this detail level filters out)`);
        }
        const body = picked
          .map((item) => `[${item.role} ${new Date(item.time).toISOString()}]\n${item.text}`)
          .join('\n\n');
        return ok(`${header}\n\n${body}`);
      },
    };

    const sendTool = {
      name: 'session_send',
      description: "Deliver a prompt into another session and wake it. mode \"queue\" adds it to that session's pending inbox for after its current turn; mode \"steer\" delivers it at its nearest step boundary. The target is resumed if it was cold. This writes into the target session log exactly like a message its own user typed, so use it deliberately and say what you are relaying. It is also how you drive one branch of a fork without touching the other.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          text: { type: 'string', description: 'Prompt text to deliver; must contain non-whitespace content.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: '"queue" (default) waits for the current turn; "steer" injects at the nearest step boundary.' },
        },
        required: ['sessionId', 'text'],
      },
      output: OUTPUT,
      async execute(args, exec) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        const text = asString(input.text);
        const mode = input.mode === 'steer' ? 'steer' : 'queue';
        if (sessionId.length === 0) return fail('sessionId is required.');
        if (text.trim().length === 0) return fail('text must contain non-whitespace content.');
        const caller = callerOf(exec);
        if (caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; answer the human instead of prompting yourself.');
        }
        try {
          await controller.prompt(
            { requestId: nextRequestId(), sessionId, mode, content: [{ type: 'text', text }] },
            callerSignal,
          );
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'session/agent-busy') hint = ' The target is owned by subagent routing (a subagent child); only its live parent session can deliver to it.';
          else if (code === 'session/not-found') hint = ' No such session exists in this process.';
          else if (code === 'session/model-unavailable') hint = ' The target has no routable model; select one for that session in the UI first.';
          return fail(`Delivery to ${sessionId} failed: ${messageOf(error)}${hint}`);
        }
        return ok(`Accepted: one ${mode} prompt delivered to ${sessionId}. It was resumed if it was cold and processes the message in its own turn; session_list shows its running state and session_read shows what it answers.`);
      },
    };

    const queueTool = {
      name: 'session_queue',
      description: "List the messages currently waiting in one session's inbox, in delivery order, with each message's placement. This is what session_send(mode=\"queue\") parked for after the current turn and what mode=\"steer\" will insert at the next step boundary, so it is how you check whether a prompt you sent is still pending. The inbox belongs to the live agent, so a cold session (no attached agent) has none; session_list shows running state. Read-only: nothing is delivered, admitted or cancelled.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable session id, from session_list.' },
          maxChars: { type: 'integer', description: 'Per-message character cap, 100-2000. Defaults to 400.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        if (typeof controller.control !== 'function') {
          return fail('This deployment exposes no live control stream, so a session inbox cannot be read.');
        }
        const maxChars = clamp(asInt(input.maxChars, 400), 100, 2000);

        // The inbox lives on the live control stream: its first frame is a
        // complete baseline carrying one queue per attached session. Read that
        // frame, then abort the stream — subscribing must not keep anything alive.
        const abort = new AbortController();
        let items = null;
        let attached = false;
        try {
          for await (const frame of controller.control(abort.signal)) {
            if (frame === null || typeof frame !== 'object' || frame.type !== 'baseline') continue;
            const value = frame.value;
            const queues = value !== null && value !== undefined && typeof value === 'object' ? value.queues : undefined;
            if (queues !== null && queues !== undefined && typeof queues === 'object') {
              attached = Object.prototype.hasOwnProperty.call(queues, sessionId);
              items = Array.isArray(queues[sessionId]) ? queues[sessionId] : [];
            } else {
              items = [];
            }
            // Release the stream BEFORE leaving the loop: a bare `break` waits on
            // the stream's own cancellation, and that cancellation is this signal.
            abort.abort();
            break;
          }
        } catch (error) {
          // A throw after the baseline is the stream closing under us, not a read failure.
          if (items === null) return fail(`Reading the inbox of ${sessionId} failed: ${messageOf(error)}`);
        } finally {
          abort.abort();
        }
        if (items === null) return fail('The live control stream ended before sending a baseline, so no inbox could be read. Try again.');

        if (items.length === 0) {
          return ok(attached
            ? `Session ${sessionId} has a live inbox with nothing pending.`
            : `No live inbox is registered for ${sessionId}: it has no attached agent in this process (a cold session), so nothing can be pending. session_list shows its running state; session_send with mode="queue" or "steer" creates pending messages.`);
        }
        const lines = [];
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const placement = item !== null && typeof item === 'object' && typeof item.placement === 'string' ? item.placement : 'queued';
          const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
          const message = item !== null && typeof item === 'object' ? item.message : undefined;
          const content = message !== null && message !== undefined && typeof message === 'object' ? message.content : undefined;
          const text = textOf(content, false).trim().replace(/\s*\n\s*/g, ' ');
          const shown = text.length === 0 ? '(no text content)' : clip(text, maxChars);
          lines.push(`${String(index + 1)}. [${placement}] ${shown}${id.length > 0 ? `  (id ${shortId(id)})` : ''}`);
        }
        return ok(`${String(items.length)} pending message${items.length === 1 ? '' : 's'} in ${sessionId}, in delivery order:\n${lines.join('\n')}`);
      },
    };

    const stopTool = {
      name: 'session_stop',
      description: "Cancel the active turn of another live session, keeping that session's pending inbox so nothing queued is lost. A cold persisted session reports session/not-found; only a live (attached) session can be cancelled. Stopping one fork branch leaves every other branch running.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args, exec) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const caller = callerOf(exec);
        if (caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; use the ordinary stop control for your own turn.');
        }
        try {
          await controller.cancel({ sessionId });
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'session/not-found') hint = ' The target is not attached right now; only a live session can be cancelled.';
          else if (code === 'session/agent-busy') hint = ' The target is owned by subagent routing (a subagent child).';
          return fail(`Cancellation of ${sessionId} failed: ${messageOf(error)}${hint}`);
        }
        return ok(`Cancellation requested for ${sessionId}; its pending inbox is kept and it stays resumable.`);
      },
    };

    const forkTool = {
      name: 'session_fork',
      description: "Branch one session into an independent copy and return the new session id. The fork is seeded with the source log up to the end of a completed turn (the latest one, or the first turn ending at or after atSeq), inherits the source's agent preset and working directory, and from then on has its own log and its own agent. Both sides are then managed separately with session_read / session_send / session_stop; the source is untouched. Use this to try two directions from one shared context and compare what each branch concludes.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Source session id to branch from.' },
          atSeq: { type: 'integer', description: 'Optional event seq to branch at: the fork keeps the log up to the first completed turn ending at or after this seq. Omit to branch from the latest completed turn. The source must have completed that turn.' },
          title: { type: 'string', description: 'Optional title for the fork. When omitted the fork is retitled "<source title> · fork" so the branches stay distinguishable in every listing.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const requestedTitle = asString(input.title).trim();
        let atSeq;
        if (typeof input.atSeq === 'number' && Number.isFinite(input.atSeq) && input.atSeq >= 0) atSeq = Math.floor(input.atSeq);

        let result;
        try {
          result = await controller.fork(atSeq === undefined ? { sessionId } : { sessionId, atSeq });
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'session/fork-unavailable') hint = ' A fork can only be cut at a completed turn boundary: either the source has no completed turn yet, or the seq you asked for lies in a turn that has not finished. Let it finish a turn and retry.';
          else if (code === 'session/not-found') hint = ' No persisted session has that id.';
          return fail(`Fork of ${sessionId} failed: ${messageOf(error)}${hint}`);
        }
        const childId = result !== null && result !== undefined && typeof result.sessionId === 'string' ? result.sessionId : null;
        if (childId === null) return fail(`Fork of ${sessionId} returned no session id.`);

        const sourceTitle = await titleOf(controller, sessionId);
        const fallbackTitle = sourceTitle === null ? 'fork' : `${sourceTitle} · fork`;
        const title = (requestedTitle.length > 0 ? requestedTitle : fallbackTitle).slice(0, 60);
        let titleNote = '';
        try {
          await controller.rename({ sessionId: childId, title });
          titleNote = `\nTitle set to "${title}".`;
        } catch (error) {
          titleNote = `\nTitle could not be set: ${messageOf(error)}`;
        }

        return ok(
          `Forked ${sessionId} -> ${childId}.${titleNote}\n`
          + 'The fork has its own log and its own agent, inherits the source\'s agent preset and cwd, and starts idle. '
          + 'Drive it independently with session_send / session_read / session_stop; the source is untouched. '
          + 'The seed ends at a completed turn boundary, so anything the source produced after that point is NOT in the fork.',
        );
      },
    };

    const describeTool = {
      name: 'session_describe',
      description: "Attach, change, or read a private note for one session — one short line saying what that session is FOR, or what you are waiting on from it. The note is NOT the session title: this preset stores it in its own file and never appends it to any session log, so the session list, the sidebar, the trajectory view and every other agent never see it. It is shown by this preset's session_list and, when the Session Canvas plugin is running, under the node on the canvas. Omit `description` to read the current note; pass an empty string to clear it.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          description: { type: 'string', description: `New note text, truncated to ${NOTE_MAX_CHARS} characters. An empty string clears the note. Omit the field entirely to read the current note.` },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args) {
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');

        if (typeof input.description !== 'string') {
          try {
            const current = await noteOf(sessionId);
            return ok(current === null ? `${sessionId} has no note.` : `${sessionId} note: ${current}`);
          } catch (error) {
            return fail(`Reading the note failed: ${messageOf(error)}`);
          }
        }

        const description = input.description.trim().slice(0, NOTE_MAX_CHARS);
        const controller = requireController();
        let unknown = '';
        if (controller !== null) {
          try {
            const listed = await controller.list({}, undefined);
            const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];
            const known = items.some((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId);
            if (!known) unknown = ` Warning: no session in this process currently has the id ${sessionId}; the note was stored anyway.`;
          } catch (error) {
            unknown = '';
          }
        }
        try {
          const stored = await writeNote(sessionId, description);
          return ok(stored === null
            ? `Cleared the note for ${sessionId}.${unknown}`
            : `Note for ${sessionId} set to: ${stored}${unknown}`);
        } catch (error) {
          return fail(`Writing the note failed: ${messageOf(error)}`);
        }
      },
    };

    const modelsTool = {
      name: 'session_models',
      description: 'List every model route this deployment can currently reach, grouped by provider, with each model\'s reasoning efforts. Use it to pick a valid provider/model pair for session_model. The catalog is advisory — membership never changes routing — and it reports providers whose discovery failed.',
      parameters: {},
      output: OUTPUT,
      async execute() {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; model routing is not possible here.');
        let catalog;
        try {
          catalog = await controller.modelCatalog();
        } catch (error) {
          return fail(`Reading the model catalog failed: ${messageOf(error)}`);
        }
        if (catalog === null || catalog === undefined || typeof catalog !== 'object') return fail('The model catalog came back empty.');

        const show = (selection) => (selection === null
          ? '(unset)'
          : `${selection.provider}/${selection.model}${selection.reasoningEffort === null ? '' : ` (effort ${selection.reasoningEffort})`}`);
        const lines = [];
        lines.push(`deployment default: ${show(selectionOf(catalog.default))}`);
        const providers = Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [];
        lines.push(`routable providers: ${providers.length === 0 ? '(none)' : providers.join(', ')}`);

        const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
        for (const group of groups) {
          if (group === null || typeof group !== 'object') continue;
          const providerId = typeof group.id === 'string' ? group.id : String(group.id);
          const displayName = typeof group.name === 'string' && group.name.length > 0 ? ` (${group.name})` : '';
          lines.push(`- ${providerId}${displayName}:`);
          const models = Array.isArray(group.models) ? group.models : [];
          if (models.length === 0) lines.push('    (no models listed)');
          for (const model of models) {
            if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue;
            const label = typeof model.name === 'string' && model.name.length > 0 && model.name !== model.id ? ` (${model.name})` : '';
            const reasoning = model.reasoning;
            let effortNote = '';
            if (reasoning !== null && reasoning !== undefined && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)) {
              const efforts = reasoning.efforts
                .map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : ''))
                .filter((id) => id.length > 0);
              if (efforts.length > 0) {
                const fallback = typeof reasoning.defaultEffort === 'string' ? ` (default ${reasoning.defaultEffort})` : '';
                effortNote = ` | efforts: ${efforts.join('/')}${fallback}`;
              }
            }
            lines.push(`    ${providerId}/${model.id}${label}${effortNote}`);
          }
        }

        const failures = Array.isArray(catalog.failures) ? catalog.failures : [];
        if (failures.length > 0) {
          lines.push('providers whose model discovery failed:');
          for (const failure of failures) {
            if (failure === null || typeof failure !== 'object') continue;
            lines.push(`    ${String(failure.id)}: ${typeof failure.message === 'string' ? failure.message : 'unknown failure'}`);
          }
        }
        return ok(lines.join('\n'));
      },
    };

    const modelTool = {
      name: 'session_model',
      description: "Read or switch the model route of one session, mid-conversation. With neither provider nor model it reports that session's route: `next` is what its NEXT request will use and `lastUsed` is the route its last recorded request actually ran on — reading does not wake the session. With provider AND model it installs the new route for the next request, so a running session picks it up at its next step. Run session_models first for valid ids.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          provider: { type: 'string', description: 'Provider route to switch to, from session_models. Pass together with model.' },
          model: { type: 'string', description: 'Exact model id to switch to, from session_models. Pass together with provider.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort id the target model supports. Omit to keep the model default.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; model routing is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const provider = asString(input.provider).trim();
        const model = asString(input.model).trim();
        const reasoningEffort = asString(input.reasoningEffort).trim();

        const show = (selection) => (selection === null
          ? '(unset)'
          : `${selection.provider}/${selection.model}${selection.reasoningEffort === null ? '' : ` (effort ${selection.reasoningEffort})`}`);

        if (provider.length === 0 && model.length === 0) {
          try {
            const route = await routeOf(controller, sessionId);
            return ok(`session ${sessionId}\n  next request will use: ${show(route.next)}\n  last request ran on:   ${show(route.lastUsed)}\n\nReading the route does not wake the session.`);
          } catch (error) {
            const hint = codeOf(error) === 'session/not-found' ? ' No persisted session has that id.' : '';
            return fail(`Reading the model route of ${sessionId} failed: ${messageOf(error)}${hint}`);
          }
        }
        if (provider.length === 0 || model.length === 0) {
          return fail('Pass both provider and model to switch, or neither to read the current route.');
        }

        const request = { sessionId, provider, model };
        if (reasoningEffort.length > 0) request.reasoningEffort = reasoningEffort;
        let result;
        try {
          result = await controller.selectModel(request);
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'session/model-unavailable') hint = ' That provider/model — or that reasoning effort — is not routable; run session_models to see what is.';
          else if (code === 'session/not-found') hint = ' No persisted session has that id.';
          else if (code === 'session/agent-busy') hint = ' The target is owned by subagent routing (a subagent child).';
          return fail(`Switching ${sessionId} failed: ${messageOf(error)}${hint}`);
        }
        const selected = selectionOf(result !== null && result !== undefined ? result.selected : undefined);
        const shown = selected === null ? `${provider}/${model}` : show(selected);
        return ok(
          `session ${sessionId} now uses ${shown} for its next request. The switch is mid-conversation: a running session applies it at its next step.\n`
          + 'Two side effects worth knowing: the target was resumed (and is now an idle live session) if it was cold, and the harness also stored this route as the deployment default for sessions created later.',
        );
      },
    };

    ctx.tools.register(modelsTool);
    ctx.tools.register(modelTool);
    ctx.tools.register(listTool);
    ctx.tools.register(readTool);
    ctx.tools.register(sendTool);
    ctx.tools.register(queueTool);
    ctx.tools.register(stopTool);
    ctx.tools.register(forkTool);
    ctx.tools.register(describeTool);
  },
};
