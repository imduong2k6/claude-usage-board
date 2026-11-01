import { expect, test } from 'claude-code/testing'

const output = (command: string, args = '') =>
  ({
    plugin: 'usage-board',
    component: 'CommandOutput',
    props: { command, args, text: 'summary', isErrored: false },
  }) as const

const day = (d: number, messages: number, tokens: number) => ({
  day: `2026-10-${String(d).padStart(2, '0')}`,
  messages,
  tokens,
  output_tokens: 0,
  sessions: 1,
})

const model = { name: 'Opus 5.5', messages: 1200, tokens: 2_000_000, share: 1, input_tokens: 10, output_tokens: 20_000, cache_write_tokens: 100_000, cache_read_tokens: 1_880_000 }
const block = (first_day: string, sessions: number, messages: number) => ({
  summary: {
    sessions,
    messages,
    tokens: 2_000_000,
    input_tokens: 10,
    output_tokens: 20_000,
    cache_write_tokens: 100_000,
    cache_read_tokens: 1_880_000,
    active_days: 3,
    first_day,
    last_day: '2026-10-31',
    peak_hour: 21,
    favorite_model: 'Opus 5.5',
  },
  hourly: Array.from({ length: 24 }, (_, h) => (h === 21 ? 50 : h)),
  models: [model],
})

const STATS = {
  generated_at: '2026-10-31T22:00:00-07:00',
  tz: 'UTC-7',
  transcripts_scanned: 9,
  daily: [day(29, 100, 500_000), day(30, 0, 0), day(31, 1134, 1_500_000)],
  ranges: { all: block('2026-10-29', 3, 1234), '30d': block('2026-10-29', 3, 1234), '7d': block('2026-10-29', 2, 99) },
}

// Reads answered from memory: the stats, the earlier count when one is given (no file otherwise), and the font.
const FONT_STUB = 'QUJDREVG'
const files = (earlier?: number, font: boolean = false) => (_: unknown, e: { path: string; as?: string }) => {
  if (e.as === 'bytes') {
    if (!font) throw new Error('ENOENT')

    return { value: { base64: FONT_STUB } }
  }
  if (!e.path.endsWith('baseline.json')) return { value: JSON.stringify(STATS) }
  if (earlier === undefined) throw new Error('ENOENT')

  return { value: JSON.stringify({ tokens: earlier }) }
}

const engineRow = ($: any, e: any) => {
  const { Text } = $.ui.resolve(e)

  return <Text>engine</Text> // nothing draws the row beneath the plugin: this stands for the engine
}

const KEYS = ['tab-overview', 'tab-models', 'tab-all', 'tab-30d', 'tab-7d']

test('/usage-board draws the old board as one picture, with its own card, tabs and font, where pictures draw', async ($, on) => {
  on('fs.read', files(1_000_000, true))
  on('ui.render', engineRow)
  await $.command.run({ command: 'usage-board', args: 'overview all' })

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...output('usage-board'), surface })
    const picture = await ui.find({ type: 'Svg' })
    const source = String(picture?.props.source)

    expect(String(picture?.props.alt)).toContain('3 sessions')
    expect(String(picture?.props.alt)).toContain('3.0M tokens') // 2.0M measured + 1.0M earlier
    expect(source).toContain('>3.0M<') // the Total tokens tile
    expect(source).toContain('more tokens than')
    expect(source).toContain('>Overview<') // the tabs are drawn in the picture
    expect(source).toContain('rx="8"') // and so is the card
    expect(source).toContain('@font-face{font-family:AnthropicSansEmbed;src:url(data:font/woff2;base64,' + FONT_STUB) // with its own font
    expect(source).toContain('class="tn"') // tabular figures on the values
    expect(await ui.find({ type: 'Box', key: 'native-card' })).toBeUndefined()
    await ui.unmount()
  }
})

test('five invisible buttons sit over the tabs, none drawn, each a press target', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)

  const ui = await $.ui.mount({ ...output('usage-board'), surface: 'desktop' })
  const boxes = (await ui.findAll({ type: 'Box' })).filter(b => b.props.position === 'absolute')

  expect(boxes.length).toBe(5)
  for (const key of KEYS) expect(await ui.find({ key })).toBeDefined()
  for (const key of KEYS) expect((await ui.find({ key }))?.props.plain).toBe(true)
  // the labels are braille blanks: they take room and show nothing
  expect((await ui.find({ key: 'tab-overview' }))?.text.replace(/⠀/g, '')).toBe('')
  await ui.unmount()
})

