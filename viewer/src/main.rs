//! coldworking-viewer: real-time spectral path tracer for scenes exported
//! from the coldworking-cad web app (.render.json).
//!
//! Usage:  coldworking-viewer <scene.render.json>
//!
//! The file is watched and reloaded automatically when it changes, so you
//! can keep exporting from the CAD app and see updates live.
//!
//! Controls:
//!   drag           orbit          wheel        zoom
//!   shift+drag     pan            R            restart accumulation
//!   D              toggle dispersion           G  toggle floor
//!   [ / ]          bounces -/+    - / =        exposure -/+
//!   , / .          light dim/brighten          P  save screenshot (PPM)
//!   F              refit camera to scene       Esc/Q quit

use coldworking_viewer::{renderer, scene};

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::Watcher;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

use renderer::{Camera, Options, Renderer};

#[derive(Debug)]
enum UserEvent {
    FileChanged,
}

struct Orbit {
    theta: f32,
    phi: f32,
    dist: f32,
    target: [f32; 3],
}

impl Orbit {
    fn eye(&self) -> [f32; 3] {
        let (cp, sp) = (self.phi.cos(), self.phi.sin());
        let (ct, st) = (self.theta.cos(), self.theta.sin());
        [
            self.target[0] + cp * ct * self.dist,
            self.target[1] + sp * self.dist,
            self.target[2] + cp * st * self.dist,
        ]
    }

    fn fit(&mut self, bbox: &scene::BBox) {
        self.target = [
            (bbox.min[0] + bbox.max[0]) / 2.0,
            (bbox.min[1] + bbox.max[1]) / 2.0,
            (bbox.min[2] + bbox.max[2]) / 2.0,
        ];
        let size = ((bbox.max[0] - bbox.min[0]).powi(2)
            + (bbox.max[1] - bbox.min[1]).powi(2)
            + (bbox.max[2] - bbox.min[2]).powi(2))
        .sqrt();
        self.dist = (size * 1.6).max(2.0);
    }
}

struct App {
    path: PathBuf,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    orbit: Orbit,
    options: Options,
    scene_name: String,
    tri_count: u32,

    dragging: bool,
    shift: bool,
    cursor: (f64, f64),
    last_title: Instant,
    last_reload: Instant,
    fps_frames: u32,
    fps_t0: Instant,
    fps: f32,
}

