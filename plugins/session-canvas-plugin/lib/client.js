// Session Canvas — CLIENT half, as a real client plugin bundle.
//
// This file is a CLASSIC SCRIPT, not an ES module: it registers a factory with
// the harness's browser module loader, exactly like every shipped client bundle
// (`lib/client.js` of `@deepseek-ai/dsh-client-ui-*`). It is therefore written by
// hand rather than produced by a bundler — it uses only `React.createElement`,
// requires nothing but react, and pulls its data from the existing `session`
// Remote namespace.
//
// Note the shim: `window.__ModuleLoader__.load({ id, factory })`, where the
// factory returns a module whose named exports are the cordis plugin parts
// (`apply`, and optionally `inject`). A missing `client.js.map` is fine — the
// client module system treats source maps as optional.
window.__ModuleLoader__.load({
	id: '@local/dsh-session-canvas',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');

		const CANVAS_W = 1120;
		const CANVAS_H = 600;
		const NODE_W = 176;
		const NODE_H = 58;
		const COL_GAP = 30;
		const ROW_GAP = 104;
		const GROUP_PAD = 24;
		const GROUP_GAP = 44;
		const GROUP_LABEL_H = 24;
		const REFRESH_MS = 4000;
		const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif';

		/** Normalize one Remote `SessionSummary` into the flat record the layout wants. */
		const normalize = (item) => {
			const parentId = typeof item.parentSessionId === 'string' ? item.parentSessionId : null;
			const isSubagent = item.origin === 'subagent';
			let title = null;
			const projections = item.projections;
			if (projections !== null && projections !== undefined && typeof projections === 'object') {
				const values = projections.values;
				if (values !== null && values !== undefined && typeof values === 'object' && typeof values.title === 'string' && values.title.length > 0) title = values.title;
			}
			return {
				id: String(item.sessionId),
				title: title,
				cwd: typeof item.cwd === 'string' ? item.cwd : null,
				running: item.running === true,
				isSubagent: isSubagent,
				isFork: !isSubagent && parentId !== null,
				parentId: parentId,
				updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
			};
		};

		const buildLayout = (sessions) => {
			const byId = new Map();
			for (const session of sessions) byId.set(session.id, session);
			const groups = new Map();
			for (const session of sessions) {
				const key = typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : '(no working directory)';
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key).push(session);
			}
			const nodes = [];
			const edges = [];
			const boxes = [];
			const keys = Array.from(groups.keys()).sort();
			let top = 28;
			for (const key of keys) {
				const members = groups.get(key);
				const memberIds = new Set(members.map((session) => session.id));
				const rows = [];
				for (const session of members) {
					let depth = 0;
					let cursor = session;
					const seen = new Set([session.id]);
					while (typeof cursor.parentId === 'string' && memberIds.has(cursor.parentId) && !seen.has(cursor.parentId)) {
						seen.add(cursor.parentId);
						const parent = byId.get(cursor.parentId);
						if (parent === undefined) break;
						cursor = parent;
						depth += 1;
						if (depth > 10) break;
					}
					while (rows.length <= depth) rows.push([]);
					rows[depth].push(session);
				}
				for (const row of rows) row.sort((left, right) => right.updatedAt - left.updatedAt);
				let widest = 1;
				for (const row of rows) if (row.length > widest) widest = row.length;
				const boxW = widest * NODE_W + (widest - 1) * COL_GAP + GROUP_PAD * 2;
				const boxH = rows.length * NODE_H + (rows.length - 1) * ROW_GAP + GROUP_PAD * 2 + GROUP_LABEL_H;
				for (let index = 0; index < rows.length; index++) {
					const row = rows[index];
					const rowW = row.length * NODE_W + (row.length - 1) * COL_GAP;
					const startX = GROUP_PAD + (boxW - GROUP_PAD * 2 - rowW) / 2;
					for (let slot = 0; slot < row.length; slot++) {
						nodes.push({
							id: row[slot].id,
							x: startX + slot * (NODE_W + COL_GAP),
							y: top + GROUP_PAD + GROUP_LABEL_H + index * (NODE_H + ROW_GAP),
							w: NODE_W,
							h: NODE_H,
							session: row[slot],
						});
					}
				}
				boxes.push({ key: key, x: 0, y: top, w: boxW, h: boxH, count: members.length });
				top += boxH + GROUP_GAP;
			}
			const nodeById = new Map();
			for (const node of nodes) nodeById.set(node.id, node);
			for (const node of nodes) {
				if (typeof node.session.parentId !== 'string') continue;
				const parent = nodeById.get(node.session.parentId);
				if (parent === undefined) continue;
				edges.push({ from: parent, to: node });
			}
			let width = 360;
			for (const box of boxes) if (box.w > width) width = box.w;
			return { nodes: nodes, edges: edges, boxes: boxes, width: width, height: Math.max(top - GROUP_GAP + 28, 220) };
		};

		const fitView = (layout) => {
			if (layout === null || layout.nodes.length === 0) return { scale: 1, x: 0, y: 0 };
			const scale = Math.max(0.32, Math.min(1, Math.min((CANVAS_W - 56) / layout.width, (CANVAS_H - 40) / layout.height)));
			return { scale: scale, x: (CANVAS_W - layout.width * scale) / 2, y: (CANVAS_H - layout.height * scale) / 2 };
		};

		const roundRect = (context, x, y, width, height, radius) => {
			const r = Math.max(0, Math.min(radius, width / 2, height / 2));
			context.beginPath();
			context.moveTo(x + r, y);
			context.lineTo(x + width - r, y);
			context.quadraticCurveTo(x + width, y, x + width, y + r);
			context.lineTo(x + width, y + height - r);
			context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
			context.lineTo(x + r, y + height);
			context.quadraticCurveTo(x, y + height, x, y + height - r);
			context.lineTo(x, y + r);
			context.quadraticCurveTo(x, y, x + r, y);
			context.closePath();
		};
		const fitText = (context, text, maxWidth) => {
			if (context.measureText(text).width <= maxWidth) return text;
			let low = 0;
			let high = text.length;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (context.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid;
				else high = mid - 1;
			}
			return low <= 0 ? '…' : text.slice(0, low) + '…';
		};
		const shortId = (id) => (typeof id === 'string' && id.length > 10 ? '…' + id.slice(id.length - 8) : String(id));
		const titleOf = (session) => (typeof session.title === 'string' && session.title.length > 0 ? session.title : '(untitled)');
		const lineageOf = (session) => {
			if (session.isSubagent) return 'subagent';
			if (session.isFork) return 'fork';
			return 'top-level';
		};

		/** Whether `cwd` names `root` itself or a directory strictly below it. */
		const trimTail = (path) => (path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path);
		const underRoot = (cwd, root) => {
			if (typeof cwd !== 'string' || cwd.length === 0) return false;
			if (typeof root !== 'string' || root.length === 0) return false;
			const left = trimTail(cwd);
			const right = trimTail(root);
			if (left === right) return true;
			return left.startsWith(right === '/' ? '/' : right + '/');
		};

		/**
		* The Workspace row accounting for `sessionId`, exactly as the shipped
		* sidebar derives it (`workspace.items.find(item => item.sessionIds
		* .includes(current))`), extended to walk up fork/subagent ancestors so the
		* canvas also scopes correctly while a child session is the open one.
		*/
		const workspaceOf = (items, sessionId, sessions) => {
			if (!Array.isArray(items) || typeof sessionId !== 'string' || sessionId.length === 0) return null;
			const byId = new Map();
			if (Array.isArray(sessions)) for (const session of sessions) byId.set(session.id, session);
			const seen = new Set();
			let cursor = sessionId;
			for (let hop = 0; hop < 12; hop++) {
				if (typeof cursor !== 'string' || cursor.length === 0 || seen.has(cursor)) return null;
				seen.add(cursor);
				for (const item of items) {
					if (item !== null && typeof item === 'object' && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(cursor) !== -1) return item;
				}
				const summary = byId.get(cursor);
				cursor = summary !== undefined && typeof summary.parentId === 'string' ? summary.parentId : null;
			}
			return null;
		};

		/**
		* Restrict the canonical session list to one Workspace: sessions the
		* Workspace accounts for, sessions whose `cwd` sits under its path (which is
		* how a subagent started in a subdirectory stays attached), and every
		* descendant of an already kept session.
		*/
		const scopeToWorkspace = (sessions, workspace, currentId) => {
			const byId = new Map();
			for (const session of sessions) byId.set(session.id, session);
			const accounted = new Set();
			let root = null;
			if (workspace !== null && workspace !== undefined && typeof workspace === 'object') {
				if (Array.isArray(workspace.sessionIds)) for (const id of workspace.sessionIds) accounted.add(String(id));
				if (typeof workspace.path === 'string' && workspace.path.length > 0) root = workspace.path;
			}
			if (root === null && typeof currentId === 'string' && byId.has(currentId)) {
				const anchor = byId.get(currentId);
				if (typeof anchor.cwd === 'string' && anchor.cwd.length > 0) root = anchor.cwd;
			}
			if (accounted.size === 0 && root === null) return [];
			const keep = new Set();
			for (const session of sessions) {
				if (accounted.has(session.id) || underRoot(session.cwd, root)) keep.add(session.id);
			}
			let grew = true;
			while (grew) {
				grew = false;
				for (const session of sessions) {
					if (keep.has(session.id)) continue;
					if (typeof session.parentId === 'string' && keep.has(session.parentId)) {
						keep.add(session.id);
						grew = true;
					}
				}
			}
			return sessions.filter((session) => keep.has(session.id));
		};

		const drawScene = (canvas, layout, view, selectedId, currentId, emptyText) => {
			if (canvas === null || canvas === undefined || typeof canvas.getContext !== 'function') return;
			const context = canvas.getContext('2d');
			if (context === null || context === undefined) return;
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.fillStyle = '#0d1017';
			context.fillRect(0, 0, CANVAS_W, CANVAS_H);
			context.fillStyle = '#161d2a';
			for (let gx = 14; gx < CANVAS_W; gx += 28) {
				for (let gy = 14; gy < CANVAS_H; gy += 28) context.fillRect(gx, gy, 1.5, 1.5);
			}
			if (layout === null || layout.nodes.length === 0) {
				context.font = '500 13px ' + FONT;
				context.fillStyle = '#5d6577';
				context.fillText(layout === null ? 'loading sessions…' : (typeof emptyText === 'string' && emptyText.length > 0 ? emptyText : 'no sessions to draw'), 40, 56);
				return;
			}

			context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
			context.font = '500 12px ' + FONT;
			for (const box of layout.boxes) {
				roundRect(context, box.x, box.y, box.w, box.h, 14);
				context.fillStyle = 'rgba(255,255,255,0.022)';
				context.fill();
				context.lineWidth = 1;
				context.strokeStyle = '#232c3d';
				context.stroke();
				context.fillStyle = '#7e879c';
				context.fillText(fitText(context, box.key, box.w - 100), box.x + 14, box.y + 17);
				const countLabel = String(box.count) + (box.count === 1 ? ' session' : ' sessions');
				context.fillStyle = '#5c657a';
				context.fillText(countLabel, box.x + box.w - 14 - context.measureText(countLabel).width, box.y + 17);
			}

			for (const edge of layout.edges) {
				const x1 = edge.from.x + edge.from.w / 2;
				const y1 = edge.from.y + edge.from.h;
				const x2 = edge.to.x + edge.to.w / 2;
				const y2 = edge.to.y;
				context.beginPath();
				context.moveTo(x1, y1);
				context.bezierCurveTo(x1, y1 + 44, x2, y2 - 44, x2, y2);
				context.lineWidth = 1.6;
				context.strokeStyle = '#31405c';
				context.stroke();
				context.beginPath();
				context.arc(x2, y2, 2.6, 0, Math.PI * 2);
				context.fillStyle = '#41537a';
				context.fill();
			}

			for (const node of layout.nodes) {
				const session = node.session;
				const isCurrent = currentId !== null && currentId !== undefined && session.id === currentId;
				const isSelected = selectedId !== null && selectedId !== undefined && session.id === selectedId;
				const running = session.running === true;
				roundRect(context, node.x, node.y, node.w, node.h, 12);
				context.fillStyle = session.isSubagent ? '#1a2231' : (session.isFork ? '#1b2333' : '#151c27');
				context.fill();
				context.lineWidth = isSelected ? 2.4 : (isCurrent ? 2.2 : 1.4);
				context.strokeStyle = isCurrent ? '#ffd166' : (isSelected ? '#4da3ff' : (running ? '#3ddc84' : '#2a3346'));
				context.stroke();
				context.beginPath();
				context.arc(node.x + 16, node.y + 19, 4, 0, Math.PI * 2);
				context.fillStyle = running ? '#3ddc84' : '#59627a';
				context.fill();
				context.font = '600 13px ' + FONT;
				context.fillStyle = '#e7ebf3';
				context.fillText(fitText(context, titleOf(session), node.w - (isCurrent ? 74 : 34)), node.x + 28, node.y + 24);
				context.font = '400 11px ' + FONT;
				context.fillStyle = '#79829a';
				const meta = shortId(session.id) + ' · ' + lineageOf(session) + (running ? ' · running' : '');
				context.fillText(fitText(context, meta, node.w - 28), node.x + 14, node.y + 44);
				if (isCurrent) {
					context.font = '600 10px ' + FONT;
					context.fillStyle = '#ffd166';
					const badge = 'current';
					context.fillText(badge, node.x + node.w - 12 - context.measureText(badge).width, node.y + 20);
				}
			}

			context.setTransform(1, 0, 0, 1, 0, 0);
			context.font = '400 11px ' + FONT;
			const legend = [
				{ color: '#3ddc84', label: 'running' },
				{ color: '#2a3346', label: 'idle' },
				{ color: '#ffd166', label: 'current session' },
				{ color: '#4da3ff', label: 'selected' },
				{ color: '#1a2231', label: 'subagent child' },
				{ color: '#1b2333', label: 'fork' },
			];
			let cursorX = 20;
			for (const item of legend) {
				context.fillStyle = item.color;
				context.strokeStyle = '#2a3346';
				context.lineWidth = 1;
				context.fillRect(cursorX, CANVAS_H - 27, 10, 10);
				context.strokeRect(cursorX, CANVAS_H - 27, 10, 10);
				context.fillStyle = '#79829a';
				context.fillText(item.label, cursorX + 16, CANVAS_H - 18);
				cursorX += 30 + context.measureText(item.label).width + 14;
			}
		};

		const pointOf = (event) => {
			const native = event !== null && event !== undefined && event.nativeEvent !== undefined && event.nativeEvent !== null ? event.nativeEvent : event;
			return {
				x: native !== null && native !== undefined && typeof native.offsetX === 'number' ? native.offsetX : 0,
				y: native !== null && native !== undefined && typeof native.offsetY === 'number' ? native.offsetY : 0,
			};
		};
		const hitTest = (layout, view, px, py) => {
			if (layout === null) return null;
			const wx = (px - view.x) / view.scale;
			const wy = (py - view.y) / view.scale;
			for (let index = layout.nodes.length - 1; index >= 0; index--) {
				const node = layout.nodes[index];
				if (wx >= node.x && wx <= node.x + node.w && wy >= node.y && wy <= node.y + node.h) return node;
			}
			return null;
		};

		const overlayWrapStyle = { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 60 };
		const panelStyle = { pointerEvents: 'auto', width: String(CANVAS_W + 2) + 'px', maxWidth: '97vw', maxHeight: '92vh', overflow: 'auto', background: '#0d1017', border: '1px solid #263043', borderRadius: '14px', boxShadow: '0 26px 70px rgba(0,0,0,0.62)', color: '#e7ebf3', fontFamily: FONT };
		const headerStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '14px 16px 10px 16px' };
		const toolbarStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 16px 12px 16px', borderBottom: '1px solid #1c2331' };
		const buttonStyle = (active) => ({ height: '28px', padding: '0 11px', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontFamily: FONT, color: active ? '#cfe4ff' : '#9aa4b8', background: active ? 'rgba(77,163,255,0.18)' : 'rgba(255,255,255,0.04)', border: '1px solid ' + (active ? 'rgba(77,163,255,0.5)' : '#242c3c') });
		const closeStyle = { height: '28px', width: '28px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px', color: '#9aa4b8', background: 'rgba(255,255,255,0.04)', border: '1px solid #242c3c', fontFamily: FONT };
		const detailsStyle = { minHeight: '42px', display: 'flex', alignItems: 'center', padding: '10px 16px 12px 16px', borderTop: '1px solid #1c2331', fontSize: '12px' };
		const mutedStyle = { color: '#79829a' };

		/** Build every component and register both slots. Runs once the client `slots` service exists. */
		const install = (ctx, sessionApi) => {
			let openState = true;
			const openListeners = new Set();
			const setOpen = (next) => {
				openState = next;
				for (const listener of Array.from(openListeners)) listener(openState);
			};
			const useOpen = () => {
				const pair = React.useState(openState);
				const value = pair[0];
				const setValue = pair[1];
				React.useEffect(() => {
					openListeners.add(setValue);
					setValue(openState);
					return () => { openListeners.delete(setValue); };
				}, []);
				return value;
			};
			const useCurrentId = (useSessions) => (typeof useSessions === 'function' ? useSessions((state) => state.current) : null);

			/** One `session.list` round trip through the existing Remote namespace. */
			const fetchSessions = async () => {
				const namespace = sessionApi;
				if (namespace === null || namespace === undefined || typeof namespace.list !== 'function') {
					throw new Error('the session Remote namespace is unavailable');
				}
				const reply = await namespace.list({});
				if (reply !== null && reply !== undefined && typeof reply === 'object' && reply.ok === false) {
					const detail = reply.error !== null && reply.error !== undefined && typeof reply.error.message === 'string' ? reply.error.message : 'request refused';
					throw new Error(detail);
				}
				const value = reply !== null && reply !== undefined && typeof reply === 'object' && reply.ok === true ? reply.value : reply;
				const items = value !== null && value !== undefined && typeof value === 'object' && Array.isArray(value.items) ? value.items : null;
				if (items === null) throw new Error('unexpected reply from session.list');
				return items;
			};

			function SessionCanvas(props) {
				const currentId = useCurrentId(props.useSessions);
				// Standard prop of the `shell.overlay` seat: the Workspace projection.
				// `items` is a stable array reference, so the selector snapshot stays
				// comparable; the matching row is then resolved by session membership.
				const workspaceItems = typeof props.useWorkspaces === 'function'
					? props.useWorkspaces((state) => (state !== null && state !== undefined && Array.isArray(state.items) ? state.items : null))
					: null;
				const dataPair = React.useState(null);
				const data = dataPair[0];
				const setData = dataPair[1];
				const statusPair = React.useState('loading');
				const status = statusPair[0];
				const setStatus = statusPair[1];
				const selectedPair = React.useState(null);
				const selectedId = selectedPair[0];
				const setSelectedId = selectedPair[1];
				const viewPair = React.useState({ scale: 1, x: 0, y: 0 });
				const view = viewPair[0];
				const setView = viewPair[1];
				const dragPair = React.useState(null);
				const drag = dragPair[0];
				const setDrag = dragPair[1];
				const holderPair = React.useState(() => ({ el: null }));
				const holder = holderPair[0];
				const viewKeyHolder = React.useState(() => ({ key: null }))[0];

				const refresh = () => {
					fetchSessions().then((items) => {
						setData(items.map(normalize));
						setStatus('ready');
					}).catch((error) => {
						setStatus('error: ' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)));
					});
				};

				React.useEffect(() => {
					refresh();
					const handle = setInterval(refresh, REFRESH_MS);
					return () => { clearInterval(handle); };
				}, []);

				// The canvas is workspace-scoped: only the Workspace that accounts for
				// the current Session is drawn, so one process serving several projects
				// never mixes their graphs.
				const workspace = workspaceOf(workspaceItems, currentId, data);
				const visible = data === null ? [] : scopeToWorkspace(data, workspace, currentId);
				const layout = data === null ? null : buildLayout(visible);
				const workspaceLabel = workspace === null
					? '（未识别）'
					: (typeof workspace.title === 'string' && workspace.title.length > 0
						? workspace.title
						: (typeof workspace.path === 'string' && workspace.path.length > 0 ? workspace.path : '（未命名）'));
				const emptyLabel = workspace === null
					? '无法确定当前工作区：没有当前会话，或该会话未归入任何工作区'
					: '当前工作区没有可绘制的会话';
				const nextViewKey = (data === null ? 0 : visible.length) + ':' + String(currentId);
				React.useEffect(() => {
					if (viewKeyHolder.key === nextViewKey) return;
					viewKeyHolder.key = nextViewKey;
					setView(fitView(layout));
				}, [nextViewKey]);
				React.useEffect(() => { drawScene(holder.el, layout, view, selectedId, currentId, emptyLabel); });

				const zoomBy = (factor) => {
					const nextScale = Math.max(0.32, Math.min(2.4, view.scale * factor));
					const ratio = nextScale / view.scale;
					setView({ scale: nextScale, x: CANVAS_W / 2 - (CANVAS_W / 2 - view.x) * ratio, y: CANVAS_H / 2 - (CANVAS_H / 2 - view.y) * ratio });
				};
				const onMouseDown = (event) => {
					const point = pointOf(event);
					setDrag({ px: point.x, py: point.y, x: view.x, y: view.y });
				};
				const onMouseMove = (event) => {
					if (drag === null) return;
					const point = pointOf(event);
					setView({ scale: view.scale, x: drag.x + (point.x - drag.px), y: drag.y + (point.y - drag.py) });
				};
				const onMouseUp = (event) => {
					const point = pointOf(event);
					if (drag !== null) {
						const moved = Math.abs(point.x - drag.px) + Math.abs(point.y - drag.py);
						if (moved < 5) {
							const hit = hitTest(layout, view, point.x, point.y);
							setSelectedId(hit === null ? null : hit.id);
						}
					}
					setDrag(null);
				};
				const onMouseLeave = () => { setDrag(null); };

				let selected = null;
				if (selectedId !== null && data !== null) {
					for (const session of data) if (session.id === selectedId) selected = session;
				}

				const header = React.createElement('div', { style: headerStyle },
					React.createElement('div', null,
						React.createElement('div', { style: { fontSize: '14px', fontWeight: 600, color: '#e7ebf3' } }, 'Session Canvas'),
						React.createElement('div', { style: { fontSize: '11.5px', color: '#7e879c', marginTop: '3px' } },
							'当前工作区 ' + workspaceLabel + ' · ' + status + ' · 会话 ' + String(visible.length))
					),
					React.createElement('button', { type: 'button', 'aria-label': '关闭', title: '关闭', onClick: () => setOpen(false), style: closeStyle }, '✕')
				);

				const toolbar = React.createElement('div', { style: toolbarStyle },
					React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: refresh }, '刷新'),
					React.createElement('span', { style: { fontSize: '11.5px', color: '#7e879c' } }, '仅当前工作区'),
					React.createElement('span', { style: { flex: '1' } }),
					React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => zoomBy(0.85) }, '−'),
					React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => zoomBy(1.18) }, '+'),
					React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => setView(fitView(layout)) }, '适应')
				);

				const canvas = React.createElement('canvas', {
					ref: (element) => { holder.el = element; },
					width: CANVAS_W,
					height: CANVAS_H,
					onMouseDown: onMouseDown,
					onMouseMove: onMouseMove,
					onMouseUp: onMouseUp,
					onMouseLeave: onMouseLeave,
					style: { display: 'block', width: String(CANVAS_W) + 'px', height: String(CANVAS_H) + 'px', cursor: drag === null ? 'grab' : 'grabbing', touchAction: 'none' },
				});

				const details = React.createElement('div', { style: detailsStyle },
					selected === null
						? React.createElement('span', { style: mutedStyle }, '点击任意节点查看详情 · 拖拽画布平移')
						: React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '14px' } },
							React.createElement('span', { style: { color: '#e7ebf3', fontWeight: 600 } }, titleOf(selected)),
							React.createElement('span', { style: mutedStyle }, shortId(selected.id)),
							React.createElement('span', { style: mutedStyle }, 'cwd ' + (selected.cwd === null ? '(none)' : selected.cwd)),
							React.createElement('span', { style: mutedStyle }, selected.running ? 'running' : 'idle'),
							React.createElement('span', { style: mutedStyle }, selected.isSubagent ? 'subagent child of ' + String(selected.parentId) : (selected.isFork ? 'fork of ' + String(selected.parentId) : 'top-level session'))
						)
				);

				return React.createElement('div', { style: overlayWrapStyle },
					React.createElement('div', { style: panelStyle }, header, toolbar, canvas, details)
				);
			}

			function CanvasOverlay(props) {
				const open = useOpen();
				if (!open) return null;
				return React.createElement(SessionCanvas, props);
			}

			function FooterButton(props) {
				const open = useOpen();
				const wide = props.wide === true;
				const icon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
					React.createElement('path', { d: 'M4 12V6.5M8 12V3.5M12 12V8.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
					React.createElement('circle', { cx: 4, cy: 12, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 }),
					React.createElement('circle', { cx: 8, cy: 3.5, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 }),
					React.createElement('circle', { cx: 12, cy: 8.5, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 })
				);
				return React.createElement('button', {
					type: 'button',
					title: 'Session Canvas',
					'aria-label': 'Session Canvas',
					onClick: () => setOpen(!open),
					style: {
						display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
						height: '32px', width: wide ? 'auto' : '32px', padding: wide ? '0 10px' : '0',
						border: '1px solid transparent', borderRadius: '8px', cursor: 'pointer', font: 'inherit', fontSize: '13px',
						background: open ? 'rgba(77,163,255,0.18)' : 'transparent', color: 'inherit',
					},
				}, icon, wide ? React.createElement('span', null, 'Session Canvas') : null);
			}

			const slots = ctx.get('slots');
			slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'session-canvas', order: 20 }, CanvasOverlay));
			slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'session-canvas', order: 20 }, FooterButton));
		};

		const apply = (ctx) => {
			// `remote.session` is a Remote namespace MOUNTED as its own Cordis service
			// (see `ctx.remote.$mount`), not an ordinary property of the `remote`
			// service. Reading it without declaring it is rejected by the Cordis
			// guard: cannot get property "remote.session" without inject. So the
			// namespace is resolved here, where the declared injection is in scope.
			const sessionApi = ctx.remote.session;
			ctx.inject(['slots'], (scoped) => { install(scoped, sessionApi); });
		};

		exports.apply = apply;
		// Hard dependencies of this client half: the Remote service, the session
		// namespace mounted onto it, and the Slot registry. Cordis parks the plugin
		// until each one exists, so `ctx.remote.session` above cannot read undefined.
		exports.inject = ['remote', 'remote.session', 'slots'];
		return module.exports;
	},
});
