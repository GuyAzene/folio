/**
 * Text that reads on a background a note set by itself, such as a highlighted block copied from a
 * handout: dark text on a light color, light text on a dark one. Without it, a pale block keeps
 * the theme's text color, which is light in dark mode and unreadable there. Returns null for a
 * color it can't read, which then keeps the theme's text.
 */
export function readableText(background: string): string | null {
  const rgb = parseColor(background);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.18 ? "#18181b" : "#f4f4f5";
}

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  yellow: [255, 255, 0],
  pink: [255, 192, 203],
  lightblue: [173, 216, 230],
  lightgreen: [144, 238, 144],
  lightyellow: [255, 255, 224],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  orange: [255, 165, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

function parseColor(value: string): [number, number, number] | null {
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(color)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(color);
  if (rgb)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((channel) =>
      Math.min(255, channel),
    ) as [number, number, number];
  return NAMED[color] ?? null;
}

/** The background a `style` attribute sets, if any, and whether it sets a text color too. */
export function styleColors(style: string): { background: string | null; color: boolean } {
  const declarations = style.split(";").map((part) => part.split(":"));
  let background: string | null = null;
  let color = false;
  for (const [property, ...rest] of declarations) {
    const name = property?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!name || !value) continue;
    if (name === "background-color" || name === "background") background = value;
    if (name === "color") color = true;
  }
  return { background, color };
}
