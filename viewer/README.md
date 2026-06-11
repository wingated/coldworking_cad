# coldworking-viewer

A compiled, real-time spectral path tracer for sculptures designed in the
coldworking-cad web app. Runs the same optical model as the web renderer —
hero-wavelength spectral sampling, Cauchy dispersion from Abbe numbers,
dichroic coating spectra, seamless glued-glass interfaces — as a native
GPU compute shader, progressively accumulating while you orbit.

Built on **wgpu**: on Linux it runs on **Vulkan** (first-class on NVIDIA),
on **macOS** it runs on **Metal** — one codebase, no SDKs to install beyond
normal GPU drivers.

## Build

Install Rust (https://rustup.rs), then:

```bash
cd viewer
cargo build --release
```

Linux needs the usual windowing dev packages only at runtime (X11 or
Wayland session); no extra build dependencies. macOS needs nothing extra.

## Run

Export a scene from the web app (**Render tab → "Export scene"**, which
downloads `<name>.render.json`), then:

```bash
./target/release/coldworking-viewer path/to/sculpture.render.json
```

Or generate the demo scene without the browser:

```bash
node ../tools/export_demo_scene.mjs demo.render.json
./target/release/coldworking-viewer demo.render.json
```

**The file is watched**: whenever it changes on disk (e.g. you re-export
from the CAD app onto the same path), the viewer reloads it in place and
restarts accumulation — a live design-render loop.

## Controls

| Input | Action |
|---|---|
| drag | orbit |
| shift+drag | pan |
| wheel | zoom |
| `R` | restart accumulation |
| `D` | toggle dispersion (spectral fire) |
| `G` | toggle matte floor |
| `[` / `]` | fewer / more bounces |
| `-` / `=` | exposure down / up |
| `,` / `.` | light intensity down / up |
| `F` | refit camera to the scene |
| `P` | save screenshot (`screenshot_<unix-time>.ppm`) |
| `Esc` / `Q` | quit |

The window title shows live stats: triangle count, accumulated samples per
pixel, fps, bounce count.

## Notes

- The renderer needs a GPU with compute support — any Vulkan-capable GPU on
  Linux (NVIDIA, AMD, Intel) or any Apple-silicon/Metal Mac. If the wrong
  GPU is picked on a multi-GPU laptop, wgpu honors backend/adapter
  environment variables (e.g. `WGPU_POWER_PREF=high`).
- Samples accumulate indefinitely; camera movement or file reload restarts
  accumulation.
- `cargo test` validates the WGSL shaders with naga (the same compiler wgpu
  uses at runtime) and exercises the scene loader and BVH builder, so CI
  can verify the renderer without a GPU.
