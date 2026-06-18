# Keepsake Design System

## Color Palette

### Primary Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Rose | `#D96B7C` | Primary brand color — buttons, headings, accents, nav CTA |
| Blush | `#E36888` | Secondary brand color — extension UI, highlights, emphasis |
| Tangerine | `#F08C21` | Accent — CTAs, secondary buttons, highlights |
| Tan Hover | `#E57E1C` | Hover state for tangerine |

### Neutral Background Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Butter | `#F4D9A6` | Primary background — website, extension bg |
| Cream | `#FFFBF4` | Light accent background — popups, cards |
| Light Pink | `#F5D0C4` | FAQ section backgrounds |
| Border | `#E0C9A8` | Subtle borders, dividers |

### Text & Ink Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Ink (Dark) | `#3A2E2A` | Primary text, headings |
| Ink Mid | `#6B5A52` | Secondary text, subtitles |
| Ink Light | `#A08878` | Tertiary text, hints |

#### Extension Text Tiers (RGBA opacity)

| Tier | Value | Usage |
|------|-------|-------|
| Ink 2 | `rgba(58,36,24,0.82)` | Body text, input values, card titles |
| Ink 3 | `rgba(58,36,24,0.62)` | Labels, eyebrows, nav, metadata |
| Ink 4 | `rgba(58,36,24,0.44)` | Helper text, sub-labels, supporting info |
| Ink 5 | `rgba(58,36,24,0.28)` | Placeholders, decorative elements |

### Supporting Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Blue | `#7FA7C6` | Accent color option |
| Olive | `#B6BE5A` | Accent color option |
| Spotify Green | `#1DB954` | Progress bars, Spotify player elements |
| Dark Chrome | `#2a1f1a` | Browser chrome backgrounds |
| Very Dark | `#121212` | Screen backgrounds, deep contrast |
| Nav Logo | `#C04E6A` | Logo text color (darker mauve) |
| Overlay | `rgba(90,46,46,0.84)` | Semi-transparent dark overlays |

---

## Typography

### Font Families

| Font | Type | Source | Usage |
|------|------|--------|-------|
| Lora | Serif | Google Fonts | Body text, labels, UI text (14px base) |
| Spectral | Serif Italic | Google Fonts | Taglines, messaging, poetic elements |
| Montserrat | Sans-serif | Google Fonts | Labels, buttons, small caps, UI controls |
| System | Sans-serif | Fallback | System UI text when custom fonts unavailable |

### Website Type Scale

#### Headings

| Element | Font | Size | Weight | Usage |
|---------|------|------|--------|-------|
| H1 (Letter) | Lora | `clamp(1.05rem, 2.4vw, 2.6rem)` | 700 | Main hero heading (responsive) |
| H2 (Features) | Lora | `clamp(22px, 3vw, 34px)` | 700 | Section headings |
| Heading Italic | Lora | — | — | Color: Rose `#D96B7C` |

#### Body

| Element | Font | Size | Weight | Line-height | Usage |
|---------|------|------|--------|-------------|-------|
| Body | Lora | `clamp(0.58rem, 1.5vw, 0.85rem)` | 400 | 1.35 | Main body text |
| Tagline | Spectral | 1rem | 700 | 1.15 | Feature taglines, emotional copy |
| Small | Montserrat | 10px | 600 | — | Labels, captions (0.12em letter-spacing) |

#### UI Labels & Controls

| Element | Font | Size | Weight | Letter-spacing | Usage |
|---------|------|------|--------|-----------------|-------|
| Nav Link | Montserrat | 10px | 600 | 0.1em | Navigation links |
| Button | Montserrat | `clamp(7.5px, 1.3vw, 10px)` | 600 | 0.12em | CTA buttons (UPPERCASE) |
| Pill Label | Montserrat | `clamp(5px, 1.1vw, 7.5px)` | 600 | 0.12em | Tag badges |
| Stamp Number | Montserrat | `clamp(6.5px, 0.6vw, 7.5px)` | 700 | 0.18em | Feature stamp numbers |
| Stamp Title | Lora | `clamp(12px, 1.25vw, 17px)` | 700 | — | Feature stamp titles |
| Stamp Desc | Lora | `clamp(10px, 1.0vw, 13px)` | 400 | — | Feature descriptions |

### Extension Type Scale

#### Main Text

| Element | Font | Size | Weight | Usage |
|---------|------|------|--------|-------|
| Base Body | Lora | 14px | 400 | Default text in inputs/textareas |
| Auth Gate | Spectral | 13px | 400 (italic) | Messaging in auth sections |
| Composer Label | Montserrat | 8.5px | 600 | "WRITING AS" header |
| Placeholder | Lora | 13px | 400 (italic) | Textarea/input placeholders |
| Status Message | Spectral | 11px | 400 (italic) | Success/error messages |

#### UI Labels

| Element | Font | Size | Weight | Letter-spacing | Usage |
|---------|------|------|--------|-----------------|-------|
| Small Label | Montserrat | 9px | 500 | 0.04em | Email display, small captions |
| Link/Action | Montserrat | 9px | 500 | 0.06em | "Account", "Sign out" links (UPPERCASE) |
| Section Label | Montserrat | 10px | 700 | 0.06em | "NOW PLAYING", section headers |
| Timestamp Badge | Montserrat | 8.5px | 600 | 0.15em | "✦ AT 1:24" timestamp labels |
| Button Small | Montserrat | 8px | 600 | 0.10em | Secondary buttons |
| Credits Badge | Montserrat | 10px | 700 | 0.06em | Credit display |
| Helper Text | Montserrat | 8px | 600 | — | Smaller UI text |

#### Card & Note Text

| Element | Font | Size | Weight | Usage |
|---------|------|------|--------|-------|
| Note Title | Lora | 11.5px | 400 | Card titles, main text |
| Note Meta | Montserrat | 8px | 600 (uppercase) | Metadata — "A NOTE · 1:24" |
| Experience Banner | Lora | 11.5px | 400 | Experience mode text |
| Tutorial Banner | Lora | 15px | 400 (italic) | Tutorial instructions |

---

## Sizing Reference

### Radius

- Large components: `22px` (illustration frames, large cards)
- Medium components: `14px` (auth gate, note cards)
- Small components: `10px` (FAQ items)
- Buttons: `20px` (pill-shaped)
- Inputs: `6px` (subtle corners)

### Spacing Base

- Base unit: `16px`
- Extension padding: `14px`
- Gutter gap: `8px` to `16px`
- Section gap: `24px` to `32px`

### Shadows

- Subtle: `0 8px 40px rgba(58,36,24,0.14)` — illustration frames
- Strong: `0 8px 40px rgba(0,0,0,0.55)` — popup modals
- Overlay: `rgba(90,46,46,0.84)` — semi-transparent dark overlay
