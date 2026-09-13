// Session Canvas — dynamic Cordis package, CLIENT half.
//
// This file is NOT an ES module: the whole file IS the function body you pass as
// `code.client` to the cordis_define tool. It is evaluated in the browser sandbox,
// where `ctx`, `React`, `host`, `styles`, and `console` are provided — no JSX, no
// imports, no bundler. Every element is React.createElement(...).
//
// Exported from a live DSH process:
//   plugin scanv-7 / package pkg-12 / run-29
//
// It occupies two slots: `shell.overlay` (the canvas panel) and
// `sidebar.footer.action` (the toggle button beside Settings). Unlike the host
// half it DOES need user approval before it activates, because it runs in the page.
//
// Differences from the exported pkg-12 instance: fork lineage is labeled
// correctly (pkg-12's host half folds every `parentSession` row into
// "subagent child"; a fork carries `parentSession` too). Nothing else changed.
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) {
      console.error('session-canvas: slots service is unavailable')
      return
    }
    const timer = ctx.get('timer')

    const CANVAS_W = 1120
    const CANVAS_H = 600
    const NODE_W = 176
    const NODE_H = 58
    const COL_GAP = 30
    const ROW_GAP = 104
    const GROUP_PAD = 24
    const GROUP_GAP = 44
    const GROUP_LABEL_H = 24
    const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif'

    // ---- shared open/closed state across both slot occupants ----
    let openState = true
    const openListeners = new Set()
    const setOpen = (next) => {
      openState = next
      for (const listener of Array.from(openListeners)) listener(openState)
    }
    const useOpen = () => {
      const pair = React.useState(openState)
      const value = pair[0]
      const setValue = pair[1]
      React.useEffect(() => {
        openListeners.add(setValue)
        setValue(openState)
        return () => { openListeners.delete(setValue) }
      }, [])
      return value
    }
    const useCurrentId = (useSessions) => (typeof useSessions === 'function' ? useSessions((state) => state.current) : null)

    // ---- layout ----
    const buildLayout = (sessions) => {
      const byId = new Map()
      for (const session of sessions) byId.set(session.id, session)
      const groups = new Map()
      for (const session of sessions) {
        const key = typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : '(no working directory)'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(session)
      }
      const nodes = []
      const edges = []
      const boxes = []
      const keys = Array.from(groups.keys()).sort()
      let top = 28
      for (const key of keys) {
        const members = groups.get(key)
        const memberIds = new Set(members.map((session) => session.id))
        const rows = []
        for (const session of members) {
          let depth = 0
          let cursor = session
          const seen = new Set([session.id])
          while (typeof cursor.parentId === 'string' && memberIds.has(cursor.parentId) && !seen.has(cursor.parentId)) {
            seen.add(cursor.parentId)
            const parent = byId.get(cursor.parentId)
            if (parent === undefined) break
            cursor = parent
            depth += 1
            if (depth > 10) break
          }
          while (rows.length <= depth) rows.push([])
          rows[depth].push(session)
        }
        for (const row of rows) row.sort((left, right) => right.updatedAt - left.updatedAt)
        let widest = 1
        for (const row of rows) if (row.length > widest) widest = row.length
        const boxW = widest * NODE_W + (widest - 1) * COL_GAP + GROUP_PAD * 2
        const boxH = rows.length * NODE_H + (rows.length - 1) * ROW_GAP + GROUP_PAD * 2 + GROUP_LABEL_H
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]
          const rowW = row.length * NODE_W + (row.length - 1) * COL_GAP
          const startX = GROUP_PAD + (boxW - GROUP_PAD * 2 - rowW) / 2
          for (let slot = 0; slot < row.length; slot++) {
            nodes.push({
              id: row[slot].id,
              x: startX + slot * (NODE_W + COL_GAP),
              y: top + GROUP_PAD + GROUP_LABEL_H + index * (NODE_H + ROW_GAP),
              w: NODE_W,
              h: NODE_H,
              session: row[slot],
            })
          }
        }
        boxes.push({ key: key, x: 0, y: top, w: boxW, h: boxH, count: members.length })
        top += boxH + GROUP_GAP
      }
      const nodeById = new Map()
      for (const node of nodes) nodeById.set(node.id, node)
      for (const node of nodes) {
        if (typeof node.session.parentId !== 'string') continue
        const parent = nodeById.get(node.session.parentId)
        if (parent === undefined) continue
        edges.push({ from: parent, to: node })
      }
      let width = 360
      for (const box of boxes) if (box.w > width) width = box.w
      return { nodes: nodes, edges: edges, boxes: boxes, width: width, height: Math.max(top - GROUP_GAP + 28, 220) }
    }

    const fitView = (layout) => {
      if (layout === null || layout.nodes.length === 0) return { scale: 1, x: 0, y: 0 }
      const scale = Math.max(0.32, Math.min(1, Math.min((CANVAS_W - 56) / layout.width, (CANVAS_H - 40) / layout.height)))
      return { scale: scale, x: (CANVAS_W - layout.width * scale) / 2, y: (CANVAS_H - layout.height * scale) / 2 }
    }

    const roundRect = (context, x, y, width, height, radius) => {
      const r = Math.max(0, Math.min(radius, width / 2, height / 2))
      context.beginPath()
      context.moveTo(x + r, y)
      context.lineTo(x + width - r, y)
      context.quadraticCurveTo(x + width, y, x + width, y + r)
      context.lineTo(x + width, y + height - r)
      context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
      context.lineTo(x + r, y + height)
      context.quadraticCurveTo(x, y + height, x, y + height - r)
      context.lineTo(x, y + r)
      context.quadraticCurveTo(x, y, x + r, y)
      context.closePath()
    }
    const fitText = (context, text, maxWidth) => {
      if (context.measureText(text).width <= maxWidth) return text
      let low = 0
      let high = text.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (context.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid
        else high = mid - 1
      }
      return low <= 0 ? '…' : text.slice(0, low) + '…'
    }
    const shortId = (id) => (typeof id === 'string' && id.length > 10 ? '…' + id.slice(id.length - 8) : String(id))
    const titleOf = (session) => (typeof session.title === 'string' && session.title.length > 0 ? session.title : '(untitled)')
    const lineageOf = (session) => {
      if (session.isSubagent) return 'subagent'
      if (session.isFork) return 'fork'
      return 'top-level'
    }

    const drawScene = (canvas, layout, view, selectedId, currentId) => {
      if (canvas === null || canvas === undefined || typeof canvas.getContext !== 'function') return
      const context = canvas.getContext('2d')
      if (context === null || context === undefined) return
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.fillStyle = '#0d1017'
      context.fillRect(0, 0, CANVAS_W, CANVAS_H)
      context.fillStyle = '#161d2a'
      for (let gx = 14; gx < CANVAS_W; gx += 28) {
        for (let gy = 14; gy < CANVAS_H; gy += 28) context.fillRect(gx, gy, 1.5, 1.5)
      }
      if (layout === null || layout.nodes.length === 0) {
        context.font = '500 13px ' + FONT
        context.fillStyle = '#5d6577'
        context.fillText(layout === null ? 'loading sessions…' : 'no sessions to draw', 40, 56)
        return
      }

      context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y)
      context.font = '500 12px ' + FONT
      for (const box of layout.boxes) {
        roundRect(context, box.x, box.y, box.w, box.h, 14)
        context.fillStyle = 'rgba(255,255,255,0.022)'
        context.fill()
        context.lineWidth = 1
        context.strokeStyle = '#232c3d'
        context.stroke()
        context.fillStyle = '#7e879c'
        context.fillText(fitText(context, box.key, box.w - 100), box.x + 14, box.y + 17)
        const countLabel = String(box.count) + (box.count === 1 ? ' session' : ' sessions')
        context.fillStyle = '#5c657a'
        context.fillText(countLabel, box.x + box.w - 14 - context.measureText(countLabel).width, box.y + 17)
      }

      for (const edge of layout.edges) {
        const x1 = edge.from.x + edge.from.w / 2
        const y1 = edge.from.y + edge.from.h
        const x2 = edge.to.x + edge.to.w / 2
        const y2 = edge.to.y
        context.beginPath()
        context.moveTo(x1, y1)
        context.bezierCurveTo(x1, y1 + 44, x2, y2 - 44, x2, y2)
        context.lineWidth = 1.6
        context.strokeStyle = '#31405c'
        context.stroke()
        context.beginPath()
        context.arc(x2, y2, 2.6, 0, Math.PI * 2)
        context.fillStyle = '#41537a'
        context.fill()
      }

      for (const node of layout.nodes) {
        const session = node.session
        const isCurrent = currentId !== null && currentId !== undefined && session.id === currentId
        const isSelected = selectedId !== null && selectedId !== undefined && session.id === selectedId
        const running = session.running === true
        roundRect(context, node.x, node.y, node.w, node.h, 12)
        context.fillStyle = session.isSubagent ? '#1a2231' : (session.isFork ? '#1b2333' : '#151c27')
        context.fill()
        context.lineWidth = isSelected ? 2.4 : (isCurrent ? 2.2 : 1.4)
        context.strokeStyle = isCurrent ? '#ffd166' : (isSelected ? '#4da3ff' : (running ? '#3ddc84' : '#2a3346'))
        context.stroke()
        context.beginPath()
        context.arc(node.x + 16, node.y + 19, 4, 0, Math.PI * 2)
        context.fillStyle = running ? '#3ddc84' : '#59627a'
        context.fill()
        context.font = '600 13px ' + FONT
        context.fillStyle = '#e7ebf3'
        context.fillText(fitText(context, titleOf(session), node.w - (isCurrent ? 74 : 34)), node.x + 28, node.y + 24)
        context.font = '400 11px ' + FONT
        context.fillStyle = '#79829a'
        const meta = shortId(session.id) + ' · ' + lineageOf(session) + (running ? ' · running' : '')
        context.fillText(fitText(context, meta, node.w - 28), node.x + 14, node.y + 44)
        if (isCurrent) {
          context.font = '600 10px ' + FONT
          context.fillStyle = '#ffd166'
          const badge = 'current'
          context.fillText(badge, node.x + node.w - 12 - context.measureText(badge).width, node.y + 20)
        }
      }

      context.setTransform(1, 0, 0, 1, 0, 0)
      context.font = '400 11px ' + FONT
      const legend = [
        { color: '#3ddc84', label: 'running' },
        { color: '#2a3346', label: 'idle' },
        { color: '#ffd166', label: 'current session' },
        { color: '#4da3ff', label: 'selected' },
        { color: '#1a2231', label: 'subagent child' },
        { color: '#1b2333', label: 'fork' },
      ]
      let cursorX = 20
      for (const item of legend) {
        context.fillStyle = item.color
        context.strokeStyle = '#2a3346'
        context.lineWidth = 1
        context.fillRect(cursorX, CANVAS_H - 27, 10, 10)
        context.strokeRect(cursorX, CANVAS_H - 27, 10, 10)
        context.fillStyle = '#79829a'
        context.fillText(item.label, cursorX + 16, CANVAS_H - 18)
        cursorX += 30 + context.measureText(item.label).width + 14
      }
    }

    const pointOf = (event) => {
      const native = event !== null && event !== undefined && event.nativeEvent !== undefined && event.nativeEvent !== null ? event.nativeEvent : event
      return {
        x: native !== null && native !== undefined && typeof native.offsetX === 'number' ? native.offsetX : 0,
        y: native !== null && native !== undefined && typeof native.offsetY === 'number' ? native.offsetY : 0,
      }
    }
    const hitTest = (layout, view, px, py) => {
      if (layout === null) return null
      const wx = (px - view.x) / view.scale
      const wy = (py - view.y) / view.scale
      for (let index = layout.nodes.length - 1; index >= 0; index--) {
        const node = layout.nodes[index]
        if (wx >= node.x && wx <= node.x + node.w && wy >= node.y && wy <= node.y + node.h) return node
      }
      return null
    }

    const overlayWrapStyle = { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 60 }
    const panelStyle = { pointerEvents: 'auto', width: String(CANVAS_W + 2) + 'px', maxWidth: '97vw', maxHeight: '92vh', overflow: 'auto', background: '#0d1017', border: '1px solid #263043', borderRadius: '14px', boxShadow: '0 26px 70px rgba(0,0,0,0.62)', color: '#e7ebf3', fontFamily: FONT }
    const headerStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '14px 16px 10px 16px' }
    const toolbarStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 16px 12px 16px', borderBottom: '1px solid #1c2331' }
    const buttonStyle = (active) => ({ height: '28px', padding: '0 11px', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontFamily: FONT, color: active ? '#cfe4ff' : '#9aa4b8', background: active ? 'rgba(77,163,255,0.18)' : 'rgba(255,255,255,0.04)', border: '1px solid ' + (active ? 'rgba(77,163,255,0.5)' : '#242c3c') })
    const closeStyle = { height: '28px', width: '28px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px', color: '#9aa4b8', background: 'rgba(255,255,255,0.04)', border: '1px solid #242c3c', fontFamily: FONT }
    const detailsStyle = { minHeight: '42px', display: 'flex', alignItems: 'center', padding: '10px 16px 12px 16px', borderTop: '1px solid #1c2331', fontSize: '12px' }
    const mutedStyle = { color: '#79829a' }

    function SessionCanvas(props) {
      const currentId = useCurrentId(props.useSessions)
      const dataPair = React.useState(null)
      const data = dataPair[0]
      const setData = dataPair[1]
      const statusPair = React.useState('loading')
      const status = statusPair[0]
      const setStatus = statusPair[1]
      const selectedPair = React.useState(null)
      const selectedId = selectedPair[0]
      const setSelectedId = selectedPair[1]
      const viewPair = React.useState({ scale: 1, x: 0, y: 0 })
      const view = viewPair[0]
      const setView = viewPair[1]
      const dragPair = React.useState(null)
      const drag = dragPair[0]
      const setDrag = dragPair[1]
      const scopePair = React.useState('all')
      const scope = scopePair[0]
      const setScope = scopePair[1]
      const holderPair = React.useState(() => ({ el: null }))
      const holder = holderPair[0]
      const viewKeyHolder = React.useState(() => ({ key: null }))[0]

      const refresh = () => {
        setStatus('loading')
        host.call('sessions-graph', {}).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.sessions)) {
            setData(result.sessions)
            setStatus('ready')
          } else {
            const reason = result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : 'unknown failure'
            setStatus('error: ' + reason)
          }
        }).catch((error) => {
          const reason = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
          setStatus('error: ' + reason)
        })
      }

      React.useEffect(() => { refresh() }, [])
      React.useEffect(() => {
        if (timer === undefined || timer === null || typeof timer.interval !== 'function') return undefined
        return timer.interval(() => { refresh() }, 4000)
      }, [])

      let visible = data === null ? [] : data
      if (scope === 'workspace' && data !== null) {
        let anchor = null
        for (const session of data) if (session.id === currentId && typeof session.cwd === 'string') anchor = session.cwd
        if (anchor !== null) visible = data.filter((session) => session.cwd === anchor)
      }
      const layout = data === null ? null : buildLayout(visible)
      const nextViewKey = (data === null ? 0 : data.length) + ':' + scope
      React.useEffect(() => {
        if (viewKeyHolder.key === nextViewKey) return
        viewKeyHolder.key = nextViewKey
        setView(fitView(layout))
      }, [nextViewKey])
      React.useEffect(() => { drawScene(holder.el, layout, view, selectedId, currentId) })

      const zoomBy = (factor) => {
        const nextScale = Math.max(0.32, Math.min(2.4, view.scale * factor))
        const ratio = nextScale / view.scale
        setView({ scale: nextScale, x: CANVAS_W / 2 - (CANVAS_W / 2 - view.x) * ratio, y: CANVAS_H / 2 - (CANVAS_H / 2 - view.y) * ratio })
      }
      const onMouseDown = (event) => {
        const point = pointOf(event)
        setDrag({ px: point.x, py: point.y, x: view.x, y: view.y })
      }
      const onMouseMove = (event) => {
        if (drag === null) return
        const point = pointOf(event)
        setView({ scale: view.scale, x: drag.x + (point.x - drag.px), y: drag.y + (point.y - drag.py) })
      }
      const onMouseUp = (event) => {
        const point = pointOf(event)
        if (drag !== null) {
          const moved = Math.abs(point.x - drag.px) + Math.abs(point.y - drag.py)
          if (moved < 5) {
            const hit = hitTest(layout, view, point.x, point.y)
            setSelectedId(hit === null ? null : hit.id)
          }
        }
        setDrag(null)
      }
      const onMouseLeave = () => { setDrag(null) }

      let selected = null
      if (selectedId !== null && data !== null) {
        for (const session of data) if (session.id === selectedId) selected = session
      }

      const header = React.createElement('div', { style: headerStyle },
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: '14px', fontWeight: 600, color: '#e7ebf3' } }, 'Session Canvas'),
          React.createElement('div', { style: { fontSize: '11.5px', color: '#7e879c', marginTop: '3px' } },
            '本进程内的会话关系图 · ' + status + ' · nodes ' + String(data === null ? 0 : data.length) + ' / shown ' + String(visible.length))
        ),
        React.createElement('button', { type: 'button', 'aria-label': '关闭', title: '关闭', onClick: () => setOpen(false), style: closeStyle }, '✕')
      )

      const toolbar = React.createElement('div', { style: toolbarStyle },
        React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: refresh }, '刷新'),
        React.createElement('button', { type: 'button', style: buttonStyle(scope === 'all'), onClick: () => setScope('all') }, '全部工作区'),
        React.createElement('button', { type: 'button', style: buttonStyle(scope === 'workspace'), onClick: () => setScope('workspace') }, '仅当前工作区'),
        React.createElement('span', { style: { flex: '1' } }),
        React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => zoomBy(0.85) }, '−'),
        React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => zoomBy(1.18) }, '+'),
        React.createElement('button', { type: 'button', style: buttonStyle(false), onClick: () => setView(fitView(layout)) }, '适应')
      )

      const canvas = React.createElement('canvas', {
        ref: (element) => { holder.el = element },
        width: CANVAS_W,
        height: CANVAS_H,
        onMouseDown: onMouseDown,
        onMouseMove: onMouseMove,
        onMouseUp: onMouseUp,
        onMouseLeave: onMouseLeave,
        style: { display: 'block', width: String(CANVAS_W) + 'px', height: String(CANVAS_H) + 'px', cursor: drag === null ? 'grab' : 'grabbing', touchAction: 'none' },
      })

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
      )

      return React.createElement('div', { style: overlayWrapStyle },
        React.createElement('div', { style: panelStyle }, header, toolbar, canvas, details)
      )
    }

    function CanvasOverlay(props) {
      const open = useOpen()
      if (!open) return null
      return React.createElement(SessionCanvas, props)
    }

    function FooterButton(props) {
      const open = useOpen()
      const wide = props.wide === true
      const icon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', { d: 'M4 12V6.5M8 12V3.5M12 12V8.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        React.createElement('circle', { cx: 4, cy: 12, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 }),
        React.createElement('circle', { cx: 8, cy: 3.5, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 }),
        React.createElement('circle', { cx: 12, cy: 8.5, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4 })
      )
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
      }, icon, wide ? React.createElement('span', null, 'Session Canvas') : null)
    }

    slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'session-canvas', order: 20 }, CanvasOverlay))
    slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'session-canvas', order: 20 }, FooterButton))

    console.log('session-canvas: client half loaded')
  },
}
