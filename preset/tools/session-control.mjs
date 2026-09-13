/**
 * Session-management tools for the `session-manager` agent preset.
 *
 * Why this file lives inside the preset directory:
 * `@deepseek-ai/dsh-agent-presets` resolves a row whose specifier starts with
 * "." against the composition's own directory, so the file travels with the
 * preset and needs no package install. A bare package name would instead
 * resolve from the harness install, which this directory cannot reach.
 *
 * Why it is `.mjs` and imports nothing:
 * the preset directory carries no package.json declaring `"type": "module"`,
 * so a `.js` file would be loaded as CommonJS. And only the ROW's specifier is
 * rewritten by the loader — a bare `import '@deepseek-ai/dsh-*'` inside this
 * file would be resolved by Node from THIS directory, not from the harness.
 * So it uses plain object tool definitions and no imports at all.
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
 */

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

/** Collect the readable text of one content-block list, eliding the noisy kinds. */
const textOf = (blocks) => {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
    else if (block.type === 'image') out += '[image]';
    else if (block.type === 'file') out += '[file]';
    else if (block.type === 'tool-call') out += `[tool ${String(block.name)}]`;
    else if (block.type === 'tool-result') out += '[tool result]';
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
      description: "List the sessions this DSH process knows about — live and persisted — with id, working directory, title, running state, and lineage (top-level, fork of another session, or a subagent child). Caller itself is always excluded. Defaults to the caller's own working directory; scope \"all\" lists every session in the process. Use this first to pick a sessionId for session_read, session_send, session_stop, or session_fork.",
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
        const runningOnly = input.runningOnly === true;
        const limit = clamp(asInt(input.limit, 40), 1, 200);

        let listed;
        try {
          listed = await controller.list({}, undefined);
        } catch (error) {
          return fail(`Could not list sessions: ${messageOf(error)}`);
        }
        const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];

        const rows = [];
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue;
          const id = typeof item.sessionId === 'string' ? item.sessionId : null;
          if (id === null || id === caller.id) continue;
          const cwd = typeof item.cwd === 'string' ? item.cwd : null;
          if (scope === 'workspace' && (targetCwd === null || cwd !== targetCwd)) continue;
          if (runningOnly && item.running !== true) continue;
          let title = null;
          const projections = item.projections;
          if (projections !== null && projections !== undefined && typeof projections === 'object') {
            const values = projections.values;
            if (values !== null && values !== undefined && typeof values === 'object' && typeof values.title === 'string' && values.title.length > 0) title = values.title;
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
          rows.push({
            id,
            cwd,
            title,
            running: item.running === true,
            isSubagent,
            isFork: !isSubagent && parentId !== null,
            parentId,
            updatedAt,
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
              + ` | cwd ${row.cwd === null ? '(none)' : row.cwd}`,
            );
          }
          lines.push('session_read shows what one of them has been doing; session_send delivers into it; session_stop cancels its active turn; session_fork branches one into a separately managed copy. A subagent child cannot be driven by these tools (only its live parent session owns it); a fork can, and is fully independent.');
        }
        return ok(lines.join('\n'));
      },
    };

    const readTool = {
      name: 'session_read',
      description: 'Read the most recent conversational messages (user, assistant) of one session, newest last, with tool calls and reasoning elided. Use it to learn what another session — or one branch of a fork — has been doing before relaying or steering it. Reading never wakes the session and never writes to it.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable session id, from session_list.' },
          limit: { type: 'integer', description: 'How many of the newest messages to return, 1-30. Defaults to 8.' },
          maxChars: { type: 'integer', description: 'Per-message character cap, 200-4000. Defaults to 1200.' },
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
        const limit = clamp(asInt(input.limit, 8), 1, 30);
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
          let blocks;
          if (event.type === 'user/message') {
            const data = event.data;
            if (data !== null && typeof data === 'object' && data.source !== null && typeof data.source === 'object' && data.source.kind === 'user') {
              role = 'user';
              blocks = data.content;
            }
          } else if (event.type === 'assistant/message') {
            const data = event.data;
            const message = data !== null && typeof data === 'object' ? data.message : undefined;
            role = 'assistant';
            blocks = message !== null && message !== undefined ? message.content : undefined;
          }
          if (role === null) continue;
          const text = textOf(blocks).trim();
          if (text.length === 0) continue;
          const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
          total += clipped.length;
          let time = 0;
          if (typeof event.time === 'number' && Number.isFinite(event.time)) time = event.time;
          picked.push({ role, time, text: clipped });
          if (total >= 9000) break;
        }
        picked.reverse();

        const meta = inspection !== null && inspection !== undefined ? inspection.meta : undefined;
        const cwd = meta !== null && meta !== undefined && typeof meta.cwd === 'string' ? meta.cwd : '(unknown)';
        const header = `session ${sessionId} | cwd ${cwd} | ${events.length} event(s) | showing the last ${picked.length} conversational message(s)`;
        if (picked.length === 0) {
          return ok(`${header}\n\n(no user or assistant text found — the session may be blank or hold only tool traffic)`);
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

    ctx.tools.register(listTool);
    ctx.tools.register(readTool);
    ctx.tools.register(sendTool);
    ctx.tools.register(stopTool);
    ctx.tools.register(forkTool);
  },
};
