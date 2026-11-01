import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardView } from '../types'

const COMMAND = 'usage-board'
const STALE_MS = 6 * 60 * 60 * 1000 // rebuild the numbers at most every six hours
const FONT_FILE = 'data/fonts/anthropic-sans-subset.woff2'

// "You've used ~N x more tokens than <book>": the three books the old board's screenshots named,
// with the token counts those screenshots imply (4.6B / 29,314 = 157k, and so on).
const BOOKS = [
  { name: 'Pride and Prejudice', tokens: 157_000 },
  { name: 'Moby-Dick', tokens: 268_000 },
  { name: 'The Lord of the Rings', tokens: 576_000 },
]

type Range = 'all' | '30d' | '7d'
type Tab = 'overview' | 'models'
const RANGE_LABEL: Record<Range, string> = { all: 'All', '30d': '30d', '7d': '7d' }

// Everything below is measured from the old board's 1x screenshot (CSS px, pixel-snapped edges).
const C = {
  card: '#212121',
  tile: '#383838',
  pill: '#313131',
  text: '#f0efec',
  muted: '#898781', // unselected tabs, tile labels, the footnote
  empty: '#383838',
  ramp: ['#86acea', '#6394e3', '#407cdd', '#2566d0'], // lightest to deepest
}
const FONT = "AnthropicSansEmbed, 'Segoe UI', system-ui, sans-serif"
// Weights that draw like the old board's regular / medium / semibold under this renderer (tuned against its screenshot).
const WT = { regular: 350, medium: 475, semibold: 550 }
const CARD_W = 480
const PAD = 12
const GAP = 4
const RADIUS = { card: 8, pill: 5, tile: 5, cell: 2 }
const PILL_PAD = 5.5 // a tab button: 5.5px of padding each side, 1px between buttons
const TAB_BASELINE = 23
// Where each tab's text starts, across the 480px card.
const PENS = { overview: 17.9, models: 84.875, all: 387.45, '30d': 414.375, '7d': 447.875 }
const ADV = { overview: 55.2, models: 41.9, all: 15.1, '30d': 21.6, '7d': 14.0 } // advances at 12px/500 with kerning

type Day = { day: string; messages: number; tokens: number }
type Model = {
  name: string
  messages: number
  tokens: number
  share: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
}
type Block = {
  summary: {
    sessions: number
    messages: number
    tokens: number
    input_tokens: number
    output_tokens: number
    cache_write_tokens: number
    cache_read_tokens: number
    active_days: number
    first_day: string
    last_day: string
    peak_hour: number
    favorite_model: string
  }
  hourly: number[]
  models: Model[]
}
type Stats = {
  generated_at: string
  tz: string
  transcripts_scanned: number
  daily: Day[]
  ranges: Record<Range, Block>
}

const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const pct = (x: number) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`)
const hour12 = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`

