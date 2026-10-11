/**
 * Session-management tools — layer ② of the `@local/dsh-session-manager` package.
 *
 * The package holds both layers: this file (the tools) and `store.mjs` (the
 * durable per-session records).
 * The preset's row names this file through a relative path reaching into the
 * package directory, because `@deepseek-ai/dsh-agent-presets` resolves a bare
 * package name from the HARNESS install while a "."-prefixed specifier goes
 * against the composition's own directory. One physical copy, two mount points.
 *
 * Why it is `.mjs`: the file is loaded as an ES module, and `.mjs` keeps it one
 * regardless of any package.json above it. Bare package imports would resolve
 * from the harness install, so this file imports only `node:` builtins and its
 * sibling `./store.mjs`.
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
 * Persistence: both the describe note (`session_describe`) and the lineage each
 * listing observes (`session_list`) go through `./store.mjs` into
 * `<DSH_HOME>/session-manager/state.json`: the one record set both the tools
 * that write it and the tools that report on it read. A note is
 * deliberately not a session title: it is never appended to any session log, so
 * the session list, the sidebar, the trajectory view and every other consumer of
 * that session never see it. It is not a secrecy boundary — the file sits in the
 * DSH home and any process could open it — it is a provenance boundary: nothing
 * else writes it.
 */
import { addDelegation, claimDelegationNotice, dropDelegation, markDelegationNotified, noteDelegation, releaseDelegationNotice, observe, pendingDelegations, readState, settleDelegation, setNote, setTitle, statePath, undeliveredDelegations, NOTE_MAX_CHARS } from './store.mjs'

let requestSeq = 0;

