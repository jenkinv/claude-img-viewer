import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shown } from '../types'

const PANE = 'img'
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const current = atom({ plugin: 'img-viewer', key: 'current' } as const, null as Shown | null)

const hash = (text: string) => {
  let n = 5381
  for (let i = 0; i < text.length; i++) n = (n * 33 + text.charCodeAt(i)) >>> 0
  return n.toString(36)
}

// Drag-and-drop pastes 'quoted' or back\ slashed paths
const unquote = (text: string) =>
  text.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1')

type Tool = 'sips' | 'magick' | 'convert'

let found: Promise<Tool | null> | undefined

// macOS ships sips; Linux needs ImageMagick: `magick` (7) or `convert` and `identify` (6)
const findTool = ($: EngineInterface) =>
  (found ??= (async (): Promise<Tool | null> => {
    if (await $.fs.exists('/usr/bin/sips')) return 'sips'
    for (const name of ['magick', 'convert'] as const) {
      const ran = await $.process.run([name, '-version']).catch(() => undefined)
      if (ran?.exitCode === 0 && ran.stdout.includes('ImageMagick')) return name
    }
    return null
  })())

const needTool = async ($: EngineInterface) => {
  const tool = await findTool($)
  if (tool === null) throw new Error('img-viewer needs ImageMagick on Linux; install it, for example: sudo apt install imagemagick')
  return tool
}

// Each image operation as the tool spells it; ImageMagick takes the first frame of an animation
const argv = {
  describe: (tool: Tool, src: string) =>
    tool === 'sips'
      ? ['/usr/bin/sips', '-g', 'format', '-g', 'pixelWidth', '-g', 'pixelHeight', src]
      : [...(tool === 'magick' ? ['magick', 'identify'] : ['identify']), '-format', '%m %w %h\n', `${src}[0]`],
  toPng: (tool: Tool, src: string, out: string) =>
    tool === 'sips' ? ['/usr/bin/sips', '-s', 'format', 'png', src, '--out', out] : [tool, `${src}[0]`, `png:${out}`],
  shrink: (tool: Tool, src: string, size: number, out: string) =>
    tool === 'sips'
      ? ['/usr/bin/sips', '-Z', String(size), src, '--out', out]
      : [tool, src, '-resize', `${size}x${size}`, `png:${out}`],
  // Exactly that size; ImageMagick would write a palette BMP for an image of few colours, so 32-bit it is
  toBmp: (tool: Tool, src: string, width: number, height: number, out: string) =>
    tool === 'sips'
      ? ['/usr/bin/sips', '-s', 'format', 'bmp', '-z', String(height), String(width), src, '--out', out]
      : [tool, src, '-resize', `${width}x${height}!`, '-type', 'TrueColorAlpha', `bmp:${out}`],
}

// The Image element reads PNG files only, so anything else is converted first
const load = async ($: EngineInterface, raw: string): Promise<Shown> => {
  const home = raw.startsWith('~/') ? await $.env.get('HOME') : undefined
  const path = home === undefined ? raw : home + raw.slice(1)
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.realPath === undefined) throw new Error(`Not a file: ${raw}`)

  const tool = await needTool($)
  const generation = Math.floor(stat.mtimeMs)
  // The extension can lie (a JPEG named .png), so the tool says what the file really is
  const { stdout } = await $.process.run(argv.describe(tool, stat.realPath))
  const [format, width, height] =
    tool === 'sips'
      ? [/format: (\w+)/.exec(stdout)?.[1], /pixelWidth: (\d+)/.exec(stdout)?.[1], /pixelHeight: (\d+)/.exec(stdout)?.[1]]
      : (/^(\w+) (\d+) (\d+)/.exec(stdout)?.slice(1) ?? [])
  if (!(Number(width) > 0 && Number(height) > 0)) throw new Error(`Cannot read image: ${raw}`)
  let png = stat.realPath
  if (format?.toLowerCase() !== 'png') {
    png = `/tmp/claude-img-${hash(stat.realPath)}-${generation}.png`
    await $.process.run(argv.toPng(tool, stat.realPath, png))
  }

  return { path: stat.realPath, png, generation, width: Number(width), height: Number(height) }
}

const rasters = new Map<string, string>()

// One cell per two pixels stacked: an upper half block, top pixel as foreground, bottom as background
const toCells = async ($: EngineInterface, shown: Shown, columns: number, rows: number) => {
  const key = `${shown.png}:${shown.generation}:${columns}x${rows}`
  const cached = rasters.get(key)
  if (cached !== undefined) return cached

  const bmp = `/tmp/claude-img-${hash(key)}.bmp`
  await $.process.run(argv.toBmp(await needTool($), shown.png, columns, rows * 2, bmp))
  const { base64 } = await $.fs.read(bmp, { as: 'bytes' })
  const view = new DataView(Uint8Array.fromBase64(base64).buffer)
  const offset = view.getUint32(10, true)
  const isTopDown = view.getInt32(22, true) < 0
  // 24-bit BGR (sips, opaque images) or 32-bit BGRA; rows pad to 4 bytes and run bottom-up unless the height is negative
  const size = view.getUint16(28, true) / 8
  const stride = Math.ceil((columns * size) / 4) * 4
  const pixel = (x: number, y: number) => {
    const at = offset + (isTopDown ? y : rows * 2 - 1 - y) * stride + x * size
    if (size === 4 && view.getUint8(at + 3) < 128) return 0x01000000
    return (view.getUint8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)
  }
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const at = 3 * (y * columns + x)
      words[at] = 0x2580
      words[at + 1] = pixel(x, 2 * y)
      words[at + 2] = pixel(x, 2 * y + 1)
    }
  }
  const cells = new Uint8Array(words.buffer).toBase64()
  rasters.set(key, cells)

  return cells
}

