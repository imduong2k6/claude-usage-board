# claude-usage-board

A Claude Code mod that recreates the old `/stats` board and draws it in each new chat: Overview and Models tabs, All / 30d / 7d ranges (click them), six stat tiles, a 26-week activity heatmap and a "more tokens than <book>" footnote.

The numbers come from your own local transcripts (`~/.claude/projects`). Nothing is sent anywhere; the board is rebuilt in the background when it is older than 6 hours.

## Install

```
/plugin marketplace add imduong2k6/claude-usage-board
/plugin install usage-board@claude-usage-board
```

Or run it from a clone with `CLAUDE_CODE_PLUGIN_DIRS=/path/to/claude-usage-board`.

The first board appears after the first rebuild (needs `python` on PATH). Type `/usage-board` any time; `/usage-board models 7d` picks a view, `static` draws it without click targets, `debug` shows the click targets.

## Notes

- Pictures draw on the desktop app, VS Code and mobile surfaces; the terminal shows a one-line summary.
- Tabs are drawn inside the picture; invisible buttons laid over them take the clicks. Their alignment was calibrated on Windows and may be slightly off elsewhere.
- The typeface is Anthropic Sans, but it is not shipped (it belongs to Anthropic). On first run the mod cuts a small subset from the copy the Claude desktop app already caches on your computer (`scripts/build_font.py`, written to `data/fonts/` and never committed). This needs Python with `pip install fonttools brotli`. Without that, or if the app cache has no font, the board draws in the system font (Segoe UI first). To use another woff2, run `python scripts/build_font.py data/fonts/anthropic-sans-subset.woff2 <font file>`.
- To add usage from before your transcripts begin, copy `data/baseline.example.json` to `data/baseline.json` and set `tokens`.

Not affiliated with Anthropic. MIT licensed.

