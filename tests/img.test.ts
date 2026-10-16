import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const pane = { plugin: 'img-viewer', surface: 'terminal', component: 'Pane', requestId: 'img' } as const
const props = {
  title: 'Image',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const img = (args: string) =>
  ({ command: 'img', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

const ghostty = { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' }

// 0xAARRGGBB pixels, top-down, laid out as sips writes a BMP: 32-bit, or 24-bit rows padded to 4 bytes
const bmp = (width: number, height: number, pixel: (x: number, y: number) => number, bpp = 32) => {
  const offset = bpp === 32 ? 138 : 54
  const stride = Math.ceil((width * bpp) / 32) * 4
  const bytes = new Uint8Array(offset + stride * height)
  const view = new DataView(bytes.buffer)
  view.setUint32(10, offset, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(28, bpp, true)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const argb = pixel(x, y)
      const at = offset + y * stride + (x * bpp) / 8
      view.setUint8(at, argb & 0xff)
      view.setUint8(at + 1, (argb >>> 8) & 0xff)
      view.setUint8(at + 2, (argb >>> 16) & 0xff)
      if (bpp === 32) view.setUint8(at + 3, argb >>> 24)
    }
  }
  return bytes.toBase64()
}

// The BMP the tool was asked for: sips `-z height width`, ImageMagick `-resize WIDTHxHEIGHT!`
const sipsBmp = (on: On, runs: string[][], bpp: number, pixel: (x: number, y: number, width: number) => number) =>
  on('fs.read', async () => {
    const run = runs.find(argv => argv.includes('-z') || argv.some(arg => /^\d+x\d+!$/.test(arg))) ?? []
    const at = run.indexOf('-z')
    const exact = /^(\d+)x(\d+)!$/.exec(run.find(arg => /^\d+x\d+!$/.test(arg)) ?? '')
    const [height, width] = at >= 0 ? [Number(run[at + 1]), Number(run[at + 2])] : [Number(exact?.[2]), Number(exact?.[1])]
    return { value: { base64: bmp(width, height, (x, y) => pixel(x, y, width), bpp) } }
  })

const world = (
  on: On,
  size: {
    width: number
    height: number
    format?: string
    bytes?: (path: string) => number
    // Which image tool the machine has: macOS sips, ImageMagick 7 or 6, or none
    tool?: 'sips' | 'magick' | 'convert' | 'none'
  },
  term: Record<string, string> = ghostty,
) => {
  const runs: string[][] = []
  const opened: string[] = []
  const openArgs: Array<Record<string, unknown>> = []
  const closed: string[] = []
  mock.env(on, { HOME: '/Users/me', ...term })
  on('fs.stat', async (_, e) =>
    e.path.includes('missing')
      ? { deny: 'ENOENT' }
      : {
          value: {
            kind: 'file',
            size: size.bytes?.(e.path) ?? 1,
            mtimeMs: 1000.7,
            isLink: false,
            realPath: e.path.startsWith('/') ? e.path : `/work/${e.path}`,
          },
        },
  )
  const tool = size.tool ?? 'sips'
  on('fs.exists', async (_, e) => ({ value: e.path === '/usr/bin/sips' ? tool === 'sips' : true }))
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    if (e.argv[1] === '-version') {
      if (e.argv[0] !== tool) return { deny: 'ENOENT' }
      return { value: { exitCode: 0, stdout: 'Version: ImageMagick 7.1.2-18', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // The tool names the real format, whatever the extension says
    const format = size.format ?? (/\.png(\[0\])?$/i.test(e.argv.at(-1) ?? '') ? 'png' : 'jpeg')
    return {
      value: {
        exitCode: 0,
        stdout:
          tool === 'sips'
            ? `x\n  format: ${format}\n  pixelWidth: ${size.width}\n  pixelHeight: ${size.height}\n`
            : `${format.toUpperCase()} ${size.width} ${size.height}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  const open = new Set<string>()
  on('ui.open', async (_, e) => {
    opened.push(e.id)
    openArgs.push({ ...e })
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_, e) => {
    closed.push(e.id)
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: 'Image', isShown: true, isFocused: false, isPlaced: true })),
  }))
  return { runs, opened, openArgs, closed }
}

test('/img shows a wide png across the pane', async ($, on) => {
  const { runs, opened } = world(on, { width: 400, height: 100 })

  const ran = await $.command.run(img('~/a.png'))

  expect(ran.text).toBeUndefined()
  expect(opened).toEqual(['img'])
  expect(runs).toEqual([['/usr/bin/sips', '-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', '/Users/me/a.png']])
  const ui = await $.ui.mount({ ...pane, props })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: '/Users/me/a.png', format: 'png', generation: 1000 })
  expect(image?.props.columns).toBe(100)
  expect(image?.props.rows).toBe(13)
})

test('/img fits a tall image to the pane height', async ($, on) => {
  world(on, { width: 100, height: 400 })

  await $.command.run(img("'/x/my shot.png'"))

  const ui = await $.ui.mount({ ...pane, props })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.alt).toBe('/x/my shot.png')
  expect(image?.props.rows).toBe(39)
  expect(image?.props.columns).toBe(20)
})

test('/img on a missing file says so and opens nothing', async ($, on) => {
  const { opened } = world(on, { width: 1, height: 1 })

  const ran = await $.command.run(img('missing.png'))

  expect(ran.text).toBe('Not a file: missing.png')
  expect(opened).toEqual([])
})

test('Read of a jpg converts it and updates the pane without opening it', async ($, on) => {
  const { runs, opened } = world(on, { width: 200, height: 100 })
  on('tool.call', { tool: 'Read' }, async () => ({ result: {} as never }))

  await $.tool.call({ tool: 'Read', file_path: '/x/notes.txt' })
  expect(runs).toEqual([])
  await $.tool.call({ tool: 'Read', file_path: '/x/shot.jpg' })

  expect(opened).toEqual([])
  const convert = runs.find(argv => argv.includes('-s')) ?? []
  expect(convert.slice(0, 6)).toEqual(['/usr/bin/sips', '-s', 'format', 'png', '/x/shot.jpg', '--out'])
  expect(convert[6]).toMatch(/^\/tmp\/claude-img-[0-9a-z]+-1000\.png$/)
  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: convert[6], format: 'png', generation: 1000 })
})

test('an ssh session from Ghostty sends the png inline', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100 }, { TERM: 'xterm-ghostty', SSH_TTY: '/dev/ttys005' })
  on('fs.read', async () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } }))

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' })
  expect(runs.find(argv => argv.includes('-Z'))?.slice(0, 4)).toEqual(['/usr/bin/sips', '-Z', '1600', '/x/a.png'])
})

test('a background session draws the image as half-block cells', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100 }, { TERM: 'xterm-ghostty' })
  sipsBmp(on, runs, 32, (x, y) => (x + y === 0 ? 0 : y % 2 === 0 ? 0xffff0000 : 0xff0000ff))

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.columns).toBe(100)
  expect(raster?.props.rows).toBe(13)
  expect(runs.find(argv => argv.includes('-z'))?.slice(0, 7)).toEqual(['/usr/bin/sips', '-s', 'format', 'bmp', '-z', '26', '100'])
  expect((await ui.find({ type: 'Text', text: 'Low-res' }))?.text).toBe(
    'Low-res preview: CLAUDE_CODE_FORCE_TERMINAL_IMAGES is not set in this session',
  )
  const words = new Uint32Array(Uint8Array.fromBase64(String(raster?.props.cells)).buffer)
  expect(words.length).toBe(100 * 13 * 3)
  expect([...words.slice(0, 6)]).toEqual([0x2580, 0x01000000, 0x0000ff, 0x2580, 0xff0000, 0x0000ff])
})

test('an opaque image comes back as a 24-bit BMP with padded rows', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100 }, { TERM: 'xterm-ghostty' })
  sipsBmp(on, runs, 24, (x, y, width) => (x === width - 1 ? 0x00ff00 : y % 2 === 0 ? 0xff0000 : 0x0000ff))

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props: { ...props, bodyColumns: 99 } })
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.columns).toBe(99)
  expect(raster?.props.rows).toBe(12)
  const words = new Uint32Array(Uint8Array.fromBase64(String(raster?.props.cells)).buffer)
  const cell = (x: number, y: number) => [...words.slice(3 * (y * 99 + x), 3 * (y * 99 + x) + 3)]
  expect(cell(0, 1)).toEqual([0x2580, 0xff0000, 0x0000ff])
  expect(cell(98, 1)).toEqual([0x2580, 0x00ff00, 0x00ff00])
  expect(cell(98, 11)).toEqual([0x2580, 0x00ff00, 0x00ff00])
})


const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('a background session with images forced sends the png inline', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100 }, { TERM: 'xterm-ghostty', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  on('fs.read', async () => ({ value: { base64: PNG } }))

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  expect(runs.find(argv => argv.includes('-Z'))?.slice(0, 4)).toEqual(['/usr/bin/sips', '-Z', '1600', '/x/a.png'])
})

test('a session started in Ghostty keeps the file source when images are forced', async ($, on) => {
  world(on, { width: 400, height: 100 }, { ...ghostty, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: '/x/a.png', format: 'png', generation: 1000 })
})

test('a forced background session says why it fell back when the png cannot be prepared', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100 }, { TERM: 'xterm-ghostty', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  on('fs.read', async (_, e) => {
    if (e.path.includes('-inline-')) return { deny: 'EIO' }
    const run = runs.find(argv => argv.includes('-z')) ?? []
    const at = run.indexOf('-z')
    return { value: { base64: bmp(Number(run[at + 2]), Number(run[at + 1]), () => 0xff808080) } }
  })

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'Low-res' }))?.text).toBe(
    'Low-res preview: could not prepare the PNG (over 2 MiB, or the image tool failed)',
  )
})

test('a .png that is really a JPEG is converted before it is drawn', async ($, on) => {
  const { runs } = world(on, { width: 470, height: 470, format: 'jpeg' })

  await $.command.run(img('/x/qr.png'))

  const convert = runs.find(argv => argv.includes('-s')) ?? []
  expect(convert.slice(0, 6)).toEqual(['/usr/bin/sips', '-s', 'format', 'png', '/x/qr.png', '--out'])
  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: convert[6], format: 'png', generation: 1000 })
})

const SHOW = 'mcp__img-viewer__show_image'

// Session start registers /img and show_image; the test stands in for the engine beneath
const started = (on: On) => {
  const tools: Array<Record<string, unknown>> = []
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_, e) => {
    tools.push({ ...e })
    return { value: { tool: `mcp__img-viewer__${e.name}` } }
  })
  return tools
}

test('session start puts show_image in front of the model', async ($, on) => {
  world(on, { width: 1, height: 1 })
  const tools = started(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(tools.map(tool => [tool.name, tool.isDeferred])).toEqual([['show_image', false]])
  expect((tools[0]?.inputSchema as { required?: string[] } | undefined)?.required).toEqual(['path'])
})

test('show_image puts an image in the pane without reading it into context', async ($, on) => {
  const { opened } = world(on, { width: 400, height: 100 })
  started(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: SHOW, path: '~/a.png' })

  expect(ran.result).toBe(
    'The user now sees /Users/me/a.png (400x100) in the image pane. You have not seen its content; use Read if you need to.',
  )
  expect(opened).toEqual(['img'])
  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: '/Users/me/a.png', format: 'png', generation: 1000 })
})

test('show_image on a missing file tells the model and opens nothing', async ($, on) => {
  const { opened } = world(on, { width: 1, height: 1 })
  started(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: SHOW, path: 'missing.png' })

  expect(ran.result).toBe('Not a file: missing.png')
  expect(opened).toEqual([])
})

test('auto and close are no subcommands: they read as file names', async ($, on) => {
  const { runs, closed } = world(on, { width: 1, height: 1 })

  await $.command.run(img('auto'))
  await $.command.run(img('close'))

  expect(runs.filter(argv => argv.includes('-g')).map(argv => argv.at(-1)?.split('/').at(-1))).toEqual(['auto', 'close'])
  expect(closed).toEqual([])
})

test('a photo too heavy to send at 1600 px is sent smaller', async ($, on) => {
  const { runs } = world(
    on,
    { width: 5472, height: 3648, bytes: path => (path.includes('-inline-1600') ? 3 * 1024 * 1024 : 1) },
    { TERM: 'xterm-ghostty', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' },
  )
  on('fs.read', async () => ({ value: { base64: PNG } }))

  await $.command.run(img('/x/dji.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect(runs.filter(argv => argv.includes('-Z')).map(argv => argv[2])).toEqual(['1600', '1200'])
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
})

test('/img with no argument opens a closed pane and closes an open one', async ($, on) => {
  const { opened, openArgs, closed } = world(on, { width: 1, height: 1 })

  await $.command.run(img(''))
  expect(opened).toEqual(['img'])
  expect(openArgs[0]?.closeOnEscape).toBeUndefined()

  await $.command.run(img(''))
  expect(closed).toEqual(['img'])
  expect(opened).toEqual(['img'])
})

test('on Linux ImageMagick 7 reads the real format and converts with magick', async ($, on) => {
  const { runs } = world(on, { width: 470, height: 470, format: 'jpeg', tool: 'magick' })

  await $.command.run(img('/x/qr.png'))

  expect(runs.filter(argv => argv[1] !== '-version').map(argv => argv.slice(0, -1))).toEqual([
    ['magick', 'identify', '-format', '%m %w %h\n'],
    ['magick', '/x/qr.png[0]'],
  ])
  expect(runs[1]?.at(-1)).toBe('/x/qr.png[0]')
  const out = runs.at(-1)?.at(-1) ?? ''
  expect(out).toMatch(/^png:\/tmp\/claude-img-[0-9a-z]+-1000\.png$/)
  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: out.slice(4), format: 'png', generation: 1000 })
})

test('ImageMagick 7 also shrinks for inline sends and draws half-block cells', async ($, on) => {
  const { runs } = world(on, { width: 400, height: 100, tool: 'magick' }, { TERM: 'xterm-256color' })
  sipsBmp(on, runs, 32, () => 0xff808080)

  await $.command.run(img('/x/a.png'))

  const ui = await $.ui.mount({ ...pane, props })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  const bmp = runs.find(argv => argv.some(arg => arg.startsWith('bmp:'))) ?? []
  expect(bmp.slice(0, -1)).toEqual(['magick', '/x/a.png', '-resize', '100x26!', '-type', 'TrueColorAlpha'])
})

test('ImageMagick 6 uses identify and convert', async ($, on) => {
  const { runs } = world(
    on,
    { width: 5472, height: 3648, tool: 'convert', bytes: path => (path.includes('-inline-1600') ? 3 * 1024 * 1024 : 1) },
    { TERM: 'xterm-ghostty', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' },
  )
  on('fs.read', async () => ({ value: { base64: PNG } }))

  await $.command.run(img('/x/dji.jpg'))

  const ui = await $.ui.mount({ ...pane, props })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  const tools = runs.filter(argv => argv[1] !== '-version').map(argv => argv[0])
  expect(tools).toEqual(['identify', 'convert', 'convert', 'convert'])
  expect(runs.filter(argv => argv.includes('-resize')).map(argv => argv[3])).toEqual(['1600x1600', '1200x1200'])
})

test('without sips or ImageMagick /img says what to install', async ($, on) => {
  const { opened } = world(on, { width: 1, height: 1, tool: 'none' })

  const ran = await $.command.run(img('/x/a.png'))

  expect(ran.text).toBe('img-viewer needs ImageMagick on Linux; install it, for example: sudo apt install imagemagick')
  expect(opened).toEqual([])
})