const inlined = new Map<string, string | null>()

// Over ssh the terminal cannot open our files, so the PNG goes inline: at most 2 MiB decoded
const toInline = async ($: EngineInterface, shown: Shown) => {
  const key = `${shown.png}:${shown.generation}`
  const cached = inlined.get(key)
  if (cached !== undefined) return cached

  // A photo's PNG can pass 2 MiB at 1600 px, so step down until it fits
  const tool = await needTool($)
  let png: string | null = null
  for (const size of [1600, 1200, 900, 600]) {
    const small = `/tmp/claude-img-${hash(key)}-inline-${size}.png`
    await $.process.run(argv.shrink(tool, shown.png, size, small))
    if ((await $.fs.stat(small)).size > 2 * 1024 * 1024) continue
    png = (await $.fs.read(small, { as: 'bytes' })).base64
    break
  }
  inlined.set(key, png)

  return png
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'img',
      description: 'Show an image in a pane; `/img` alone opens or closes the pane',
      argumentHint: '[path]',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        'Show an image file to the user in the image pane. Use it when the user asks to see, show, open or preview ' +
        'an image. It does not read the image into your context, so you will not see its content; use Read only ' +
        'when you need to look at the image yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The image file: absolute, relative to the working directory, or ~/...' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__img-viewer__show_image' }, async ($, e) => {
    const shown = await load($, unquote(String(e.path ?? ''))).catch((error: Error) => error)
    if (shown instanceof Error) return { result: shown.message }
    await update($, current, () => shown)
    const opened = await $.ui.open({ id: PANE, title: 'Image' })

    return {
      result: opened.isPlaced
        ? `The user now sees ${shown.path} (${shown.width}x${shown.height}) in the image pane. ` +
          'You have not seen its content; use Read if you need to.'
        : `${shown.path} is loaded but the image pane is not shown (${opened.reason}); ask the user to run /img.`,
    }
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    const arg = unquote(e.args)
    if (arg === '' && (await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })

      return {}
    }
    if (arg !== '') {
      const shown = await load($, arg).catch((error: Error) => error)
      if (shown instanceof Error) return { text: shown.message }
      await update($, current, () => shown)
    }
    const opened = await $.ui.open({ id: PANE, title: 'Image' })

    return opened.isPlaced ? {} : { text: `Image pane not shown: ${opened.reason}` }
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !IMAGE.test(e.file_path)) return ran

    // An open pane follows the images Claude reads; a closed one shows the latest when /img opens it
    const shown = await load($, e.file_path).catch(() => undefined)
    if (shown !== undefined) await update($, current, () => shown)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shown = await read($, current)
    if (e.surface !== 'terminal' || shown === null) {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>{shown === null ? 'No image yet: /img <path>' : shown.path}</Text>
    }

    const { Box, Text, Image, Raster } = $.ui.resolve(e)
    // A background session's TERM follows the attached client (xterm-ghostty) while TERM_PROGRAM stays
    // unset, so only TERM_PROGRAM tells a session started directly in Ghostty or kitty. ssh forwards TERM
    // but not TERM_PROGRAM; the daemon never has SSH_TTY
    const isSsh = (await $.env.get('SSH_TTY')) !== undefined
    const isDirect =
      !isSsh &&
      (/ghostty|kitty/i.test(`${await $.env.get('TERM_PROGRAM')}`) || (await $.env.get('KITTY_WINDOW_ID')) !== undefined)
    // Claude Code draws no kitty graphics in background sessions unless CLAUDE_CODE_FORCE_TERMINAL_IMAGES
    // is set; the daemon then passes them on, but the client terminal may be across ssh, so send the PNG
    const isForced = Boolean(await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'))
    const inline = !isDirect && (isForced || (isSsh && /ghostty|kitty/i.test(`${await $.env.get('TERM')}`)))
    const png = inline ? await toInline($, shown).catch(() => null) : null
    const isKitty = png !== null || isDirect
    // A terminal cell is about twice as tall as it is wide
    const maxColumns = Math.min(isKitty ? 255 : 512, e.props.bodyColumns)
    const maxRows = Math.min(isKitty ? 255 : 256, e.props.scroll.bodyRows - 1)
    let columns = maxColumns
    let rows = Math.round((columns * shown.height) / shown.width / 2)
    if (rows > maxRows) {
      rows = maxRows
      columns = Math.round((rows * 2 * shown.width) / shown.height)
    }
    columns = Math.max(1, columns)
    rows = Math.max(1, rows)

    const cells = isKitty ? undefined : await toCells($, shown, columns, rows).catch(() => null)

    return (
      <Box flexDirection="column">
        <Text dimColor>{shown.path}</Text>
        {isKitty ? (
          <Image
            key="img"
            source={png !== null ? { png } : { file: shown.png, format: 'png', generation: shown.generation }}
            columns={columns}
            rows={rows}
            alt={shown.path}
          />
        ) : cells ? (
          <Raster key="img" columns={columns} rows={rows} cells={cells} />
        ) : (
          <Text color="red">Cannot draw this image</Text>
        )}
        {!isKitty && (
          <Text dimColor>
            {isForced
              ? 'Low-res preview: could not prepare the PNG (over 2 MiB, or the image tool failed)'
              : 'Low-res preview: CLAUDE_CODE_FORCE_TERMINAL_IMAGES is not set in this session'}
          </Text>
        )}
      </Box>
    )
  })
}
