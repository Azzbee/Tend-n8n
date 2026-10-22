export interface Pixel {
  x: number;
  y: number;
  tone: number;
  bridge: boolean;
}
export function animationAllowed(
  paused: boolean,
  reducedMotion: boolean,
  hidden: boolean,
): boolean {
  return !paused && !reducedMotion && !hidden;
}
const profile: ReadonlyArray<readonly [number, number]> = [
  [3, 28],
  [9, 24],
  [13, 22],
  [13, 19],
  [9, 17],
  [7, 13],
  [7, 8],
  [10, 4],
  [15, 2],
  [23, 1],
  [28, 3],
  [31, 7],
  [31, 10],
  [34, 13],
  [31, 14],
  [31, 16],
  [29, 18],
  [25, 19],
  [24, 22],
  [30, 25],
  [35, 28],
];
function inside(x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = profile.length - 1; i < profile.length; j = i++) {
    const a = profile[i];
    const b = profile[j];
    if (a === undefined || b === undefined) continue;
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
export function profilePixels(): Pixel[] {
  const pixels: Pixel[] = [];
  for (let y = 1; y < 28; y++) {
    for (let x = 3; x < 36; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const tone = ((x * 17 + y * 31) % 13) / 13;
      if ((x * 11 + y * 7) % 17 === 0) continue;
      pixels.push({ x, y, tone, bridge: false });
      pixels.push({ x: 79 - x, y, tone: 1 - tone, bridge: false });
    }
  }
  for (let x = 34; x <= 45; x++) {
    pixels.push({ x, y: 12 + ((x * 7) % 5), tone: (x % 4) / 4, bridge: true });
  }
  return pixels;
}
// A toggle button: the label stays put and aria-pressed carries the state;
// with the device's reduce-motion setting there is nothing to toggle.
export function motionButtonState(
  paused: boolean,
  reduced: boolean,
): { label: string; disabled: boolean; pressed: "true" | "false" | null } {
  return reduced
    ? { label: "Motion off (device setting)", disabled: true, pressed: null }
    : {
        label: "Pause motion",
        disabled: false,
        pressed: String(paused) as "true" | "false",
      };
}
export function mountPixelArt(
  canvas: HTMLCanvasElement,
  button: HTMLButtonElement,
): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const groups = new Map<string, Pixel[]>();
  for (const pixel of profilePixels()) {
    const color = pixel.bridge
      ? `rgba(220,245,188,${0.45 + pixel.tone * 0.5})`
      : `rgba(192,211,168,${0.3 + pixel.tone * 0.6})`;
    const group = groups.get(color) ?? [];
    group.push(pixel);
    groups.set(color, group);
  }
  let paused = false;
  let frame: number | null = null;
  let lastDraw = 0;
  let width = 0;
  let height = 0;
  let pointer = 0;
  function draw(time: number): void {
    if (context === null) return;
    const unit = Math.min(height / 28, width / 80);
    const left = (width - 80 * unit) / 2;
    const top = (height - 28 * unit) / 2;
    const moving = animationAllowed(paused, motion.matches, document.hidden);
    context.clearRect(0, 0, width, height);
    for (const [color, pixels] of groups) {
      context.fillStyle = color;
      for (const pixel of pixels) {
        const wave = moving
          ? Math.sin(time / 1700 + pixel.x * 0.7 + pixel.y * 0.4)
          : 0;
        const drift =
          wave * (pixel.bridge ? 1.8 : 0.45) +
          (moving ? pointer * pixel.tone * 1.7 : 0);
        context.fillRect(
          left + pixel.x * unit + drift,
          top + pixel.y * unit,
          unit * 0.76,
          unit * 0.76,
        );
      }
    }
  }

  function tick(time: number): void {
    frame = null;
    if (!animationAllowed(paused, motion.matches, document.hidden)) return;
    if (time - lastDraw >= 32) {
      draw(time);
      lastDraw = time;
    }
    frame = requestAnimationFrame(tick);
  }
  function reconcile(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const state = motionButtonState(paused, motion.matches);
    button.disabled = state.disabled;
    button.textContent = state.label;
    if (state.pressed === null) button.removeAttribute("aria-pressed");
    else button.setAttribute("aria-pressed", state.pressed);
    draw(0);
    if (animationAllowed(paused, motion.matches, document.hidden))
      frame = requestAnimationFrame(tick);
  }
  function resize(): void {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    reconcile();
  }
  button.addEventListener("click", () => {
    paused = !paused;
    reconcile();
  });
  motion.addEventListener("change", reconcile);
  document.addEventListener("visibilitychange", reconcile);
  canvas.addEventListener("pointermove", (event) => {
    const bounds = canvas.getBoundingClientRect();
    pointer = Math.max(
      -1,
      Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2),
    );
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = 0;
  });
  new ResizeObserver(resize).observe(canvas);
  resize();
  canvas.dataset.ready = "true";
  button.hidden = false;
}