test('pressing a tab changes what the board shows', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)
  await $.command.run({ command: 'usage-board', args: 'overview all' })

  const ui = await $.ui.mount({ ...output('usage-board'), surface: 'desktop' })
  await ui.press({ key: 'tab-7d' })
  await ui.press({ key: 'tab-models' })
  const after = await $.ui.mount({ ...output('usage-board'), surface: 'desktop' })

  expect(String((await after.find({ type: 'Svg' }))?.props.alt)).toContain('Usage by model, 7d')
  await ui.unmount()
  await after.unmount()
})

test('the words of the command set the view', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)

  for (const [args, alt] of [
    ['models 30d', 'Usage by model, 30d'],
    ['overview', 'Usage, 30d'], // the range stays
    ['all', 'Usage, All'],
  ] as const) {
    await $.command.run({ command: 'usage-board', args })
    const ui = await $.ui.mount({ ...output('usage-board'), surface: 'desktop' })

    expect(String((await ui.find({ type: 'Svg' }))?.props.alt)).toContain(alt)
    await ui.unmount()
  }
})

test('static draws the board with nothing to press, and debug makes the click targets visible', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)

  const still = await $.ui.mount({ ...output('usage-board', 'static models 7d'), surface: 'desktop' })
  expect(String((await still.find({ type: 'Svg' }))?.props.alt)).toContain('Usage by model, 7d')
  expect(await still.find({ type: 'Button' })).toBeUndefined()
  await still.unmount()

  const debug = await $.ui.mount({ ...output('usage-board', 'debug'), surface: 'desktop' })
  expect((await debug.find({ key: 'tab-overview' }))?.text).toMatch(/^\|⠀+\|$/)
  await debug.unmount()
})

test('in a narrow chat the whole picture scales down together', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)

  const ui = await $.ui.mount({ ...output('usage-board'), surface: 'desktop', viewport: { columns: 60, rows: 40 } })
  const picture = await ui.find({ type: 'Svg' })

  expect(Number(picture?.props.width)).toBeLessThan(480)
  expect(Number(picture?.props.width)).toBeGreaterThanOrEqual(336)
  expect(String(picture?.props.source)).toContain('viewBox="0 0 480 306"') // still drawn at 480
  await ui.unmount()
})

test('without the font file it still draws, in the system font', async ($, on) => {
  on('fs.read', files(undefined, false))
  on('ui.render', engineRow)

  const ui = await $.ui.mount({ ...output('usage-board'), surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)

  expect(source).not.toContain('@font-face')
  expect(source).toContain('Segoe UI')
  await ui.unmount()
})

test('the terminal keeps the engine row, which holds the one-line text', async ($, on) => {
  on('fs.read', files())
  on('ui.render', engineRow)

  const ui = await $.ui.mount({ ...output('usage-board'), surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('the command answers one line of text, with the earlier count in the total', async ($, on) => {
  on('fs.read', files(1_000_000))

  const { text } = await $.command.run({ command: 'usage-board', args: '' })

  expect(text).toContain('3 sessions')
  expect(text).toContain('3.0M tokens')
})

test('without an earlier count the total is the measured one', async ($, on) => {
  on('fs.read', files())

  const { text } = await $.command.run({ command: 'usage-board', args: '' })

  expect(text).toContain('2.0M tokens')
})

test('another command, no numbers, or numbers in an older format keep the engine row', async ($, on) => {
  let file = JSON.stringify(STATS)
  on('fs.read', () => {
    if (file === 'missing') throw new Error('ENOENT')

    return { value: file }
  })
  on('ui.render', engineRow)

  for (const [command, content] of [
    ['cost', JSON.stringify(STATS)],
    ['usage-board', 'missing'],
    ['usage-board', JSON.stringify({ summary: STATS.ranges.all.summary, daily: STATS.daily })],
  ] as const) {
    file = content
    const ui = await $.ui.mount({ ...output(command), surface: 'desktop' })

    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  }
})
