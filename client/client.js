// 顶栏「折叠」页：账本（token 收支）、模型视角（折叠后模型真正看到的历史）、设置（可视化改配置）。
//
// 为什么手写 bundle：DSH 客户端插件就是 CJS + require 的产物，不需要构建链；
// 这个文件直接被 /plugins/<包名>/client.js 加载。渲染只用 react.createElement，不依赖 JSX。

window.__ModuleLoader__.load({
  id: 'dsh-fold-plugin',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    var h = react.createElement
    var REFRESH_MS = 5000

    function formatTokens(value) {
      var n = typeof value === 'number' && isFinite(value) ? value : 0
      var abs = Math.abs(n)
      var sign = n < 0 ? '−' : ''
      if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M'
      if (abs >= 10000) return sign + (abs / 1000).toFixed(1) + 'k'
      if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'k'
      return sign + String(Math.round(abs))
    }

    function formatChars(value) {
      var n = typeof value === 'number' && isFinite(value) ? value : 0
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k 字'
      return Math.round(n) + ' 字'
    }

    function percent(rate) {
      var value = typeof rate === 'number' && isFinite(rate) ? rate : 0
      return (value * 100).toFixed(1) + '%'
    }

    function preview(text, limit) {
      var value = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
      if (!value) return '（没有文字）'
      return value.length <= limit ? value : value.slice(0, limit) + '…'
    }

    function clock(at) {
      try {
        var d = new Date(at || Date.now())
        var pad = function (v) { return v < 10 ? '0' + v : String(v) }
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      } catch {
        return ''
      }
    }

    function readJson(response) {
      return response.json().then(function (body) {
        if (!response.ok || !body || body.ok !== true) {
          throw new Error((body && (body.error || (body.errors && body.errors.join('；')))) || ('HTTP ' + response.status))
        }
        return body
      })
    }

    var C = {
      panel: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '18px 22px 32px', minHeight: '100%', boxSizing: 'border-box' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      sub: { fontSize: '12px', opacity: 0.62, lineHeight: '18px' },
      tabBar: { display: 'flex', gap: '2px', borderBottom: '1px solid rgba(128,128,128,.25)' },
      tab: { fontSize: '12px', padding: '7px 14px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.6, cursor: 'pointer' },
      tabActive: { opacity: 1, borderBottomColor: '#34d399', fontWeight: 600 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: '10px', padding: '10px 12px', minWidth: '0' },
      kpiLabel: { fontSize: '12px', opacity: 0.65, marginBottom: '4px' },
      kpiValue: { fontSize: '20px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: '26px' },
      kpiHint: { fontSize: '11px', opacity: 0.55, marginTop: '2px' },
      section: { border: '1px solid rgba(128,128,128,.22)', borderRadius: '10px', padding: '12px 14px' },
      sectionHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' },
      sectionTitle: { fontSize: '13px', fontWeight: 600 },
      legend: { display: 'flex', gap: '14px', fontSize: '11px', opacity: 0.7 },
      dot: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', marginRight: '5px', verticalAlign: 'middle' },
      barRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '12px' },
      turnLabel: { width: '40px', flex: '0 0 40px', opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
      barArea: { flex: '1 1 0', display: 'flex', alignItems: 'center', minWidth: '0' },
      barTrack: { position: 'relative', height: '10px', borderRadius: '3px', background: 'rgba(128,128,128,.14)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: '3px' },
      values: { flex: '0 0 132px', display: 'flex', justifyContent: 'flex-end', gap: '8px', fontVariantNumeric: 'tabular-nums', fontSize: '11px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', fontWeight: 500, opacity: 0.6, padding: '4px 8px', borderBottom: '1px solid rgba(128,128,128,.22)', whiteSpace: 'nowrap' },
      td: { padding: '5px 8px', borderBottom: '1px solid rgba(128,128,128,.12)', verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontVariantNumeric: 'tabular-nums' },
      button: { fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      notice: { fontSize: '12px', opacity: 0.7, padding: '12px 14px', border: '1px dashed rgba(128,128,128,.35)', borderRadius: '10px', lineHeight: '20px' },
      pinLine: { padding: '6px 0', borderTop: '1px solid rgba(128,128,128,.14)', fontSize: '12px' },
      turn: { border: '1px solid rgba(128,128,128,.22)', borderRadius: '10px', overflow: 'hidden' },
      turnSummary: { padding: '8px 12px', cursor: 'pointer', listStyle: 'none' },
      turnHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      turnNo: { fontSize: '13px', fontWeight: 600 },
      turnMeta: { marginLeft: 'auto', fontSize: '11px', opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
      turnBody: { padding: '2px 12px 12px' },
      tag: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.35)', opacity: 0.85, whiteSpace: 'nowrap' },
      peek: { display: 'flex', gap: '6px', fontSize: '11px', opacity: 0.7, marginTop: '3px', lineHeight: '17px' },
      peekKey: { flex: '0 0 28px', opacity: 0.7 },
      entry: { margin: '8px 0', padding: '6px 8px', borderRadius: '8px' },
      entryHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: '2px' },
      entryRole: { fontSize: '12px', fontWeight: 600 },
      entryMeta: { fontSize: '11px', opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
      nested: { marginTop: '6px', border: '1px dashed rgba(128,128,128,.35)', borderRadius: '7px', padding: '6px 8px' },
      nestedSummary: { fontSize: '11px', cursor: 'pointer', opacity: 0.7 },
      blockHead: { fontSize: '10px', opacity: 0.6, marginBottom: '2px' },
      blockText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', lineHeight: '18px' },
      blockClip: { maxHeight: '240px', overflow: 'auto' },
      field: { borderTop: '1px solid rgba(128,128,128,.14)', padding: '10px 0' },
      fieldTop: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      fieldKey: { fontSize: '12px', fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      fieldRange: { fontSize: '11px', opacity: 0.5, fontVariantNumeric: 'tabular-nums' },
      fieldDesc: { fontSize: '11px', opacity: 0.62, margin: '3px 0 6px', lineHeight: '17px' },
      input: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.4)', background: 'rgba(128,128,128,.08)', color: 'inherit', width: '180px', fontVariantNumeric: 'tabular-nums' },
      textarea: { fontSize: '12px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.4)', background: 'rgba(128,128,128,.08)', color: 'inherit', width: '100%', boxSizing: 'border-box', lineHeight: '18px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    }

    var KIND_COLORS = {
      user: ['rgba(47,111,235,.10)', '#2f6feb'],
      inject: ['rgba(154,163,174,.12)', '#9aa3ae'],
      checkpoint: ['rgba(92,102,112,.12)', '#5c6670'],
      pin: ['rgba(130,80,223,.10)', '#8250df'],
      system: ['rgba(128,128,128,.08)', '#6b7280'],
      developer: ['rgba(130,80,223,.08)', '#8250df'],
      reply: ['rgba(26,127,55,.07)', '#1a7f37'],
      result: ['rgba(217,119,6,.09)', '#d97706'],
      think: ['rgba(212,167,44,.10)', '#d4a72c'],
      call: ['rgba(79,70,229,.08)', '#4f46e5'],
      text: ['rgba(128,128,128,.06)', '#9aa3ae'],
    }

    var BLOCK_LABELS = {
      think: '思考',
      reply: '回复',
      call: '调用',
      result: '工具结果',
      inject: '注入消息',
      developer: '开发者消息',
      text: '文本',
      other: '其它',
    }

    function tint(kind) {
      var pair = KIND_COLORS[kind] || KIND_COLORS.text
      return { background: pair[0], borderLeft: '3px solid ' + pair[1] }
    }

    function entryKindOf(entry) {
      if (!entry) return 'text'
      if (entry.isCheckpoint) return 'checkpoint'
      if (entry.isPin) return 'pin'
      var role = entry.role ? String(entry.role) : ''
      var sourceKind = entry.sourceKind ? String(entry.sourceKind) : ''
      if (role === 'system') return 'system'
      if (role === 'tool') return 'result'
      if (role === 'developer') return 'developer'
      if (role === 'user') return sourceKind === 'user' || sourceKind === 'schedule' ? 'user' : 'inject'
      return 'reply'
    }

    function Kpi(props) {
      return h('div', { style: C.card },
        h('div', { style: C.kpiLabel }, props.label),
        h('div', { style: Object.assign({}, C.kpiValue, { color: props.color || 'inherit' }) }, props.value),
        h('div', { style: C.kpiHint }, props.hint || '')
      )
    }

    function BarRow(props) {
      var row = props.row
      var saved = Math.max(0, row.savedTokens || 0)
      var cost = Math.max(0, (row.recallTokens || 0) + (row.pinTokens || 0))
      var max = props.max || 1
      var savedPct = max > 0 ? Math.min(100, (saved / max) * 100) : 0
      var costPct = max > 0 ? Math.min(100, (cost / max) * 100) : 0
      var net = saved > 0 || cost > 0 ? '净 ' + formatTokens(row.netTokens || 0) : '—'
      return h('div', { style: C.barRow, title: '第 ' + row.turn + ' 轮：折叠省下 ' + formatTokens(saved) + ' token，召回与重要消息占 ' + formatTokens(cost) + ' token' },
        h('div', { style: C.turnLabel }, 'T' + row.turn),
        h('div', { style: Object.assign({}, C.barArea, { justifyContent: 'flex-end' }) },
          h('div', { style: Object.assign({}, C.barTrack, { width: costPct + '%' }) },
            h('div', { style: Object.assign({}, C.barFill, { width: '100%', background: '#f87171' }) })
          )
        ),
        h('div', { style: { width: '1px', height: '14px', background: 'rgba(128,128,128,.5)', flex: '0 0 1px' } }),
        h('div', { style: Object.assign({}, C.barArea, { justifyContent: 'flex-start' }) },
          h('div', { style: Object.assign({}, C.barTrack, { width: savedPct + '%' }) },
            h('div', { style: Object.assign({}, C.barFill, { width: '100%', background: '#34d399' }) })
          )
        ),
        h('div', { style: C.values },
          h('span', { style: { color: '#f87171' } }, cost > 0 ? formatTokens(-cost) : ''),
          h('span', { style: { color: '#34d399' } }, saved > 0 ? '+' + formatTokens(saved) : ''),
          h('span', { style: { opacity: 0.55 } }, net)
        )
      )
    }

    function FoldTable(props) {
      var rows = props.rows || []
      if (rows.length === 0) return h('div', { style: C.notice }, '还没有折叠记录。')
      var header = h('tr', {}, ['编号', '轮', '原文', '摘要', '省下', '召回'].map(function (title) {
        return h('th', { key: title, style: C.th }, title)
      }))
      var body = rows.map(function (row) {
        return h('tr', { key: row.id },
          h('td', { style: Object.assign({}, C.td, C.mono) }, row.id),
          h('td', { style: Object.assign({}, C.td, C.mono) }, String(row.turn)),
          h('td', { style: Object.assign({}, C.td, C.mono) }, formatChars(row.originalChars)),
          h('td', { style: Object.assign({}, C.td, C.mono) }, formatChars(row.noteChars)),
          h('td', { style: Object.assign({}, C.td, C.mono, { color: '#34d399' }) }, '+' + formatTokens(row.savedTokens)),
          h('td', { style: Object.assign({}, C.td, C.mono, { color: row.recallCount > 0 ? '#fbbf24' : 'inherit', opacity: row.recallCount > 0 ? 1 : 0.5 }) }, String(row.recallCount))
        )
      })
      return h('div', { style: { maxHeight: '260px', overflowY: 'auto' } },
        h('table', { style: C.table },
          h('thead', {}, header),
          h('tbody', {}, body)
        )
      )
    }

    function Pins(props) {
      var pins = props.pins || []
      if (pins.length === 0) {
        return h('div', { style: C.notice }, '还没有重要消息。需要长期复用的结论用 fold_pin 固化，它永不折叠，但会一直占着上下文。')
      }
      return h('div', {}, pins.map(function (pin) {
        var text = String(pin.text || '')
        var short = text.length > 120 ? text.slice(0, 120) + '…' : text
        return h('div', { key: pin.id + ':' + pin.at, style: C.pinLine },
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline' } },
            h('span', { style: { fontWeight: 600 } }, pin.id),
            h('span', { style: Object.assign({}, C.mono, { opacity: 0.55 }) }, 'T' + pin.turn + ' · ' + formatChars(pin.chars) + ' · ' + formatTokens(-pin.tokens) + ' token'),
            pin.estimated ? h('span', { style: { opacity: 0.45, fontSize: '11px' } }, '（旧记录，轮次按估算）') : null
          ),
          h('div', { style: { opacity: 0.7, marginTop: '2px', whiteSpace: 'pre-wrap' } }, short)
        )
      }))
    }

    // ---------- 账本 ----------
    function Ledger(props) {
      var sessionId = props.sessionId
      var state = react.useState({ status: 'loading', data: null, error: '', at: 0 })
      var payload = state[0]
      var setPayload = state[1]
      var tick = react.useState(0)
      var alive = react.useRef(true)

      react.useEffect(function () {
        alive.current = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        function load() {
          fetch('/fold-stats?session=' + encodeURIComponent(sessionId), controller ? { signal: controller.signal } : undefined)
            .then(readJson)
            .then(function (body) {
              if (!alive.current) return
              setPayload({ status: 'ready', data: body, error: '', at: Date.now() })
            })
            .catch(function (error) {
              if (!alive.current || (error && error.name === 'AbortError')) return
              setPayload(function (previous) {
                return { status: previous.data ? 'ready' : 'error', data: previous.data, error: String(error && error.message ? error.message : error), at: Date.now() }
              })
            })
        }
        load()
        var timer = setInterval(load, REFRESH_MS)
        return function () {
          alive.current = false
          clearInterval(timer)
          if (controller) controller.abort()
        }
      }, [sessionId, tick[0]])

      var data = payload.data
      var totals = data && data.totals ? data.totals : null
      var startedAt = payload.at || (data && data.generatedAt) || 0
      var toolbar = h('div', { style: C.row },
        h('span', { style: C.sub }, startedAt ? '更新于 ' + clock(startedAt) + ' · 每 5 秒自动刷新' : '读取中…'),
        h('div', { style: { flex: 1 } }),
        h('button', { style: C.button, onClick: function () { tick[1](function (value) { return value + 1 }) } }, '刷新')
      )

      var errorLine = payload.status === 'error' && payload.error
        ? h('div', { style: { fontSize: '12px', color: '#f87171' } }, '读取统计失败：' + payload.error + '（每 5 秒会自动重试）')
        : null

      if (!data) {
        return h('div', {}, toolbar, errorLine,
          h('div', { style: C.notice }, payload.status === 'loading' ? '正在读取统计…' : '还没有数据。'))
      }

      var kpis = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' } },
        h(Kpi, { label: '折叠收益', value: '+' + formatTokens(totals.savedTokens), color: '#34d399', hint: totals.folds + ' 段折叠，省下 ' + formatChars(totals.savedChars) + '（保留率 ' + Math.round((totals.saveRate || 0) * 100) + '%）' }),
        h(Kpi, { label: '召回成本', value: formatTokens(-totals.recallTokens), color: totals.recallTokens > 0 ? '#f87171' : 'inherit', hint: totals.recalls + ' 次召回，' + totals.recalledFolds + ' 段被回看过' }),
        h(Kpi, { label: '重要消息成本', value: formatTokens(-totals.pinTokens), color: totals.pinTokens > 0 ? '#fbbf24' : 'inherit', hint: totals.pins + ' 条固化，共 ' + formatChars(totals.pinChars) }),
        h(Kpi, { label: '净收益', value: (totals.netTokens >= 0 ? '+' : '') + formatTokens(totals.netTokens), color: totals.netTokens >= 0 ? '#34d399' : '#f87171', hint: '当前历史里折叠摘要 + 重要消息约占 ' + formatTokens(data.current ? data.current.tokens : 0) + ' token' })
      )

      var turns = Array.isArray(data.turns) ? data.turns : []
      var max = 1
      for (var i = 0; i < turns.length; i += 1) {
        max = Math.max(max, turns[i].savedTokens || 0, (turns[i].recallTokens || 0) + (turns[i].pinTokens || 0))
      }
      var chart = turns.length === 0
        ? h('div', { style: C.notice }, '还没有折叠记录。每轮结束时，本轮较长的思考与回复会被折成一条带编号的检查点；折叠后这里会出现收益与开销。')
        : h('div', {}, turns.map(function (item) { return h(BarRow, { key: item.turn, row: item, max: max }) }))

      var chartSection = h('div', { style: C.section },
        h('div', { style: C.sectionHead },
          h('div', { style: C.sectionTitle }, '每轮 token 收支'),
          h('div', { style: C.legend },
            h('span', {}, h('span', { style: Object.assign({}, C.dot, { background: '#34d399' }) }), '折叠省下'),
            h('span', {}, h('span', { style: Object.assign({}, C.dot, { background: '#f87171' }) }), '召回 + 重要消息')
          )
        ),
        chart
      )

      var tableSection = h('div', { style: C.section },
        h('div', { style: C.sectionHead },
          h('div', { style: C.sectionTitle }, '折叠明细'),
          h('div', { style: C.sub }, '召回列 = 这一段被 fold_recall 取回过几次；反复取回说明该总结成重要消息')
        ),
        h(FoldTable, { rows: data.rows || [] })
      )

      var pinsSection = h('div', { style: C.section },
        h('div', { style: C.sectionHead },
          h('div', { style: C.sectionTitle }, '重要消息'),
          h('div', { style: C.sub }, '永不折叠，长期占用上下文')
        ),
        h(Pins, { pins: data.pins || [] })
      )

      var footnote = h('div', { style: { fontSize: '11px', opacity: 0.5, lineHeight: '18px' } },
        '估算口径与宿主 token-meter 一致：每 ' + (data.estimate ? data.estimate.charsPerToken : 4) + ' 字符算 1 token，每个文本块再加 ' + (data.estimate ? data.estimate.blockOverhead : 4) + ' token 开销。'
      )

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, toolbar, errorLine, kpis, chartSection, tableSection, pinsSection, footnote)
    }

    // ---------- 模型视角 ----------
    function BlockView(props) {
      var block = props.block || {}
      var kind = block.kind || 'text'
      var text = typeof block.text === 'string' ? block.text : ''
      var label = BLOCK_LABELS[kind] || '文本'
      if (kind === 'call' && block.name) label += ' ' + block.name
      return h('div', { style: Object.assign({}, tint(kind), { padding: '6px 8px', margin: '5px 0', borderRadius: '6px' }) },
        h('div', { style: C.blockHead }, label + ' · ' + text.length + ' 字'),
        h('div', { style: Object.assign({}, C.blockText, props.wide ? {} : C.blockClip) }, text || '（空）')
      )
    }

    function EntryView(props) {
      var entry = props.entry || {}
      var kind = entryKindOf(entry)
      var role = entry.isCheckpoint
        ? '折叠摘要 ' + (entry.foldId || '')
        : entry.isPin
          ? '重要消息「' + (entry.pinLabel || '') + '」'
          : (entry.roleLabel || entry.role || '消息')
      var meta = []
      if (entry.sourceLabel) meta.push(entry.sourceLabel)
      if (entry.seq !== null && entry.seq !== undefined) meta.push('#' + entry.seq)
      meta.push(formatChars(entry.chars))
      var body = []
      var blocks = Array.isArray(entry.blocks) ? entry.blocks : []
      for (var i = 0; i < blocks.length; i += 1) {
        body.push(h(BlockView, { key: 'b' + i, block: blocks[i], wide: props.wide }))
      }
      var record = entry.foldRecord
      if (entry.isCheckpoint && record && Array.isArray(record.items) && record.items.length > 0) {
        var original = []
        for (var j = 0; j < record.items.length; j += 1) {
          var item = record.items[j]
          var itemBlocks = Array.isArray(item.blocks) ? item.blocks : []
          for (var k = 0; k < itemBlocks.length; k += 1) {
            original.push(h(BlockView, { key: 'o' + j + '-' + k, block: itemBlocks[k], wide: props.wide }))
          }
        }
        body.push(h('details', { key: 'origin', style: C.nested },
          h('summary', { style: C.nestedSummary }, '折叠掉的原文 · ' + record.items.length + ' 段（模型看不到，仅供对照）'),
          original
        ))
      }
      return h('div', { style: Object.assign({}, C.entry, tint(kind)) },
        h('div', { style: C.entryHead },
          h('span', { style: C.entryRole }, role),
          meta.map(function (text, index) { return h('span', { key: 'm' + index, style: C.entryMeta }, text) })
        ),
        body
      )
    }

    function TurnCard(props) {
      var group = props.group || {}
      var isSystem = group.kind === 'system'
      var label = isSystem ? '系统提示词' : (typeof group.turn === 'number' ? '第 ' + group.turn + ' 轮' : '第 ' + (group.ordinal || 0) + ' 段')
      var tags = []
      if (isSystem) {
        tags.push(h('span', { key: 'sys', style: C.tag }, '不折叠 · 全文'))
      } else {
        var foldIds = Array.isArray(group.foldIds) ? group.foldIds : []
        for (var i = 0; i < foldIds.length; i += 1) tags.push(h('span', { key: 'f' + i, style: C.tag }, foldIds[i]))
        if (group.continuation) tags.push(h('span', { key: 'cont', style: C.tag }, '轮内续接'))
        if (group.folded) tags.push(h('span', { key: 'folded', style: C.tag }, '已折叠'))
        else if (group.prePlugin) tags.push(h('span', { key: 'pre', style: C.tag }, '插件生效前 · 未折叠'))
        else tags.push(h('span', { key: 'none', style: C.tag }, group.short ? '内容较少 · 未折叠' : '未折叠'))
      }
      var meta = isSystem
        ? formatChars(group.chars) + ' 字'
        : (group.steps || 0) + ' 步 · ' + formatChars(group.chars) + (group.folded ? ' ← 原文 ' + formatChars(group.unfoldedChars) : '')
      var summary = h('summary', { style: C.turnSummary },
        h('div', { style: C.turnHead },
          h('span', { style: C.turnNo }, label),
          tags,
          h('span', { style: C.turnMeta }, meta)
        ),
        isSystem ? null : h('div', { style: C.peek },
          h('span', { style: C.peekKey }, '用户'),
          h('span', {}, preview(group.userText, 150))
        ),
        isSystem ? null : h('div', { style: C.peek },
          h('span', { style: C.peekKey }, '回复'),
          h('span', {}, preview(group.replyText || group.replyNote || '', 150))
        )
      )
      var entries = Array.isArray(group.entries) ? group.entries : []
      return h('details', { style: C.turn },
        summary,
        h('div', { style: C.turnBody }, entries.map(function (entry, index) {
          return h(EntryView, { key: 'e' + index, entry: entry, wide: props.wide })
        }))
      )
    }

    function ModelView(props) {
      var sessionId = props.sessionId
      var state = react.useState({ status: 'loading', data: null, error: '' })
      var payload = state[0]
      var setPayload = state[1]
      var tick = react.useState(0)
      var wide = react.useState(false)
      var alive = react.useRef(true)

      react.useEffect(function () {
        alive.current = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        setPayload(function (previous) { return { status: previous.data ? 'ready' : 'loading', data: previous.data, error: '' } })
        fetch('/fold-view?session=' + encodeURIComponent(sessionId), controller ? { signal: controller.signal } : undefined)
          .then(readJson)
          .then(function (body) {
            if (!alive.current) return
            setPayload({ status: 'ready', data: body, error: '' })
          })
          .catch(function (error) {
            if (!alive.current || (error && error.name === 'AbortError')) return
            setPayload(function (previous) {
              return { status: previous.data ? 'ready' : 'error', data: previous.data, error: String(error && error.message ? error.message : error) }
            })
          })
        return function () {
          alive.current = false
          if (controller) controller.abort()
        }
      }, [sessionId, tick[0]])

      var data = payload.data
      var toolbar = h('div', { style: C.row },
        h('div', { style: C.sub }, '这是 session.deriveMessages() 派生的真实请求历史：折叠检查点就是模型实际看到的样子；展开检查点可对照被替换掉的原文。'),
        h('div', { style: { flex: 1 } }),
        h('label', { style: Object.assign({}, C.sub, { cursor: 'pointer' }) },
          h('input', { type: 'checkbox', checked: wide[0], onChange: function (event) { wide[1](event.target.checked) } }),
          ' 展开长文本'
        ),
        h('button', { style: C.button, onClick: function () { tick[1](function (value) { return value + 1 }) } }, '刷新')
      )
      if (!data) {
        return h('div', {}, toolbar,
          h('div', { style: C.notice }, payload.status === 'error' ? '读取模型视角失败：' + payload.error : '正在读取模型视角…'))
      }
      if (data.empty) return h('div', {}, toolbar, h('div', { style: C.notice }, '这个会话还没有派生消息（历史为空）。'))
      var totals = data.totals || {}
      var tokens = totals.tokens || {}
      var notice = h('div', { style: C.notice },
        '模型看到 ' + (totals.messages || 0) + ' 条消息、' + formatChars(totals.chars) + '，约 ' +
        formatTokens(tokens.low) + '–' + formatTokens(tokens.high) + ' token；折叠检查点 ' + (totals.checkpoints || 0) +
        ' 条、重要消息 ' + (totals.pins || 0) + ' 条；相比不折叠省 ' + formatChars(totals.savedChars) +
        '（' + percent(totals.saveRate) + '）。'
      )
      var warns = (data.warns || []).map(function (text, index) {
        return h('div', { key: 'w' + index, style: { fontSize: '11px', opacity: 0.65, lineHeight: '17px' } }, '· ' + text)
      })
      var groups = Array.isArray(data.groups) ? data.groups : []
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        toolbar,
        notice,
        warns.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, warns) : null,
        groups.map(function (group, index) {
          return h(TurnCard, { key: 'g' + index, group: group, wide: wide[0] })
        })
      )
    }

    // ---------- 设置 ----------
    function fieldRange(field) {
      if (!field) return ''
      var base = field.kind === 'boolean'
        ? 'true / false'
        : field.kind === 'string'
          ? '不超过 ' + field.maxChars + ' 字'
          : field.min + '~' + field.max
      return base + ' · 默认 ' + JSON.stringify(field.default)
    }

    function SettingsView() {
      var state = react.useState({ status: 'loading', data: null, error: '', message: '', saving: false })
      var payload = state[0]
      var setPayload = state[1]
      var draftState = react.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]

      react.useEffect(function () {
        var alive = true
        fetch('/fold-config')
          .then(readJson)
          .then(function (body) {
            if (!alive) return
            setPayload({ status: 'ready', data: body, error: '', message: '', saving: false })
            setDraft(Object.assign({}, body.config || {}))
          })
          .catch(function (error) {
            if (!alive) return
            setPayload({ status: 'error', data: null, error: String(error && error.message ? error.message : error), message: '', saving: false })
          })
        return function () { alive = false }
      }, [])

      function update(key, value) {
        setDraft(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function submit(body, doneText) {
        setPayload(function (previous) { return Object.assign({}, previous, { saving: true, message: '', error: '' }) })
        fetch('/fold-config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(readJson)
          .then(function (result) {
            setPayload({ status: 'ready', data: result, error: '', message: doneText, saving: false })
            setDraft(Object.assign({}, result.config || {}))
          })
          .catch(function (error) {
            setPayload(function (previous) {
              return Object.assign({}, previous, { saving: false, error: String(error && error.message ? error.message : error), message: '' })
            })
          })
      }

      function save() {
        var data = payload.data
        if (!data) return
        var patch = {}
        var fields = data.fields || []
        for (var i = 0; i < fields.length; i += 1) {
          var field = fields[i]
          var value = draft[field.key]
          if (field.kind === 'boolean') {
            patch[field.key] = value === true
          } else if (field.kind === 'string') {
            patch[field.key] = value === undefined || value === null ? '' : String(value)
          } else {
            var number = Number(value)
            if (!isFinite(number)) {
              setPayload(function (previous) {
                return Object.assign({}, previous, { saving: false, error: field.key + ' 必须是数字（当前是 ' + JSON.stringify(value) + '）', message: '' })
              })
              return
            }
            patch[field.key] = number
          }
        }
        submit({ patch: patch }, '已保存并立即生效。')
      }

      function reset() {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('恢复全部默认配置？已保存的自定义值会被覆盖。')) return
        }
        submit({ reset: true }, '已恢复默认配置。')
      }

      if (payload.status === 'loading' && !payload.data) {
        return h('div', { style: C.notice }, '正在读取配置…')
      }
      if (payload.status === 'error' && !payload.data) {
        return h('div', { style: C.notice }, '读取配置失败：' + payload.error)
      }
      var data = payload.data || {}
      var fields = Array.isArray(data.fields) ? data.fields : []
      var rows = fields.map(function (field) {
        var value = draft[field.key]
        var input
        if (field.kind === 'boolean') {
          input = h('label', { style: Object.assign({}, C.sub, { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }) },
            h('input', { type: 'checkbox', checked: value === true, onChange: function (event) { update(field.key, event.target.checked) } }),
            value === true ? '开启' : '关闭'
          )
        } else if (field.kind === 'string') {
          input = h('textarea', {
            style: C.textarea,
            rows: field.key === 'systemPromptText' ? 12 : 3,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { update(field.key, event.target.value) },
          })
        } else {
          input = h('input', {
            type: 'number',
            style: C.input,
            step: field.kind === 'ratio' ? '0.01' : '1',
            min: field.min,
            max: field.max,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { update(field.key, event.target.value) },
          })
        }
        return h('div', { key: field.key, style: C.field },
          h('div', { style: C.fieldTop },
            h('label', { style: C.fieldKey }, field.key),
            h('span', { style: C.fieldRange }, fieldRange(field))
          ),
          h('div', { style: C.fieldDesc }, field.description || ''),
          input
        )
      })
      var feedback = []
      if (payload.error) feedback.push(h('div', { key: 'err', style: { fontSize: '12px', color: '#f87171' } }, payload.error))
      if (payload.message) feedback.push(h('div', { key: 'ok', style: { fontSize: '12px', color: '#34d399' } }, payload.message))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: C.row },
          h('div', { style: C.sub }, '修改会写入 ' + (data.filePath || '配置文件') + ' 并立即重建系统提示段；数值超出范围会被拒绝。'),
          h('div', { style: { flex: 1 } }),
          h('button', { style: C.button, onClick: reset, disabled: payload.saving }, '恢复默认'),
          h('button', { style: Object.assign({}, C.button, { borderColor: '#34d399' }), onClick: save, disabled: payload.saving }, payload.saving ? '保存中…' : '保存')
        ),
        feedback.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, feedback) : null,
        h('div', {}, rows)
      )
    }

    // ---------- 页面 ----------
    function FoldStatsView(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var tabState = react.useState('ledger')
      var tab = tabState[0]
      var setTab = tabState[1]
      if (!sessionId) {
        return h('div', { style: C.panel }, h('div', { style: C.notice }, '切换到具体会话后，这里显示该会话的折叠情况。'))
      }
      var tabs = [['ledger', '账本'], ['model', '模型视角'], ['settings', '设置']]
      var header = h('div', { style: C.row },
        h('div', { style: C.title }, '上下文折叠'),
        h('div', { style: C.sub }, '按轮折叠 · 折叠算收益，召回与重要消息算成本'),
        h('div', { style: { flex: 1 } }),
        h('a', {
          style: Object.assign({}, C.button, { textDecoration: 'none', display: 'inline-block' }),
          href: '/fold-report?session=' + encodeURIComponent(sessionId),
          target: '_blank',
          rel: 'noopener noreferrer',
        }, '逐轮报告')
      )
      var tabBar = h('div', { style: C.tabBar }, tabs.map(function (item) {
        return h('button', {
          key: item[0],
          style: Object.assign({}, C.tab, tab === item[0] ? C.tabActive : {}),
          onClick: function () { setTab(item[0]) },
        }, item[1])
      }))
      var body = tab === 'model'
        ? h(ModelView, { sessionId: sessionId })
        : tab === 'settings'
          ? h(SettingsView, {})
          : h(Ledger, { sessionId: sessionId })
      return h('div', { style: C.panel }, header, tabBar, body)
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'fold-stats',
          order: 20,
          label: function () { return '折叠' },
          inject: function (sessionId) { return { sessionId: sessionId } },
        }, FoldStatsView)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