impl App {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            window: None,
            renderer: None,
            orbit: Orbit { theta: 0.7, phi: 0.42, dist: 8.0, target: [0.0; 3] },
            options: Options::default(),
            scene_name: String::new(),
            tri_count: 0,
            dragging: false,
            shift: false,
            cursor: (0.0, 0.0),
            last_title: Instant::now(),
            last_reload: Instant::now() - Duration::from_secs(10),
            fps_frames: 0,
            fps_t0: Instant::now(),
            fps: 0.0,
        }
    }

    fn camera(&self) -> Camera {
        Camera {
            eye: self.orbit.eye(),
            target: self.orbit.target,
            fov: 40.0_f32.to_radians(),
        }
    }

    fn load_scene(&mut self, fit: bool) {
        // Editors often write files non-atomically; retry briefly on failure.
        let mut last_err = None;
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(120));
            }
            match scene::load(&self.path) {
                Ok(s) => {
                    self.scene_name = s.name.clone();
                    self.tri_count = s.tri_count;
                    self.options.floor_y = s.bbox.min[1] - 1e-4;
                    if fit {
                        self.orbit.fit(&s.bbox);
                    }
                    if let Some(r) = &mut self.renderer {
                        r.set_scene(&s);
                    }
                    log::info!(
                        "loaded {:?}: {} triangles ({})",
                        self.path, s.tri_count, s.name
                    );
                    return;
                }
                Err(e) => last_err = Some(e),
            }
        }
        log::error!(
            "failed to load {:?}: {} (keeping previous scene)",
            self.path,
            last_err.unwrap()
        );
    }

    fn reset(&mut self) {
        if let Some(r) = &mut self.renderer {
            r.reset();
        }
    }

    fn screenshot(&self) {
        let Some(r) = &self.renderer else { return };
        let (w, h, rgb) = r.read_image(self.options.exposure);
        let name = format!(
            "screenshot_{}.ppm",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        let mut data = format!("P6\n{w} {h}\n255\n").into_bytes();
        data.extend_from_slice(&rgb);
        match std::fs::write(&name, data) {
            Ok(()) => log::info!("saved {name}"),
            Err(e) => log::error!("screenshot failed: {e}"),
        }
    }

    fn update_title(&mut self) {
        if self.last_title.elapsed() < Duration::from_millis(250) {
            return;
        }
        self.last_title = Instant::now();
        if let (Some(w), Some(r)) = (&self.window, &self.renderer) {
            w.set_title(&format!(
                "{} — {} tris · {} spp · {:.0} fps · bounces {} · {}{}",
                self.scene_name,
                self.tri_count,
                r.sample_count,
                self.fps,
                self.options.bounces,
                if self.options.dispersion { "dispersion" } else { "no dispersion" },
                if self.options.floor { " · floor" } else { "" },
            ));
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("coldworking-viewer")
                        .with_inner_size(winit::dpi::LogicalSize::new(1280, 800)),
                )
                .expect("create window"),
        );
        match Renderer::new(window.clone()) {
            Ok(r) => self.renderer = Some(r),
            Err(e) => {
                eprintln!("Failed to initialize GPU renderer: {e}");
                event_loop.exit();
                return;
            }
        }
        self.window = Some(window);
        self.load_scene(true);
        self.window.as_ref().unwrap().request_redraw();
    }

    fn user_event(&mut self, _el: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::FileChanged => {
                // Debounce bursts of events from a single save.
                if self.last_reload.elapsed() > Duration::from_millis(150) {
                    self.last_reload = Instant::now();
                    log::info!("file changed; reloading");
                    self.load_scene(false);
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),

            WindowEvent::Resized(size) => {
                if let Some(r) = &mut self.renderer {
                    r.resize(size.width, size.height);
                }
            }

            WindowEvent::RedrawRequested => {
                let cam = self.camera();
                if let Some(r) = &mut self.renderer {
                    if let Err(e) = r.render(&cam, &self.options, 1) {
                        log::warn!("render: {e}");
                    }
                    self.fps_frames += 1;
                    let el = self.fps_t0.elapsed().as_secs_f32();
                    if el > 0.5 {
                        self.fps = self.fps_frames as f32 / el;
                        self.fps_frames = 0;
                        self.fps_t0 = Instant::now();
                    }
                }
                self.update_title();
                if let Some(w) = &self.window {
                    w.request_redraw(); // continuous progressive rendering
                }
            }

            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                self.dragging = state == ElementState::Pressed;
            }

            WindowEvent::CursorMoved { position, .. } => {
                let dx = (position.x - self.cursor.0) as f32;
                let dy = (position.y - self.cursor.1) as f32;
                self.cursor = (position.x, position.y);
                if !self.dragging {
                    return;
                }
                if self.shift {
                    // Pan in the view plane.
                    let eye = self.orbit.eye();
                    let fwd = [
                        self.orbit.target[0] - eye[0],
                        self.orbit.target[1] - eye[1],
                        self.orbit.target[2] - eye[2],
                    ];
                    let fl = (fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]).sqrt();
                    let f = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
                    let right = [f[2], 0.0, -f[0]]; // cross(f, up) up=(0,1,0), normalized below
                    let rl = (right[0] * right[0] + right[2] * right[2]).sqrt().max(1e-6);
                    let r = [right[0] / rl, 0.0, right[2] / rl];
                    let up = [
                        r[1] * f[2] - r[2] * f[1],
                        r[2] * f[0] - r[0] * f[2],
                        r[0] * f[1] - r[1] * f[0],
                    ];
                    let s = self.orbit.dist * 0.0016;
                    for k in 0..3 {
                        self.orbit.target[k] += -r[k] * dx * s + up[k] * dy * s;
                    }
                } else {
                    self.orbit.theta += dx * 0.008;
                    self.orbit.phi = (self.orbit.phi + dy * 0.008).clamp(-1.5, 1.5);
                }
                self.reset();
            }

            WindowEvent::MouseWheel { delta, .. } => {
                let amount = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y * 40.0,
                    MouseScrollDelta::PixelDelta(p) => p.y as f32,
                };
                self.orbit.dist = (self.orbit.dist * (-amount * 0.0024).exp()).clamp(0.3, 300.0);
                self.reset();
            }

            WindowEvent::ModifiersChanged(m) => {
                self.shift = m.state().shift_key();
            }

            WindowEvent::KeyboardInput { event, .. } => {
                if event.state != ElementState::Pressed {
                    return;
                }
                match event.logical_key {
                    Key::Named(NamedKey::Escape) => event_loop.exit(),
                    Key::Character(ref s) => match s.as_str() {
                        "q" => event_loop.exit(),
                        "r" => self.reset(),
                        "d" => {
                            self.options.dispersion = !self.options.dispersion;
                            self.reset();
                        }
                        "g" => {
                            self.options.floor = !self.options.floor;
                            self.reset();
                        }
                        "[" => {
                            self.options.bounces = self.options.bounces.saturating_sub(4).max(2);
                            self.reset();
                        }
                        "]" => {
                            self.options.bounces = (self.options.bounces + 4).min(80);
                            self.reset();
                        }
                        "-" => self.options.exposure = (self.options.exposure / 1.25).max(0.05),
                        "=" | "+" => self.options.exposure = (self.options.exposure * 1.25).min(20.0),
                        "," => {
                            self.options.env_intensity = (self.options.env_intensity / 1.25).max(0.1);
                            self.reset();
                        }
                        "." => {
                            self.options.env_intensity = (self.options.env_intensity * 1.25).min(10.0);
                            self.reset();
                        }
                        "f" => {
                            if let Ok(s) = scene::load(&self.path) {
                                self.orbit.fit(&s.bbox);
                                self.reset();
                            }
                        }
                        "p" => self.screenshot(),
                        _ => {}
                    },
                    _ => {}
                }
            }

            _ => {}
        }
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,wgpu_core=warn,wgpu_hal=warn,naga=warn"))
        .init();

    let Some(path) = std::env::args().nth(1).map(PathBuf::from) else {
        eprintln!("usage: coldworking-viewer <scene.render.json>");
        eprintln!("Export a scene from the web app: Render tab -> \"Export scene\".");
        std::process::exit(2);
    };
    if !path.exists() {
        eprintln!("file not found: {}", path.display());
        std::process::exit(2);
    }

    let event_loop = match EventLoop::<UserEvent>::with_user_event().build() {
        Ok(el) => el,
        Err(e) => {
            eprintln!("Could not create a window system connection: {e}");
            eprintln!("(coldworking-viewer needs a desktop session — X11/Wayland on Linux, or macOS.)");
            std::process::exit(1);
        }
    };
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();

    // Watch the file's directory (more reliable than watching the file
    // itself across editors that replace-on-save) and filter for our path.
    let watch_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    let watch_dir = watch_path.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let target = watch_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(ev) = res {
            let relevant = ev.paths.iter().any(|p| {
                p == &target || p.file_name() == target.file_name()
            });
            let is_change = matches!(
                ev.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            );
            if relevant && is_change {
                let _ = proxy.send_event(UserEvent::FileChanged);
            }
        }
    })
    .expect("file watcher");
    watcher
        .watch(&watch_dir, notify::RecursiveMode::NonRecursive)
        .expect("watch directory");

    let mut app = App::new(watch_path);
    event_loop.run_app(&mut app).expect("event loop run");
}
