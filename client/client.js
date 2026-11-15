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
    // 宿主注入的 react 版本不一定带 useMemo；没有就退回每次现算，解析本身是线性的。
    var useMemoHook = typeof react.useMemo === 'function' ? react.useMemo : null
    var REFRESH_MS = 5000
    // 构成图要服务端重建一份模型视角，比账本数字贵得多，单独按更慢的节奏拉。
    var COMPOSITION_REFRESH_MS = 20000
    // 引用跳转的出口：组件树从上到下要穿五层，传一串回调不如放一个模块级出口。
    // ModelView 挂载时注册、卸载时清空，跳转目标永远指向当前这一页。
    var NAV = { jump: null, refs: null, gen: 0 }

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

    // 切分点要精确到字：这是「原文多少字 / 这次给了多少」的坐标，不能四舍五入成 7.3k。
    function exactChars(value) {
      var n = typeof value === 'number' && isFinite(value) ? Math.round(value) : 0
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 字'
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

    // 摘要只取前 limit 个可见字符：先把开头一段压平，够长就截，不够再往后看。
    // 不能上全局替换——一条工具输出可能有几十万字，每张收起的卡片都扫一遍就是白烧 CPU。
    function preview(text, limit) {
      var source = String(text === null || text === undefined ? '' : text)
      var got = Math.max(limit * 4, 400)
      var flat = ''
      while (true) {
        var cut = Math.min(got, source.length)
        flat = source.slice(0, cut).replace(/\s+/g, ' ').trim()
        if (flat.length > limit || cut >= source.length) break
        got = cut * 2
      }
      if (!flat) return '（没有文字）'
      return flat.length <= limit ? flat : flat.slice(0, limit) + '…'
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
      panel: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '0 22px 32px', minHeight: '100%', boxSizing: 'border-box' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      sub: { fontSize: '12px', opacity: 0.62, lineHeight: '18px' },
      // 顶栏贴住视口上沿：横向用负边距吃掉面板留白，底色不透明才遮得住滑过去的正文。
      // 宿主把对话内容放在 overflow:auto 的滚动容器里，这里只负责在容器内粘住，不改宿主的布局。
      header: {
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        margin: '0 -22px',
        padding: '14px 22px 0',
        background: 'var(--dsw-alias-bg-base, #1b1d21)',
        borderBottom: '1px solid rgba(128,128,128,.22)',
      },
      headerTop: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      headerMeta: { marginLeft: 'auto', fontSize: '11px', opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
      headerMetaError: { color: '#f87171', opacity: 1 },
      tabRow: { display: 'flex', alignItems: 'flex-end' },
      tab: { fontSize: '13px', padding: '7px 1px', marginRight: '20px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.62, cursor: 'pointer' },
      tabActive: { opacity: 1, borderBottomColor: '#34d399', fontWeight: 600 },
      tabHint: { marginLeft: 'auto', fontSize: '11px', opacity: 0.42, paddingBottom: '7px' },
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
      // 口径说明是「查账时才会读」的参考文字：收进一条折叠行，别让七段小字压在账本上。
      notesBox: { margin: '10px 0 2px', border: '1px solid rgba(128,128,128,.18)', borderRadius: '8px', padding: '2px 10px 4px' },
      notesSummary: { fontSize: '11px', opacity: 0.62, cursor: 'pointer', listStyle: 'none', padding: '4px 0' },
      noteLine: { fontSize: '11px', opacity: 0.62, lineHeight: '18px', margin: '4px 0 0' },
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
      // 段数一多，清单就会把页面越拉越长：装进固定高度的滚动区，滚轮在框内走，页面高度不再随段数增长。
      scrollBox: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: 'min(56vh, 560px)', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px', scrollbarWidth: 'thin' },
      scrollBoxTight: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: 'min(38vh, 340px)', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px', scrollbarWidth: 'thin' },
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

    // 召回标记按方向分三种颜色：被召回红、召回黄、检索橘黄。三种色相在正文灰底上互相拉开，
    // 再加同色浅底与不透明的文字——C.tag 默认半透明灰边，那种规格在几万字的清单里会沉进正文，
    // 扫不出来就等于没标。账本里「召回成本」的红是数字不是标签，两者不在同一处，不会混。
    var RECALL_HUES = { recalled: '239,68,68', recall: '234,179,8', search: '249,115,22' }
    var RECALL_TEXT = { recalled: '#ef4444', recall: '#eab308', search: '#f97316' }

    function recallTagStyle(kind) {
      var hue = RECALL_HUES[kind] || RECALL_HUES.recall
      return {
        color: RECALL_TEXT[kind] || RECALL_TEXT.recall,
        borderColor: 'rgba(' + hue + ',.55)',
        background: 'rgba(' + hue + ',.16)',
        opacity: 1,
        fontWeight: 600,
      }
    }

    var RECALL_TAG_STYLE = recallTagStyle('recall')
    var SEARCH_TAG_STYLE = recallTagStyle('search')
    var RECALLED_TAG_STYLE = recallTagStyle('recalled')
    // 能点的标签：颜色说明方向，指针说明可以跳过去。
    var CHIP_CLICK = { cursor: 'pointer' }
    // 跳转落点短暂描边：滚过去之后得看得见落在哪一段上。
    var FLASH_STYLE = { outline: '1px solid rgba(234,179,8,.65)', outlineOffset: '1px' }

    // 一次调用是召回还是检索，只看它有没有折叠编号：只给 query 的是关键词检索，没有返回原文。
    function recallCallStyle(call) {
      return call && call.id ? RECALL_TAG_STYLE : SEARCH_TAG_STYLE
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
          hint: totals.recalls + ' 次召回' + (totals.probes > 0 ? ' + ' + totals.probes + ' 次目录/检索（同样计入成本）' : '') + '，' + totals.recalledFolds + ' 段被回看过',
        },
        {
          label: '重要消息成本',
          value: (pin > 0 ? '−' : '') + formatTokens(pin) + ' token',
          color: pin > 0 ? '#fbbf24' : 'inherit',
          hint: totals.pins + ' 条固化，' + formatCharsTokens(totals.pinChars || 0) +
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
    // 多出来的那一截按来源拆开写：只报合计数时，读者分不出「分段目录」与「召回原文」各占多少，
    // 而分段目录恰恰是最容易被误当成免费的那一笔——它是 fold_recall 的工具结果，同样按未命中计。
    function overheadParts(totals) {
      var overhead = totals && totals.pluginOverhead
      if (!overhead) return []
      var parts = []
      if (overhead.checkpoint > 0) parts.push('检查点 ' + formatTokens(overhead.checkpoint))
      if (overhead.recall > 0) parts.push('召回原文 ' + formatTokens(overhead.recall))
      if (overhead.probe > 0) parts.push('分段目录与检索 ' + formatTokens(overhead.probe))
      if (overhead.pin > 0) parts.push('重要消息 ' + formatTokens(overhead.pin))
      return parts
    }

    function missNote(totals) {
      var folded = totals && typeof totals.foldedInputTokens === 'number' ? totals.foldedInputTokens : 0
      var plain = totals && typeof totals.unfoldedInputTokens === 'number' ? totals.unfoldedInputTokens : 0
      var diff = Math.max(0, folded - plain)
      var parts = overheadParts(totals)
      var detail = parts.length > 0
        ? parts.join('、') + '，合计 ' + formatTokens(diff) + ' token'
        : '检查点、固化消息、召回正文，累计 ' + formatTokens(diff) + ' token'
      return '未命中 = 内容首次上行的那一次。原文两种视角都要付一次；折叠多出的是插件自己写进上下文的内容：'
        + detail + '。分段目录与关键词检索也是 fold_recall 的工具结果，同样算在这笔未命中里。'
        + '折叠省的是命中档：前缀体积小，重复重发的部分按缓存价便宜一半多。'
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
                // 逐轮把插件额外开销拆在提示里：合计数看不出「取目录」也算了一笔，拆开才查得动账。
                var overhead = row.pluginOverhead
                var overheadTitle = overhead && overhead.total > 0
                  ? '第 ' + row.turn + ' 轮插件额外首次上行：检查点 ' + formatTokens(overhead.checkpoint || 0) +
                    '、召回原文 ' + formatTokens(overhead.recall || 0) +
                    '（其中分段目录与检索 ' + formatTokens(overhead.probe || 0) + '）、重要消息 ' + formatTokens(overhead.pin || 0)
                  : undefined
                return h('tr', { key: 'c' + row.turn },
                  h('td', { style: Object.assign({}, C.td, C.mono), title: overheadTitle }, String(row.turn === null ? '?' : row.turn)),
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
        // 六条口径说明每年看两次：收进折叠行，账本主体只剩数字与表。
        h('details', { style: C.notesBox },
          h('summary', { style: C.notesSummary }, '口径与校准说明：金额不是收益、未命中怎么算、估算与实测差多少'),
          h('div', { style: C.noteLine }, '金额不是收益：同一批 token 换成高峰价就翻倍，真实请求还会被缓存与请求期压缩器改写。这里只回答「这些 token 按当前单价折算是多少」；「实测」那一栏才是 provider 回报的真实计费。'),
          h('div', { style: C.noteLine }, '三档分别结算；输出在两种视角里是同一句回复，净省为 0。'),
          h('div', { style: C.noteLine }, calibrationNote(cost)),
          h('div', { style: C.noteLine }, costDriftNote(cost.drift)),
          h('div', { style: C.noteLine }, missNote(totals)),
          h('div', { style: C.noteLine }, estimateVsActualNote(cost))
        ),
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
      }, [sessionId])

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
      }, [sessionId])

      var data = payload.data
      var totals = data && data.totals ? data.totals : null
      // 刷新时间放在顶栏：它属于整页的新鲜度，不该跟着内容滚出屏幕。
      react.useEffect(function () {
        if (!props.onMeta) return
        var at = payload.at || (payload.data && payload.data.generatedAt) || 0
        props.onMeta({
          text: at ? '更新于 ' + clock(at) + ' · 每 5 秒自动刷新' : '正在读取…',
          error: payload.status === 'error' ? payload.error : '',
        })
      }, [payload.at, payload.status, payload.error])

      var errorLine = payload.status === 'error' && payload.error
        ? h('div', { style: { fontSize: '12px', color: '#f87171' } }, '读取统计失败：' + payload.error + '（每 5 秒会自动重试）')
        : null

      if (!data) {
        return h('div', {}, errorLine,
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

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, errorLine, kpis, compositionPanel, costSection, chartSection, tableSection, footnote)
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

    // 跳转落点：打开目标 details（顺带触发按需加载）、滚到看得见的地方、短暂描边。
    // gen 每次跳转都变，依赖它才能在同一个落点上连续跳两次。
    function useReveal(ref, active, gen, withFlash) {
      var flash = react.useState(false)
      react.useEffect(function () {
        if (!active || !ref.current) return
        var node = ref.current
        if (node.open !== true) node.open = true
        var scroll = setTimeout(function () {
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 80)
        var clear = null
        if (withFlash) {
          flash[1](true)
          clear = setTimeout(function () { flash[1](false) }, 1800)
        }
        return function () {
          clearTimeout(scroll)
          if (clear) clearTimeout(clear)
        }
      }, [gen])
      return flash[0]
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

    // ---------- 召回结果：分段原文折起来看，截断点单独标出来 ----------
    // 模型视角里的 fold_recall 返回就是一整块工具结果正文，分段召回动辄几万字：
    // 平铺进 DOM 既卡，也看不出哪一段是取回的、单次上限切在哪。
    // 这里沿用工具自己写的段头再切一遍，每段一个折叠条目，切分点单独一行。
    var CUT_STYLE = {
      fontSize: '11px',
      lineHeight: '17px',
      color: '#b45309',
      background: 'rgba(217,119,6,.10)',
      border: '1px dashed rgba(217,119,6,.55)',
      borderRadius: '5px',
      padding: '3px 7px',
      marginTop: '4px',
    }

    function isNoteLine(line) {
      return /^(（|…（)/.test(String(line || ''))
    }

    // 三种返回形态各有一种表头（整段 / 分段 / 目录）；认不出来就退回普通块，绝不改写原文。
    function parseRecallResult(text) {
      var value = typeof text === 'string' ? text : ''
      if (value.indexOf('折叠 ') !== 0) return null
      var newline = value.indexOf('\n')
      var head = newline < 0 ? value : value.slice(0, newline)
      var body = newline < 0 ? '' : value.slice(newline + 1)
      var match = null
      var result = null
      if ((match = /^折叠 (\S+)（第 (\d+) 轮）取回 (\d+)\/(\d+) 段：$/.exec(head))) {
        result = { kind: 'parts', id: match[1], turn: Number(match[2]), picked: Number(match[3]), total: Number(match[4]) }
      } else if ((match = /^折叠 (\S+)（第 (\d+) 轮，原文约 ([\d,]+) 字，≈(\d+) token，共 (\d+) 段）原文较长，先给目录。$/.exec(head))) {
        // 组号依次是：编号、轮次、原文字数、token 估算、总段数。
        result = { kind: 'index', id: match[1], turn: Number(match[2]), chars: match[3], totalParts: Number(match[5]) }
      } else if ((match = /^折叠 (\S+)（第 (\d+) 轮，原文约 ([\d,]+) 字，≈(\d+) token）$/.exec(head))) {
        result = { kind: 'direct', id: match[1], turn: Number(match[2]), chars: match[3] }
      }
      if (!result) return null
      result.head = head
      result.segments = []
      result.notes = []
      result.lines = []
      var lines = body.split('\n')

      // 目录：正文是逐行的段号清单，尾注是「目录已截断」这类提示。
      if (result.kind === 'index') {
        for (var li = 0; li < lines.length; li += 1) {
          var indexLine = lines[li]
          if (!indexLine.trim()) continue
          if (isNoteLine(indexLine)) result.notes.push({ cut: indexLine.indexOf('截断') >= 0, text: indexLine.trim() })
          else result.lines.push(indexLine)
        }
        return result
      }

      // 整段 / 分段：按段头切，段内截断与尾注各归各位。
      // 只把「后面全是注释」的括号行当尾注：正文里偶有一行以括号开头，不能因此把后半段吃掉。
      function notesOnlyFrom(from) {
        for (var t = from; t < lines.length; t += 1) {
          var probe = lines[t].trim()
          if (probe && !isNoteLine(probe)) return false
        }
        return true
      }
      var current = null
      function closeSegment() {
        if (!current) return
        current.text = current.text.replace(/\n+$/, '')
        result.segments.push(current)
        current = null
      }
      for (var si = 0; si < lines.length; si += 1) {
        var line = lines[si]
        var section = /^--- #(\d+)(?: (.+?))? ---$/.exec(line)
        if (section) {
          closeSegment()
          current = { no: Number(section[1]), label: section[2] || '', text: '', cut: null }
          continue
        }
        var trimmed = line.trim()
        // 段内截断：工具在段尾写「本段已截断」，正文切在那里，截断点单独标出来。
        if (current && trimmed.indexOf('…（本段已截断：') === 0) {
          var cut = /^…（本段已截断：原文 (\d+) 字，≈\d+ token，本次只返回前 (\d+) 字。需要完整内容请再按段召回。）$/.exec(trimmed)
          if (cut) {
            current.cut = { full: Number(cut[1]), kept: Number(cut[2]) }
            closeSegment()
            continue
          }
        }
        if (isNoteLine(trimmed) && notesOnlyFrom(si + 1)) {
          closeSegment()
          result.notes.push({
            cut: trimmed.indexOf('没取回') >= 0 || trimmed.indexOf('被截断') >= 0 || trimmed.indexOf('目录已截断') >= 0,
            text: trimmed,
          })
          continue
        }
        if (!current) continue
        current.text += (current.text ? '\n' : '') + line
      }
      closeSegment()
      return result
    }

    function recallCutText(cut) {
      return '✂ 单次上限切在这里：原文 ' + exactChars(cut.full) + '，本次只返回前 ' + exactChars(cut.kept) +
        '；要完整内容就按这一段再召回。'
    }

    function RecallSegment(props) {
      var opened = useLazyOpen()
      var segment = props.segment || {}
      var body = typeof segment.text === 'string' ? segment.text : ''
      var cut = segment.cut || null
      var head = '#' + segment.no + (segment.label ? ' [' + segment.label + ']' : '') + ' · ' + formatCharsTokens(body.length) +
        (cut ? ' · 已截断' : '')
      return h('details', { style: C.itemBox, onToggle: opened[1] },
        h('summary', {
          style: C.itemSummary,
          // 切分点写在 title 里：收起时也能量出「原文多少、这次给了多少」。
          title: cut ? '这一段超过单次召回上限：原文 ' + exactChars(cut.full) + '，本次只返回前 ' + exactChars(cut.kept) : undefined,
        }, head),
        opened[0]
          ? h('div', { style: C.itemBody },
              h('div', { style: Object.assign({}, C.blockText, props.wide ? C.blockWide : C.blockClip) }, body || '（空）'),
              cut ? h('div', { style: CUT_STYLE }, recallCutText(cut)) : null
            )
          : null
      )
    }

    function RecallResult(props) {
      var parsed = props.parsed || {}
      var opened = useLazyOpen()
      var segments = Array.isArray(parsed.segments) ? parsed.segments : []
      var notes = Array.isArray(parsed.notes) ? parsed.notes : []
      var cuts = 0
      var chars = 0
      for (var i = 0; i < segments.length; i += 1) {
        if (segments[i] && segments[i].cut) cuts += 1
        chars += segments[i] && typeof segments[i].text === 'string' ? segments[i].text.length : 0
      }
      var segmentNos = []
      if (parsed.kind !== 'index') {
        for (var s = 0; s < segments.length; s += 1) if (segments[s]) segmentNos.push(segments[s].no)
      }
      // 目录形态的正文就是这些行：目录自己也占上下文，收起行要把它的字数与 token 一起给出来，
      // 否则只写「目录 128 段」，看不出这一面墙有多大。
      var indexLines = parsed.kind === 'index' && Array.isArray(parsed.lines) ? parsed.lines : []
      var indexChars = 0
      for (var il = 0; il < indexLines.length; il += 1) indexChars += String(indexLines[il] || '').length + 1
      // 「召回 fN」单独成标签：这次工具调用取回了哪份折叠，是这一块最要紧的身份信息。
      var headLead = '召回 ' + parsed.id
      var head = ''
      if (parsed.kind === 'parts') {
        // 取回范围直接写进收起行：点了哪几段不必展开就能核对。
        head = '分段取回 ' + parsed.picked + '/' + parsed.total + ' 段'
        // 只列这次正文里真的出现的段号；因预算没取回的段由下面的尾注说明，不在这里凑数。
        var ranges = compactRanges(segmentNos)
        if (ranges) head += '（' + ranges + '）'
      } else if (parsed.kind === 'direct') {
        head = '整段取回 ' + segments.length + ' 段'
      } else {
        head = '分段目录 ' + (parsed.totalParts || 0) + ' 段（原文没有返回）'
        if (indexLines.length > 0) head += ' · ' + formatCharsTokens(indexChars)
      }
      if (segments.length > 0) head += ' · ' + formatChars(chars)
      if (cuts > 0) head += ' · ' + cuts + ' 段被截断'
      var omitted = 0
      for (var n = 0; n < notes.length; n += 1) {
        var miss = /还有 (\d+) 段没取回/.exec(notes[n].text || '')
        if (miss) omitted += Number(miss[1])
      }
      if (omitted > 0) head += ' · ' + omitted + ' 段没取回'
      var children = []
      if (parsed.kind === 'index') {
        for (var l = 0; l < indexLines.length; l += 1) {
          children.push(h('div', { key: 'l' + l, style: RECALL_LINE_STYLE }, indexLines[l]))
        }
      } else {
        for (var s = 0; s < segments.length; s += 1) {
          children.push(h(RecallSegment, { key: 's' + s, segment: segments[s], wide: props.wide }))
        }
      }
      // 取回的段、目录行同样限高：一次分段召回可能取回几十段，展开后不该把页面拉长。
      // 尾注留在框外——切分点与「还有 N 段没取回」是要紧信息，不能被滚走。
      var listLimit = parsed.kind === 'index' ? LINE_SCROLL_AFTER : PART_SCROLL_AFTER
      var body = children.length > listLimit
        ? [h('div', {
            key: 'list',
            style: parsed.kind === 'index' ? C.scrollBoxTight : C.scrollBox,
            title: children.length + ' 行，在框内滚动查看',
          }, children)]
        : children
      for (var k = 0; k < notes.length; k += 1) {
        body.push(h('div', {
          key: 'n' + k,
          style: notes[k].cut ? CUT_STYLE : RECALL_LINE_STYLE,
        }, notes[k].text))
      }
      return h('details', { style: C.nested, onToggle: opened[1] },
        h('summary', { style: Object.assign({}, C.nestedSummary, { opacity: 1 }), title: parsed.head || '' },
          h('span', { style: Object.assign({}, C.tag, RECALL_TAG_STYLE, { marginRight: '6px' }) }, headLead),
          h('span', { style: { opacity: 0.7 } }, head)
        ),
        opened[0] ? h('div', { style: C.nestedBody }, body) : null
      )
    }

    function BlockView(props) {
      var block = props.block || {}
      var kind = block.kind || 'text'
      var text = typeof block.text === 'string' ? block.text : ''
      var label = BLOCK_LABELS[kind] || '文本'
      if (kind === 'call' && block.name) label += ' ' + block.name
      // fold_recall 的返回按段折起来：长原文不摊进 DOM，取回范围与切分点直接写在标题上。
      var recall = useMemoHook
        ? useMemoHook(function () { return kind === 'result' ? parseRecallResult(text) : null }, [text])
        : kind === 'result' ? parseRecallResult(text) : null
      if (recall) {
        // 外层保留工具结果的底色与块头，内层才是可折叠的召回明细：块的归属不变，只是多收了一层。
        return h('div', { style: Object.assign({}, tint(kind), C.blockBox) },
          h('div', { style: C.blockHead }, label + ' · ' + formatCharsTokens(text.length)),
          h(RecallResult, { parsed: recall, wide: props.wide })
        )
      }
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
      var ownRef = react.useRef(null)
      // 跳转落点：这一段的段号对上了就展开、滚过去、描一下边。
      var focus = props.focus
      var focusHere = focus && typeof focus.part === 'number' && focus.part === props.index
      var flash = useReveal(ownRef, focusHere, focusHere ? focus.gen : 0, true)
      var seq = item.seq === null || item.seq === undefined ? '?' : item.seq
      var blocks = Array.isArray(item.blocks) ? item.blocks : []
      var kindPart = blocks[0] || {}
      var kindLabel = recallKindLabel({ kind: kindPart.kind || 'text', name: kindPart.name || '' })
      var head = '第 ' + props.index + ' 段 · #' + seq + ' · [' + kindLabel + '] · ' + formatCharsTokens(item.chars)
      // 折叠原文里的召回调用也标出来：段头一行能看出这段曾在哪次召回里被取回。
      // 以前是一串灰字拼在段头后面，混在等宽清单里看不出边界，现在与条目上的标记同规格。
      var calls = Array.isArray(item.recallCalls) ? item.recallCalls : []
      var callTags = []
      for (var ci = 0; ci < calls.length && ci < 2; ci += 1) {
        callTags.push(h('span', {
          key: 'rc' + ci,
          style: Object.assign({}, C.tag, recallCallStyle(calls[ci]), CHIP_CLICK),
          title: recallCallTitle(calls[ci]) + '；点开跳到被召回的段',
          onClick: (function (call) {
            return function (event) {
              event.preventDefault()
              event.stopPropagation()
              openCallRefs(call)
            }
          })(calls[ci]),
        }, recallChipLabel(calls[ci])))
      }
      if (calls.length > 2) {
        callTags.push(h('span', {
          key: 'rcmore',
          style: Object.assign({}, C.tag, RECALL_TAG_STYLE),
          title: '还有 ' + (calls.length - 2) + ' 次召回调用',
        }, '另 ' + (calls.length - 2) + ' 次'))
      }
      // 方向相反的另一种标记：这一段被后来的分段召回取回过几次（不是它内部发起的调用）。
      var recalled = typeof props.recallCount === 'number' && props.recallCount > 0 ? props.recallCount : 0
      var refs = Array.isArray(props.refs) ? props.refs : []
      // 这一段只是被关键词检索点到过：检索没有返回原文，所以与被召回分开标、分开数。
      var searchRows = props.searchedParts && typeof props.searchedParts === 'object' ? props.searchedParts[props.index] : null
      var searched = Array.isArray(searchRows) ? searchRows.length : 0
      var titleBits = []
      if (recalled > 0) titleBits.push('这一段被 fold_recall 取回 ' + recalled + ' 次')
      if (searched > 0) titleBits.push('这一段被关键词检索命中 ' + searched + ' 次（检索不返回原文）')
      if (calls.length > 0) titleBits.push(calls.map(recallCallTitle).join('\n'))
      return h('details', { ref: ownRef, style: flash ? Object.assign({}, C.itemBox, FLASH_STYLE) : C.itemBox, onToggle: opened[1] },
        // 收起行默认半透明；行里放了彩色标签，父级的透明度会把标签一起压灰，所以这里改成不透明，
        // 灰度只落在段头文字上——标签必须保持标签的颜色。
        h('summary', { style: Object.assign({}, C.itemSummary, { opacity: 1 }), title: titleBits.length > 0 ? titleBits.join('\n') : undefined },
          h('span', { style: { opacity: 0.72 } }, head),
          callTags.length > 0
            ? h('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap', marginLeft: '6px' } }, callTags)
            : null,
          recalled > 0
            ? h('span', {
                style: Object.assign({}, C.tag, RECALLED_TAG_STYLE, { marginLeft: '6px' }, refs.length > 0 ? CHIP_CLICK : {}),
                title: refs.length > 0 ? '这一段被取回 ' + recalled + ' 次；点开看是哪几次调用' : '这一段被取回 ' + recalled + ' 次',
                onClick: refs.length > 0
                  ? function (event) {
                      event.preventDefault()
                      event.stopPropagation()
                      // 这一段自己就是反查的起点：把它的开头一起带进面板。
                      openPartRefs(props.partRefs, props.index, segmentPreview(blocks[0] && blocks[0].text))
                    }
                  : undefined,
              }, '被召回 ' + recalled + ' 次')
            : null,
          searched > 0
            ? h('span', {
                style: Object.assign({}, C.tag, SEARCH_TAG_STYLE, { marginLeft: '6px' }, CHIP_CLICK),
                title: '这一段被关键词检索命中 ' + searched + ' 次；点开看是哪几次检索',
                onClick: function (event) {
                  event.preventDefault()
                  event.stopPropagation()
                  openSearchRefs(props.searchedParts, props.searchedRefs, props.index, segmentPreview(blocks[0] && blocks[0].text))
                },
              }, '被检索 ' + searched + ' 次')
            : null
        ),
        opened[0] ? h('div', { style: C.itemBody }, h(BlockList, { blocks: item.blocks, wide: props.wide })) : null
      )
    }

    // 回复的 markdown 标题：与 lib/markdown.js 同一套规则（ATX 标题、跳过代码块、至少两个标题）。
    // 只用在「需要分段」的长回复上；短回复仍整段展示，和召回行为一致。
    function headingLines(text) {
      var lines = String(text === null || text === undefined ? '' : text).split('\n')
      var out = []
      var fence = ''
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i]
        var fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (fenceMatch) {
          var mark = fenceMatch[1]
          var rest = fenceMatch[2].trim()
          if (!fence) fence = mark
          else if (rest === '' && mark.charAt(0) === fence.charAt(0) && mark.length >= fence.length) fence = ''
          continue
        }
        if (fence) continue
        var heading = line.match(/^ {0,3}(#{1,6})(?:[ \t\u3000]+(.*?))?[ \t\u3000]*$/)
        if (!heading) continue
        var title = String(heading[2] || '').replace(/[ \t\u3000]+#+[ \t\u3000]*$/, '').trim()
        if (!title) continue
        out.push({ line: i, title: title })
      }
      return out
    }

    function splitReplySections(text) {
      var value = String(text === null || text === undefined ? '' : text)
      var lines = value.split('\n')
      var headings = headingLines(value)
      if (headings.length < 2) return null
      var sections = []
      if (headings[0].line > 0) {
        var intro = lines.slice(0, headings[0].line).join('\n').trim()
        if (intro) sections.push(intro)
      }
      for (var i = 0; i < headings.length; i += 1) {
        var from = headings[i].line
        var to = i + 1 < headings.length ? headings[i + 1].line : lines.length
        var body = lines.slice(from, to).join('\n').replace(/[ \t\n]+$/, '')
        if (body) sections.push(body)
      }
      return sections
    }

    // 一段自己发起的调用：块归属由服务端随段下发（recallCallBlocks 是「第几次调用来自第几个块」）。
    // 模型先思考再调用时，一条消息会切成思考段与调用段两段，标记只该落在调用段上——
    // 以前按条目取调用，两段都是同一串 chip，等于把标记撒了一地。
    // 老数据没有块归属时退回「调用块整条带走」：至少不会落到思考段上。
    function callsOfBlock(item, blockIndex, block) {
      if (!block || (block.kind || 'text') !== 'call') return []
      var calls = Array.isArray(item && item.recallCalls) ? item.recallCalls : []
      if (calls.length === 0) return []
      var owners = Array.isArray(item && item.recallCallBlocks) ? item.recallCallBlocks : null
      if (!owners || owners.length !== calls.length) return calls
      var out = []
      for (var i = 0; i < calls.length; i += 1) if (owners[i] === blockIndex) out.push(calls[i])
      return out
    }

    // 折叠原文按召回时的形态展示：整段够小就直接给全文，超过就先给目录（与 fold_recall 一致）。
    // 长 markdown 回复按标题切段，UI 里的段号才能和实际召回对得上。
    function foldPartsOf(record, options) {
      var settings = options || {}
      var splitChars = typeof settings.replySplitChars === 'number' && settings.replySplitChars > 0 ? settings.replySplitChars : 0
      // 检查点里回复没被截断时召回不再返回回复段（重复内容）；段号必须同样跳过，否则整份对不上。
      var skipReply = record && record.replyTruncated === false
      var items = Array.isArray(record && record.items) ? record.items : []
      var parts = []
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i] || {}
        var blocks = Array.isArray(item.blocks) ? item.blocks : []
        for (var j = 0; j < blocks.length; j += 1) {
          var block = blocks[j] || {}
          var text = typeof block.text === 'string' ? block.text : ''
          var kind = block.kind || 'text'
          if (skipReply && kind === 'reply') continue
          // 记录里的回复正文带 '[回复] ' 前缀；切节前先摘掉，否则第一行标题被前缀挡住，标题就少一个。
          var body = text
          var prefix = ''
          if (kind === 'reply' && text.indexOf('[回复] ') === 0) {
            prefix = '[回复] '
            body = text.slice(prefix.length)
          }
          var sections = kind === 'reply' && splitChars > 0 && body.length > splitChars ? splitReplySections(body) : null
          if (sections) {
            for (var k = 0; k < sections.length; k += 1) {
              parts.push({ no: parts.length + 1, seq: item.seq, kind: kind, name: block.name || '', text: prefix + sections[k], chars: sections[k].length })
            }
            continue
          }
          // 段里的召回调用随段一起带出来：只带这一段自己的调用（见 callsOfBlock）。
          parts.push({
            no: parts.length + 1,
            seq: item.seq,
            kind: kind,
            name: block.name || '',
            text: text,
            chars: text.length,
            calls: callsOfBlock(item, j, block),
          })
        }
      }
      return parts
    }

    // 引用面板里的段预览：只给开头一段，别把整段搬进弹窗。
    // 段正文自带「[类型] 」前缀，预览里去掉——那一行旁边已经写着 #段号与类型。
    function segmentPreview(text, limit) {
      var flat = String(text === null || text === undefined ? '' : text).replace(/^\[[^\]]*\]\s*/, '')
      if (!flat.trim()) return ''
      var got = preview(flat, limit || 120)
      return got === '（没有文字）' ? '' : got
    }

    // 引用落点那一段的正文：按条目 index 找到检查点，再按召回同一套切段规则取第 part 段。
    function segmentPreviewOf(entries, target, config) {
      if (!target || typeof target.part !== 'number' || target.part <= 0) return ''
      var list = Array.isArray(entries) ? entries : []
      var wantIndex = typeof target.i === 'number' ? target.i : -1
      var settings = config || {}
      var maxTokens = typeof settings.maxRecallTokens === 'number' && settings.maxRecallTokens > 0 ? settings.maxRecallTokens : 1000
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i] || {}
        if (entry.isCheckpoint !== true || !entry.foldRecord) continue
        if (typeof entry.index === 'number' && entry.index !== wantIndex) continue
        var parts = foldPartsOf(entry.foldRecord, { replySplitChars: maxTokens * 4 })
        for (var p = 0; p < parts.length; p += 1) {
          if (parts[p].no === target.part) return segmentPreview(parts[p].text)
        }
        return ''
      }
      return ''
    }

    function recallKindLabel(part) {
      var label = BLOCK_LABELS[part.kind] || '文本'
      if (part.kind === 'call' && part.name) label += ' ' + part.name
      return label
    }

    // 召回 chip 只显示「取哪一段」，完整参数放 title：条目头一行要能扫读。
    function recallQueryText(query) {
      var text = String(query === null || query === undefined ? '' : query).replace(/\s+/g, ' ').trim()
      return text.length <= 24 ? text : text.slice(0, 24) + '…'
    }

    // 段号压成区间：#195-#207、#1,#3-#5。调用 chip、结果头与原文目录共用同一种写法，
    // 同一个段在页面上到处都长一个样，扫一眼就能对上。
    function compactRanges(numbers) {
      var list = []
      var source = Array.isArray(numbers) ? numbers : []
      for (var i = 0; i < source.length; i += 1) {
        var value = Number(source[i])
        if (!isFinite(value) || value <= 0) continue
        list.push(Math.floor(value))
      }
      list.sort(function (a, b) { return a - b })
      var out = []
      var start = null
      var prev = null
      for (var j = 0; j < list.length; j += 1) {
        var no = list[j]
        if (no === prev) continue
        if (start === null) { start = no; prev = no; continue }
        if (no === prev + 1) { prev = no; continue }
        out.push(start === prev ? '#' + start : '#' + start + '-#' + prev)
        start = no
        prev = no
      }
      if (start !== null) out.push(start === prev ? '#' + start : '#' + start + '-#' + prev)
      return out.join(',')
    }

    function callSegmentCount(call) {
      if (call && typeof call.segmentCount === 'number' && call.segmentCount > 0) return Math.floor(call.segmentCount)
      return call && Array.isArray(call.segments) ? call.segments.length : 0
    }

    // 服务端按召回的切段规则把 parts / query 解析成具体段号，客户端不再猜选择器。
    // 解析不出段号时返回空串，chip 退回显示原始参数（老数据没有这个字段）。
    function callSegmentText(call) {
      var numbers = call && Array.isArray(call.segments) ? call.segments : []
      var count = callSegmentCount(call)
      var ranges = compactRanges(numbers)
      if (ranges) return '段 ' + ranges + (count > numbers.length ? ' 等 ' + count + ' 段' : '')
      return count > 0 ? count + ' 段' : ''
    }

    function recallChipLabel(call) {
      var id = call && call.id ? String(call.id) : ''
      var query = call && call.query ? String(call.query) : ''
      var parts = call && call.parts ? String(call.parts) : ''
      var outcome = call && call.outcome ? String(call.outcome) : ''
      if (!id) {
        if (!query) return '检索'
        var hitFolds = typeof call.searchFoldCount === 'number' ? call.searchFoldCount : 0
        var hitParts = typeof call.searchPartCount === 'number' ? call.searchPartCount : 0
        return '检索「' + recallQueryText(query) + '」' +
          (hitParts > 0 ? ' · ' + (hitFolds > 0 ? hitFolds + ' 折叠 ' : '') + hitParts + ' 段' : '')
      }
      var label = '召回 ' + id
      var count = callSegmentCount(call)
      // 整段 / 目录 / 失败这三种结果写在工具返回里，说清楚「这次到底给了什么」：
      // 不给段号，免得把「只给了目录」读成「取回了这些段」。
      if (outcome === 'direct') return label + ' · 整段' + (count > 0 ? ' ' + count + ' 段' : '')
      if (outcome === 'index') {
        // 目录本身会被截断：列出的段数 / 总段数一起写，免得把「29 行」读成「只有 29 段」。
        var total = typeof call.totalParts === 'number' && call.totalParts > 0 ? call.totalParts : 0
        var shown = count > 0 ? count + (total > count ? '/' + total : '') : (total > 0 ? String(total) : '')
        return label + ' · 目录' + (shown ? ' ' + shown + ' 段' : '')
      }
      if (outcome === 'error') return label + ' · 未取回'
      var segments = callSegmentText(call)
      // 段号优先：parts 写的是 reply / 3-5 这类选择器，解析后的段号才是「取过哪几段」。
      if (segments) return label + ' · ' + segments
      if (parts) return label + ' · 段 ' + parts
      if (query) return label + ' · 筛「' + recallQueryText(query) + '」'
      return label
    }

    function recallCallTitle(call) {
      var via = call && call.via ? '在 ' + call.via + ' 里调用' : '直接调用'
      var fields = []
      if (call && call.id) fields.push('id=' + JSON.stringify(call.id))
      if (call && call.query) fields.push('query=' + JSON.stringify(call.query))
      if (call && call.parts) fields.push('parts=' + JSON.stringify(call.parts))
      var numbers = call && Array.isArray(call.segments) ? call.segments : []
      var ranges = compactRanges(numbers)
      var count = callSegmentCount(call)
      if (ranges) fields.push('取回 ' + ranges + (count > numbers.length ? ' 等 ' + count + ' 段' : ''))
      // 工具结果写明的结果形状：整段、只给目录、失败。参数里看不出来，只有结果里写着。
      var outcome = call && call.outcome ? String(call.outcome) : ''
      if (outcome === 'direct') fields.push('整段返回')
      else if (outcome === 'index') fields.push('只给目录（共 ' + (call && call.totalParts ? call.totalParts : count) + ' 段，没有返回原文）')
      else if (outcome === 'error') fields.push('未取回：' + ((call && call.note) || '工具返回错误'))
      else if (outcome === 'search') fields.push('关键词检索（没有返回原文）')
      return via + ' fold_recall' + (fields.length ? '：' + fields.join('，') : '（参数未解析）')
    }

    // 检索调用没有单一折叠编号：它命中的是一条条折叠的分段目录。
    // 所以引用分两层——每条折叠一行「分段目录」，再逐段列出命中的段号；
    // 目录里的段号就是检索命中的段号，两边能对上。
    function openSearchCallRefs(call) {
      if (!NAV.refs) return
      var hits = Array.isArray(call.searchHits) ? call.searchHits : []
      var items = []
      var unlisted = 0
      for (var i = 0; i < hits.length; i += 1) {
        var hit = hits[i] || {}
        var loc = hit.loc || null
        if (!loc) continue
        var numbers = Array.isArray(hit.numbers) ? hit.numbers : []
        items.push({
          label: hit.id + '（第 ' + (hit.turn || '?') + ' 轮）· 分段目录 · 命中 ' + (hit.count || 0) + '/' + (hit.totalParts || 0) + ' 段',
          target: { o: loc.o, i: loc.i, dir: true },
        })
        for (var k = 0; k < numbers.length && k < 6; k += 1) {
          items.push({ label: hit.id + ' 段 #' + numbers[k], target: { o: loc.o, i: loc.i, part: numbers[k] } })
        }
        if (typeof hit.unlisted === 'number' && hit.unlisted > 0) unlisted += hit.unlisted
      }
      var note = items.length === 0
        ? '这次检索没有命中任何折叠（或命中的折叠不在这份历史里）。'
        : '点一条跳到那条折叠的分段目录，或那一段。'
      if (unlisted > 0) note += '另有 ' + unlisted + ' 段命中但没列出来（用 parts 区间选）。'
      if (typeof call.searchMoreFolds === 'number' && call.searchMoreFolds > 0) note += '这次检索还有 ' + call.searchMoreFolds + ' 条更早的折叠没列出。'
      NAV.refs({ title: '检索调用 · ' + recallChipLabel(call), items: items, note: note })
    }

    // 引用面板的两类入口：从调用跳到被召回的段，从段跳回调用它的地方。
    // 面板本身由 ModelView 渲染，这里只负责把「跳去哪」整理成一串可点的条目。
    function openCallRefs(call) {
      if (!call || !NAV.refs) return
      // 只给 query 的检索：命中落在别的折叠的分段目录上，走另一条路。
      if (!call.id) {
        openSearchCallRefs(call)
        return
      }
      var foldLoc = call && call.foldLoc ? call.foldLoc : null
      var items = []
      var numbers = Array.isArray(call.segments) ? call.segments : []
      if (foldLoc && numbers.length > 0) {
        for (var i = 0; i < numbers.length && i < 60; i += 1) {
          items.push({
            label: '段 #' + numbers[i] + (call.outcome === 'index' ? '（目录里的段）' : ''),
            target: { o: foldLoc.o, i: foldLoc.i, part: numbers[i] },
          })
        }
      } else if (foldLoc) {
        items.push({ label: '这条折叠的检查点', target: { o: foldLoc.o, i: foldLoc.i } })
      }
      NAV.refs({
        title: '召回调用 · ' + recallChipLabel(call),
        items: items,
        note: items.length > 0 ? '点一条跳到被召回的段。' : '这次调用没有落到具体的段上。',
      })
    }

    // 段号 -> 调用落点：同一次调用的多段并成一条，按轮次与折叠编号列出来。
    // onlyNo 只列某一段自己的引用：从一段反查时，别把同一份折叠里别的段也叫进来。
    // 落点精确到段（part）：调用发生在折叠原文里时，跳过去要打开那一段，而不是只打开检查点。
    function partRefItems(table, onlyNo) {
      var source = table && typeof table === 'object' ? table : {}
      var only = typeof onlyNo === 'number' && onlyNo > 0 ? Math.floor(onlyNo) : 0
      var groups = {}
      var order = []
      for (var key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue
        var no = Number(key)
        if (!isFinite(no) || no <= 0) continue
        if (only > 0 && no !== only) continue
        var refs = Array.isArray(source[key]) ? source[key] : []
        for (var i = 0; i < refs.length; i += 1) {
          var ref = refs[i] || {}
          if (typeof ref.o !== 'number' || typeof ref.i !== 'number') continue
          var part = typeof ref.part === 'number' && ref.part > 0 ? Math.floor(ref.part) : 0
          var id = ref.o + ':' + ref.i + ':' + part
          if (!groups[id]) {
            groups[id] = { o: ref.o, i: ref.i, part: part, t: typeof ref.t === 'number' ? ref.t : ref.o, fold: ref.id || '', nos: [] }
            order.push(id)
          }
          groups[id].nos.push(Math.floor(no))
        }
      }
      order.sort(function (a, b) {
        var left = groups[a]
        var right = groups[b]
        return left.o - right.o || left.i - right.i || left.part - right.part
      })
      return order.map(function (id) {
        var row = groups[id]
        var ranges = compactRanges(row.nos)
        return {
          label: '第 ' + row.t + ' 轮 · ' + (row.fold ? '召回 ' + row.fold : '检索') + (ranges ? ' · 段 ' + ranges : '') +
            (row.part > 0 ? ' · 调用在第 ' + row.part + ' 段' : ''),
          target: row.part > 0 ? { o: row.o, i: row.i, part: row.part } : { o: row.o, i: row.i },
        }
      })
    }

    // preview 是「这一段自己的开头」：从段这一端反查调用时，段号与正文一起摆出来，
    // 否则几行引用指向哪里全靠记忆。
    function openPartRefs(table, no, previewText) {
      if (!NAV.refs) return
      var items = partRefItems(table, no)
      NAV.refs({
        title: (no ? '第 ' + no + ' 段' : '这段折叠') + '被谁召回过',
        items: items,
        preview: typeof previewText === 'string' ? previewText : '',
        note: items.length > 0 ? '点一条跳到那次调用所在的位置。' : '没有召回到这一段的记录。',
      })
    }

    // 轮卡片上的合计标签点开时，这一轮的正文还没取：条目按需拉回来再列。
    function entryNameOf(entry) {
      var source = entry || {}
      if (source.isCheckpoint) return '折叠摘要 ' + (source.foldId || '')
      if (source.isPin) return '重要消息「' + (source.pinLabel || '') + '」'
      return source.roleLabel || source.role || '消息'
    }

    // 一个条目里所有的召回调用：条目自己的块，加上折叠原文里的（已被折掉的调用）。
    function callsOfEntry(entry) {
      var source = entry || {}
      var out = []
      var calls = Array.isArray(source.recallCalls) ? source.recallCalls : []
      for (var i = 0; i < calls.length; i += 1) out.push(calls[i])
      var record = source.foldRecord
      var items = record && Array.isArray(record.items) ? record.items : []
      for (var j = 0; j < items.length; j += 1) {
        var itemCalls = Array.isArray(items[j] && items[j].recallCalls) ? items[j].recallCalls : []
        for (var k = 0; k < itemCalls.length; k += 1) out.push(itemCalls[k])
      }
      return out
    }

    // 这一轮的召回调用：每条回答「去哪儿找这次调用」。调用落在折叠原文里时精确到那一段，
    // 跳过去会打开检查点、展开折叠原文、再展开那一段，而不是只停在检查点上。
    function turnCallItems(entries, ordinal) {
      var list = Array.isArray(entries) ? entries : []
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i] || {}
        var index = typeof entry.index === 'number' ? entry.index : 0
        var calls = callsOfEntry(entry)
        for (var j = 0; j < calls.length; j += 1) {
          var call = calls[j] || {}
          var part = typeof call.partNo === 'number' && call.partNo > 0 ? Math.floor(call.partNo) : 0
          out.push({
            label: entryNameOf(entry) + ' · ' + recallChipLabel(call) + (part > 0 ? ' · 调用在第 ' + part + ' 段' : ''),
            target: part > 0 ? { o: ordinal, i: index, part: part } : { o: ordinal, i: index },
          })
        }
      }
      return out
    }

    // 这一轮被后来的调用取回过哪些段：把检查点的引用表合成一份，一条调用只出现一次。
    function turnRecalledItems(entries) {
      var list = Array.isArray(entries) ? entries : []
      var merged = {}
      for (var i = 0; i < list.length; i += 1) {
        var table = list[i] && list[i].partRefs
        if (!table || typeof table !== 'object') continue
        for (var no in table) {
          if (!Object.prototype.hasOwnProperty.call(table, no)) continue
          var rows = Array.isArray(table[no]) ? table[no] : []
          if (rows.length === 0) continue
          merged[no] = (merged[no] || []).concat(rows)
        }
      }
      return partRefItems(merged)
    }

    // 这一轮里被检索过的分段目录：把检查点上的检索引用合成一份，一条检索只出现一次。
    function turnSearchedItems(entries) {
      var list = Array.isArray(entries) ? entries : []
      var rows = []
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i] || {}
        var refs = Array.isArray(entry.searchedRefs) ? entry.searchedRefs : []
        for (var j = 0; j < refs.length; j += 1) {
          var row = refs[j] || {}
          rows.push({
            o: row.o, i: row.i, t: row.t, query: row.query || '',
            count: row.count || 0, totalParts: row.totalParts || 0,
            numbers: Array.isArray(row.numbers) ? row.numbers : [],
            fold: entry.foldId || '',
          })
        }
      }
      return searchRefItems(rows)
    }

    // 条目级标记：直接调用逐次列出（最多 4 个），折叠原文里的调用只报次数，被召回次数只对检查点有意义。
    function recallEntryTags(entry, onOpen, onSearch) {
      var source = entry || {}
      var out = []
      var calls = Array.isArray(source.recallCalls) ? source.recallCalls : []
      var shown = calls.slice(0, 4)
      for (var i = 0; i < shown.length; i += 1) {
        var call = shown[i] || {}
        out.push(h('span', {
          key: 'rc' + i,
          style: Object.assign({}, C.tag, recallCallStyle(call)),
          title: recallCallTitle(call),
        }, recallChipLabel(call)))
      }
      if (calls.length > shown.length) {
        out.push(h('span', {
          key: 'rcmore',
          style: Object.assign({}, C.tag, RECALL_TAG_STYLE),
          title: '还有 ' + (calls.length - shown.length) + ' 次召回调用',
        }, '另 ' + (calls.length - shown.length) + ' 次'))
      }
      var folded = typeof source.foldedRecallCount === 'number' ? source.foldedRecallCount : 0
      if (folded > 0) {
        out.push(h('span', {
          key: 'foldedrc',
          style: Object.assign({}, C.tag, RECALL_TAG_STYLE),
          title: '折叠原文里有 ' + folded + ' 次召回调用，已随原文一起收起',
        }, '含召回 ' + folded + ' 次'))
      }
      var foldedSearch = typeof source.foldedSearchCount === 'number' ? source.foldedSearchCount : 0
      if (foldedSearch > 0) {
        out.push(h('span', {
          key: 'foldedsr',
          style: Object.assign({}, C.tag, SEARCH_TAG_STYLE),
          title: '折叠原文里有 ' + foldedSearch + ' 次关键词检索',
        }, '含检索 ' + foldedSearch + ' 次'))
      }
      var recalled = typeof source.recalledCount === 'number' ? source.recalledCount : 0
      var recalledPartCount = typeof source.recalledPartCount === 'number' ? source.recalledPartCount : 0
      if (recalled > 0) {
        out.push(h('span', {
          key: 'recalled',
          style: Object.assign({}, C.tag, RECALLED_TAG_STYLE, typeof onOpen === 'function' ? CHIP_CLICK : {}),
          title: '这段折叠被召回 ' + recalled + ' 次' +
            (recalledPartCount > 0 ? '，分段召回共取回 ' + recalledPartCount + ' 段次（段号见下方原文列表）' : '') +
            '：取回的是原文，检查点本身没有被重发' +
            (typeof onOpen === 'function' ? '；点开看是哪几次调用取回的' : ''),
          onClick: typeof onOpen === 'function'
            ? function (event) { event.preventDefault(); event.stopPropagation(); onOpen() }
            : undefined,
        }, '被召回 ' + recalled + ' 次' + (recalledPartCount > 0 ? ' · ' + recalledPartCount + ' 段次' : '')))
      }
      // 这条折叠的分段目录被关键词检索用过几次：检索没返回原文，所以是另一种颜色、另一种数。
      var searchedCount = typeof source.searchedCount === 'number' ? source.searchedCount : 0
      var searchedPartCount = typeof source.searchedPartCount === 'number' ? source.searchedPartCount : 0
      if (searchedCount > 0) {
        out.push(h('span', {
          key: 'searched',
          style: Object.assign({}, C.tag, SEARCH_TAG_STYLE, typeof onSearch === 'function' ? CHIP_CLICK : {}),
          title: '这张分段目录被 ' + searchedCount + ' 次关键词检索用过' +
            (searchedPartCount > 0 ? '，命中 ' + searchedPartCount + ' 段次（检索不返回原文）' : '（检索不返回原文）') +
            (typeof onSearch === 'function' ? '；点开看是哪几次检索' : ''),
          onClick: typeof onSearch === 'function'
            ? function (event) { event.preventDefault(); event.stopPropagation(); onSearch() }
            : undefined,
        }, '被检索 ' + searchedCount + ' 次' + (searchedPartCount > 0 ? ' · ' + searchedPartCount + ' 段次' : '')))
      }
      return out
    }

    // 段号被关键词检索命中的次数：目录行里的「检索×N」，与「召回×N」并排。
    function partSearchCount(searchedParts, no) {
      if (!searchedParts || typeof searchedParts !== 'object') return 0
      var rows = searchedParts[no]
      return Array.isArray(rows) ? rows.length : 0
    }

    // 被检索的反向引用：这一段 / 这张分段目录被哪几次关键词检索命中过。
    // 行来自服务端：段级带关键词，折叠级还带命中数（命中 n/m 段、列出的段号）。
    function searchRefItems(rows, onlyNo) {
      var list = Array.isArray(rows) ? rows : []
      var groups = {}
      var order = []
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i] || {}
        if (typeof row.o !== 'number' || typeof row.i !== 'number') continue
        // 同一条消息里可能有多次检索：按「条目 + 调用所在段」分组，落点才精确到那一次。
        var part = typeof row.part === 'number' && row.part > 0 ? Math.floor(row.part) : 0
        var key = row.o + ':' + row.i + ':' + part
        if (!groups[key]) {
          groups[key] = {
            o: row.o, i: row.i, part: part,
            t: typeof row.t === 'number' ? row.t : row.o,
            query: row.query || '', fold: row.fold || '', nos: [], count: 0, totalParts: 0,
          }
          order.push(key)
        }
        var group = groups[key]
        if (!group.query && row.query) group.query = row.query
        if (typeof row.count === 'number' && row.count > group.count) group.count = row.count
        if (typeof row.totalParts === 'number' && row.totalParts > group.totalParts) group.totalParts = row.totalParts
        var numbers = Array.isArray(row.numbers) ? row.numbers : (typeof onlyNo === 'number' && onlyNo > 0 ? [onlyNo] : [])
        for (var k = 0; k < numbers.length; k += 1) group.nos.push(numbers[k])
      }
      order.sort(function (a, b) {
        return groups[a].o - groups[b].o || groups[a].i - groups[b].i || groups[a].part - groups[b].part
      })
      return order.map(function (key) {
        var row = groups[key]
        var ranges = compactRanges(row.nos)
        var hit = row.count > 0 ? '命中 ' + row.count + (row.totalParts > 0 ? '/' + row.totalParts : '') + ' 段' : ''
        return {
          label: '第 ' + row.t + ' 轮 · 检索' + (row.fold ? ' ' + row.fold : '') + (row.query ? '「' + recallQueryText(row.query) + '」' : '') +
            (hit ? ' · ' + hit : '') + (ranges ? ' · 段 ' + ranges : '') +
            (row.part > 0 ? ' · 调用在第 ' + row.part + ' 段' : ''),
          target: row.part > 0 ? { o: row.o, i: row.i, part: row.part } : { o: row.o, i: row.i },
        }
      })
    }

    // 目录被检索：点目录行上的「检索×N」或折叠原文标题上的「被检索 N 次」都走这里。
    function openSearchRefs(searchedParts, searchedRefs, no, previewText) {
      if (!NAV.refs) return
      var seg = typeof no === 'number' && no > 0 ? Math.floor(no) : 0
      var rows = seg > 0
        ? (searchedParts && Array.isArray(searchedParts[seg]) ? searchedParts[seg] : [])
        : (Array.isArray(searchedRefs) ? searchedRefs : [])
      var items = searchRefItems(rows, seg)
      NAV.refs({
        title: seg > 0 ? '第 ' + seg + ' 段被检索过' : '这张分段目录被检索过',
        items: items,
        preview: typeof previewText === 'string' ? previewText : '',
        note: items.length > 0 ? '点一条跳到那次检索调用的位置。' : '没有检索命中过这里。',
      })
    }

    function partRecallCount(recalledParts, no) {
      if (!recalledParts || typeof recalledParts !== 'object') return 0
      var value = recalledParts[no]
      return typeof value === 'number' && value > 0 ? value : 0
    }

    function recallIndexLines(parts, previewChars, recalledParts, searchedParts) {
      return parts.map(function (part) {
        var meta = '#' + part.no + ' [' + recallKindLabel(part) + '] ' + formatCharsTokens(part.chars)
        // 目录行也带段级标记：扫一遍目录就能看出哪些段被取回过、哪些只被检索点到过。
        var times = partRecallCount(recalledParts, part.no)
        if (times > 0) meta += ' · 召回×' + times
        var hits = partSearchCount(searchedParts, part.no)
        if (hits > 0) meta += ' · 检索×' + hits
        var flat = part.text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()
        if (!flat) return meta
        // 与 lib/recall.js 同规则：预览比原文短才用预览，否则整行给原文。
        var preview = flat.length <= previewChars ? flat : flat.slice(0, Math.max(0, previewChars)) + '…'
        return meta + '：' + (preview.length < flat.length ? preview : flat)
      })
    }

    function recallPlan(record, config) {
      var settings = config || {}
      var previewTokens = typeof settings.recallIndexPreviewTokens === 'number' && settings.recallIndexPreviewTokens > 0 ? settings.recallIndexPreviewTokens : 25
      var maxRecallTokens = typeof settings.maxRecallTokens === 'number' && settings.maxRecallTokens > 0 ? settings.maxRecallTokens : 1000
      var minRatio = typeof settings.minFoldRatio === 'number' && settings.minFoldRatio > 0 ? settings.minFoldRatio : 0.5
      var parts = foldPartsOf(record, { replySplitChars: maxRecallTokens * 4 })
      var chars = parts.reduce(function (sum, part) { return sum + part.chars }, 0)
      var tokens = Math.round(chars / 4)
      // 与服务端同口径：每行在预览/原文间二选一；目录整体省不到原文的 minRatio 倍时整段返回。头部与合计按约 200 字估。
      var indexChars = recallIndexLines(parts, previewTokens * 4).reduce(function (sum, line) { return sum + line.length + 1 }, 0) + 200
      var direct = indexChars >= chars * minRatio
      return { parts: parts, chars: chars, tokens: tokens, direct: direct, previewChars: previewTokens * 4 }
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

    // 目录行里的「召回×N」是被召回次数的缩略写法。整行是等宽正文，只靠字号分不出来，
    // 所以把这个记号单独染红：扫目录时它和段号一样是定位用的坐标。
    var RECALLED_TEXT_STYLE = { color: RECALL_TEXT.recalled, fontWeight: 600 }
    // 检索命中的段号用橘黄：与「召回×N」的红并排出现时，一眼能分出「取回过」和「只是找到了」。
    var SEARCH_TEXT_STYLE = { color: RECALL_TEXT.search, fontWeight: 600 }

    function recallCountNodes(line) {
      // 目录行里两种记号：「召回×N」被取回过、'检索×N' 只在检索结果里被点到。各染各的色。
      var pattern = /(召回×\d+|检索×\d+)/g
      var out = []
      var last = 0
      var match
      while ((match = pattern.exec(line))) {
        if (match.index > last) out.push(line.slice(last, match.index))
        out.push(h('span', {
          key: 'm' + match.index,
          style: match[1].charAt(0) === '检' ? SEARCH_TEXT_STYLE : RECALLED_TEXT_STYLE,
        }, match[1]))
        last = match.index + match[1].length
      }
      if (out.length === 0) return line
      if (last < line.length) out.push(line.slice(last))
      return out
    }

    // 清单超过一屏就交给滚动区。20 段 / 40 行以内一屏看得完，套壳只多一层嵌套滚动；
    // 再多就要截住，否则页面高度随段数一路长下去，想滚到下面的内容得先滚过整份清单。
    var PART_SCROLL_AFTER = 20
    var LINE_SCROLL_AFTER = 40

    function FoldOriginal(props) {
      var record = props.record || {}
      var plan = recallPlan(record, props.config)
      var opened = useLazyOpen()
      var ownRef = react.useRef(null)
      var dirRef = react.useRef(null)
      // 落到「第几段」或「整张目录」时就展开这一层：段条目还没挂进 DOM，必须先打开才能滚过去。
      var focus = props.focus
      var focusPart = focus && typeof focus.part === 'number' ? focus.part : 0
      var focusDir = !!(focus && focus.dir === true)
      var focusGen = focus ? focus.gen : 0
      useReveal(ownRef, focusPart > 0 || focusDir, focusGen, false)
      var partRefs = props.partRefs && typeof props.partRefs === 'object' ? props.partRefs : {}
      var hasRefs = false
      for (var refKey in partRefs) {
        if (Object.prototype.hasOwnProperty.call(partRefs, refKey)) {
          hasRefs = true
          break
        }
      }
      var recalledParts = props.recalledParts && typeof props.recalledParts === 'object' ? props.recalledParts : {}
      var searchedParts = props.searchedParts && typeof props.searchedParts === 'object' ? props.searchedParts : {}
      var searchedRefs = Array.isArray(props.searchedRefs) ? props.searchedRefs : []
      var recalledSegments = 0
      var recalledTimes = 0
      for (var key in recalledParts) {
        if (!Object.prototype.hasOwnProperty.call(recalledParts, key)) continue
        var times = partRecallCount(recalledParts, key)
        if (times <= 0) continue
        recalledSegments += 1
        recalledTimes += times
      }
      var searchedSegments = 0
      var searchedTimes = 0
      for (var skey in searchedParts) {
        if (!Object.prototype.hasOwnProperty.call(searchedParts, skey)) continue
        var hits = partSearchCount(searchedParts, skey)
        if (hits <= 0) continue
        searchedSegments += 1
        searchedTimes += hits
      }
      var searchedCount = typeof props.searchedCount === 'number' && props.searchedCount > 0 ? props.searchedCount : 0
      var head = '折叠掉的原文 · ' + plan.parts.length + ' 段 · 约 ' + formatChars(plan.chars) + '（≈' + formatTokens(plan.tokens) + ' token）' +
        '（' + (plan.direct ? '召回时整段返回' : '召回时先给目录') + '，模型看不到）'
      // 目录被检索：这条折叠的分段目录被后来的关键词检索按段号用过几次。
      var dirCount = searchedCount > 0 ? searchedCount : (searchedRefs.length > 0 ? searchedRefs.length : 0)
      // 目录的展开状态自己管：跳转要能把它打开并滚过去，用户点开也要能收回去。
      var directory = react.useState(false)
      react.useEffect(function () {
        if (!focusDir) return
        if (!directory[0]) {
          directory[1](true)
          return
        }
        var node = dirRef.current
        if (!node || typeof node.scrollIntoView !== 'function') return
        var scroll = setTimeout(function () { node.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, 80)
        return function () { clearTimeout(scroll) }
        // opened[0] 一起看：外层是先展开、目录节点才挂进 DOM 的。
      }, [focusDir, focusGen, directory[0], opened[0]])
      var children = []
      if (!plan.direct) {
        var lines = recallIndexLines(plan.parts, plan.previewChars, recalledParts, searchedParts)
        var lineNodes = []
        // 目录自己也占上下文：模型第一遍收到的就是这些行。收起时只写「N 行」，看不出这一面墙多大，
        // 所以把目录自身的字数与 token 一起写着——和原文合计是两个数，别混。
        var dirChars = 0
        for (var li = 0; li < lines.length; li += 1) {
          dirChars += lines[li].length + 1
          lineNodes.push(h('div', { key: 'idx' + li, style: RECALL_LINE_STYLE }, recallCountNodes(lines[li])))
        }
        // 目录是「一面墙」：收起时只留一行，下面每段本来就是可折叠条目。
        // 要按段号扫类型/字数时再点开，和召回时先给目录、再按段取回是同一个顺序。
        children.push(h('details', {
          key: 'idx',
          ref: dirRef,
          style: C.nested,
          open: directory[0],
          onToggle: function (event) { directory[1](event.currentTarget.open === true) },
        },
          h('summary', { style: Object.assign({}, C.nestedSummary, { opacity: 1 }) },
            h('span', { style: { opacity: 0.7 } },
              '分段目录 · ' + lines.length + ' 行 · ' + formatCharsTokens(dirChars) + ' · 召回时按这里的段号选'),
            // 这张目录被关键词检索用过：段号就是检索命中的段号，点开看是哪几次检索。
            dirCount > 0
              ? h('span', {
                  style: Object.assign({}, SEARCH_TEXT_STYLE, CHIP_CLICK),
                  title: '这张分段目录被 ' + dirCount + ' 次关键词检索用过' +
                    (searchedSegments > 0 ? '，其中 ' + searchedSegments + ' 段被命中 ' + searchedTimes + ' 次' : '') +
                    '；点开看是哪几次检索',
                  onClick: function (event) {
                    event.preventDefault()
                    event.stopPropagation()
                    openSearchRefs(searchedParts, searchedRefs, 0)
                  },
                }, ' · 被检索 ' + dirCount + ' 次')
              : null
          ),
          // 目录本身也是一面墙：行数多时限高，别让「展开目录」也把页面拉长。
          directory[0]
            ? h('div', { style: lines.length > LINE_SCROLL_AFTER ? C.scrollBoxTight : C.nestedBody }, lineNodes)
            : null
        ))
      }
      var partNodes = []
      for (var pi = 0; pi < plan.parts.length; pi += 1) {
        var part = plan.parts[pi]
        partNodes.push(h(FoldItem, {
          key: 'i' + pi,
          // 段内发起的召回调用随段一起带出来（foldPartsOf 从原文条目里接的）。
          item: {
            seq: part.seq,
            chars: part.chars,
            recallCalls: Array.isArray(part.calls) ? part.calls : [],
            blocks: [{ kind: part.kind, name: part.name, text: part.text }],
          },
          index: part.no,
          recallCount: partRecallCount(recalledParts, part.no),
          refs: Array.isArray(partRefs[part.no]) ? partRefs[part.no] : [],
          partRefs: partRefs,
          searchedParts: searchedParts,
          searchedRefs: searchedRefs,
          focus: focusPart === part.no ? focus : null,
          wide: props.wide,
        }))
      }
      // 段条目多时整份清单进滚动区：展开面板只多一屏，页面的滚动条还在手里。
      if (partNodes.length > PART_SCROLL_AFTER) {
        children.push(h('div', {
          key: 'parts',
          style: C.scrollBox,
          title: partNodes.length + ' 段，在框内滚动查看',
        }, partNodes))
      } else {
        for (var pn = 0; pn < partNodes.length; pn += 1) children.push(partNodes[pn])
      }
      return h('details', { ref: ownRef, style: C.nested, onToggle: opened[1] },
        h('summary', { style: Object.assign({}, C.nestedSummary, { opacity: 1 }) },
          h('span', { style: { opacity: 0.7 } }, head),
          recalledSegments > 0
            ? h('span', {
                style: Object.assign({}, RECALLED_TEXT_STYLE, hasRefs ? CHIP_CLICK : {}),
                title: hasRefs ? '点开看是哪些调用取回了这些段' : '这些段被后面的召回取回过',
                onClick: hasRefs
                  ? function (event) { event.preventDefault(); event.stopPropagation(); openPartRefs(partRefs, 0) }
                  : undefined,
              }, ' · 其中 ' + recalledSegments + ' 段被召回 ' + recalledTimes + ' 次')
            : null,
          // 反方向的另一种标记：这些段只是被关键词检索点到过，原文并没有返回给模型。
          searchedSegments > 0
            ? h('span', {
                style: Object.assign({}, SEARCH_TEXT_STYLE, CHIP_CLICK),
                title: '这些段被关键词检索命中 ' + searchedTimes + ' 次（检索不返回原文）；点开看是哪几次检索',
                onClick: function (event) {
                  event.preventDefault()
                  event.stopPropagation()
                  openSearchRefs(searchedParts, searchedRefs, 0)
                },
              }, ' · 其中 ' + searchedSegments + ' 段被检索 ' + searchedTimes + ' 次')
            : null
        ),
        opened[0] ? h('div', { style: C.nestedBody }, children) : null
      )
    }

    function EntryView(props) {
      var entry = props.entry || {}
      var kind = entryKindOf(entry)
      var opened = useLazyOpen()
      var ownRef = react.useRef(null)
      // 跳转落点：条目序号对上了就展开、滚过去、描一下边。
      var focus = props.focus
      var focusHere = focus && typeof focus.i === 'number' && focus.i === entry.index
      var flash = useReveal(ownRef, focusHere, focusHere ? focus.gen : 0, true)
      var role = entry.isCheckpoint
        ? '折叠摘要 ' + (entry.foldId || '')
        : entry.isPin
          ? '重要消息「' + (entry.pinLabel || '') + '」'
          : (entry.roleLabel || entry.role || '消息')
      var meta = []
      if (entry.sourceLabel) meta.push(entry.sourceLabel)
      if (entry.seq !== null && entry.seq !== undefined) meta.push('#' + entry.seq)
      meta.push(formatCharsTokens(entry.chars))
      var record = entry.foldRecord
      var hasOriginal = entry.isCheckpoint && record && Array.isArray(record.items) && record.items.length > 0
      // 检查点的「被召回」标签点开就是引用面板：哪几次调用取回了这段折叠的哪几段。
      // 只有服务端真的下发了引用表才做成可点，否则点开只会是一个空面板。
      var recallTags = recallEntryTags(entry,
        entry.partRefs && typeof entry.partRefs === 'object'
          ? function () { openPartRefs(entry.partRefs, 0) }
          : undefined,
        entry.searchedRefs && Array.isArray(entry.searchedRefs)
          ? function () { openSearchRefs(entry.searchedParts, entry.searchedRefs, 0) }
          : undefined)
      var summary = h('summary', { style: C.entrySummary },
        h('div', { style: C.entryHead },
          h('span', { style: C.entryRole }, role),
          recallTags.length > 0
            ? h('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } }, recallTags)
            : null,
          meta.map(function (text, index) { return h('span', { key: 'm' + index, style: C.entryMeta }, text) })
        ),
        h('div', { style: C.entryPeek }, preview(firstTextOf(entry), 140) || '（空）')
      )
      return h('details', {
        ref: ownRef,
        style: flash ? Object.assign({}, C.entry, tint(kind), FLASH_STYLE) : Object.assign({}, C.entry, tint(kind)),
        onToggle: opened[1],
      },
        summary,
        opened[0]
          ? h('div', { style: C.entryBody },
              h(BlockList, { blocks: entry.blocks, wide: props.wide }),
              hasOriginal
                ? h(FoldOriginal, {
                    record: record,
                    recalledParts: entry.recalledParts,
                    partRefs: entry.partRefs,
                    searchedParts: entry.searchedParts,
                    searchedRefs: entry.searchedRefs,
                    searchedCount: entry.searchedCount,
                    focus: focusHere && (focus.part || focus.dir) ? focus : null,
                    wide: props.wide,
                    config: props.config,
                  })
                : null
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

    // 引用面板的段预览要读目标那一轮：按会话 + 轮次 + 数据版本缓存，
    // 同一次打开只发一次请求，关掉再打开不重发；失败不留坏缓存。
    var TURN_CACHE = {}
    function loadTurnEntries(sessionId, ordinal, stamp) {
      var key = String(sessionId || '') + '|' + ordinal + '|' + (typeof stamp === 'number' ? stamp : 0)
      var hit = TURN_CACHE[key]
      // 一律回 Promise：缓存命中也要能 .then，调用方不用判两次。
      if (hit) return hit.promise
      var slot = { status: 'loading', entries: [], error: '' }
      slot.promise = fetch('/fold-turn?session=' + encodeURIComponent(sessionId || '') + '&ordinal=' + ordinal)
        .then(readJson)
        .then(function (result) {
          slot.status = 'ready'
          slot.entries = Array.isArray(result.entries) ? result.entries : []
          return slot
        })
        .catch(function (error) {
          slot.status = 'error'
          slot.error = String(error && error.message ? error.message : error)
          if (TURN_CACHE[key] === slot) delete TURN_CACHE[key]
          return slot
        })
      TURN_CACHE[key] = slot
      return slot.promise
    }

    // 轮正文按需拉：首包只带分组头与重要消息，展开这一轮时才取它的条目。
    // 长会话单是各条消息的正文就有几十 MB，一次下发会让浏览器先卡在解析和内存上。
    function TurnCard(props) {
      var group = props.group || {}
      if (group.kind === 'system') return h(SystemCard, { group: group, wide: props.wide, current: props.current })
      var opened = useLazyOpen()
      var ordinal = typeof group.ordinal === 'number' ? group.ordinal : -1
      var stamp = typeof props.stamp === 'number' ? props.stamp : 0
      var detailsRef = react.useRef(null)
      // 目标轮次对上了就展开：正文随展开按需拉，拉回来之后 EntryView 再定位到具体条目。
      var jumpFocus = props.focus
      var focusHere = jumpFocus && jumpFocus.o === ordinal
      useReveal(detailsRef, focusHere, focusHere ? jumpFocus.gen : 0, false)
      var bodyState = react.useState({ status: 'idle', stamp: 0, entries: [], error: '' })
      var body = bodyState[0]
      var setBody = bodyState[1]
      var attemptState = react.useState(0)

      // 展开才拉；取过同一版数据就不再重复拉，刷新后 stamp 变化才重取。
      // 关掉再打开会中断在途请求，所以这里不拦 loading 状态：重新打开就重新拉一次。
      react.useEffect(function () {
        if (!opened[0] || ordinal < 0) return
        if (body.status === 'ready' && body.stamp === stamp) return
        var alive = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        setBody({ status: 'loading', stamp: stamp, entries: [], error: '' })
        fetch('/fold-turn?session=' + encodeURIComponent(props.sessionId || '') + '&ordinal=' + ordinal, controller ? { signal: controller.signal } : undefined)
          .then(readJson)
          .then(function (result) {
            if (!alive) return
            setBody({ status: 'ready', stamp: stamp, entries: Array.isArray(result.entries) ? result.entries : [], error: '' })
          })
          .catch(function (error) {
            if (!alive || (error && error.name === 'AbortError')) return
            setBody({ status: 'error', stamp: stamp, entries: [], error: String(error && error.message ? error.message : error) })
          })
        return function () {
          alive = false
          if (controller) controller.abort()
        }
      }, [opened[0], ordinal, attemptState[0], stamp])

      // 合计标签也能点：这一轮的正文按需拉，拉回来再列「哪几次调用 / 哪几段被取回」。
      // 标签在 summary 里，点它必须先掐掉默认的展开——否则点标签只会把整轮展开。
      var openTurnPanel = function (kind) {
        if (!NAV.refs) return
        var title = '第 ' + (typeof group.turn === 'number' ? group.turn : group.ordinal) + ' 轮 · ' +
          (kind === 'calls' ? '召回调用' : kind === 'searched' ? '被检索的分段目录' : '被召回的段')
        NAV.refs({ title: title, items: [], note: '正在读取这一轮的正文…' })
        var gen = NAV.panelGen || 0
        loadTurnEntries(props.sessionId, ordinal, stamp).then(function (slot) {
          // 迟到的结果不再顶掉已经换过的面板（用户可能已经关了或点了别的标签）。
          if ((NAV.panelGen || 0) !== gen) return
          if (slot.status !== 'ready') {
            NAV.refs({ title: title, items: [], note: '读取这一轮的正文失败：' + (slot.error || '未知原因') })
            return
          }
          var items = kind === 'calls'
            ? turnCallItems(slot.entries, ordinal)
            : kind === 'searched' ? turnSearchedItems(slot.entries) : turnRecalledItems(slot.entries)
          NAV.refs({
            title: title,
            items: items,
            note: items.length === 0
              ? '这一轮没有' + (kind === 'calls' ? '召回调用' : kind === 'searched' ? '被检索的目录' : '被召回的段') + '。'
              : (kind === 'calls' ? '点一条跳到那次调用的位置。' : '点一条跳到那次调用的条目。'),
          })
        })
      }
      var chipClick = function (kind) {
        return function (event) {
          event.preventDefault()
          event.stopPropagation()
          openTurnPanel(kind)
        }
      }

      var label = typeof group.turn === 'number' ? '第 ' + group.turn + ' 轮' : '第 ' + (group.ordinal || 0) + ' 段'
      var tags = []
      var foldIds = Array.isArray(group.foldIds) ? group.foldIds : []
      for (var i = 0; i < foldIds.length; i += 1) tags.push(h('span', { key: 'f' + i, style: C.tag }, foldIds[i]))
      if (group.continuation) tags.push(h('span', { key: 'cont', style: C.tag }, '轮内续接'))
      if (group.folded) tags.push(h('span', { key: 'folded', style: C.tag }, '已折叠'))
      else if (group.prePlugin) tags.push(h('span', { key: 'pre', style: C.tag }, '插件生效前 · 未折叠'))
      else tags.push(h('span', { key: 'none', style: C.tag }, group.short ? '内容较少 · 未折叠' : '未折叠'))
      // 召回合计提到轮卡片头：展开前就能看出这一轮取回了什么、哪段被取回过。
      var recallCallCount = typeof group.recallCallCount === 'number' ? group.recallCallCount : 0
      if (recallCallCount > 0) {
        tags.push(h('span', {
          key: 'rcall',
          style: Object.assign({}, C.tag, RECALL_TAG_STYLE, CHIP_CLICK),
          title: '这一轮共 ' + recallCallCount + ' 次召回调用，含折叠原文里的调用；点开看是哪几次、跳到调用位置',
          onClick: chipClick('calls'),
        }, '召回 ' + recallCallCount + ' 次'))
      }
      var recallSearchCount = typeof group.recallSearchCount === 'number' ? group.recallSearchCount : 0
      if (recallSearchCount > 0) {
        tags.push(h('span', {
          key: 'rsearch',
          style: Object.assign({}, C.tag, SEARCH_TAG_STYLE),
          title: '这一轮共 ' + recallSearchCount + ' 次关键词检索',
        }, '检索 ' + recallSearchCount + ' 次'))
      }
      var recalledCount = typeof group.recalledCount === 'number' ? group.recalledCount : 0
      var recalledPartCount = typeof group.recalledPartCount === 'number' ? group.recalledPartCount : 0
      if (recalledCount > 0) {
        tags.push(h('span', {
          key: 'recalled',
          style: Object.assign({}, C.tag, RECALLED_TAG_STYLE, CHIP_CLICK),
          title: '这一轮的折叠被召回共 ' + recalledCount + ' 次' +
            (recalledPartCount > 0 ? '，分段召回共取回 ' + recalledPartCount + ' 段次' : '') +
            '；点开看是哪几次调用取回的',
          onClick: chipClick('recalled'),
        }, '被召回 ' + recalledCount + ' 次' + (recalledPartCount > 0 ? ' · ' + recalledPartCount + ' 段次' : '')))
      }
      // 被检索：这一轮的折叠分段目录被关键词检索用过几次。检索没返回原文，与被召回分开列。
      var searchedCount = typeof group.searchedCount === 'number' ? group.searchedCount : 0
      var searchedPartCount = typeof group.searchedPartCount === 'number' ? group.searchedPartCount : 0
      if (searchedCount > 0) {
        tags.push(h('span', {
          key: 'searched',
          style: Object.assign({}, C.tag, SEARCH_TAG_STYLE, CHIP_CLICK),
          title: '这一轮的折叠分段目录被关键词检索用过 ' + searchedCount + ' 次' +
            (searchedPartCount > 0 ? '，命中 ' + searchedPartCount + ' 段次（检索不返回原文）' : '') +
            '；点开看是哪几次检索',
          onClick: chipClick('searched'),
        }, '被检索 ' + searchedCount + ' 次' + (searchedPartCount > 0 ? ' · ' + searchedPartCount + ' 段次' : '')))
      }
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
      // 重要消息不从轮里删掉，而是提到轮卡片之外常显：折叠这一轮也能一眼看到。
      var pins = Array.isArray(group.pins) ? group.pins : []
      var bodyNode = null
      if (opened[0]) {
        if (body.status === 'ready') {
          bodyNode = body.entries.length === 0
            ? h('div', { style: C.turnBody }, h('div', { style: C.sub }, '这一轮没有可展开的正文。'))
            : h('div', { style: C.turnBody }, body.entries.map(function (item, index) {
                return h(EntryView, { key: 'e' + index, entry: item, wide: props.wide, config: props.config, focus: focusHere ? jumpFocus : null })
              }))
        } else if (body.status === 'error') {
          bodyNode = h('div', { style: C.turnBody },
            h('div', { style: { fontSize: '12px', color: '#f87171' } }, '这一轮的正文读取失败：' + body.error),
            h('button', {
              style: Object.assign({}, C.button, { marginTop: '6px' }),
              onClick: function () { attemptState[1](function (value) { return value + 1 }) },
            }, '重试')
          )
        } else {
          bodyNode = h('div', { style: C.turnBody }, h('div', { style: C.sub }, '正在读取这一轮的正文…'))
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('details', { ref: detailsRef, style: C.turn, onToggle: opened[1] }, summary, bodyNode),
        pins.map(function (pin, index) {
          return h(EntryView, { key: 'pin' + index, entry: pin, wide: props.wide, config: props.config, focus: focusHere ? jumpFocus : null })
        })
      )
    }

    // 宿主每重渲染一次都会重建这一页的元素树：props 没变就跳过，别让展开状态与子树白重算。
    var MemoTurnCard = typeof react.memo === 'function' ? react.memo(TurnCard) : TurnCard

    // 引用面板：点标签打开，列出去处，点一条就跳。只回答「去哪儿」，不复制原文——
    // 原文已经在页面里，再贴一份只会让两处对不上。
    var PANEL_BACKDROP = {
      position: 'fixed', inset: '0', zIndex: 60,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '12vh', background: 'rgba(0,0,0,.38)',
    }
    var PANEL_BOX = {
      width: 'min(560px, calc(100vw - 32px))',
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '14px 16px', borderRadius: '12px',
      background: 'Canvas', color: 'CanvasText',
      border: '1px solid rgba(128,128,128,.4)',
      boxShadow: '0 18px 40px rgba(0,0,0,.35)',
    }
    var PANEL_LIST = {
      overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px',
      maxHeight: '40vh', paddingRight: '4px', scrollbarWidth: 'thin',
    }
    var PANEL_ITEM = {
      fontSize: '12px', textAlign: 'left', padding: '5px 8px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,.28)', background: 'transparent', color: 'inherit', cursor: 'pointer',
      display: 'flex', flexDirection: 'column', gap: '2px',
    }
    // 引用条目的两行：段号一行、正文一行。正文是段开头的一段话，读一眼就知道那条段是什么。
    var PANEL_ITEM_HEAD = { fontSize: '12px', lineHeight: '17px', fontWeight: 600 }
    var PANEL_ITEM_PREVIEW = { fontSize: '11px', lineHeight: '16px', opacity: 0.72, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
    var PANEL_NOTE_PREVIEW = { fontSize: '11px', lineHeight: '16px', opacity: 0.78, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '4px 8px', borderRadius: '6px', background: 'rgba(128,128,128,.10)' }

    // 面板条目的落点键：只有「跳到某一段」的条目才有，用来按段去取预览。
    function panelKeyOf(item) {
      var target = item && item.target ? item.target : null
      if (!target) return ''
      if (typeof target.part !== 'number' || target.part <= 0) return ''
      if (typeof target.o !== 'number' || target.o < 0) return ''
      return target.o + ':' + (typeof target.i === 'number' ? target.i : -1) + ':' + target.part
    }

    function RefPanel(props) {
      var info = props.info
      var previewState = react.useState({})
      var previews = previewState[0]
      // 一打开就把每条「跳到某一段」的落点正文取回来：段号只是一串数字，看不到那一段写的是什么
      // 就得先跳过去再判断是不是它。同一条折叠的多个段共用一次请求，取过的按版本缓存。
      react.useEffect(function () {
        if (!info) return
        var items = Array.isArray(info.items) ? info.items : []
        if (items.length === 0) return
        var alive = true
        var pending = {}
        var keys = []
        for (var i = 0; i < items.length; i += 1) {
          var key = panelKeyOf(items[i])
          if (!key || pending[key]) continue
          pending[key] = items[i].target
          keys.push(key)
        }
        if (keys.length === 0) return
        var loading = {}
        for (var k = 0; k < keys.length; k += 1) loading[keys[k]] = { text: '' }
        previewState[1](function (previous) { return Object.assign({}, previous, loading) })
        var ordinals = []
        for (var key2 in pending) {
          if (!Object.prototype.hasOwnProperty.call(pending, key2)) continue
          if (ordinals.indexOf(pending[key2].o) < 0) ordinals.push(pending[key2].o)
        }
        var apply = function (ordinal) {
          loadTurnEntries(props.sessionId, ordinal, props.stamp).then(function (slot) {
            if (!alive) return
            var patch = {}
            for (var key in pending) {
              if (!Object.prototype.hasOwnProperty.call(pending, key)) continue
              if (pending[key].o !== ordinal) continue
              patch[key] = {
                done: true,
                text: slot.status === 'ready' ? segmentPreviewOf(slot.entries, pending[key], props.config) : '',
              }
            }
            previewState[1](function (previous) { return Object.assign({}, previous, patch) })
          })
        }
        for (var oi = 0; oi < ordinals.length; oi += 1) apply(ordinals[oi])
        return function () { alive = false }
      }, [info])
      if (!info) return null
      var items = Array.isArray(info.items) ? info.items : []
      return h('div', { style: PANEL_BACKDROP, onClick: props.onClose },
        h('div', { style: PANEL_BOX, onClick: function (event) { event.stopPropagation() } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: C.title }, info.title || '引用关系'),
            h('div', { style: { flex: 1 } }),
            h('button', { style: C.button, onClick: props.onClose }, '关闭')
          ),
          info.preview ? h('div', { style: PANEL_NOTE_PREVIEW }, info.preview) : null,
          items.length > 0
            ? h('div', { style: PANEL_LIST }, items.map(function (item, index) {
                var key = panelKeyOf(item)
                var got = key ? previews[key] : null
                var text = got && got.text ? got.text : ''
                return h('button', {
                  key: 'r' + index,
                  style: PANEL_ITEM,
                  onClick: function () { props.onPick(item) },
                },
                  h('div', { style: PANEL_ITEM_HEAD }, item.label),
                  text
                    ? h('div', { style: PANEL_ITEM_PREVIEW }, text)
                    : got
                      ? h('div', { style: Object.assign({}, PANEL_ITEM_PREVIEW, { opacity: 0.4 }) },
                          got.done ? '（没有取到这一段的正文）' : '正在读取这一段…')
                      : null
                )
              }))
            : h('div', { style: C.sub }, info.note || '没有可跳转的引用。'),
          info.note ? h('div', { style: C.sub }, info.note) : null
        )
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
      // 引用跳转：focus 是落点，panel 是「谁引用了谁」的列表。
      var focusState = react.useState(null)
      var panelState = react.useState(null)

      react.useEffect(function () {
        NAV.jump = function (target) {
          if (!target) return
          focusState[1]({
            o: typeof target.o === 'number' ? target.o : -1,
            i: typeof target.i === 'number' ? target.i : -1,
            part: typeof target.part === 'number' ? target.part : 0,
            // 落到「分段目录」上：检索没有具体段号时，它指向的正是那张目录。
            dir: target.dir === true,
            gen: (NAV.gen += 1),
          })
          panelState[1](null)
        }
        NAV.refs = function (info) {
          // 面板每换一次内容就换一代：异步补内容的回调据此判断自己是否已经过期。
          NAV.panelGen = (NAV.panelGen || 0) + 1
          panelState[1](info)
        }
        return function () {
          NAV.jump = null
          NAV.refs = null
        }
      }, [])

      // Esc 关面板；宿主环境没有键盘事件时跳过（冒烟测试里 window 是假件）。
      react.useEffect(function () {
        if (!panelState[0]) return
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        var onKey = function (event) { if (event && event.key === 'Escape') panelState[1](null) }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [panelState[0]])

      react.useEffect(function () {
        alive.current = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        setPayload(function (previous) { return { status: previous.data ? 'ready' : 'loading', data: previous.data, error: '', at: previous.at || 0 } })
        fetch('/fold-view?session=' + encodeURIComponent(sessionId), controller ? { signal: controller.signal } : undefined)
          .then(readJson)
          .then(function (body) {
            if (!alive.current) return
            setPayload({ status: 'ready', data: body, error: '', at: Date.now() })
          })
          .catch(function (error) {
            if (!alive.current || (error && error.name === 'AbortError')) return
            setPayload(function (previous) {
              return { status: previous.data ? 'ready' : 'error', data: previous.data, error: String(error && error.message ? error.message : error), at: previous.at || 0 }
            })
          })
        return function () {
          alive.current = false
          if (controller) controller.abort()
        }
      }, [sessionId, tick[0]])

      // 这一页不自动刷新：一次请求就是一整份投影，反复拉会白烧 CPU（每轮卡片都被重渲染）。
      react.useEffect(function () {
        if (!props.onMeta) return
        if (payload.status === 'error') props.onMeta({ text: '读取失败', error: payload.error })
        else if (payload.data) props.onMeta({ text: '读取于 ' + clock(payload.at || 0), error: '' })
        else props.onMeta({ text: '正在读取…', error: '' })
      }, [payload.status, payload.at, payload.error])

      var data = payload.data
      var toolbar = h('div', { style: C.row },
        h('div', { style: C.sub }, '模型实际收到的历史；点开一轮才读取正文。'),
        h('div', { style: { flex: 1 } }),
        h('label', { style: Object.assign({}, C.sub, { cursor: 'pointer' }) },
          h('input', { type: 'checkbox', checked: wide[0], onChange: function (event) { wide[1](event.target.checked) } }),
          ' 展开长文本'
        ),
        h('button', { style: C.button, title: '这一页不自动刷新，重新拉一次投影', onClick: function () { tick[1](function (value) { return value + 1 }) } }, '重新读取')
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
      var recallTotals = data.recallTotals || {}
      var recallBits = []
      if (recallTotals.calls > 0) recallBits.push('召回调用 ' + recallTotals.calls + ' 次')
      if (recallTotals.searches > 0) recallBits.push('检索 ' + recallTotals.searches + ' 次')
      if (recallTotals.recalled > 0) {
        recallBits.push((recallTotals.folds || 0) + ' 段折叠被召回 ' + recallTotals.recalled + ' 次' +
          (recallTotals.parts > 0 ? '（分段一共取回 ' + recallTotals.parts + ' 段次）' : ''))
      }
      if (recallTotals.searched > 0) {
        recallBits.push((recallTotals.searchedFolds || 0) + ' 张分段目录被检索 ' + recallTotals.searched + ' 段次（检索不返回原文）')
      }
      var recallText = recallBits.length > 0 ? '；模型视角里' + recallBits.join('、') : ''
      var notice = h('div', { style: C.notice },
        '折叠后的会话历史 ' + (totals.messages || 0) + ' 条消息、' + formatChars(totals.chars) + '，约 ' +
        formatTokens(tokens) + ' token（4 字符/token，按块 +4）；折叠检查点 ' + (totals.checkpoints || 0) +
        ' 条、重要消息 ' + (totals.pins || 0) + ' 条；相比不折叠省 ' + formatChars(totals.savedChars) +
        '（' + percent(totals.saveRate) + '）' + staleText + recallText + '。'
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
          return h(MemoTurnCard, {
            key: 'g' + index,
            group: group,
            wide: wide[0],
            config: data.config,
            current: index === lastSystemIndex,
            sessionId: sessionId,
            stamp: typeof data.generatedAt === 'number' ? data.generatedAt : 0,
            focus: focusState[0],
          })
        }),
        h(RefPanel, {
          info: panelState[0],
          sessionId: sessionId,
          config: data.config,
          stamp: typeof data.generatedAt === 'number' ? data.generatedAt : 0,
          onClose: function () { panelState[1](null) },
          onPick: function (item) { NAV.jump(item.target) },
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
      // 顶栏那行小字由当前标签页回填：账本给「更新于 …」，模型视角给「读取于 …」。
      var metaState = react.useState(null)
      var reportMeta = react.useCallback ? react.useCallback(function (next) { metaState[1](next) }, []) : function (next) { metaState[1](next) }
      // 关掉总开关时插件对模型完全静默，这一页就只剩账单：先说清楚，免得有人以为折叠坏了。
      var offState = react.useState(null)
      react.useEffect(function () {
        var alive = true
        fetch('/fold-config')
          .then(readJson)
          .then(function (body) {
            if (!alive) return
            var settings = body && body.config ? body.config : null
            offState[1](Boolean(settings) && settings.enabled === false)
          })
          .catch(function () {
            // 读不到配置就当「不知道」：这一条只是提示，不该因为配置接口出错就挡住账本。
            if (alive) offState[1](null)
          })
        return function () { alive = false }
      }, [])
      if (!sessionId) {
        return h('div', { style: C.panel }, h('div', { style: C.notice }, '切换到具体会话后，这里显示该会话的折叠情况。'))
      }
      var tabs = [['ledger', '账本'], ['model', '模型视角']]
      var meta = metaState[0]
      // 换标签页就清掉上一页的「更新于」：两页读取节奏不同，混在一行会让人以为刚刷新过。
      react.useEffect(function () { metaState[1](null) }, [tab])
      var header = h('div', { style: C.header },
        h('div', { style: C.headerTop },
          h('div', { style: C.title }, '上下文折叠'),
          h('div', { style: C.sub }, '折叠算收益，召回与重要消息算成本'),
          h('div', { style: Object.assign({}, C.headerMeta, meta && meta.error ? C.headerMetaError : {}) },
            meta && meta.error ? '读取失败：' + meta.error : (meta ? meta.text : '')
          )
        ),
        h('div', { style: C.tabRow }, tabs.map(function (item) {
          return h('button', {
            key: item[0],
            style: Object.assign({}, C.tab, tab === item[0] ? C.tabActive : {}),
            onClick: function () { setTab(item[0]) },
          }, item[1])
        }), h('div', { style: C.tabHint }, '参数在侧栏「插件」页'))
      )
      var offBanner = offState[0] === true
        ? h('div', { style: C.notice }, '压缩已关闭：不折叠、不注入折叠说明、也不提供召回与固化工具。下方数字取自未压缩的会话，用来核对账单。')
        : null
      var body = tab === 'model'
        ? h(ModelView, { sessionId: sessionId, onMeta: reportMeta })
        : h(Ledger, { sessionId: sessionId, onMeta: reportMeta })
      return h('div', { style: C.panel }, header, offBanner, body)
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
      FoldStatsView: FoldStatsView,
      Ledger: Ledger,
      ModelView: ModelView,
      CompositionPanel: CompositionPanel,
      CompositionChart: CompositionChart,
      TurnCard: TurnCard,
      entryKindOf: entryKindOf,
      costDriftNote: costDriftNote,
      calibrationNote: calibrationNote,
      missNote: missNote,
      CostSection: CostSection,
      ledgerKpis: ledgerKpis,
      formatMoney: formatMoney,
      FoldOriginal: FoldOriginal,
      EntryView: EntryView,
      recallChipLabel: recallChipLabel,
      partRefItems: partRefItems,
      openPartRefs: openPartRefs,
      openSearchRefs: openSearchRefs,
      openCallRefs: openCallRefs,
      searchRefItems: searchRefItems,
      turnSearchedItems: turnSearchedItems,
      partSearchCount: partSearchCount,
      turnCallItems: turnCallItems,
      turnRecalledItems: turnRecalledItems,
      callsOfEntry: callsOfEntry,
      NAV: NAV,
      recallCallTitle: recallCallTitle,
      recallEntryTags: recallEntryTags,
      foldPartsOf: foldPartsOf,
      callsOfBlock: callsOfBlock,
      segmentPreview: segmentPreview,
      segmentPreviewOf: segmentPreviewOf,
      panelKeyOf: panelKeyOf,
      RefPanel: RefPanel,
      recallPlan: recallPlan,
      recallIndexLines: recallIndexLines,
      partRecallCount: partRecallCount,
      FoldItem: FoldItem,
      parseRecallResult: parseRecallResult,
      recallCutText: recallCutText,
      RecallSegment: RecallSegment,
      BlockView: BlockView,
      RecallResult: RecallResult,
    }
    return module.exports
  },
})