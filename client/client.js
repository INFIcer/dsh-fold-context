// 顶栏「折叠」页：账本（token 收支）、模型视角（折叠后模型真正看到的历史）。
// 参数表单另外注册到原生「插件」页的组合包配置位（plugins.bundle.config），不占顶栏。
//
// 为什么手写 bundle：DSH 客户端插件就是 CJS + require 的产物，不需要构建链；
// 这个文件直接被 /plugins/<包名>/client.js 加载。渲染只用 react.createElement，不依赖 JSX。

window.__ModuleLoader__.load({
  id: 'dsh-fold-context',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    var h = react.createElement
    var REFRESH_MS = 5000
    // 构成图要服务端重建一份模型视角，比账本数字贵得多，单独按更慢的节奏拉。
    var COMPOSITION_REFRESH_MS = 20000

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

    // 字数与 token 一起给：4 字符 ≈ 1 token，与宿主 token-meter 的基本档一致。
    var CHARS_PER_TOKEN = 4
    function formatCharsTokens(value) {
      var chars = typeof value === 'number' && isFinite(value) ? value : 0
      return formatChars(chars) + '（≈' + formatTokens(Math.round(chars / CHARS_PER_TOKEN)) + ' token）'
    }

    // 金额一律按人民币显示：大于 1 元给到分，小的给到 4 位，再小就写成「<¥0.0001」。
    function formatMoney(value) {
      var n = typeof value === 'number' && isFinite(value) ? value : 0
      var abs = Math.abs(n)
      var sign = n < 0 ? '−' : ''
      if (abs >= 1000) return sign + '¥' + (abs / 1000).toFixed(1) + 'k'
      if (abs >= 100) return sign + '¥' + abs.toFixed(0)
      if (abs >= 1) return sign + '¥' + abs.toFixed(2)
      if (abs >= 0.01) return sign + '¥' + abs.toFixed(3)
      if (abs === 0) return '¥0'
      if (abs >= 0.0001) return sign + '¥' + abs.toFixed(4)
      return sign + '<¥0.0001'
    }

    // 金额按「元 / 百万 token」折算：token × 单价 / 1e6。
    function moneyOfTokens(tokens, price) {
      var n = typeof tokens === 'number' && isFinite(tokens) ? tokens : 0
      var p = typeof price === 'number' && isFinite(price) ? price : 0
      return (n * p) / 1000000
    }

    function moneyCell(value, color) {
      return h('td', { style: Object.assign({}, C.td, C.mono, color ? { color: color } : {}) }, formatMoney(value))
    }

    function priceLine(prices) {
      return '命中 ¥' + prices.cacheHit + ' / 未命中 ¥' + prices.input + ' / 输出 ¥' + prices.output + ' 每百万 token'
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
      entrySummary: { padding: '5px 8px', cursor: 'pointer', listStyle: 'none' },
      entryPeek: { fontSize: '11px', opacity: 0.6, marginTop: '2px', lineHeight: '17px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      entryBody: { padding: '0 8px 8px' },
      blockBox: { padding: '6px 8px', margin: '5px 0', borderRadius: '6px' },
      blockWide: { maxHeight: 'none' },
      nestedBody: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' },
      itemBox: { border: '1px solid rgba(128,128,128,.18)', borderRadius: '6px', padding: '4px 6px' },
      itemSummary: { fontSize: '11px', cursor: 'pointer', opacity: 0.72, fontVariantNumeric: 'tabular-nums' },
      itemBody: { paddingTop: '2px' },
      hunkHead: { fontSize: '11px', opacity: 0.6, marginTop: '6px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      diffBox: { fontSize: '11px', lineHeight: '16px', borderRadius: '6px', overflow: 'auto', maxHeight: '320px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      diffLine: { padding: '0 6px' },
      diffAdd: { background: 'rgba(52,211,153,.14)' },
      diffDel: { background: 'rgba(248,113,113,.14)' },
      diffFull: { marginTop: '8px' },
      compBar: { position: 'relative', width: '100%', height: '8px', borderRadius: '3px', overflow: 'hidden', background: 'rgba(128,128,128,.10)' },
      compFill: { display: 'flex', height: '100%', borderRadius: '3px', overflow: 'hidden' },
      compSeg: { height: '100%' },
      compMark: { position: 'absolute', top: '0', bottom: '0', width: '1px', background: 'rgba(255,255,255,.7)' },
      compLine: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginTop: '6px' },
      compLineLabel: { width: '44px', flex: '0 0 44px', opacity: 0.6 },
      // 数值列定宽，两条 bar 的轨道才能严格等宽，比例尺才对得齐。
      compLineValue: { flex: '0 0 80px', width: '80px', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
      compGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '2px 18px', marginTop: '10px' },
      compItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', lineHeight: '20px', minWidth: '0' },
      compCell: { fontVariantNumeric: 'tabular-nums', textAlign: 'right', minWidth: '44px' },
      compNote: { fontSize: '11px', opacity: 0.6, lineHeight: '18px' },
      toggleOn: { fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.5)', background: 'rgba(128,128,128,.18)', color: 'inherit', cursor: 'pointer', fontWeight: 600 },
      toggleOff: { fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.28)', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.65 },
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

    // 账本顶部四张卡只报 token。折叠的收益没法折成人民币：同一批 token 换成高峰价就翻倍，
    // 真实请求还会被缓存、请求期压缩器和工具定义改写，算出来的金额既不能验证也不能横向比。
    // 所以收益与成本一律用 token 计量；金额只留在「成本参考」里，回答「这些 token 折算多少」。
    function ledgerKpis(totals, current) {
      var net = totals.netTokens || 0
      var recall = totals.recallTokens || 0
      var pin = totals.pinTokens || 0
      return [
        {
          label: '折叠收益',
          value: '+' + formatTokens(totals.savedTokens || 0) + ' token',
          color: '#34d399',
          hint: totals.folds + ' 段折叠，' + formatChars(totals.savedChars) + '，保留率 ' + Math.round((totals.saveRate || 0) * 100) + '%',
        },
        {
          label: '召回成本',
          value: (recall > 0 ? '−' : '') + formatTokens(recall) + ' token',
          color: recall > 0 ? '#f87171' : 'inherit',
          hint: totals.recalls + ' 次召回' + (totals.probes > 0 ? ' + ' + totals.probes + ' 次目录/检索' : '') + '，' + totals.recalledFolds + ' 段被回看过',
        },
        {
          label: '重要消息成本',
          value: (pin > 0 ? '−' : '') + formatTokens(pin) + ' token',
          color: pin > 0 ? '#fbbf24' : 'inherit',
          hint: totals.pins + ' 条固化，' + formatChars(totals.pinChars || 0) +
            (totals.pinsLost > 0 ? '；' + totals.pinsLost + ' 条已被压缩卷走（不再计入常驻）' : ''),
        },
        {
          label: '净收益',
          value: (net >= 0 ? '+' : '') + formatTokens(net) + ' token',
          color: net >= 0 ? '#34d399' : '#f87171',
          hint: '当前常驻摘要 + 重要消息约 ' + formatTokens(current ? current.tokens : 0) + ' token',
        },
      ]
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

    // 每轮请求开销：把每一轮「折叠后」与「不折叠」各重放一遍算出来的 token 账。
    // 估算不等于账单，但两者的差能说明折叠到底省在哪：省下的量随轮数累积，
    // 检查点本身每轮只付一次未命中的钱。
    // 估算与实测的口径差：只有「归折叠管的那部分」能跟 provider 回报并排比。
    // 把三段拆开写，避免把插件生效前那一轮与工具定义算成本插件的偏差。
    function costDriftNote(drift) {
      if (!drift) return '实际输入要等本轮有一次模型调用后才会出现。'
      var governed = drift.governedTokens || 0
      var text = '本插件覆盖的历史约 ' + formatTokens(governed) + ' token'
      if (drift.legacyTokens > 0) {
        text += '（另有插件生效前那一轮约 ' + formatTokens(drift.legacyTokens) + ' token 从未被折叠，实测里已被请求期压缩器改写，不计入这个口径）'
      }
      text += '；provider 实测最近一次请求 ' + formatTokens(drift.actualPromptTokens) + ' token'
      if (drift.externalTokens > 0) {
        text += '，其中约 ' + formatTokens(drift.externalTokens) + ' token 是历史之外的开销（工具定义、请求期压缩器注入的摘要）'
      }
      text += '。'
      if (drift.underEstimate) {
        return text + '实测比本插件覆盖的部分大，差额来自历史之外的开销；折叠省下的量仍按同一套重放口径算。'
      }
      if (drift.governedRatio) {
        return text + '实测约为本插件覆盖部分的 ' + Math.round(drift.governedRatio * 100) + '%。'
      }
      return text
    }

    // 校准：成本模型的两个系数是用 provider 回报反推的，页面要写清楚它从哪来，
    // 否则读者会以为那是一个手调的折扣，进而怀疑整套账单。
    function calibrationNote(cost) {
      var cal = (cost && cost.calibration) || null
      var measured = cost && typeof cost.measuredHitRate === 'number'
      var rate = cost && typeof cost.hitRate === 'number' ? cost.hitRate : 0.97
      var resend = cost && typeof cost.resendHitRate === 'number' ? cost.resendHitRate : null
      var text = '命中率 ' + percent(rate) + (measured ? '（provider 实测）' : '（默认值）')
      // 结算用的不是这个展示值：每步新写进历史的内容按定义必定未命中，留在分母里会压低命中率。
      if (resend !== null && resend > rate + 0.0005) {
        text += '，扣掉每步新增内容后 ' + percent(resend) + '（结算按这个）'
      }
      if (!cal || !cal.coveredTurns) {
        return text + '；还没有 provider 回报，校准系数按 1 计，估算可能偏高'
      }
      text += '；按 ' + cal.coveredTurns + ' 轮回报反推校准：提示词 ×' + Number(cal.promptScale).toFixed(2) + '、输出 ×' + Number(cal.outputScale).toFixed(2)
      // 被夹断说明模型本身偏了：把没夹断的系数写出来，免得把「模型错了」看成「刚好没超」。
      if (cal.promptScaleClamped) {
        text += '（夹断前 ×' + Number(cal.rawPromptScale).toFixed(2) + '，超出安全区间；先查模型口径，不要靠这个夹断值解释账单）'
      }
      return text
    }

    // 未命中口径：两种视角都要为原文付一次首次上行；折叠视角还要多付
    // 检查点、固化消息、召回返回的正文——所以不折叠的未命中总是更小一截。
    // 折叠真正省的是命中档：前缀体积小 5 倍，重复部分才便宜。
    function missNote(totals) {
      var folded = totals && typeof totals.foldedInputTokens === 'number' ? totals.foldedInputTokens : 0
      var plain = totals && typeof totals.unfoldedInputTokens === 'number' ? totals.unfoldedInputTokens : 0
      var diff = Math.max(0, folded - plain)
      return '未命中 = 内容首次上行的那一次。原文两种视角都要付一次；折叠多出检查点、固化消息、召回正文，'
        + '累计 ' + formatTokens(diff) + ' token。折叠省的是命中档：前缀体积小，重复重发的部分按缓存价便宜一半多。'
    }

    // 折叠视角的重放量应该≈ provider 实测（同一份历史在每一步被重发），对不上就直接写差多少。
    // 只比「已经有回报」的轮次：正在跑的这轮还没被 provider 计费，把它算进来会显得估算偏高。
    function estimateVsActualNote(cost) {
      var rows = Array.isArray(cost.turns) ? cost.turns : []
      var actual = 0
      var coveredFolded = 0
      var totalFolded = 0
      var pendingFolded = 0
      var pendingMoney = 0
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i] || {}
        totalFolded += row.foldedTokens || 0
        if (!row.actualPromptTokens) {
          pendingFolded += row.foldedTokens || 0
          pendingMoney += row.foldedMoney || 0
          continue
        }
        actual += row.actualPromptTokens
        coveredFolded += row.foldedTokens || 0
      }
      if (!actual || !coveredFolded) return '实测账单要等本轮有一次模型调用并拿到 provider 回报后才会出现。'
      var diff = coveredFolded / actual - 1
      var text = '折叠视角重放 ' + formatTokens(coveredFolded) + ' token，provider 实测 ' + formatTokens(actual) + ' token'
      text += Math.abs(diff) <= 0.1
        ? '；两者一致（差 ' + percent(Math.abs(diff)) + '）'
        : '；估算' + (diff > 0 ? '偏高' : '偏低') + ' ' + percent(Math.abs(diff))
      if (pendingFolded > 0) {
        text += '。另有在途轮次 ' + formatTokens(pendingFolded) + ' token（按单价约 ' + formatMoney(pendingMoney) + '）还没进实测账单，估算合计里含这部分'
      }
      return text + '。'
    }

    function CostSection(props) {
      var cost = props.cost || {}
      var totals = cost.totals || {}
      var latest = cost.latest || null
      var prices = cost.prices || { cacheHit: 0.02, input: 1, output: 4 }
      var rows = Array.isArray(cost.turns) ? cost.turns : []
      // 三档分开结算：各自乘自己的单价，加起来才是这一份历史的账单。
      // 输出在两种视角里是同一句回复，所以两边一样、净省为 0；列出来是为了把账凑齐。
      var parts = [
        { key: 'hit', label: '缓存命中输入', folded: totals.foldedHitTokens || 0, unfolded: totals.unfoldedHitTokens || 0, price: prices.cacheHit },
        { key: 'input', label: '输入（未命中）', folded: totals.foldedInputTokens || 0, unfolded: totals.unfoldedInputTokens || 0, price: prices.input },
        { key: 'output', label: '输出', folded: totals.outputTokens || 0, unfolded: totals.outputTokens || 0, price: prices.output },
      ]
      var foldedMoney = 0
      var unfoldedMoney = 0
      for (var pi = 0; pi < parts.length; pi += 1) {
        parts[pi].foldedMoney = moneyOfTokens(parts[pi].folded, parts[pi].price)
        parts[pi].unfoldedMoney = moneyOfTokens(parts[pi].unfolded, parts[pi].price)
        foldedMoney += parts[pi].foldedMoney
        unfoldedMoney += parts[pi].unfoldedMoney
      }
      var savedMoney = unfoldedMoney - foldedMoney
      var saved = totals.netSavedTokens || 0
      // 头部四张卡用 token：这份历史现在多大、折叠省了多少，都是 token 的事。
      // 金额只回答「这批 token 按当前单价折算是多少」，放在下面的表里当参考。
      var kpis = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' } },
        h(Kpi, { label: '折叠后上下文', value: formatTokens(totals.foldedTokens || 0) + ' token', color: '#34d399', hint: '按当前历史重放 ' + (totals.turns || 0) + ' 轮 / ' + (totals.steps || 0) + ' 步请求' }),
        h(Kpi, { label: '不折叠上下文', value: formatTokens(totals.unfoldedTokens || 0) + ' token', color: '#f87171', hint: '原文一直留在上下文里' }),
        h(Kpi, { label: '净省', value: (saved >= 0 ? '+' : '') + formatTokens(saved) + ' token', color: saved >= 0 ? '#34d399' : '#f87171', hint: '省 ' + percent(totals.savedRate || 0) }),
        h(Kpi, { label: '实测最近一次请求', value: latest ? formatMoney(totals.latestMoney || 0) : '—', color: '#60a5fa', hint: latest ? '真实账单；' + formatTokens(latest.promptTokens) + ' token，有回报的 ' + (totals.actualTurns || 0) + ' 轮累计 ' + formatMoney(totals.actualMoney || 0) : '本进程还没有拿到 provider 回报' })
      )
      function headCells(titles) {
        return h('tr', {}, titles.map(function (title) {
          return h('th', { key: title, style: C.th }, title)
        }))
      }
      var breakdownRows = parts.map(function (part) {
        var netMoney = part.unfoldedMoney - part.foldedMoney
        return h('tr', { key: part.key },
          h('td', { style: C.td }, part.label),
          h('td', { style: Object.assign({}, C.td, C.mono) }, formatTokens(part.folded)),
          h('td', { style: Object.assign({}, C.td, C.mono) }, formatTokens(part.unfolded)),
          h('td', { style: Object.assign({}, C.td, C.mono, { opacity: 0.7 }) }, '¥' + part.price),
          moneyCell(part.foldedMoney),
          moneyCell(part.unfoldedMoney),
          moneyCell(netMoney, netMoney > 0 ? '#34d399' : 'inherit')
        )
      })
      breakdownRows.push(h('tr', { key: 'sum' },
        h('td', { style: Object.assign({}, C.td, { fontWeight: 600 }) }, '合计'),
        h('td', { style: Object.assign({}, C.td, C.mono, { fontWeight: 600 }) }, formatTokens(totals.foldedTokens || 0)),
        h('td', { style: Object.assign({}, C.td, C.mono, { fontWeight: 600 }) }, formatTokens(totals.unfoldedTokens || 0)),
        h('td', { style: Object.assign({}, C.td, C.mono, { opacity: 0.5 }) }, '—'),
        moneyCell(foldedMoney, '#34d399'),
        moneyCell(unfoldedMoney, '#f87171'),
        moneyCell(savedMoney, savedMoney >= 0 ? '#34d399' : '#f87171')
      ))
      // 实测：provider 回报的同一套三档，金额也按同一套单价结算，能和估算并排看。
      var actualParts = [
        { key: 'hit', label: '缓存命中输入', tokens: totals.actualHitTokens || 0, price: prices.cacheHit },
        { key: 'input', label: '输入（未命中）', tokens: totals.actualInputTokens || 0, price: prices.input },
        { key: 'output', label: '输出', tokens: totals.actualOutputTokens || 0, price: prices.output },
      ]
      var actualMoney = 0
      for (var ai = 0; ai < actualParts.length; ai += 1) {
        actualParts[ai].money = moneyOfTokens(actualParts[ai].tokens, actualParts[ai].price)
        actualMoney += actualParts[ai].money
      }
      var actualTable = (totals.actualTurns || 0) > 0
        ? h('div', {},
            h('div', { style: Object.assign({}, C.sub, { margin: '10px 0 4px' }) }, '实测账单（provider 回报，' + (totals.actualTurns || 0) + ' 轮 / ' + (totals.actualSteps || 0) + ' 步）'),
            h('table', { style: C.table },
              h('thead', {}, headCells(['类别', 'token', '单价（¥ / M）', '金额'])),
              h('tbody', {}, actualParts.map(function (part) {
                return h('tr', { key: 'a' + part.key },
                  h('td', { style: C.td }, part.label),
                  h('td', { style: Object.assign({}, C.td, C.mono) }, formatTokens(part.tokens)),
                  h('td', { style: Object.assign({}, C.td, C.mono, { opacity: 0.7 }) }, '¥' + part.price),
                  moneyCell(part.money)
                )
              }).concat([
                h('tr', { key: 'asum' },
                  h('td', { style: Object.assign({}, C.td, { fontWeight: 600 }) }, '合计'),
                  h('td', { style: Object.assign({}, C.td, C.mono, { fontWeight: 600 }) }, formatTokens(totals.actualPromptTokens || 0)),
                  h('td', { style: Object.assign({}, C.td, C.mono, { opacity: 0.5 }) }, '—'),
                  moneyCell(actualMoney, '#60a5fa')
                ),
              ]))
            )
          )
        : null
      var turnTable = rows.length === 0
        ? h('div', { style: C.notice }, '还没有可估算的轮次。')
        : h('div', { style: { maxHeight: '280px', overflowY: 'auto' } },
            h('table', { style: C.table },
              h('thead', {}, headCells(['轮', '步', '折叠后', '不折叠', '净省 token', '实际输入'])),
              h('tbody', {}, rows.map(function (row) {
                var rowSaved = row.netSavedTokens || 0
                return h('tr', { key: 'c' + row.turn },
                  h('td', { style: Object.assign({}, C.td, C.mono) }, String(row.turn === null ? '?' : row.turn)),
                  h('td', { style: Object.assign({}, C.td, C.mono) }, String(row.steps || 1)),
                  h('td', { style: Object.assign({}, C.td, C.mono) }, formatTokens(row.foldedTokens)),
                  h('td', { style: Object.assign({}, C.td, C.mono) }, formatTokens(row.unfoldedTokens)),
                  h('td', { style: Object.assign({}, C.td, C.mono, { color: rowSaved >= 0 ? '#34d399' : '#f87171' }) }, (rowSaved >= 0 ? '+' : '') + formatTokens(rowSaved)),
                  h('td', { style: Object.assign({}, C.td, C.mono, { opacity: row.actualPromptTokens ? 1 : 0.4 }) }, row.actualPromptTokens ? formatTokens(row.actualPromptTokens) : '—')
                )
              }))
            )
          )
      return h('div', { style: C.section },
        h('div', { style: C.sectionHead },
          h('div', { style: C.sectionTitle }, '成本参考（按单价折算）'),
          h('div', { style: C.sub }, priceLine(prices) + ' · 折叠收益以 token 计，金额只是同一批 token 的折算参考')
        ),
        kpis,
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, '金额不是收益：同一批 token 换成高峰价就翻倍，真实请求还会被缓存与请求期压缩器改写。这里只回答「这些 token 按当前单价折算是多少」；「实测」那一栏才是 provider 回报的真实计费。'),
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, calibrationNote(cost)),
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, costDriftNote(cost.drift)),
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, missNote(totals)),
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, '三档分别结算；输出在两种视角里是同一句回复，净省为 0。'),
        h('div', { style: { fontSize: '11px', opacity: 0.6, lineHeight: '17px' } }, estimateVsActualNote(cost)),
        h('div', { style: Object.assign({}, C.sub, { margin: '10px 0 4px' }) }, '按类别拆分（估算）'),
        h('div', { style: { maxHeight: '260px', overflowY: 'auto' } },
          h('table', { style: C.table },
            h('thead', {}, headCells(['类别', '折叠后 token', '不折叠 token', '单价（¥ / M）', '折叠后', '不折叠', '净省'])),
            h('tbody', {}, breakdownRows)
          )
        ),
        actualTable,
        h('div', { style: Object.assign({}, C.sub, { margin: '10px 0 4px' }) }, '逐轮请求开销（估算）'),
        turnTable
      )
    }

    // ---------- 账本 ----------
    function Ledger(props) {
      var sessionId = props.sessionId
      var state = react.useState({ status: 'loading', data: null, error: '', at: 0 })
      var payload = state[0]
      var setPayload = state[1]
      var tick = react.useState(0)
      var alive = react.useRef(true)
      var compositionState = react.useState({ data: null, error: '' })
      var setComposition = compositionState[1]

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

      // 构成图单独一条通道：它要服务端重建模型视角，失败也只影响这两张图，不动账本数字。
      react.useEffect(function () {
        var live = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        function loadComposition() {
          fetch('/fold-composition?session=' + encodeURIComponent(sessionId), controller ? { signal: controller.signal } : undefined)
            .then(readJson)
            .then(function (body) {
              if (!live) return
              setComposition({ data: body || null, error: '' })
            })
            .catch(function (error) {
              if (!live || (error && error.name === 'AbortError')) return
              setComposition(function (previous) {
                return { data: previous.data, error: String(error && error.message ? error.message : error) }
              })
            })
        }
        loadComposition()
        var timer = setInterval(loadComposition, COMPOSITION_REFRESH_MS)
        return function () {
          live = false
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
        ledgerKpis(totals, data.current).map(function (item) {
          return h(Kpi, { key: item.label, label: item.label, value: item.value, color: item.color, hint: item.hint })
        })
      )

      var compositionBody = compositionState[0].data
      var composition = compositionBody && compositionBody.composition ? compositionBody.composition : null
      var cost = compositionBody && compositionBody.cost ? compositionBody.cost : null
      var compositionPanel = composition
        ? h(CompositionPanel, { composition: composition })
        : compositionState[0].error
          ? h('div', { style: { fontSize: '11px', color: '#f87171' } }, '上下文构成读取失败：' + compositionState[0].error + '（' + Math.round(COMPOSITION_REFRESH_MS / 1000) + ' 秒后自动重试）')
          : null

      var costSection = cost ? h(CostSection, { cost: cost }) : null

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

      var footnote = h('div', { style: { fontSize: '11px', opacity: 0.5, lineHeight: '18px' } },
        '估算口径与宿主 token-meter 一致：每 ' + (data.estimate ? data.estimate.charsPerToken : 4) + ' 字符算 1 token，每个文本块再加 ' + (data.estimate ? data.estimate.blockOverhead : 4) + ' token 开销。'
      )

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, toolbar, errorLine, kpis, compositionPanel, costSection, chartSection, tableSection, footnote)
    }

    // ---------- 模型视角 ----------
    // 这里的「折叠」只是界面收起，与插件的折叠压缩无关：收起时正文不挂进 DOM，
    // 一次展开一个才渲染一个，避免几万字一次铺开导致页面卡顿。

    function useLazyOpen() {
      var state = react.useState(false)
      return [state[0], function (event) {
        var next = event && event.currentTarget ? event.currentTarget.open === true : !state[0]
        if (next !== state[0]) state[1](next)
      }]
    }

    function firstTextOf(entry) {
      var blocks = Array.isArray(entry && entry.blocks) ? entry.blocks : []
      for (var i = 0; i < blocks.length; i += 1) {
        var text = blocks[i] && typeof blocks[i].text === 'string' ? blocks[i].text : ''
        if (text) return text
      }
      return ''
    }

    function blocksOfGroup(group) {
      var out = []
      var entries = Array.isArray(group && group.entries) ? group.entries : []
      for (var i = 0; i < entries.length; i += 1) {
        var blocks = Array.isArray(entries[i] && entries[i].blocks) ? entries[i].blocks : []
        for (var j = 0; j < blocks.length; j += 1) out.push(blocks[j])
      }
      return out
    }

    function BlockView(props) {
      var block = props.block || {}
      var kind = block.kind || 'text'
      var text = typeof block.text === 'string' ? block.text : ''
      var label = BLOCK_LABELS[kind] || '文本'
      if (kind === 'call' && block.name) label += ' ' + block.name
      return h('div', { style: Object.assign({}, tint(kind), C.blockBox) },
        h('div', { style: C.blockHead }, label + ' · ' + formatCharsTokens(text.length)),
        h('div', { style: Object.assign({}, C.blockText, props.wide ? C.blockWide : C.blockClip) }, text || '（空）')
      )
    }

    function BlockList(props) {
      var blocks = Array.isArray(props.blocks) ? props.blocks : []
      return blocks.map(function (block, index) {
        return h(BlockView, { key: 'b' + index, block: block, wide: props.wide })
      })
    }

    function FoldItem(props) {
      var item = props.item || {}
      var opened = useLazyOpen()
      var seq = item.seq === null || item.seq === undefined ? '?' : item.seq
      var blocks = Array.isArray(item.blocks) ? item.blocks : []
      var kindPart = blocks[0] || {}
      var kindLabel = recallKindLabel({ kind: kindPart.kind || 'text', name: kindPart.name || '' })
      var head = '第 ' + props.index + ' 段 · #' + seq + ' · [' + kindLabel + '] · ' + formatCharsTokens(item.chars)
      return h('details', { style: C.itemBox, onToggle: opened[1] },
        h('summary', { style: C.itemSummary }, head),
        opened[0] ? h('div', { style: C.itemBody }, h(BlockList, { blocks: item.blocks, wide: props.wide })) : null
      )
    }

    // 折叠原文按召回时的形态展示：整段够小就直接给全文，超过就先给目录（与 fold_recall 一致）。
    function foldPartsOf(record) {
      var items = Array.isArray(record && record.items) ? record.items : []
      var parts = []
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i] || {}
        var blocks = Array.isArray(item.blocks) ? item.blocks : []
        for (var j = 0; j < blocks.length; j += 1) {
          var block = blocks[j] || {}
          var text = typeof block.text === 'string' ? block.text : ''
          parts.push({ no: parts.length + 1, seq: item.seq, kind: block.kind || 'text', name: block.name || '', text: text, chars: text.length })
        }
      }
      return parts
    }

    function recallKindLabel(part) {
      var label = BLOCK_LABELS[part.kind] || '文本'
      if (part.kind === 'call' && part.name) label += ' ' + part.name
      return label
    }

    function recallIndexLines(parts, previewChars) {
      return parts.map(function (part) {
        var flat = part.text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()
        var cut = flat.length <= previewChars ? flat : flat.slice(0, Math.max(0, previewChars)) + '…'
        return '#' + part.no + ' [' + recallKindLabel(part) + '] ' + formatCharsTokens(part.chars) + '：' + (cut || '（空）')
      })
    }

    function recallPlan(record, config) {
      var settings = config || {}
      var directTokens = typeof settings.recallDirectTokens === 'number' && settings.recallDirectTokens > 0 ? settings.recallDirectTokens : 2000
      var previewTokens = typeof settings.recallIndexPreviewTokens === 'number' && settings.recallIndexPreviewTokens > 0 ? settings.recallIndexPreviewTokens : 25
      var parts = foldPartsOf(record)
      var chars = parts.reduce(function (sum, part) { return sum + part.chars }, 0)
      var tokens = Math.round(chars / 4)
      return { parts: parts, chars: chars, tokens: tokens, direct: tokens <= directTokens, directLimit: directTokens, previewChars: previewTokens * 4 }
    }

    var RECALL_LINE_STYLE = {
      fontSize: '11px',
      lineHeight: '16px',
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      padding: '1px 5px',
      borderRadius: '4px',
      background: 'rgba(127,127,127,.08)',
    }

    function FoldOriginal(props) {
      var record = props.record || {}
      var plan = recallPlan(record, props.config)
      var opened = useLazyOpen()
      var head = '折叠掉的原文 · ' + plan.parts.length + ' 段 · 约 ' + formatChars(plan.chars) + '（≈' + formatTokens(plan.tokens) + ' token）' +
        '（' + (plan.direct ? '召回时整段返回' : '召回时先给目录') + '，模型看不到）'
      // 不再单列说明段：目录行本身就带段号/类型/字数/token/预览，整段模式靠每段头部标注。
      var children = []
      if (!plan.direct) {
        var lines = recallIndexLines(plan.parts, plan.previewChars)
        for (var li = 0; li < lines.length; li += 1) {
          children.push(h('div', { key: 'idx' + li, style: RECALL_LINE_STYLE }, lines[li]))
        }
      }
      for (var pi = 0; pi < plan.parts.length; pi += 1) {
        var part = plan.parts[pi]
        children.push(h(FoldItem, {
          key: 'i' + pi,
          item: { seq: part.seq, chars: part.chars, blocks: [{ kind: part.kind, name: part.name, text: part.text }] },
          index: part.no,
          wide: props.wide,
        }))
      }
      return h('details', { style: C.nested, onToggle: opened[1] },
        h('summary', { style: C.nestedSummary }, head),
        opened[0] ? h('div', { style: C.nestedBody }, children) : null
      )
    }

    function EntryView(props) {
      var entry = props.entry || {}
      var kind = entryKindOf(entry)
      var opened = useLazyOpen()
      var role = entry.isCheckpoint
        ? '折叠摘要 ' + (entry.foldId || '')
        : entry.isPin
          ? '重要消息「' + (entry.pinLabel || '') + '」'
          : (entry.roleLabel || entry.role || '消息')
      var meta = []
      if (entry.sourceLabel) meta.push(entry.sourceLabel)
      if (entry.seq !== null && entry.seq !== undefined) meta.push('#' + entry.seq)
      meta.push(formatChars(entry.chars))
      var record = entry.foldRecord
      var hasOriginal = entry.isCheckpoint && record && Array.isArray(record.items) && record.items.length > 0
      var summary = h('summary', { style: C.entrySummary },
        h('div', { style: C.entryHead },
          h('span', { style: C.entryRole }, role),
          meta.map(function (text, index) { return h('span', { key: 'm' + index, style: C.entryMeta }, text) })
        ),
        h('div', { style: C.entryPeek }, preview(firstTextOf(entry), 140) || '（空）')
      )
      return h('details', { style: Object.assign({}, C.entry, tint(kind)), onToggle: opened[1] },
        summary,
        opened[0]
          ? h('div', { style: C.entryBody },
              h(BlockList, { blocks: entry.blocks, wide: props.wide }),
              hasOriginal ? h(FoldOriginal, { record: record, wide: props.wide, config: props.config }) : null
            )
          : null
      )
    }

    // 逐行渲染差异：+ 绿、− 红、上下文原样，超长行在服务端已截断并标注。
    function DiffView(props) {
      var diff = props.diff || {}
      if (diff.same) return [h('div', { key: 'same', style: C.sub }, '与上一版逐行一致。')]
      var hunks = Array.isArray(diff.hunks) ? diff.hunks : []
      if (hunks.length === 0) return [h('div', { key: 'none', style: C.sub }, '没有可显示的差异。')]
      var out = []
      for (var hi = 0; hi < hunks.length; hi += 1) {
        var hunk = hunks[hi] || {}
        out.push(h('div', { key: 'h' + hi, style: C.hunkHead },
          '@@ -' + hunk.aStart + ',' + hunk.aLines + ' +' + hunk.bStart + ',' + hunk.bLines + ' @@'))
        var lines = Array.isArray(hunk.lines) ? hunk.lines : []
        var rows = []
        for (var li = 0; li < lines.length; li += 1) {
          var line = lines[li] || {}
          var t = line.t === 'add' || line.t === 'del' ? line.t : 'ctx'
          var style = t === 'add'
            ? Object.assign({}, C.diffLine, C.diffAdd)
            : t === 'del'
              ? Object.assign({}, C.diffLine, C.diffDel)
              : C.diffLine
          rows.push(h('div', { key: 'l' + li, style: style }, (t === 'add' ? '+ ' : t === 'del' ? '− ' : '  ') + (line.text || '')))
        }
        out.push(h('div', { key: 'hb' + hi, style: C.diffBox }, rows))
      }
      if (diff.truncated) out.push(h('div', { key: 'tr', style: C.sub }, '（差异过多，只显示前 ' + hunks.length + ' 段）'))
      if (diff.clipped) out.push(h('div', { key: 'cl', style: C.sub }, '（有超长行被截断，只显示每行开头）'))
      return out
    }

    // 系统提示词按出现时间单独成卡：第一版看全文，之后默认只看变化。
    function SystemCard(props) {
      var group = props.group || {}
      var version = typeof group.version === 'number' && group.version > 0 ? group.version : 1
      var diff = group.diff || null
      var opened = useLazyOpen()
      var fullState = react.useState(false)
      var tags = [
        h('span', { key: 'v', style: C.tag }, '第 ' + version + ' 版'),
        h('span', { key: 'nf', style: C.tag }, '不折叠'),
      ]
      // 只有最后一条非空 system 是当前提示词；更早的版本留在历史里，模型仍会读到。
      if (props.current === true) tags.push(h('span', { key: 'cur', style: C.tag }, '当前生效'))
      else if (props.current === false) tags.push(h('span', { key: 'old', style: Object.assign({}, C.tag, { opacity: 0.7 }) }, '旧版 · 模型仍会读到'))
      if (version > 1) {
        tags.push(h('span', { key: 'd', style: C.tag }, diff ? (diff.same ? '与上一版一致' : '+' + diff.add + ' −' + diff.del) : '无差异数据'))
      }
      var summary = h('summary', { style: C.turnSummary },
        h('div', { style: C.turnHead },
          h('span', { style: C.turnNo }, '系统提示词'),
          tags,
          h('span', { style: C.turnMeta }, formatCharsTokens(group.chars) + ' · ' + (group.entries || []).length + ' 条')
        ),
        h('div', { style: C.peek },
          h('span', { style: C.peekKey }, '内容'),
          h('span', {}, preview(firstTextOf((group.entries || [])[0] || {}), 140))
        )
      )
      var body = null
      if (opened[0]) {
        if (version > 1 && diff && !diff.same) {
          var showFull = fullState[0]
          body = h('div', { style: C.turnBody },
            DiffView({ diff: diff }),
            showFull
              ? h('div', { style: C.diffFull }, h(BlockList, { blocks: blocksOfGroup(group), wide: props.wide }))
              : h('button', { style: Object.assign({}, C.button, { marginTop: '8px' }), onClick: function () { fullState[1](true) } }, '查看这一版全文')
          )
        } else {
          body = h('div', { style: C.turnBody },
            diff && diff.same ? h('div', { style: C.sub }, '与上一版逐行一致。') : null,
            h(BlockList, { blocks: blocksOfGroup(group), wide: props.wide })
          )
        }
      }
      return h('details', { style: C.turn, onToggle: opened[1] }, summary, body)
    }

    // ---------- 上下文构成（模型视角页顶部） ----------
    // 参考原生上下文面板的紧凑布局：一条占比条、可折行图例、矮趋势图。
    // 横轴按块（轮次 / 系统提示词版本），纵轴 token；颜色按用途分段。
    // token 口径与宿主 token-meter 的基本档一致：4 字符 ≈ 1 token。
    // 两种视角：折叠后 = 模型现在看到的；不折叠 = 假设一次都没折过。

    // 旧版系统提示是会话历史里的副本，真正上行的只有最后一条：不参与堆叠与合计，
    // 只在图例里留个数字当参考，否则构成图会被抬高好几倍。
    var COMPOSITION_KEYS = ['system', 'user', 'assistant', 'tools', 'inject', 'checkpoint', 'pin']

    var COMPOSITION_COLORS = {
      system: '#8b949e',
      // 旧版提示词已经没用，颜色压暗一档，和当前生效的那版拉开。
      systemHistory: '#64748b',
      user: '#3b82f6',
      assistant: '#34d399',
      tools: '#f59e0b',
      inject: '#a78bfa',
      checkpoint: '#22d3ee',
      pin: '#f472b6',
    }

    function compositionColor(key) {
      return COMPOSITION_COLORS[key] || '#8b949e'
    }

    function compositionValue(point, view, mode, key) {
      if (!point) return 0
      var bucket = mode === 'step' ? point[view] : point.cumulative ? point.cumulative[view] : null
      var chars = bucket && typeof bucket[key] === 'number' ? bucket[key] : 0
      return chars / 4
    }

    // 某一视角一块历史的总 token（七类相加）。画对照虚线用，独立于当前视图。
    function compositionTotal(point, viewName, mode) {
      var bucket = !point ? null : mode === 'step' ? point[viewName] : point.cumulative ? point.cumulative[viewName] : null
      var sum = 0
      for (var k = 0; k < COMPOSITION_KEYS.length; k += 1) {
        var value = bucket && typeof bucket[COMPOSITION_KEYS[k]] === 'number' ? bucket[COMPOSITION_KEYS[k]] : 0
        sum += value
      }
      return sum / 4
    }

    // 纵轴上限取整到 1/2/5 的整数倍，刻度不出现 3.7 这种数。
    function niceCeil(value) {
      if (!(value > 0)) return 1
      var power = Math.pow(10, Math.floor(Math.log10(value)))
      var unit = value / power
      var step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10
      return step * power
    }

    var CHART_HEIGHT = 132

    // 趋势图宽度跟容器走：viewBox 与像素宽一致，SVG 不再按宽度等比放大把面板撑高。
    function useChartWidth() {
      var ref = react.useRef(null)
      var state = react.useState(720)
      react.useEffect(function () {
        var node = ref.current
        if (!node) return
        function measure() {
          var next = node.clientWidth
          if (next > 0) state[1](Math.round(next))
        }
        measure()
        if (typeof ResizeObserver !== 'function') return
        var observer = new ResizeObserver(measure)
        observer.observe(node)
        return function () { observer.disconnect() }
      }, [])
      return [ref, state[0] > 0 ? state[0] : 720]
    }

    function CompositionChart(props) {
      var points = Array.isArray(props.points) ? props.points : []
      var view = props.view === 'unfolded' ? 'unfolded' : 'folded'
      var mode = props.mode === 'step' ? 'step' : 'total'
      var measured = useChartWidth()
      var width = measured[1]
      var height = CHART_HEIGHT
      var padLeft = 46
      var padRight = 8
      var padTop = 8
      var padBottom = 22
      var count = points.length
      if (count < 2) return h('div', { style: C.compNote }, '块数不足，画不了趋势图。')
      var plotWidth = width - padLeft - padRight
      var plotHeight = height - padTop - padBottom
      var stacks = []
      var max = 0
      var otherView = view === 'folded' ? 'unfolded' : 'folded'
      var otherTotals = []
      var otherMax = 0
      for (var i = 0; i < count; i += 1) {
        var running = 0
        var row = []
        for (var k = 0; k < COMPOSITION_KEYS.length; k += 1) {
          running += compositionValue(points[i], view, mode, COMPOSITION_KEYS[k])
          row.push(running)
        }
        stacks.push(row)
        if (running > max) max = running
        var otherValue = compositionTotal(points[i], otherView, mode)
        otherTotals.push(otherValue)
        if (otherValue > otherMax) otherMax = otherValue
      }
      // 纵轴上限要容得下两条线，否则另一视角的虚线会画出画布。
      var top = niceCeil(Math.max(max, otherMax))
      function xAt(index) {
        return padLeft + (plotWidth * index) / (count - 1)
      }
      function yAt(value) {
        return padTop + plotHeight - (plotHeight * value) / top
      }
      var grid = []
      for (var g = 0; g <= 3; g += 1) {
        var tick = (top * g) / 3
        var y = yAt(tick)
        grid.push(h('line', { key: 'g' + g, x1: padLeft, y1: y, x2: width - padRight, y2: y, stroke: 'rgba(128,128,128,.22)', strokeWidth: 1 }))
        grid.push(h('text', { key: 't' + g, x: padLeft - 6, y: y + 3, fontSize: 10, fill: 'currentColor', opacity: 0.5, textAnchor: 'end' }, formatTokens(Math.round(tick))))
      }
      var layers = []
      for (var c = 0; c < COMPOSITION_KEYS.length; c += 1) {
        var key = COMPOSITION_KEYS[c]
        var upper = []
        var lower = []
        for (var p = 0; p < count; p += 1) {
          upper.push([xAt(p), yAt(stacks[p][c])])
          lower.push([xAt(p), yAt(c === 0 ? 0 : stacks[p][c - 1])])
        }
        var path = ''
        for (var u = 0; u < upper.length; u += 1) path += (u === 0 ? 'M' : 'L') + upper[u][0].toFixed(1) + ',' + upper[u][1].toFixed(1) + ' '
        for (var lo = lower.length - 1; lo >= 0; lo -= 1) path += 'L' + lower[lo][0].toFixed(1) + ',' + lower[lo][1].toFixed(1) + ' '
        path += 'Z'
        layers.push(h('path', { key: 'a' + c, d: path, fill: compositionColor(key), fillOpacity: 0.78, stroke: 'none' }))
      }
      // 另一视角的累计总量：虚线，和面积共用纵轴，差额就是折叠省下的部分。
      var otherPath = ''
      for (var ri = 0; ri < count; ri += 1) {
        otherPath += (ri === 0 ? 'M' : 'L') + xAt(ri).toFixed(1) + ',' + yAt(otherTotals[ri]).toFixed(1) + ' '
      }
      var otherLine = h('path', {
        key: 'ref',
        d: otherPath.trim(),
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeDasharray: '5 4',
        opacity: 0.7,
      })
      // 每个块一个透明热区，鼠标停上去看这块的折叠后 / 不折叠 token 数。
      var hover = []
      var sliceWidth = plotWidth / (count - 1)
      for (var hi = 0; hi < count; hi += 1) {
        var point = points[hi]
        var fTokens = Math.round((point.totals && point.totals.folded ? point.totals.folded : 0) / 4)
        var uTokens = Math.round((point.totals && point.totals.unfolded ? point.totals.unfolded : 0) / 4)
        hover.push(h('rect', {
          key: 'h' + hi,
          x: xAt(hi) - sliceWidth / 2,
          y: padTop,
          width: sliceWidth,
          height: plotHeight,
          fill: 'transparent',
        }, h('title', {}, (point.label || '第 ' + point.ordinal + ' 块') + ' · 折叠后 ' + formatTokens(fTokens) + ' token · 不折叠 ' + formatTokens(uTokens) + ' token')))
      }
      var labels = []
      var every = Math.max(1, Math.ceil(count / 8))
      for (var li = 0; li < count; li += 1) {
        if (li % every !== 0 && li !== count - 1) continue
        var label = points[li].label || ''
        if (!label) continue
        labels.push(h('text', { key: 'l' + li, x: xAt(li), y: height - 7, fontSize: 10, fill: 'currentColor', opacity: 0.55, textAnchor: 'middle' }, label))
      }
      return h('div', { ref: measured[0], style: { width: '100%' } },
        h('svg', {
          width: width,
          height: height,
          viewBox: '0 0 ' + width + ' ' + height,
          style: { width: '100%', height: height + 'px', display: 'block' },
        }, grid.concat(layers, [otherLine], hover, labels))
      )
    }

    function CompositionPanel(props) {
      var composition = props.composition || {}
      var categories = Array.isArray(composition.categories) ? composition.categories : []
      var points = Array.isArray(composition.points) ? composition.points : []
      var totals = composition.totals || {}
      var folded = totals.folded || {}
      var unfolded = totals.unfolded || {}
      var sum = totals.sum || {}
      var foldedTotal = typeof sum.folded === 'number' ? sum.folded : 0
      var unfoldedTotal = typeof sum.unfolded === 'number' ? sum.unfolded : 0
      var viewState = react.useState('folded')
      var modeState = react.useState('total')
      var view = viewState[0]
      var mode = modeState[0]

      function tokensOf(chars) {
        return Math.round((chars || 0) / 4)
      }

      // 两条 bar 共用一条比例尺：以不折叠的总量为满格，折叠后按比例缩短。
      // 这样长度差本身就是省下的量，而不是两条各自铺满 100% 只比内部色块。
      function barLine(label, bucket, total, scale, markerRatio) {
        var ratio = scale > 0 ? Math.max(0, Math.min(1, (total || 0) / scale)) : 0
        var fill = h('div', { style: Object.assign({}, C.compFill, { width: (100 * ratio) + '%' }) },
          categories.map(function (category) {
            if (category.reference === true) return null
            var value = bucket[category.key] || 0
            if (!(value > 0)) return null
            return h('div', {
              key: category.key,
              title: category.label + ' ' + formatChars(value) + ' ≈ ' + formatTokens(tokensOf(value)) + ' token',
              style: Object.assign({}, C.compSeg, {
                width: (total > 0 ? 100 * value / total : 0) + '%',
                background: compositionColor(category.key),
              }),
            })
          }))
        var trackProps = {
          style: Object.assign({}, C.compBar, { flex: '1 1 0' }),
          title: label + '合计 ' + formatTokens(tokensOf(total)) + ' token（满格 = 不折叠总量）',
        }
        // 在不折叠那条上画一道竖线，标出「折叠后只保留到这里」的位置。
        var track = null
        if (typeof markerRatio === 'number' && markerRatio > 0 && markerRatio < 1) {
          track = h('div', trackProps, fill, h('div', {
            key: 'mark',
            title: '折叠后保留 ' + percent(markerRatio) + '，其余被折掉',
            style: Object.assign({}, C.compMark, { left: (100 * markerRatio).toFixed(2) + '%' }),
          }))
        } else {
          track = h('div', trackProps, fill)
        }
        return h('div', { style: C.compLine },
          h('span', { style: C.compLineLabel }, label),
          track,
          h('span', { style: C.compLineValue }, formatTokens(tokensOf(total)) + ' token')
        )
      }

      var legend = categories.map(function (category) {
        var f = folded[category.key] || 0
        var u = unfolded[category.key] || 0
        return h('div', {
          key: category.key,
          style: C.compItem,
          title: category.label + '：折叠后 ' + formatChars(f) + ' ≈ ' + formatTokens(tokensOf(f)) + ' token；不折叠 ' + formatChars(u) + ' ≈ ' + formatTokens(tokensOf(u)) + ' token',
        },
          h('span', { style: Object.assign({}, C.dot, { background: compositionColor(category.key) }) }),
          h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, category.label),
          h('span', { style: C.compCell }, formatTokens(tokensOf(f))),
          h('span', { style: Object.assign({}, C.compCell, { opacity: 0.55 }) }, formatTokens(tokensOf(u)))
        )
      })

      function toggle(label, active, onClick) {
        return h('button', { style: active ? C.toggleOn : C.toggleOff, onClick: onClick }, label)
      }

      var saveRate = foldedTotal > 0 ? 1 - foldedTotal / (unfoldedTotal || 1) : 0
      var barScale = Math.max(foldedTotal, unfoldedTotal)
      // 构成与趋势左右并排：两张图各自窄一点才看得出形状，宽屏也不会被拉成一整条横线。
      // 容器窄时 auto-fit 自动落回上下排。
      return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', alignItems: 'start' } },
        h('div', { style: C.section },
          h('div', { style: C.sectionHead },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
              h('div', { style: C.sectionTitle }, '上下文构成'),
              h('div', { style: C.sub }, '折叠后 ' + formatTokens(tokensOf(foldedTotal)) + ' token · 不折叠 ' + formatTokens(tokensOf(unfoldedTotal)) + ' · 省 ' + percent(saveRate))
            ),
            h('div', { style: C.sub }, '按用途分类；两条同比例尺，长度差就是省下的量（图例：折叠后 / 不折叠）。系统提示只算当前生效的那一版；旧版提示词单列在图例里，不计入合计。')
          ),
          barLine('折叠后', folded, foldedTotal, barScale, 0),
          barLine('不折叠', unfolded, unfoldedTotal, barScale, unfoldedTotal > 0 ? foldedTotal / unfoldedTotal : 0),
          h('div', { style: C.compGrid }, legend)
        ),
        h('div', { style: C.section },
          h('div', { style: C.sectionHead },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
              h('div', { style: C.sectionTitle }, '上下文趋势'),
              h('div', { style: C.sub }, '虚线是不折叠视角')
            ),
            h('div', { style: C.row },
              toggle('折叠后', view === 'folded', function () { viewState[1]('folded') }),
              toggle('不折叠', view === 'unfolded', function () { viewState[1]('unfolded') }),
              h('span', { style: { width: '6px' } }),
              toggle('总量', mode === 'total', function () { modeState[1]('total') }),
              toggle('每块增量', mode === 'step', function () { modeState[1]('step') })
            )
          ),
          h(CompositionChart, { points: points, view: view, mode: mode }),
          h('div', { style: Object.assign({}, C.compNote, { marginTop: '4px' }) }, '横轴每格是一块历史：T = 轮次，S = 系统提示词版本；面积按当前视角累加，两条线的差就是折叠省下的量。')
        )
      )
    }

    function TurnCard(props) {
      var group = props.group || {}
      if (group.kind === 'system') return h(SystemCard, { group: group, wide: props.wide, current: props.current })
      var opened = useLazyOpen()
      var label = typeof group.turn === 'number' ? '第 ' + group.turn + ' 轮' : '第 ' + (group.ordinal || 0) + ' 段'
      var tags = []
      var foldIds = Array.isArray(group.foldIds) ? group.foldIds : []
      for (var i = 0; i < foldIds.length; i += 1) tags.push(h('span', { key: 'f' + i, style: C.tag }, foldIds[i]))
      if (group.continuation) tags.push(h('span', { key: 'cont', style: C.tag }, '轮内续接'))
      if (group.folded) tags.push(h('span', { key: 'folded', style: C.tag }, '已折叠'))
      else if (group.prePlugin) tags.push(h('span', { key: 'pre', style: C.tag }, '插件生效前 · 未折叠'))
      else tags.push(h('span', { key: 'none', style: C.tag }, group.short ? '内容较少 · 未折叠' : '未折叠'))
      // 重要消息按时间顺序贴在它出现的这一轮旁边，不再在页顶做汇总。
      var pinLabels = Array.isArray(group.pinLabels) ? group.pinLabels : []
      for (var pi = 0; pi < pinLabels.length; pi += 1) {
        tags.push(h('span', { key: 'pin' + pi, style: Object.assign({}, C.tag, { color: '#8250df', borderColor: 'rgba(130,80,223,.45)' }) }, '重要消息·' + pinLabels[pi]))
      }
      var meta = (group.steps || 0) + ' 步 · ' + formatCharsTokens(group.chars) + (group.folded ? ' ← 原文 ' + formatCharsTokens(group.unfoldedChars) : '')
      var summary = h('summary', { style: C.turnSummary },
        h('div', { style: C.turnHead },
          h('span', { style: C.turnNo }, label),
          tags,
          h('span', { style: C.turnMeta }, meta)
        ),
        h('div', { style: C.peek },
          h('span', { style: C.peekKey }, '用户'),
          h('span', {}, preview(group.userText, 150))
        ),
        h('div', { style: C.peek },
          h('span', { style: C.peekKey }, '回复'),
          h('span', {}, preview(group.replyText || group.replyNote || '', 150))
        )
      )
      var entries = Array.isArray(group.entries) ? group.entries : []
      var pins = []
      var rest = []
      for (var ei = 0; ei < entries.length; ei += 1) {
        var entry = entries[ei]
        if (entry && entry.isPin) pins.push(entry)
        else rest.push(entry)
      }
      // 重要消息不从轮里删掉，而是提到轮卡片之外常显：折叠这一轮也能一眼看到。
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('details', { style: C.turn, onToggle: opened[1] },
          summary,
          opened[0]
            ? h('div', { style: C.turnBody }, rest.map(function (item, index) {
                return h(EntryView, { key: 'e' + index, entry: item, wide: props.wide, config: props.config })
              }))
            : null
        ),
        pins.map(function (pin, index) {
          return h(EntryView, { key: 'pin' + index, entry: pin, wide: props.wide, config: props.config })
        })
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
        h('div', { style: C.sub }, '这是 session.deriveMessages() 派生的真实请求历史：折叠检查点就是模型实际看到的样子；点开一轮才渲染正文，避免长历史卡顿。'),
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
      var tokens = typeof totals.tokens === 'number' ? totals.tokens : 0
      var stale = totals.staleSystem || null
      var staleText = stale && stale.count > 0
        ? '；另有 ' + stale.count + ' 条旧版系统提示（' + formatChars(stale.chars) + '）留在会话历史里但不会上行，已从合计里扣掉'
        : ''
      var notice = h('div', { style: C.notice },
        '折叠后的会话历史 ' + (totals.messages || 0) + ' 条消息、' + formatChars(totals.chars) + '，约 ' +
        formatTokens(tokens) + ' token（4 字符/token，按块 +4）；折叠检查点 ' + (totals.checkpoints || 0) +
        ' 条、重要消息 ' + (totals.pins || 0) + ' 条；相比不折叠省 ' + formatChars(totals.savedChars) +
        '（' + percent(totals.saveRate) + '）' + staleText + '。'
      )
      var actual = data.actual || null
      var gap = actual ? tokens > actual.promptTokens * 1.3 : false
      var actualNote = actual
        ? h('div', { style: { fontSize: '11px', lineHeight: '17px', color: gap ? '#fbbf24' : 'inherit', opacity: gap ? 1 : 0.7 } },
            'provider 回报：最近一次请求的计费输入 ' + formatTokens(actual.promptTokens) + ' token（新输入 ' + formatTokens(actual.inputTokens) + ' + 缓存命中 ' + formatTokens(actual.cacheReadTokens) + ' + 写缓存 ' + formatTokens(actual.cacheWriteTokens) + '）。' +
            (gap
              ? '它明显少于上面的估算：还有请求期压缩在改写信史（例如 billion-context），上面的数字量的是会话历史，不是真正上行的内容。'
              : '这里的估算与账单同向。'))
        : h('div', { style: { fontSize: '11px', lineHeight: '17px', opacity: 0.5 } }, 'provider 回报要等本轮发生一次模型调用后才有。')
      var warns = (data.warns || []).map(function (text, index) {
        return h('div', { key: 'w' + index, style: { fontSize: '11px', opacity: 0.65, lineHeight: '17px' } }, '· ' + text)
      })
      var groups = Array.isArray(data.groups) ? data.groups : []
      // 当前系统提示 = 最后一个非空 system 组；前面的版本只是留在历史里的旧副本。
      var lastSystemIndex = -1
      for (var gi = 0; gi < groups.length; gi += 1) {
        var candidate = groups[gi]
        if (candidate && candidate.kind === 'system' && candidate.chars > 0) lastSystemIndex = gi
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        toolbar,
        notice,
        actualNote,
        warns.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, warns) : null,
        groups.map(function (group, index) {
          return h(TurnCard, { key: 'g' + index, group: group, wide: wide[0], config: data.config, current: index === lastSystemIndex })
        })
      )
    }

    // ---------- 插件设置页（渲染在侧栏「插件」页的 dsh-fold-context 页面上） ----------
    function fieldRange(field) {
      if (!field) return ''
      var base = field.kind === 'boolean'
        ? 'true / false'
        : field.kind === 'string'
          ? '不超过 ' + field.maxChars + ' 字'
          : field.kind === 'price'
            ? field.min + '~' + field.max + ' 元 / 百万 token'
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
        submit({ reset: true }, '已写入默认配置（覆盖 profile 里的同名值）。')
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
            step: field.kind === 'ratio' || field.kind === 'price' ? '0.01' : '1',
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
      var tabs = [['ledger', '账本'], ['model', '模型视角']]
      var header = h('div', { style: C.row },
        h('div', { style: C.title }, '上下文折叠'),
        h('div', { style: C.sub }, '按轮折叠 · 折叠算收益，召回与重要消息算成本 · 参数在侧栏「插件」页的 dsh-fold-context 页面里调'),
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
      // 参数表单挂在原生「插件」页的组合包配置位上，而不是对话顶栏：
      // 顶栏只放这个会话的账本与模型视角，改参数属于插件自身的一次性设置。
      // key 是组合包名，注册只在组合包开启期间存在。
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-fold-context',
        }, SettingsView)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 供 node 冒烟测试直接调用组件函数：客户端没有测试框架，暴露内部组件比引入依赖便宜。
    exports.__test = {
      CompositionPanel: CompositionPanel,
      CompositionChart: CompositionChart,
      TurnCard: TurnCard,
      entryKindOf: entryKindOf,
      costDriftNote: costDriftNote,
      calibrationNote: calibrationNote,
      CostSection: CostSection,
      ledgerKpis: ledgerKpis,
      formatMoney: formatMoney,
      FoldOriginal: FoldOriginal,
      foldPartsOf: foldPartsOf,
      recallPlan: recallPlan,
      recallIndexLines: recallIndexLines,
    }
    return module.exports
  },
})