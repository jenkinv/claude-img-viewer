# claude-img-viewer

A Claude Code mod that shows images inside Claude Code's terminal UI, in a pane beside the conversation.

- `/img <path>` shows an image; `/img` alone opens or closes the pane.
- Ask in plain words ("show me ~/Desktop/shot.png") and Claude calls the `show_image` tool: the image is shown to you without being read into Claude's context, so it costs no image tokens.
- While the pane is open it follows the images Claude reads with its Read tool, so you see what Claude is looking at.

## Requirements

- Claude Code 2.1.300 or later (mods, the function-hook plugins, are an early-access feature and may change between releases).
- A terminal with the kitty graphics protocol, such as Ghostty or kitty, for full-resolution images. Other terminals get a low-resolution half-block preview.
- macOS: nothing else (it uses the built-in `sips`).
- Linux: ImageMagick 7 (`magick`) or 6 (`convert` and `identify`), for example `sudo apt install imagemagick`.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install img-viewer --marketplace jenkinv/claude-img-viewer
```

or from a shell:

```
claude plugin install img-viewer --marketplace jenkinv/claude-img-viewer
```

## Usage

| You do | What happens |
| --- | --- |
| `/img ~/Pictures/photo.jpg` | Shows that image in the pane |
| `/img` | Opens the pane if it is closed, closes it if it is open |
| "Show me screenshot.png" | Claude calls `show_image`; the image appears, Claude never sees it |
| Claude reads an image file | An open pane switches to that image |

Paths may be absolute, relative to the session's folder, or start with `~/`; a path dragged in from a file manager works too. Anything that is not a PNG is converted first, judged by the file's content rather than its extension. PNG, JPEG, GIF, TIFF and BMP work with both `sips` and ImageMagick; HEIC and WebP depend on the codecs your system has.

## Where images appear

| Session | Result |
| --- | --- |
| `claude` started directly in Ghostty or kitty | Full-resolution image |
| `claude` over SSH from Ghostty or kitty | Full-resolution image (sent inline, downscaled to fit 2 MiB) |
| Background sessions (`claude agents`) | Half-block preview, unless images are forced (below) |
| Any other terminal | Half-block preview |

Claude Code draws no images in background sessions by default. To turn them on, add this to `~/.claude/settings.json` and start a new session:

```json
{ "env": { "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1" } }
```

This variable is undocumented and may stop working in a later release; the mod then falls back to the half-block preview. It also makes Claude Code send image data to terminals that cannot draw it, which then show stray characters.

When the preview is low resolution, a grey line under it says why.

## Limitations

- Transparent images are drawn over the terminal's background, so dark artwork on a transparent background can be hard to see on a dark theme.
- Images pasted into the prompt (`[Image #1]`) cannot be shown; give a file path.
- Claude Code decides where the pane sits (beside the conversation in the fullscreen layout, above the prompt otherwise).
- In the `claude agents` view, Esc and `ctrl+x` shortcuts may not reach the pane; use `/img` to close it.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
