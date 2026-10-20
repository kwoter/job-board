# Field: design system

Field is a field notebook: paper, ink, a green pen and a highlighter. Calm, tactile, made for an
iPad and an Apple Pencil first, laptop second, phone third. Everything should feel like it was
written, not generated.

## Principles
- **Paper, not glass.** Surfaces are sheets of paper with a hairline edge and a soft shadow. Glass
  (backdrop blur) is only for floating chrome: the sidebar on scroll, the bottom bar, the toast.
- **One accent.** Field green does the work (primary buttons, ticks, focus). Highlighter yellow is
  the signature and is used sparingly: today, up next, the active tool. Amber and red only mean time.
- **Write anywhere.** Every place you add a job is a text field big enough to Scribble into with the
  Pencil. No custom drawing pads for text.
- **Respond on press.** Every pressable thing scales to .97 on `:active` within 100ms.

## Themes
Follows the system (`prefers-color-scheme`); the Account panel can pin Paper or Night
(`html[data-theme]`, localStorage `field-theme`).

| Token | Paper (light) | Night (dark) |
| --- | --- | --- |
| `--bg` | `#F3F0E8` | `#11120F` |
| `--bg-2` (sidebar) | `#EBE7DC` | `#0C0D0B` |
| `--surface` (cards, sheets) | `#FFFDF8` | `#1B1C18` |
| `--surface-2` (inputs, wells) | `#F7F4EC` | `#23241F` |
| `--ink` | `#1A1B17` | `#EFECE4` |
| `--ink-2` | `#5C5B54` | `#AAA79D` |
| `--ink-3` | `#94918A` | `#6F6D65` |
| `--line` | `rgba(26,27,23,.08)` | `rgba(239,236,228,.07)` |
| `--line-2` | `rgba(26,27,23,.15)` | `rgba(239,236,228,.14)` |
| `--accent` (field green) | `#1E6B4E` | `#62C295` |
| `--on-accent` | `#FFFFFF` | `#0A1D15` |
| `--mark` (highlighter) | `#F6D365` | `#E9C451` |
| `--amber` (due today) | `#A9680F` | `#E7B04A` |
| `--red` (overdue, high) | `#BE3A26` | `#F07A63` |

## Type
- Display: **Instrument Serif** 400 (roman + italic). Greeting, screen titles, wordmark, empty
  states. Large sizes track at `-0.01em`, leading 1.05.
- UI: **Geist** 400/500/600. Body 15-16px, labels 12px small caps (`letter-spacing .08em`).
- Numbers: Geist with `font-variant-numeric: tabular-nums`.

## Shape and depth
- Radii: 10 (chips, inputs) / 14 (cards, buttons) / 22 (sheets, panels) / 28 (app icon-like marks).
- Card shadow: `0 1px 0 var(--line), 0 10px 24px -14px rgba(20,18,10,.28)`.
- Sheet shadow: `0 30px 80px -20px rgba(20,18,10,.45)`.

## Motion
- Default ease `cubic-bezier(.32,.72,0,1)` (critically damped feel), 200-360ms.
- Ticking a job: ring draws, check strokes in, card settles into Done. Reduced motion: cross-fade.

## Layout
- >= 1024px: sidebar (248px) + content; board in three lanes.
- 760-1023px (iPad portrait): top bar + three lanes, floating bottom switcher.
- < 760px: phone. Swipeable lanes with a segmented tab, floating switcher, add button.
- Notes editor keeps its measured rail layout (see repo history 21 Sep); only colours are tokens.

## App icon
`icons/icon.svg` is the source. Field-green squircle, three cream ruled lines, a highlighter tick on
the first. Rendered by `scripts/render-icons.mjs` to 1024/512/192/180 and a maskable 512.