const json = (text: unknown): any => {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

// The measured numbers, plus the tokens the person says they used before the transcripts begin
// (data/baseline.json, which the rebuild never writes).
type Loaded = Stats & { earlier: number }
const load = async (read: (path: string) => Promise<unknown>, root: string): Promise<Loaded | undefined> => {
  const stats = json(await read(`${root}/data/stats.json`).catch(() => undefined))
  if (!(stats?.ranges?.all && Array.isArray(stats.daily) && stats.daily.length > 0)) return undefined
  const tokens = Number(json(await read(`${root}/data/baseline.json`).catch(() => undefined))?.tokens)

  return { ...stats, earlier: Number.isFinite(tokens) && tokens > 0 ? tokens : 0 }
}

// The words of the command: `/usage-board models 7d`. Words left out stay undefined.
const words = (args?: string) => {
  const w = (args ?? '').toLowerCase().split(/\s+/)

  return {
    tab: w.includes('models') ? ('models' as const) : w.includes('overview') ? ('overview' as const) : undefined,
    range: w.includes('7d') ? ('7d' as const) : w.includes('30d') ? ('30d' as const) : w.includes('all') ? ('all' as const) : undefined,
    isStatic: w.includes('static'),
    isDebug: w.includes('debug'),
  }
}

// Which tab and range the board shows. Every board row in the chat reads it, so a press redraws them all.
const view = atom({ plugin: 'usage-board', key: 'view' } as const, { tab: 'overview', range: 'all' }, { shape: 'view-1' })

// The font is read once; the picture carries it, so it never depends on what is installed.
let fontData: string | undefined
const styles = (base64: string) =>
  `<style>${base64 ? `@font-face{font-family:AnthropicSansEmbed;src:url(data:font/woff2;base64,${base64}) format('woff2');font-weight:300 800}` : ''}.tn{font-variant-numeric:tabular-nums}</style>`

// SVG pieces. Everything drawn is a rect or a text.
const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '') // XML refuses these, and the engine then drops the picture
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
type TextOpts = { size: number; weight: number; fill: string; anchor?: 'start' | 'middle' | 'end'; tnum?: boolean; wordSpacing?: number }
const text = (x: number, y: number, s: string, o: TextOpts) =>
  `<text x="${x}" y="${y}" font-size="${o.size}" font-weight="${o.weight}" fill="${o.fill}" text-anchor="${o.anchor ?? 'start'}" font-family="${FONT}"${o.tnum ? ' class="tn"' : ''}${o.wordSpacing ? ` word-spacing="${o.wordSpacing}"` : ''}>${esc(s)}</text>`
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0) =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}" rx="${rx}" fill="${fill}"/>`
// A box whose edges land on whole pixels the way a browser's layout snaps them.
const snapped = (x: number, y: number, w: number, h: number, fill: string, rx: number) => {
  const left = Math.round(x)
  const top = Math.round(y)

  return rect(left, top, Math.round(x + w) - left, Math.round(y + h) - top, fill, rx)
}
// The card is always drawn 480 wide; in a narrower chat the whole picture is scaled down together, as the old board did.
const picture = (w: number, h: number, body: string, font: string, scale: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="0 0 ${w} ${h}">${styles(font)}${rect(0, 0, w, h, C.card, RADIUS.card)}${body}</svg>`

// Where the five tab buttons sit (card pixels): the pen of their text, and the box around it.
type Key = 'overview' | 'models' | 'all' | '30d' | '7d'
const tabBoxes = () =>
  (['overview', 'models', 'all', '30d', '7d'] as const).map(key => ({
    key,
    pen: PENS[key],
    left: Math.round(PENS[key] - PILL_PAD),
    right: Math.round(PENS[key] + ADV[key] + PILL_PAD),
  }))

// The top row of the card: Overview / Models, then All / 30d / 7d, the chosen ones in a pill.
const tabs = (tab: Tab, range: Range) => {
  const isOn = (key: Key) => key === tab || key === range
  const label: Record<Key, string> = { overview: 'Overview', models: 'Models', all: 'All', '30d': '30d', '7d': '7d' }
  let out = ''
  for (const b of tabBoxes()) {
    const on = isOn(b.key)
    if (on) out += rect(b.left, 8, b.right - b.left, 20, C.pill, RADIUS.pill)
    out += text(b.pen, TAB_BASELINE, label[b.key], { size: 12, weight: WT.medium, fill: on ? C.text : C.muted })
  }

  return out
}

// Overview, as the old board had it: six tiles, 26 weeks of days, one line about the total.
const overview = (stats: Stats, block: Block, W: number, earlier: number, range: Range) => {
  const s = block.summary
  const inner = W - 2 * PAD
  let out = tabs('overview', range)

  const tw = (inner - 2 * GAP) / 3
  const th = 44
  const tiles: [string, string][] = [
    ['Sessions', int(s.sessions)],
    ['Messages', int(s.messages)],
    ['Total tokens', compact(s.tokens + earlier)],
    ['Active days', int(s.active_days)],
    ['Peak hour', s.messages > 0 ? hour12(s.peak_hour) : '—'],
    ['Favorite model', s.favorite_model],
  ]
  tiles.forEach(([name, value], i) => {
    const x = PAD + (i % 3) * (tw + GAP)
    const y = 48 + Math.floor(i / 3) * (th + GAP)
    out += snapped(x, y, tw, th, C.tile, RADIUS.tile)
    out += text(x + 4, y + 16, name, { size: 12, weight: WT.regular, fill: C.muted })
    out += i === 5 ? text(x + 4, y + 33, value, { size: 12, weight: WT.regular, fill: C.text, tnum: true }) : text(x + 4, y + 35, value, { size: 13, weight: WT.semibold, fill: C.text, tnum: true })
  })

  // 26 weeks across, Sunday on top, the last day in the right-hand column; days outside the range stay empty.
  const cellGap = 3
  const weeks = 26
  const pitch = (inner + cellGap) / weeks
  const cell = pitch - cellGap
  const days = stats.daily
  const lastDow = new Date(`${days[days.length - 1].day}T00:00:00Z`).getUTCDay()
  const lastPos = (weeks - 1) * 7 + lastDow
  const busiest = Math.max(1, ...days.map(d => d.messages))
  const cuts = [0.25, 0.5, 0.75].map(p => p * busiest) // levels scale with the busiest day, so only a few stand out
  const byPos = new Map<number, Day>()
  days.forEach((d, i) => byPos.set(lastPos - (days.length - 1 - i), d))
  const top = 146
  for (let p = 0; p <= lastPos; p++) {
    const d = byPos.get(p)
    const fill = d && d.messages > 0 && d.day >= s.first_day ? C.ramp[cuts.filter(c => d.messages > c).length] : C.empty
    out += snapped(PAD + Math.floor(p / 7) * pitch, top + (p % 7) * pitch, cell, cell, fill, RADIUS.cell)
  }

  const book = BOOKS[Number(s.last_day.slice(8, 10)) % BOOKS.length]
  out += text(PAD - 0.25, 289, `You’ve used ~${Math.round((s.tokens + earlier) / book.tokens)}× more tokens than ${book.name}.`, { size: 11, weight: 400, fill: C.muted, wordSpacing: -0.15 })

  return { body: out, height: 306 }
}

// Models: each model's share, tokens per day, and what the total is made of, in the same tiles.
const models = (stats: Stats, block: Block, W: number, earlier: number, range: Range) => {
  const s = block.summary
  const inner = W - 2 * PAD
  let y = 48
  let out = tabs('models', range)
  const tile = (h: number) => {
    out += snapped(PAD, y, inner, h, C.tile, RADIUS.tile)
    y += h + GAP
  }

  if (earlier > 0) {
    out += text(PAD, y + 9, `Measured since ${dayLabel(s.first_day)}, without the ${compact(earlier)} added.`, { size: 11, weight: WT.regular, fill: C.muted })
    y += 18
  }
  if (block.models.length === 0) {
    tile(44)
    out += text(PAD + 8, y - GAP - 18, 'No activity in this range.', { size: 12, weight: WT.regular, fill: C.muted })
  }
  block.models.slice(0, 5).forEach(m => {
    const top = y
    tile(56)
    out += text(PAD + 8, top + 19, m.name, { size: 14, weight: WT.semibold, fill: C.text })
    out += text(W - PAD - 8, top + 19, `${compact(m.tokens)} · ${pct(m.share)}`, { size: 12, weight: WT.regular, fill: C.muted, anchor: 'end' })
    out += rect(PAD + 8, top + 27, inner - 16, 4, C.card, 2) + rect(PAD + 8, top + 27, m.share > 0 ? Math.max(4, (inner - 16) * m.share) : 0, 4, C.ramp[1], 2)
    out += text(PAD + 8, top + 47, `${int(m.messages)} replies · output ${compact(m.output_tokens)} · cached ${compact(m.cache_read_tokens)}`, { size: 11, weight: WT.regular, fill: C.muted })
  })

  const shown = stats.daily.filter(d => d.day >= s.first_day).slice(-90) // the chart stays small however long the history grows
  if (shown.length > 0) {
    const top = y
    tile(104)
    const peak = shown.reduce((a, d) => (d.tokens > a.tokens ? d : a), shown[0])
    out += text(PAD + 8, top + 19, 'Tokens per day', { size: 12, weight: WT.regular, fill: C.muted })
    out += text(W - PAD - 8, top + 19, `Busiest ${dayLabel(peak.day)} · ${compact(peak.tokens)}`, { size: 12, weight: WT.regular, fill: C.muted, anchor: 'end' })
    const bh = 52
    const bw = (inner - 16) / shown.length
    const maxTokens = Math.max(1, ...shown.map(d => d.tokens))
    shown.forEach((d, i) => {
      const hgt = d.tokens > 0 ? Math.max(2, (d.tokens / maxTokens) * bh) : 2
      const fill = d === peak ? C.ramp[3] : d.tokens > 0 ? C.ramp[1] : C.card
      out += rect(PAD + 8 + i * bw + 1, top + 28 + bh - hgt, Math.max(1, bw - 2), hgt, fill, 1)
    })
    out += text(PAD + 8, top + 98, dayLabel(shown[0].day), { size: 11, weight: WT.regular, fill: C.muted })
    out += text(W - PAD - 8, top + 98, dayLabel(shown[shown.length - 1].day), { size: 11, weight: WT.regular, fill: C.muted, anchor: 'end' })
  }

  const top = y
  tile(112)
  out += text(PAD + 8, top + 19, 'Where the tokens went', { size: 12, weight: WT.regular, fill: C.muted })
  const mix: [string, number][] = [
    ['Cache read', s.cache_read_tokens],
    ['Cache write', s.cache_write_tokens],
    ['Output', s.output_tokens],
    ['Input', s.input_tokens],
  ]
  const mixMax = Math.max(1, ...mix.map(([, n]) => n))
  const trackX = PAD + 8 + 84
  const trackW = inner - 16 - 84 - 84
  mix.forEach(([name, n], i) => {
    const ry = top + 30 + i * 20
    out += text(PAD + 8, ry + 11, name, { size: 12, weight: WT.regular, fill: C.text })
    out += rect(trackX, ry + 3, trackW, 6, C.card, 3) + rect(trackX, ry + 3, n > 0 ? Math.min(trackW, Math.max(3, (trackW * n) / mixMax)) : 0, 6, C.ramp[1], 3)
    out += text(W - PAD - 8, ry + 11, `${compact(n)} · ${pct(n / Math.max(1, s.tokens))}`, { size: 11, weight: WT.regular, fill: C.muted, anchor: 'end' })
  })

  return { body: out, height: y + PAD - GAP }
}

// An invisible button's label: braille blanks take room and show nothing.
const blank = (n: number) => '⠀'.repeat(Math.max(1, n))

// The board is the output of the /usage-board command: no slot of its own to fight over,
// so it shows whatever else (plan bars, other mods) is drawing the band above the prompt.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show the usage board: sessions, tokens, activity, models',
      argumentHint: '[overview|models] [all|30d|7d] [static]',
      immediate: true,
    })
    if (!e.isInteractive) return started

    // A new chat opens with the board. `immediate` lets it run while the first turn is still going.
    $.clock.after(500, () => {
      void $.command.run({ command: COMMAND, args: '' }).catch(() => undefined)
    })

    // The numbers come from the transcripts on disk; rebuild them in the background when old.
    // `$.process` is CLI-only, so on a surface without it the board keeps its last numbers.
    void (async () => {
      const file = `${$.plugin.root}/data/stats.json`
      const script = `${$.plugin.root}/scripts/build_stats.py`
      try {
        const age = await $.fs.stat(file).then(
          async s => (await $.clock.now()) - s.mtimeMs,
          () => Infinity,
        )
        if (age < STALE_MS) return
        for (const python of ['python', 'python3']) {
          const ran = await $.process.run([python, '-I', script, file], { timeoutMs: 600_000 }).catch(() => undefined)
          if (ran?.exitCode === 0) {
            $.ui.invalidate('ui.render') // draw the fresh numbers; the first draw used the old file
            return
          }
        }
        $.ui.log('usage-board: could not rebuild the numbers; showing the last ones', { to: 'debug' })
      } catch (err) {
        $.ui.log(`usage-board: refresh skipped: ${String(err)}`, { to: 'debug' })
      }
    })()

    return started
  })

  // The stored row, and what a surface that draws no picture shows: one line.
  on('command.run', { command: COMMAND }, async ($, e) => {
    // `/usage-board models 7d` sets the view the board rows show; a `static` row keeps to its own words.
    const asked = words(e.args)
    if ((asked.tab || asked.range) && !asked.isStatic) {
      await update($, view, v => ({ tab: asked.tab ?? v.tab, range: asked.range ?? v.range }))
    }
    const stats = await load(path => $.fs.read(path), $.plugin.root)
    if (!stats) return { text: 'Usage board: no numbers yet. They are built from your transcripts in the background.' }
    const s = stats.ranges.all.summary

    return {
      text: `Usage ${dayLabel(s.first_day)} to ${dayLabel(s.last_day)}: ${int(s.sessions)} sessions, ${int(s.messages)} messages, ${compact(s.tokens + stats.earlier)} tokens, peak ${hour12(s.peak_hour)}, ${s.favorite_model}.`,
    }
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== COMMAND || e.surface === 'terminal') return next(e) // the terminal draws no picture
    const stats = await load(path => $.fs.read(path), $.plugin.root)
    if (!stats) return next(e)
    const t = $.ui.resolve(e)
    if (!('Svg' in t)) return next(e)
    const { Box, Button, Svg } = t

    if (!fontData) {
      const bytes = (await $.fs.read(`${$.plugin.root}/${FONT_FILE}`, { as: 'bytes' }).catch(() => undefined)) as { base64?: string } | undefined
      fontData = bytes?.base64 ?? ''
    }

    // `static` draws the board with nothing to press; otherwise invisible buttons sit over the tabs
    // and the shared view decides what shows.
    const asked = words(e.props.args)
    const { tab, range } = asked.isStatic ? { tab: asked.tab ?? 'overview', range: asked.range ?? 'all' } : await read($, view)
    // The old board's card is 480px wide; a narrower chat scales it down. The chat's content is about 140px
    // narrower than `viewport.columns` x 8px.
    const scale = Math.min(1, Math.max(0.7, ((e.viewport?.columns ?? 90) * 8 - 140) / CARD_W))
    const block = stats.ranges[range] ?? stats.ranges.all
    const s = block.summary
    const earlier = range === 'all' ? stats.earlier : 0 // the earlier count belongs to All only
    const drawn = tab === 'models' ? models(stats, block, CARD_W, earlier, range) : overview(stats, block, CARD_W, earlier, range)
    const alt =
      tab === 'models'
        ? `Usage by model, ${RANGE_LABEL[range]}: ${block.models.map(m => `${m.name} ${pct(m.share)}`).join(', ')}.`
        : `Usage, ${RANGE_LABEL[range]}: ${int(s.sessions)} sessions, ${int(s.messages)} messages, ${compact(s.tokens + earlier)} tokens, peak hour ${hour12(s.peak_hour)}, favorite model ${s.favorite_model}.`
    const graphic = <Svg source={picture(CARD_W, drawn.height, drawn.body, fontData, scale)} alt={alt} width={Math.round(CARD_W * scale)} height={Math.round(drawn.height * scale)} />
    if (asked.isStatic) return graphic

    const press = (change: Partial<BoardView>) => () => update($, view, v => ({ ...v, ...change }))
    const change: Record<Key, Partial<BoardView>> = {
      overview: { tab: 'overview' },
      models: { tab: 'models' },
      all: { range: 'all' },
      '30d': { range: '30d' },
      '7d': { range: '7d' },
    }

    // Invisible buttons over the drawn tabs. Measured in the app: a plain button is its label plus about 5.8px of
    // padding each side, a braille blank is 9.1px (Segoe UI Symbol), a cell is 8.086px wide. `debug` shows them as bars.
    const overlay = tabBoxes().map(b => {
      const n = Math.round(((b.right - b.left) * scale - 11.6) / 9.11)

      return (
        <Box key={`hit-${b.key}`} position="absolute" left={Math.round((b.left * scale) / 8.086)} top={0}>
          <Button key={`tab-${b.key}`} plain label={asked.isDebug ? `|${blank(n)}|` : blank(n)} onPress={press(change[b.key])} />
        </Box>
      )
    })

    return (
      <Box flexDirection="column" alignSelf="flex-start">
        {graphic}
        {overlay}
      </Box>
    )
  })
}
