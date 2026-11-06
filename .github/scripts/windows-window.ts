// Pictures of Folio's window on Windows, light and dark, with the buttons Windows draws over the
// tab strip: the screen itself is captured, since a page's own screenshot has no window frame.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { launch } from "../../tests/electron/app.ts";

const out = resolve(process.argv[2] ?? "window-pictures");
await mkdir(out, { recursive: true });

function screen(file: string): void {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    `$bitmap.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "inherit" });
}

const running = await launch(await mkdtemp(resolve(tmpdir(), "folio-window-")));
try {
  const place = () =>
    running.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
      window.focus();
    });
  await place();
  await running.page.waitForTimeout(3_000);
  screen(resolve(out, "light.png"));
  await running.page.evaluate(() => localStorage.setItem("folio.theme", "dark"));
  await running.page.reload();
  await place();
  await running.page.waitForTimeout(3_000);
  screen(resolve(out, "dark.png"));
} finally {
  await running.close();
}
