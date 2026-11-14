// 顶栏「折叠」页：轮询宿主 /fold-stats，把折叠收益与召回/重要消息成本画成图表。
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

    function clock(at) {
      try {
        var d = new Date(at || Date.now())
        var pad = function (v) { return v < 10 ? '0' + v : String(v) }
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      } catch {
        return ''
      }
    }

    var C = {
      panel: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '18px 22px 32px', minHeight: '100%', boxSizing: 'border-box' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      sub: { fontSize: '12px', opacity: 0.62, lineHeight: '18px' },
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
      var parts = []
      if (saved > 0 || cost > 0) {
        parts.push('净 ' + formatTokens((row.netTokens || 0)))
      } else {
        parts.push('—')
      }
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
          h('span', { style: { opacity: 0.55 } }, parts[0])
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

    function FoldStatsView(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var useState = react.useState
      var useEffect = react.useEffect
      var state = useState({ status: 'loading', data: null, error: '', at: 0 })
      var payload = state[0]
      var setPayload = state[1]
      var tick = useState(0)
      var setTick = tick[1]
      var alive = react.useRef(true)

      useEffect(function () {
        alive.current = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        function load() {
          if (!sessionId) {
            setPayload({ status: 'ready', data: null, error: '', at: Date.now() })
            return
          }
          fetch('/fold-stats?session=' + encodeURIComponent(sessionId), controller ? { signal: controller.signal } : undefined)
            .then(function (response) {
              return response.json().then(function (body) {
                if (!response.ok || !body || body.ok !== true) {
                  throw new Error((body && body.error) || ('HTTP ' + response.status))
                }
                return body
              })
            })
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

      if (!sessionId) {
        return h('div', { style: C.panel }, h('div', { style: C.notice }, '切换到具体会话后，这里显示该会话的折叠账本。'))
      }

      var data = payload.data
      var totals = data && data.totals ? data.totals : null
      var startedAt = payload.at || (data && data.generatedAt) || 0
      var header = h('div', { style: C.row },
        h('div', { style: C.title }, '折叠账本'),
        h('div', { style: C.sub }, '折叠算收益，召回与重要消息算成本；每 5 秒自动刷新'),
        h('div', { style: { flex: 1 } }),
        h('span', { style: C.sub }, startedAt ? '更新于 ' + clock(startedAt) : ''),
        h('button', {
          style: C.button,
          onClick: function () { setTick(function (value) { return value + 1 }) },
        }, '刷新'),
        // 逐轮报告是服务端现算的整页 HTML：新窗口打开，不打断对话。
        h('a', {
          style: Object.assign({}, C.button, { textDecoration: 'none', display: 'inline-block' }),
          href: '/fold-report?session=' + encodeURIComponent(sessionId),
          target: '_blank',
          rel: 'noopener noreferrer',
        }, '逐轮报告')
      )

      var errorLine = payload.status === 'error' && payload.error
        ? h('div', { style: { fontSize: '12px', color: '#f87171' } }, '读取统计失败：' + payload.error + '（每 5 秒会自动重试）')
        : null

      if (!data) {
        return h('div', { style: C.panel }, header, errorLine,
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
        var row = turns[i]
        max = Math.max(max, row.savedTokens || 0, (row.recallTokens || 0) + (row.pinTokens || 0))
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

      return h('div', { style: C.panel }, header, errorLine, kpis, chartSection, tableSection, pinsSection, footnote)
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