/** Mint one prompt correlation id for `sessionController.prompt`. */
const nextRequestId = () => `preset-session-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

/**
 * The correlation id of a delegation's callback notice.
 *
 * Deliberately DERIVED from the delegation id instead of minted fresh: the
 * session controller dedupes a prompt whose `requestId` already appears in the
 * target's inbox or durable log (`hasPromptRequest`), so re-enqueuing the same
 * notice after a crash — or from a second watcher instance — is a no-op rather
 * than a second delivery. A fresh id per attempt, which is what `nextRequestId`
 * gives, defeats exactly that protection.
 */
const noticeRequestId = (delegationId) => `preset-delegation-${delegationId}`;

let delegationSeq = 0;

/** Mint one delegation id. */
const nextDelegationId = () => `dlg-${Date.now().toString(36)}-${(++delegationSeq).toString(36)}`;

/** How often a pending delegation is re-checked while one exists. */
const DELEGATION_POLL_MS = 5000;

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

// ── session_read caps ───────────────────────────────────────────────────────
//
// The caller chooses the size of what it reads back. `maxChars` is the per-event
// cap, `totalChars` is the whole-response budget; both default to the historic
// behaviour (1200 per event, 12000 total) so an unqualified call costs exactly
// what it used to, but either may be raised freely to read a long delivery in a
// single call. The absolute ceilings only stop a typo becoming a multi-megabyte
// response.

const READ_DEFAULT_MAX_CHARS = 1200;
const READ_DEFAULT_TOTAL_CHARS = 12000;
const READ_MAX_CHARS_LIMIT = 500000;
const READ_TOTAL_CHARS_LIMIT = 5000000;
/** Shorten one opaque id to its distinguishing tail. */
const shortId = (id) => (id.length > 10 ? `…${id.slice(id.length - 8)}` : id);

// ── per-session notes and observed lineage, owned by this package ───────────
//
// The durable layer lives in ./store.mjs so that every reader of the records
// reads exactly what these tools write. These two adapters keep the tool bodies
// unchanged.

/** The current note for one session, or null when none is attached. */
const noteOf = async (sessionId) => {
  const state = await readState();
  const record = state.byId[sessionId];
  return record !== null && record !== undefined && typeof record.description === 'string' && record.description.length > 0 ? record.description : null;
};

/** Set (non-empty) or clear (empty string) one session's note. */
const writeNote = async (sessionId, description) => {
  await setNote(sessionId, description);
  return description.length === 0 ? null : description;
};

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

/**
 * Strip what a session title may never carry, mirroring the host's own
 * normalization (`@deepseek-ai/dsh-session-title` `cleanTitleText`).
 *
 * This is a PRE-FLIGHT check, not the authority: the host normalizes and
 * truncates again in `SessionTitleService.rename`, and its answer is what the
 * tool reports. Rejecting here only keeps an obviously empty title (controls
 * and zero-width marks only, say) from becoming a round trip whose only result
 * would be `session/title-invalid`. The host strips OSC/CSI/ESC sequences and
 * directional controls for the same reason a displayed title must not be able to
 * lie about its own text.
 */
const visibleTitleOf = (input) => input
  .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
  .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001B[@-_]/gu, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
  .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

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

/**
 * Decide one delegation's outcome from the TARGET's durable event log.
 *
 * The delivered prompt is the first user-authored message after `baselineSeq`,
 * and the outcome is the first `turn/end` after that, with the assistant prose
 * in between as the reply. A `turn/end` BEFORE the prompt is admitted is
 * ignored: with mode="queue" the target may already be mid-turn, and that turn
 * ending says nothing about the task. Reading the answer out of the log (rather
 * than off an in-memory watcher) is what lets a delegation survive a restart.
 *
 * @param events - the target session's events, oldest first.
 * @param baselineSeq - the target's last sequence when the prompt was delivered.
 * @returns the outcome to settle with, or null while it is still running.
 */
const readDelegationOutcome = (events, baselineSeq) => {
  if (!Array.isArray(events)) return null;
  let armed = false;
  let reply = '';
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (typeof event.seq !== 'number' || !Number.isFinite(event.seq) || event.seq <= baselineSeq) continue;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : null;
    if (!armed) {
      const source = data !== null ? data.source : undefined;
      if (event.type === 'user/message' && source !== null && source !== undefined && typeof source === 'object' && source.kind === 'user') armed = true;
      continue;
    }
    if (event.type === 'assistant/message') {
      const message = data !== null && data.message !== null && typeof data.message === 'object' ? data.message : null;
      const text = textOf(message !== null ? message.content : undefined, false).trim();
      if (text.length > 0) reply = text;
      continue;
    }
    if (event.type === 'turn/end') {
      const reason = data !== null && data.reason !== null && typeof data.reason === 'object' && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown';
      if (reason === 'completed' || reason === 'max-tokens') return { status: 'done', reply, note: `turn ended ${reason}` };
      if (reason === 'error') {
        const failure = data.reason.error;
        const detail = failure !== null && typeof failure === 'object' && typeof failure.message === 'string' ? failure.message : 'model request failed';
        return { status: 'failed', reply, note: `turn errored: ${detail}` };
      }
      return { status: 'failed', reply, note: `turn ended ${reason}` };
    }
  }
  return null;
};

export default {
  name: 'session-control',
  inject: ['tools'],
  apply(ctx) {
    // Resolved per call so a late host provider is still picked up.
    const runtime = () => ({
      controller: ctx.get('sessionController'),
      agents: ctx.get('agents'),
      commands: ctx.get('commands'),
      workspaces: ctx.get('workspaceRegistry'),
    });

    /** The calling agent's durable id, workspace cwd and preset, read defensively. */
    const callerOf = (exec) => {
      const found = { id: null, cwd: null, preset: null };
      const agent = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent : null;
      if (agent === null || agent === undefined) return found;
      if (typeof agent.id === 'string') found.id = agent.id;
      const session = agent.session;
      if (session !== null && session !== undefined && session.header !== null && session.header !== undefined) {
        if (typeof session.header.cwd === 'string') found.cwd = session.header.cwd;
        if (typeof session.header.agentPreset === 'string' && session.header.agentPreset.length > 0) found.preset = session.header.agentPreset;
      }
      if (found.cwd === null && found.id !== null) {
        const { agents } = runtime();
        const live = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(found.id) : undefined;
        const liveSession = live !== undefined && live !== null ? live.session : undefined;
        if (liveSession !== undefined && liveSession !== null && liveSession.header !== undefined && liveSession.header !== null) {
          if (typeof liveSession.header.cwd === 'string') found.cwd = liveSession.header.cwd;
          if (found.preset === null && typeof liveSession.header.agentPreset === 'string' && liveSession.header.agentPreset.length > 0) found.preset = liveSession.header.agentPreset;
        }
      }
      return found;
    };

    const requireController = () => {
      const { controller } = runtime();
      return controller === undefined || controller === null ? null : controller;
    };

    const requireWorkspaces = () => {
      const { workspaces } = runtime();
      return workspaces === undefined || workspaces === null ? null : workspaces;
    };

    // ── delegation callbacks ────────────────────────────────────────────────
    //
    // Push side of `session_send(callback: true)`: one pass turns "the target
    // finished its turn" into "the delegator was told". Completion is decided
    // from the TARGET's durable log (readDelegationOutcome), so the watcher holds
    // no per-delegation state and a record left pending by a restart still
    // settles afterwards.
    //
    // Delivery is idempotent, and that is a property of the LEDGER, not of this
    // pass. Two rules enforce it:
    //
    //   1. A pass only ever notifies a row it WON the atomic claim for
    //      (`claimDelegationNotice`). Two watcher passes — the timer's and a
    //      `session_delegations` read's, or the same pass on two module
    //      instances — can both see one settled row, but only one gets a
    //      non-null claim. Notifying off `settleDelegation` alone, as this code
    //      once did, ignored which caller had actually settled the row, so every
    //      pass that observed a settled delegation re-sent its notice.
    //   2. `notifiedAt` is persisted AFTER the prompt is accepted, and the
    //      notice's `requestId` is derived from the delegation id, so the crash
    //      window between settling and sending is safe in both directions: the
    //      next start retries (no loss), and the controller dedupes that retry
    //      (`hasPromptRequest`, no duplicate) even if the first send did land.
    //
    // A dismissed row can never be notified: `dismiss` removes it, and nothing
    // can claim a row it cannot find.

    /** Deliver one outcome into the delegator's own session, as a queued message. */
    const notifyDelegator = async (controller, delegation, outcome) => {
      // Re-check the row immediately before sending: a `dismiss` that lands in
      // the gap between the claim and this prompt must suppress the notice, not
      // let a row the user already forgot still arrive.
      const latest = await readState();
      const row = latest.delegations.find((item) => item.id === delegation.id);
      if (row === undefined || row.notifiedAt > 0) {
        releaseDelegationNotice(delegation.id);
        return false;
      }
      const headline = outcome.status === 'done' ? '完成了你委托的任务' : '结束了你委托的任务，但没有正常完成';
      // Deliberately a SHORT acknowledgement, never the reply body: the reply can
      // run to thousands of characters, and a queued notice that carries it both
      // bloats the delegator's context and arrives truncated anyway. The full
      // text is durable in the target's session log, so the notice only says
      // where to read it.
      const lines = [
        `[callback] 会话 ${shortId(delegation.to)} ${headline}。`,
        `task：「${delegation.task.length > 0 ? clip(delegation.task, 120) : '(no task text)'}」`,
        outcome.reply.length > 0
          ? `它留下了 ${String(outcome.reply.length)} 字符的答复（未随 callback 携带）。`
          : '它没有留下文本答复。',
        `状态 ${outcome.status}${outcome.note.length > 0 ? `（${outcome.note}）` : ''} · delegation ${delegation.id} · 请用 session_read(sessionId="${delegation.to}") 查看完整交付，delegation ledger 用 session_delegations。`,
      ];
      try {
        await controller.prompt(
          { requestId: noticeRequestId(delegation.id), sessionId: delegation.from, mode: 'queue', content: [{ type: 'text', text: lines.join('\n') }] },
          callerSignal,
        );
        // Durable "delivered": written only after the controller ACCEPTED the
        // notice, so a restart cannot re-enqueue it and a failed attempt is not
        // silently treated as done. A row dismissed while the prompt was in
        // flight simply leaves nothing to mark.
        await markDelegationNotified(delegation.id);
        return true;
      } catch (error) {
        // The target finished; only the notice could not be delivered. Leave
        // `notifiedAt` unset (the attempt cap bounds retries) and always free the
        // in-flight claim, even if recording the reason itself fails.
        try {
          await noteDelegation(delegation.id, `回调未投递：${messageOf(error)}`);
        } finally {
          releaseDelegationNotice(delegation.id);
        }
        return false;
      }
    };

    /**
     * Deliver one settled row, at most once, to whichever pass wins its claim.
     * `outcome` is the text to announce; it is the freshly-read outcome when this
     * pass settled the row, and the recorded row itself when this pass is only
     * recovering a notice that an earlier pass failed to send. Returns true when
     * a notice was actually handed to the delegator.
     */
    const deliverSettled = async (controller, delegation, outcome) => {
      const claimed = await claimDelegationNotice(delegation.id);
      if (claimed === null) return false; // another pass already claimed or delivered it
      return notifyDelegator(controller, claimed, outcome);
    };

    /** One pass over every pending delegation. Concurrent calls share the in-flight pass. */
    let checking = null;
    const checkDelegations = () => {
      if (checking !== null) return checking;
      checking = (async () => {
        try {
          const controller = requireController();
          if (controller === null) return;
          const state = await readState();
          // Deliver anything already settled but not yet announced. This is what
          // makes a notice survive the gap between settling a row and sending its
          // notice (a process exit in between, or a delivery that threw).
          for (const delegation of undeliveredDelegations(state)) {
            await deliverSettled(controller, delegation, {
              status: delegation.status,
              reply: delegation.reply,
              note: delegation.note,
            });
          }
          const pending = pendingDelegations(await readState());
          if (pending.length === 0) return;
          for (const delegation of pending) {
            let inspection;
            try {
              inspection = await controller.inspect(delegation.to, undefined);
            } catch (error) {
              continue; // unreadable right now (deleted, mid-write): keep it pending
            }
            const events = inspection !== null && inspection !== undefined && Array.isArray(inspection.events) ? inspection.events : null;
            const outcome = readDelegationOutcome(events, delegation.baselineSeq);
            if (outcome === null) continue;
            // Settle first, then claim+deliver. The settle is itself atomic and
            // only one pass can win it, and the claim gates the send.
            const settled = await settleDelegation(delegation.id, outcome);
            if (settled === null) continue; // another pass settled (or dismissed) it first
            await deliverSettled(controller, settled, outcome);
          }
        } catch (error) {
          // A watcher pass never fails a tool call or the poll loop.
        } finally {
          checking = null;
        }
      })();
      return checking;
    };

    const timer = ctx.get('timer');
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      const startWatch = () => timer.interval(() => { void checkDelegations(); }, DELEGATION_POLL_MS);
      if (typeof ctx.effect === 'function') ctx.effect(startWatch, 'session-manager: delegation watcher');
      else startWatch();
    }

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
        const state = await readState();
        const notes = state.byId;

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
          lines.push('session_read shows what one of them has been doing (detail="tools"/"all" includes tool calls, results and reasoning); session_send delivers into it; session_stop cancels its active turn; session_fork branches one into a separately managed copy; session_model reads or switches its model mid-run; session_queue shows what is still waiting in its inbox; session_describe attaches a private note only this preset can see; session_rename reads or replaces the title above (the label the sidebar shows). A subagent child cannot be driven by these tools (only its live parent session owns it); a fork can, and is fully independent.');
        }

        // Persist the relations this listing just observed, so they outlive the
        // sessions they describe and later listings can still report them. A
        // failure here must not hide the listing itself.
        try {
          await observe(rows.map((row) => ({
            id: row.id,
            parentId: row.parentId,
            kind: row.isSubagent ? 'subagent' : (row.isFork ? 'fork' : 'top-level'),
            cwd: row.cwd,
            title: row.title,
          })));
        } catch (error) {
          lines.push(`Warning: could not persist the observed relations into ${statePath()} (${messageOf(error)}). The listing above is still current.`);
        }
        return ok(lines.join('\n'));
      },
    };

    const readTool = {
      name: 'session_read',
      description: 'Read the most recent events of one session, oldest first, newest last. detail="text" (default) returns user and assistant prose only; detail="tools" adds tool calls and their results; detail="all" also adds system/context messages, reasoning text and title changes. Reading never wakes the session, never writes to it, and works on cold persisted sessions as well as live ones. size is YOURS to choose: maxChars caps one event (default 1200, no practical upper bound) and totalChars caps the whole response (default 12000) — raise either to read a long delivery in one call instead of getting only its first part, and the header reports which cap cut the text.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable session id, from session_list.' },
          detail: { type: 'string', enum: ['text', 'tools', 'all'], description: '"text" (default) = prose only; "tools" = also tool calls, results and errors; "all" = also system messages, reasoning and titles.' },
          limit: { type: 'integer', description: 'How many of the newest events to return, 1-40. Defaults to 8 (with detail="tools"/"all" one tool call and its result count separately).' },
          maxChars: { type: 'integer', description: 'Per-event character cap, 1-500000. Defaults to 1200; raise it to read a long event without elision.' },
          totalChars: { type: 'integer', description: 'Total character budget across the whole response, 1-5000000. Defaults to 12000, or maxChars × limit when maxChars is set explicitly. Reading stops at whichever cap is reached first.' },
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
        const maxCharsExplicit = typeof input.maxChars === 'number' && Number.isFinite(input.maxChars);
        // A floor of 1 instead of 200: the caller owns the size now, and 1 is a
        // legitimate "just tell me this exists" probe.
        const maxChars = Math.min(READ_MAX_CHARS_LIMIT, Math.max(1, asInt(input.maxChars, READ_DEFAULT_MAX_CHARS)));
        // Widening only the per-event cap must widen the whole response with it,
        // otherwise the old total ceiling would silently undo the raise.
        const totalChars = Math.min(READ_TOTAL_CHARS_LIMIT, Math.max(1, asInt(input.totalChars, maxCharsExplicit ? maxChars * limit : READ_DEFAULT_TOTAL_CHARS)));
        // Tool-call arguments used to be clipped at a fixed 400 no matter what
        // maxChars was, which made a large maxChars useless for a long command.
        const argCap = Math.max(400, maxChars);

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
        let clipped = 0;
        let budgetStopped = false;
        // Whether the scan stopped because it hit `limit` (false) or because it
        // ran out of events (true) — the header reports only the latter.
        let ended = false;
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
              text = `${data.name}(${raw.length > argCap ? `${raw.slice(0, argCap)}…` : raw})`;
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
          // Stop before spending the last slice of budget on an event that cannot
          // fit even partially.
          if (total + maxChars > totalChars && picked.length > 0) {
            budgetStopped = true;
            break;
          }
          const capped = clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
          total += capped.length;
          if (clean.length > maxChars) clipped += 1;
          let time = 0;
          if (typeof event.time === 'number' && Number.isFinite(event.time)) time = event.time;
          picked.push({ role, time, text: capped });
          if (total >= totalChars) {
            budgetStopped = true;
            break;
          }
        }
        ended = picked.length < limit;
        picked.reverse();

        const meta = inspection !== null && inspection !== undefined ? inspection.meta : undefined;
        const cwd = meta !== null && meta !== undefined && typeof meta.cwd === 'string' ? meta.cwd : '(unknown)';
        // Say when a cap actually cut content, and which one did it — otherwise a
        // trailing ellipsis leaves the caller guessing whether more exists.
        let note = null;
        if (budgetStopped) {
          note = `stopped at the ${totalChars}-character budget (${total} of ${totalChars} returned)`;
        } else if (clipped > 0) {
          note = `${clipped === 1 ? '1 event' : String(clipped) + ' events'} clipped to ${maxChars} character${maxChars === 1 ? '' : 's'} each`;
        } else if (ended) {
          // The scan ran out of events with items still to take: a real end of list.
          note = `reached the end of matching events (${picked.length} of limit ${limit})`;
        }
        const caps = `detail=${detail} | showing the last ${picked.length} matching event(s) | cap maxChars=${maxChars}, totalChars=${totalChars}`
          + (note !== null ? ` | ${note}` : '');
        const header = `session ${sessionId} | cwd ${cwd} | ${events.length} event(s) | ${caps}`;
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
      description: "Deliver a prompt into another session and wake it. mode \"queue\" adds it to that session's pending inbox for after its current turn; mode \"steer\" delivers it at its nearest step boundary. The target is resumed if it was cold. This writes into the target session log exactly like a message its own user typed, so use it deliberately and say what you are relaying. It is also how you drive one branch of a fork without touching the other. Set callback=true to be TOLD when the target finishes that turn: a SHORT acknowledgement (status, delegation id, whether a reply exists and its length — never the reply body) is delivered back into YOUR session as a queued message, and you then read the full delivery with session_read on the target. The delegation is also recorded in a durable ledger you can read with session_delegations. The target needs no cooperation and no special preset for this — the watch is on your side.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          text: { type: 'string', description: 'Prompt text to deliver; must contain non-whitespace content.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: '"queue" (default) waits for the current turn; "steer" injects at the nearest step boundary.' },
          callback: { type: 'boolean', description: 'When true, report the target\'s outcome back into this session once that turn ends. Defaults to false (fire and forget).' },
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
        const callback = input.callback === true;
        if (sessionId.length === 0) return fail('sessionId is required.');
        if (text.trim().length === 0) return fail('text must contain non-whitespace content.');
        const caller = callerOf(exec);
        if (caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; answer the human instead of prompting yourself.');
        }
        if (callback && caller.id === null) {
          return fail('callback=true needs a caller session to reply to, and this call carries no caller identity.');
        }

        // Baseline BEFORE delivery: the outcome is read as "the first user message
        // after this sequence, then the first turn end after that".
        let baselineSeq = 0;
        if (callback) {
          try {
            const inspection = await controller.inspect(sessionId, undefined);
            const events = inspection !== null && inspection !== undefined && Array.isArray(inspection.events) ? inspection.events : [];
            for (const event of events) if (event !== null && typeof event === 'object' && typeof event.seq === 'number' && event.seq > baselineSeq) baselineSeq = event.seq;
          } catch (error) {
            baselineSeq = 0;
          }
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

        if (!callback) {
          return ok(`Accepted: one ${mode} prompt delivered to ${sessionId}. It was resumed if it was cold and processes the message in its own turn; session_list shows its running state and session_read shows what it answers.`);
        }
        const delegationId = nextDelegationId();
        await addDelegation({ id: delegationId, from: caller.id, to: sessionId, task: text, mode, createdAt: Date.now(), baselineSeq, status: 'pending' });
        void checkDelegations();
        return ok(`Accepted: one ${mode} prompt delivered to ${sessionId}, with callback ${delegationId} registered. When that turn ends a short acknowledgement (status and reply length, not the reply itself) is delivered into THIS session as a queued message — it will not interrupt a turn you are already running — and the full delivery is read with session_read(sessionId="${sessionId}"). session_delegations lists the ledger; session_queue marks the target too.`);
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

        // A pending-or-settled delegation to this session is exactly as relevant as
        // the inbox: it is the other half of "what did I ask it to do".
        const ledger = (await readState()).delegations.filter((item) => item.to === sessionId);
        const settled = ledger.filter((item) => item.status !== 'pending').length;
        const ledgerNote = ledger.length === 0
          ? ''
          : `\nDelegations to ${sessionId}: ${String(ledger.length)} recorded, ${String(ledger.length - settled)} still pending, ${String(settled)} settled — session_delegations shows the replies.`;

        if (items.length === 0) {
          return ok((attached
            ? `Session ${sessionId} has a live inbox with nothing pending.`
            : `No live inbox is registered for ${sessionId}: it has no attached agent in this process (a cold session), so nothing can be pending. session_list shows its running state; session_send with mode="queue" or "steer" creates pending messages.`) + ledgerNote);
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
        return ok(`${String(items.length)} pending message${items.length === 1 ? '' : 's'} in ${sessionId}, in delivery order:\n${lines.join('\n')}${ledgerNote}`);
      },
    };

    /**
     * Read the live inbox of one session off the control-stream baseline.
     *
     * The inbox lives on the live control stream: its first frame is a complete
     * baseline carrying one queue per attached session. Read that frame, then
     * abort the stream — subscribing must not keep anything alive.
     *
     * @returns `{ attached, items }` where `items` are the host queue entries
     *   (`{ id, placement, message: { id, content }, rpcId? }`) in delivery order.
     * @throws when the stream ends without a baseline at all.
     */
    const readInbox = async (controller, sessionId) => {
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
        if (items === null) throw error;
      } finally {
        abort.abort();
      }
      if (items === null) throw new Error('The live control stream ended before sending a baseline.');
      return { attached, items };
    };

    /** One pending entry's one-line preview, for management listings and dry-runs. */
    const previewEntry = (item, maxChars) => {
      const placement = item !== null && typeof item === 'object' && typeof item.placement === 'string' ? item.placement : 'queued';
      const message = item !== null && typeof item === 'object' ? item.message : undefined;
      const content = message !== null && message !== undefined && typeof message === 'object' ? message.content : undefined;
      const text = textOf(content, false).trim().replace(/\s*\n\s*/g, ' ');
      return { placement, text: text.length === 0 ? '(no text content)' : clip(text, maxChars) };
    };

    const queueManageTool = {
      name: 'session_queue_manage',
      description: "Manage the messages still waiting in another session's inbox: revoke (remove) or replace (edit) a message that has NOT been delivered yet, or clear the whole pending inbox. This is the write-side complement of the read-only session_queue. Exactly like session_send / session_stop, it may act on any live session this preset manages — never the caller itself and never a subagent-owned child. ONLY undelivered messages can be touched: once a message has been admitted into the target's current turn (or steer-injected at a step boundary) it leaves the inbox, becomes part of that session's durable history, and CANNOT be revoked or rewritten — asking for such an item returns an explicit error, never a silent success. Start with action=\"list\" to see every pending entry with its FULL stable itemId (the same id session_queue prints shortened); the id is minted when the prompt is admitted and never changes, so it is immune to concurrent delivery reshuffling. action=\"edit\" replaces the pending text in place and keeps the message's placement (queued stays queued, steering stays steering); action=\"remove\" revokes one pending item; action=\"clear\" removes every message still pending at that instant and requires confirm=true. The tool also works on a session whose turn was stopped, because session_stop keeps the pending inbox. dryRun validates and reports exactly what would change without changing anything.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          action: { type: 'string', enum: ['list', 'remove', 'edit', 'clear'], description: '"list" (default) shows pending entries with full ids; "remove" revokes one pending item by itemId; "edit" replaces one pending item\'s text, keeping its placement; "clear" removes every currently-pending item (requires confirm=true).' },
          itemId: { type: 'string', description: 'The full id of one pending entry, from action="list". Required for remove and edit. A delivered message no longer has a pending id — it is history and cannot be changed.' },
          text: { type: 'string', description: 'Replacement text for action="edit"; must contain non-whitespace content.' },
          confirm: { type: 'boolean', description: 'Required true for action="clear", so an inbox is never wiped by accident.' },
          dryRun: { type: 'boolean', description: 'Validate and report only: locate the item(s), check they are still pending, describe the exact change — and change nothing. Defaults to false.' },
          maxChars: { type: 'integer', description: 'Per-message preview cap for list and dry-runs, 100-2000. Defaults to 400.' },
        },
        required: ['sessionId', 'action'],
      },
      output: OUTPUT,
      async execute(args, exec) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        const action = ['list', 'remove', 'edit', 'clear'].includes(input.action) ? input.action : 'list';
        if (sessionId.length === 0) return fail('sessionId is required.');
        if (typeof controller.control !== 'function' || typeof controller.updateQueue !== 'function') {
          return fail('This deployment exposes no live session-control stream or queue mutation, so queued messages cannot be managed here.');
        }
        const dryRun = input.dryRun === true;
        const itemId = asString(input.itemId).trim();
        const text = asString(input.text);
        const maxChars = clamp(asInt(input.maxChars, 400), 100, 2000);
        const caller = callerOf(exec);
        if (caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; a session\'s own inbox is driven by its own UI, not by this coordination tool.');
        }
        if (action === 'edit' && text.trim().length === 0) return fail('text must contain non-whitespace content to replace a pending message.');
        if ((action === 'remove' || action === 'edit') && itemId.length === 0) return fail(`itemId is required for action="${action}". List the queue first (action="list") to get full ids.`);
        if (action === 'clear' && input.confirm !== true) {
          return fail('clear requires confirm=true: it removes every message still pending in that session\'s inbox. Pass confirm=true to proceed, or dryRun=true to preview first.');
        }

        let inbox;
        try {
          inbox = await readInbox(controller, sessionId);
        } catch (error) {
          return fail(`Reading the inbox of ${sessionId} failed: ${messageOf(error)}`);
        }
        const { attached, items } = inbox;

        const noInbox = () => `No live inbox is registered for ${sessionId}: it has no attached agent in this process (a cold session), so nothing can be pending there. Note session_stop does NOT make a session cold — it cancels the turn but keeps the inbox; only a session with no attached agent has no inbox.`;

        if (action === 'list') {
          if (items.length === 0) {
            return ok((attached
              ? `Session ${sessionId} has a live inbox with nothing pending.`
              : noInbox())
              + ' Manage pending messages with action="remove"/"edit"/"clear".');
          }
          const lines = [];
          for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
            const { placement, text: preview } = previewEntry(item, maxChars);
            lines.push(`${String(index + 1)}. [${placement}] ${preview}  (id ${id.length > 0 ? id : '(none)'})`);
          }
          return ok(`${String(items.length)} pending message${items.length === 1 ? '' : 's'} in ${sessionId}, in delivery order (full ids — pass one to action="remove"/"edit"; a delivered message is history and no longer appears here):\n${lines.join('\n')}`);
        }

        if (!attached) return fail(noInbox());

        if (action === 'remove' || action === 'edit') {
          const entry = items.find((item) => item !== null && typeof item === 'object' && item.id === itemId);
          const verb = action === 'remove' ? 'revoke' : 'rewrite';
          if (dryRun) {
            if (entry === undefined) {
              return fail(`DRY RUN — nothing changed. No pending message ${itemId} is in ${sessionId}: it is either already delivered (admitted into that session's current turn — that is history now and cannot be undone) or the id does not exist. action="list" shows the ids still pending.`);
            }
            const { placement, text: preview } = previewEntry(entry, maxChars);
            return ok(`DRY RUN — nothing changed. Would ${action === 'remove' ? 'revoke' : 'replace the text of'} pending message ${itemId} (placement ${placement}) in ${sessionId}.\nCurrent text: ${preview}${action === 'edit' ? `\nNew text:     ${clip(text, maxChars)}` : ''}`);
          }
          try {
            await controller.updateQueue({
              sessionId,
              itemId,
              action: action === 'remove' ? { kind: 'remove' } : { kind: 'edit', content: [{ type: 'text', text }] },
            });
          } catch (error) {
            const code = codeOf(error);
            if (code === 'session/queue-item-not-found') {
              return fail(`Could not ${verb} ${itemId} in ${sessionId}: it is no longer pending — it was already delivered (admitted into that session's current turn), and delivered messages are that session's history, which cannot be changed. Use action="list" to see what is still pending.`);
            }
            if (code === 'session/agent-busy') {
              return fail(`Could not ${verb} ${itemId} in ${sessionId}: the target is owned by subagent routing (a subagent child); only its live parent session can manage its queue.`);
            }
            if (code === 'session/attachment-invalid' || code === 'gateway/bad-request') {
              return fail(`Edit of ${itemId} in ${sessionId} rejected: ${messageOf(error)}`);
            }
            return fail(`Queue mutation of ${itemId} in ${sessionId} failed: ${messageOf(error)}`);
          }
          return ok(action === 'remove'
            ? `Revoked pending message ${itemId} from ${sessionId}; it will never be delivered. (Already-delivered messages are history and are untouched.)`
            : `Replaced the pending text of ${itemId} in ${sessionId}; it keeps its placement and will be delivered with the new text.`
            + (action === 'edit' ? `\nNew text: ${text}` : ''));
        }

        // clear
        if (items.length === 0) {
          return ok(`Nothing pending in ${sessionId} — the inbox is already empty.`);
        }
        if (dryRun) {
          const clearLines = items.map((item) => {
            const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '(none)';
            const { placement, text: preview } = previewEntry(item, maxChars);
            return `- [${placement}] ${preview}  (id ${id})`;
          });
          return ok(`DRY RUN — nothing changed. clear would remove ${String(items.length)} pending message(s) from ${sessionId}:\n${clearLines.join('\n')}`);
        }
        const removed = [];
        const failures = [];
        for (const item of items) {
          const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
          if (id.length === 0) continue;
          try {
            await controller.updateQueue({ sessionId, itemId: id, action: { kind: 'remove' } });
            removed.push(id);
          } catch (error) {
            if (codeOf(error) === 'session/queue-item-not-found') failures.push(`${id} (was already delivered between list and clear — left as history, cannot be revoked)`);
            else failures.push(`${id} (${messageOf(error)})`);
          }
        }
        return ok(`Cleared ${String(removed.length)}/${String(items.length)} pending message(s) from ${sessionId}.\n${failures.length === 0 ? '' : `Not removed:\n${failures.join('\n')}`}`
          + ' Already-delivered messages are that session\'s history and are never touched.');
      },
    };

    const delegationsTool = {
      name: 'session_delegations',
      description: 'Read the delegation ledger: one row per session_send you made with callback=true, with its target, the task excerpt, and its state. pending = the target has not finished that turn yet; done = it finished and here is an excerpt of the reply it produced (the callback notice itself is only a short acknowledgement — read the full delivery with session_read on the target); failed = that turn ended aborted, blocked or errored; unknown = nothing confirmed it (for example a watcher timed out). A row that asked its delegator a question shows the question and your answer as `asked:` lines; unlike the `note:` line, those survive the task settling. Reading also performs a check pass, so a finished delegation appears here even if the automatic callback notice never reached you. The ledger is durable: it survives restarts, and a delegation still pending from before a restart keeps being watched.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Only delegations sent TO this session.' },
          status: { type: 'string', enum: ['all', 'pending', 'done', 'failed', 'unknown'], description: 'Filter by state. Defaults to all.' },
          limit: { type: 'integer', description: 'How many rows, 1-100. Defaults to 20, newest first.' },
          dismiss: { type: 'string', description: 'Delegation id to forget: removes the ledger row. Nothing about the sessions themselves changes.' },
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {};
        const dismiss = asString(input.dismiss).trim();
        if (dismiss.length > 0) {
          const before = (await readState()).delegations.length;
          await dropDelegation(dismiss);
          const after = (await readState()).delegations.length;
          return ok(after < before ? `Forgot delegation ${dismiss}.` : `No delegation ${dismiss} in the ledger.`);
        }

        // A check pass first, so this read is always at least as fresh as the pull.
        await checkDelegations();
        const state = await readState();
        const caller = callerOf(exec);
        const target = asString(input.sessionId).trim();
        const status = ['pending', 'done', 'failed', 'unknown'].includes(input.status) ? input.status : 'all';
        const limit = clamp(asInt(input.limit, 20), 1, 100);
        const all = Array.isArray(state.delegations) ? state.delegations : [];
        const pendingAll = pendingDelegations(state).length;
        const rows = all
          .filter((item) => (target.length > 0 ? item.to === target : (caller.id === null ? true : item.from === caller.id)))
          .filter((item) => status === 'all' || item.status === status)
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, limit);

        if (rows.length === 0) {
          const scope = target.length > 0 ? ` to ${target}` : (caller.id === null ? '' : ' from this session');
          return ok(`No delegation${scope} matches${status === 'all' ? '' : ` (status ${status})`}. ${String(all.length)} recorded in total, ${String(pendingAll)} pending. session_send with callback=true records one.`);
        }
        const lines = [`${String(rows.length)} delegation(s), newest first · ${String(pendingAll)} pending in total:`];
        for (const row of rows) {
          const age = row.createdAt > 0 ? `, ${String(Math.max(0, Math.round((Date.now() - row.createdAt) / 1000)))}s ago` : '';
          // `notified` is the durable "its callback notice was delivered" marker.
          // A settled row still showing `not notified` is one the watcher will
          // announce exactly once, which is what makes a missing callback
          // diagnosable without guessing.
          const notice = row.status === 'pending' ? '' : (row.notifiedAt > 0 ? ' · notified' : ' · not notified');
          lines.push(`- ${row.id} · to ${row.to} · ${row.status} (${row.mode}${age}${notice}) · task: ${row.task.length > 0 ? row.task : '(no text)'}`);
          if (row.reply.length > 0) lines.push(`    reply: ${clip(row.reply, 400)}`);
          // `askLog` is the durable ask record. `note` is overwritten when the
          // task settles, so anything written there would vanish; this field is
          // the only one that survives into history, and it is what makes a
          // question that was forwarded to you — and your answer to it — auditable.
          if (row.askLog.length > 0) for (const entry of row.askLog.split('\n')) lines.push(`    asked: ${entry}`);
          if (row.note.length > 0) lines.push(`    note: ${row.note}`);
        }
        lines.push('pending rows settle automatically once their target ends that turn; dismiss a row you are done with.');
        return ok(lines.join('\n'));
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

    const compactTool = {
      name: 'session_compact',
      description: 'Compact one live session\'s history right now, by running its own /compact command in that session\'s scope: the compactable span is replaced by a single summary node and the transaction is written to that session\'s log. This is the same operation the target\'s own /compact performs, so it needs a live (attached) agent that is idle — a session in the middle of a turn, one already compacting, or a cold session reports that instead of compacting. Compaction REWRITES what that session\'s model sees next, so report it plainly. The target\'s preset must compose compaction at all; a preset without it (for example `minimal`) has no /compact to run.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable session id, from session_list.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const caller = callerOf(exec);
        if (caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; compact your own session from your own UI instead of driving yourself.');
        }
        const { commands, agents, controller } = runtime();
        if (commands === undefined || commands === null || typeof commands.execute !== 'function') {
          return fail('The command registry is unavailable in this deployment, so no session can be asked to compact.');
        }

        // A command resolves through the target's OWN scoped registrations, so the
        // handler runs with that session's compaction engine, not this one. The
        // registry keys scoped commands by agent, hence the bare `{ id }` agent.
        const signal = new AbortController().signal;
        let execution;
        try {
          execution = await commands.execute({ id: sessionId }, '/compact', [], signal);
        } catch (error) {
          return fail(`Compacting ${sessionId} failed: ${messageOf(error)}`);
        }
        if (execution === undefined || execution === null) {
          let live = false;
          if (agents !== undefined && agents !== null && typeof agents.get === 'function') {
            try {
              live = agents.get(sessionId) !== undefined && agents.get(sessionId) !== null;
            } catch (error) {
              live = false;
            }
          } else if (controller !== null && controller !== undefined) {
            try {
              const listed = await controller.list({}, undefined);
              const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : [];
              live = items.some((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId);
            } catch (error) {
              live = false;
            }
          }
          return fail(live
            ? `No /compact command is registered for ${sessionId}: its preset does not compose compaction, so there is nothing to run.`
            : `No /compact command is registered for ${sessionId}: it has no attached agent (a cold session composes no commands). Open it once, or use session_send to wake it, and retry.`);
        }
        const result = execution.result;
        const text = result !== null && result !== undefined && typeof result.text === 'string' ? result.text : '(no result text)';
        if (result !== null && result !== undefined && result.kind === 'error') {
          return fail(`Compact refused for ${sessionId}: ${text}`);
        }
        return ok(`Compact ${sessionId}: ${text} That session's history is rewritten in place — its model now sees the summary instead of the folded span.`);
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

    const createTool = {
      name: 'session_create',
      description: "Create a brand-new top-level session in this DSH process — not a fork. A fork inherits the source session's history, preset and working directory; a create starts EMPTY, with its own preset and cwd, which is what you want for a fresh worker. Defaults: preset = the caller's own preset (or `standard` when the caller's is unknown), cwd = the caller's working directory. Pass `title` to name it up front, and provider+model to start it on a specific route. Returns the new session id; drive it with session_send.",
      parameters: {
        type: 'object',
        properties: {
          preset: { type: 'string', description: 'Agent preset id for the new session, e.g. "standard", "ptc", "minimal". Defaults to the caller\'s preset, else "standard".' },
          cwd: { type: 'string', description: 'Absolute working directory. Defaults to the caller\'s cwd. When it resolves to a registered workspace root, the session is attached to that workspace.' },
          title: { type: 'string', description: 'Optional title to set immediately (wakes the fresh session once to record it).' },
          provider: { type: 'string', description: 'Model provider for the new session; requires `model`.' },
          model: { type: 'string', description: 'Model id for the new session; requires `provider`.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort when a model is given.' },
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const controller = requireController();
        if (controller === null) return fail('sessionController is unavailable in this deployment; session management is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const requestedPreset = asString(input.preset).trim();
        const requestedCwd = asString(input.cwd).trim();
        const title = asString(input.title).trim();
        const provider = asString(input.provider).trim();
        const model = asString(input.model).trim();
        const reasoningEffort = asString(input.reasoningEffort).trim();
        if ((provider.length === 0) !== (model.length === 0)) {
          return fail('Pass both provider and model to start the session on a specific route, or neither.');
        }
        const caller = callerOf(exec);
        const cwd = requestedCwd.length > 0 ? requestedCwd : caller.cwd;
        const preset = requestedPreset.length > 0 ? requestedPreset : (caller.preset !== null ? caller.preset : 'standard');

        // `session.create` accepts workspaceId XOR cwd, and only the workspaceId
        // form ATTACHES the session to a workspace (the cwd form leaves it
        // unattached, visible only through its directory). So attach whenever the
        // requested cwd IS a registered workspace root; an arbitrary
        // subdirectory keeps its exact cwd instead.
        const { workspaces } = runtime();
        let workspace = null;
        if (cwd !== null && workspaces !== undefined && workspaces !== null && typeof workspaces.resolveByPath === 'function') {
          try {
            const found = await workspaces.resolveByPath(cwd);
            if (found !== undefined && found !== null && found.path === cwd && typeof found.id === 'string') workspace = found;
          } catch (error) {
            workspace = null;
          }
        }
        const request = { agentPreset: preset };
        if (workspace !== null) request.workspaceId = workspace.id;
        else if (cwd !== null) request.cwd = cwd;

        let created;
        try {
          created = await controller.create(request);
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'agent-preset/not-found' || code === 'agent-preset/invalid') hint = ' No session was created; check the preset id (the roster is in the mode picker, or in settings).';
          else if (code === 'workspace/not-found') hint = ' The workspace disappeared between lookup and creation.';
          return fail(`Creating a session failed: ${messageOf(error)}${hint}`);
        }
        const sessionId = created !== null && created !== undefined && typeof created.sessionId === 'string' ? created.sessionId : '';
        if (sessionId.length === 0) return fail('sessionController.create returned no session id; nothing to report.');
        const usedPreset = created !== null && created !== undefined && typeof created.agentPreset === 'string' ? created.agentPreset : preset;

        // A created session already has a live (idle) agent, so both of these only
        // widen what it will do — but they do resume it, which the report says.
        let titleNote = '';
        if (title.length > 0) {
          try {
            await controller.rename({ sessionId, title });
            titleNote = `, titled "${title}"`;
          } catch (error) {
            titleNote = `, title NOT set (${messageOf(error)})`;
          }
        }
        let modelNote = '';
        if (provider.length > 0 && model.length > 0) {
          try {
            await controller.selectModel({ sessionId, provider, model, ...(reasoningEffort.length === 0 ? {} : { reasoningEffort }) });
            modelNote = `, model ${provider}/${model}${reasoningEffort.length === 0 ? '' : ` (effort ${reasoningEffort})`}`;
          } catch (error) {
            modelNote = `, model NOT set (${messageOf(error)})`;
          }
        }

        // Record it in the durable store straight away, so the next listing
        // reports it even before any listing observes it.
        try {
          await observe([{ id: sessionId, parentId: null, kind: 'top-level', cwd: workspace !== null ? workspace.path : cwd, title: title.length > 0 ? title : null }]);
        } catch (error) {
          // A failed bookkeeping write must not hide the created session.
        }

        const where = workspace !== null
          ? `cwd ${workspace.path} (attached to workspace ${workspace.id})`
          : (cwd !== null ? `cwd ${cwd} (not attached to any workspace)` : 'the deployment default cwd');
        return ok(`Created ${sessionId}: brand-new top-level session, preset ${usedPreset}, ${where}${titleNote}${modelNote}. It starts with an empty history and a live idle agent. Drive it with session_send (add callback=true to be told when it finishes), and session_read/session_queue/session_stop/session_compact/session_model all work on it like any other session.`);
      },
    };

    const renameTool = {
      name: 'session_rename',
      description: "Read or set the TITLE of another session — the short label the GUI sidebar, session_list and every other agent see. Omit `title` to read the current one; pass `title` to set it. The title is stored in the session's own durable log as a `session/title` event, so it is visible everywhere, unlike session_describe's private note; the note and the title are independent. Setting a title PINS it: in-flight automatic title generation is superseded and later user messages schedule none, so the label you set stays yours. The host normalizes what you pass (control characters and ANSI escapes are stripped, runs of whitespace collapse to one space) and truncates it to its own byte budget, so the accepted title can be shorter than what you sent — the reply reports the title as ACCEPTED, which is the one now in effect. An empty or all-invisible title is refused: pass real text, and use session_describe with an empty string to clear the private note instead (a session's title can never be unset, only replaced). The target is resumed if it was cold.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          title: { type: 'string', description: 'New title. Omit the field entirely to read the current title instead of setting one. Must contain visible characters after the host normalizes it; one line, and keep it short — the host truncates it to a byte budget and reports what it accepted.' },
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

        // Read mode: omit `title` entirely. An empty string is a WRITE of an empty
        // title, which no session may hold, so the two must not be confused.
        if (typeof input.title !== 'string') {
          const current = await titleOf(controller, sessionId);
          if (current === null) {
            return ok(`Session ${sessionId} has no durable title yet (the host derives a display label from its directory instead). Pass a title to set one.`);
          }
          return ok(`session ${sessionId} title: ${current}\nThis is the title the GUI sidebar and session_list show for it. Pass title=... to replace it, or session_describe for a private note only this preset can see.`);
        }

        const requested = visibleTitleOf(input.title);
        if (requested.length === 0) {
          return fail('That title normalizes to nothing visible (it is only whitespace, control characters or invisible marks). A session title must carry visible characters and can never be unset — pass real text to set one, or omit `title` to read the current one.');
        }

        let accepted;
        try {
          accepted = await controller.rename({ sessionId, title: input.title });
        } catch (error) {
          const code = codeOf(error);
          let hint = '';
          if (code === 'session/title-invalid') hint = ' The host normalized that text to nothing visible; a session title must carry visible characters.';
          else if (code === 'session/not-found') hint = ' No persisted session has that id.';
          else if (code === 'session/agent-busy') hint = ' The target is owned by subagent routing (a subagent child); only its live parent session can rename it.';
          else if (code === 'gateway/internal' && messageOf(error).includes('session-title')) hint = ' This deployment mounts no session-title service, so no session can be renamed here.';
          return fail(`Renaming ${sessionId} failed: ${messageOf(error)}${hint}`);
        }

        // The host's answer, not our echo of the input: it normalized and
        // truncated the text, and only what it accepted is now in effect.
        const title = accepted !== null && accepted !== undefined && typeof accepted.title === 'string' && accepted.title.length > 0
          ? accepted.title
          : requested;
        const seq = accepted !== null && accepted !== undefined && typeof accepted.seq === 'number' && Number.isFinite(accepted.seq) ? accepted.seq : null;
        // Keep the durable record in step with what the log now says, so a
        // listing that runs before this session is observed again still reports
        // the new title. `setTitle` touches only that one field — `observe`
        // would also blank this session's lineage, which for a fork child would
        // silently reclassify it as top-level.
        try {
          await setTitle(sessionId, title);
        } catch (error) {
          // Bookkeeping is best-effort: the rename itself already landed.
        }
        return ok(
          `Renamed ${sessionId} to: ${title}${seq === null ? '' : ` (durable session/title event at seq ${String(seq)})`}. `
          + 'This title is now pinned: automatic title generation will not overwrite it, and later messages will not schedule one. '
          + 'It is visible in the GUI sidebar and to every other session — the private, only-this-preset note stays separate (session_describe).',
        );
      },
    };

    const describeTool = {
      name: 'session_describe',
      description: "Attach, change, or read a private note for one session — one short line saying what that session is FOR, or what you are waiting on from it. The note is NOT the session title: this preset stores it in its own file and never appends it to any session log, so the session list, the sidebar, the trajectory view and every other agent never see it. It is shown by this preset's session_list. Omit `description` to read the current note; pass an empty string to clear it.",
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
            : `Note for ${sessionId} set to: ${stored}${unknown} (persisted in ${statePath()})`);
        } catch (error) {
          return fail(`Writing the note failed: ${messageOf(error)}`);
        }
      },
    };

    const archiveTool = {
      name: 'session_archive',
      description: "Archive or unarchive one session through the running workspace registry: archive hides the session from every GUI workspace sidebar while keeping its log, records and position intact (nothing is deleted; unarchive restores it). This is the same registry path the sidebar's own Archive action uses, so it applies immediately and durably in the running process — no restart — and archive also clears that session's pin in the same write. Archive of an already-archived session is a no-op. Without stopActivity an archive is refused while the session has running work (a turn, subagent, job or reminder); pass stopActivity to let the registry stop that work and archive anyway. The target must be known to persistence or be live. Do not archive this conversation's own session id from inside it: with stopActivity that would end the current turn.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Durable target session id, from session_list.' },
          action: { type: 'string', enum: ['archive', 'unarchive'], description: 'archive hides the session from the workspace sidebar (default); unarchive shows it again, at its recorded position.' },
          stopActivity: { type: 'boolean', description: 'Only for action=archive: allow archiving a session with running work by stopping that work first (turn, subagent, job, reminder). Default false — a session with running activity is refused.' },
        },
        required: ['sessionId'],
      },
      output: OUTPUT,
      async execute(args, exec) {
        const workspaces = requireWorkspaces();
        if (workspaces === null) return fail('workspaceRegistry is unavailable in this deployment; archival is not possible here.');
        const input = args !== null && typeof args === 'object' ? args : {};
        const sessionId = asString(input.sessionId).trim();
        if (sessionId.length === 0) return fail('sessionId is required.');
        const action = asString(input.action).trim() === 'unarchive' ? 'unarchive' : 'archive';
        const stopActivity = input.stopActivity === true;
        const caller = callerOf(exec);
        if (action === 'archive' && caller.id !== null && caller.id === sessionId) {
          return fail('That is the caller itself; archiving your own session from inside it would end this conversation. Have a sibling coordinator session or the workspace UI archive it instead.');
        }
        try {
          if (action === 'archive') {
            await workspaces.archiveSession(sessionId, { stopActivity });
            const note = stopActivity ? ' Its running work was stopped so the archive could go through.' : '';
            return ok(`Archived ${sessionId}: it is hidden from the workspace sidebar; its log, records and position are kept.${note} Restore it with session_archive action=unarchive.`);
          }
          await workspaces.unarchiveSession(sessionId);
          return ok(`Unarchived ${sessionId}: it shows in the workspace sidebar again, at its recorded position.`);
        } catch (error) {
          const name = error !== null && typeof error === 'object' ? error.name : undefined;
          const message = messageOf(error);
          if (action === 'archive' && name === 'WorkspaceActiveSessionError') {
            return fail(`Archiving ${sessionId} was refused: the session has running activity and stopActivity was not set. Pass stopActivity to stop that work and archive anyway (${message}).`);
          }
          if (name === 'WorkspaceUnknownSessionError') {
            return fail(`Archiving ${sessionId} failed: no live or persisted session has that id (${message}).`);
          }
          if (action === 'unarchive') {
            return fail(`Unarchiving ${sessionId} failed: ${message}`);
          }
          return fail(`Archiving ${sessionId} failed: ${message}`);
        }
      },
    };

    const modelsTool = {
      name: 'session_models',
      description: 'List every model route this deployment can currently reach, grouped by provider, with each model\'s reasoning efforts. Use it to pick a valid provider/model pair for session_model. The catalog is advisory — membership never changes routing — and it reports providers whose discovery failed.',
      // Registered through the RAW `ctx.tools.register()` path, which forwards
      // `parameters` to the model API verbatim (it validates only the OUTPUT
      // schema). An empty `{}` is not a valid function schema: providers reject
      // it with `type must be "object", got "type: null"`. This tool takes no
      // arguments, so declare the empty object root explicitly.
      parameters: {
        type: 'object',
        properties: {},
      },
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
    ctx.tools.register(queueManageTool);
    ctx.tools.register(delegationsTool);
    ctx.tools.register(stopTool);
    ctx.tools.register(compactTool);
    ctx.tools.register(forkTool);
    ctx.tools.register(createTool);
    ctx.tools.register(renameTool);
    ctx.tools.register(describeTool);
    ctx.tools.register(archiveTool);
  },
};
