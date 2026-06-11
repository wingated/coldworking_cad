//! wgpu renderer: compute-shader path tracing into an accumulation buffer,
//! plus a tonemapping blit to the window surface.

use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use winit::window::Window;

use crate::scene::GpuScene;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Uniforms {
    pub eye: [f32; 3],
    pub frame: u32,
    pub right: [f32; 3],
    pub bounces: u32,
    pub up: [f32; 3],
    pub flags: u32, // bit0 dispersion, bit1 floor, bit2 srgb surface
    pub fwd: [f32; 3],
    pub _pad0: u32,
    pub res: [f32; 2],
    pub tan_fov: f32,
    pub aspect: f32,
    pub env_intensity: f32,
    pub floor_y: f32,
    pub exposure: f32,
    pub _pad1: f32,
}

pub struct Options {
    pub bounces: u32,
    pub dispersion: bool,
    pub floor: bool,
    pub floor_y: f32,
    pub env_intensity: f32,
    pub exposure: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            bounces: 24,
            dispersion: true,
            floor: false,
            floor_y: 0.0,
            env_intensity: 1.0,
            exposure: 1.0,
        }
    }
}

pub struct Camera {
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub fov: f32,
}

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    srgb_surface: bool,

    trace_pipeline: wgpu::ComputePipeline,
    blit_pipeline: wgpu::RenderPipeline,
    trace_layout: wgpu::BindGroupLayout,
    blit_layout: wgpu::BindGroupLayout,

    uniform_buf: wgpu::Buffer,
    accum_buf: wgpu::Buffer,
    tris_buf: wgpu::Buffer,
    nodes_buf: wgpu::Buffer,
    mats_buf: wgpu::Buffer,
    coats_buf: wgpu::Buffer,

    trace_bind: Option<wgpu::BindGroup>,
    blit_bind: Option<wgpu::BindGroup>,

    pub frame: u32,
    pub sample_count: u32,
    need_clear: bool,
    has_scene: bool,
}

impl Renderer {
    pub fn new(window: Arc<Window>) -> Result<Self, String> {
        let size = window.inner_size();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance
            .create_surface(window)
            .map_err(|e| format!("create_surface: {e}"))?;

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .map_err(|e| format!("no suitable GPU adapter: {e}"))?;

        let info = adapter.get_info();
        log::info!("GPU: {} ({:?}, {:?})", info.name, info.device_type, info.backend);

        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("coldworking-viewer"),
                ..Default::default()
            }))
            .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        // Prefer a non-sRGB format so the blit shader's manual gamma applies;
        // fall back to whatever exists and tell the shader via a flag.
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let srgb_surface = format.is_srgb();

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(8),
            height: size.height.max(8),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let trace_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("trace"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/trace.wgsl").into()),
        });
        let blit_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blit"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/blit.wgsl").into()),
        });

        let storage_ro = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let trace_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("trace layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                storage_ro(1),
                storage_ro(2),
                storage_ro(3),
                storage_ro(4),
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let trace_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&trace_layout)],
            immediate_size: 0,
        });
        let trace_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("trace"),
            layout: Some(&trace_pl),
            module: &trace_module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let blit_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&blit_layout)],
            immediate_size: 0,
        });
        let blit_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("blit"),
            layout: Some(&blit_pl),
            vertex: wgpu::VertexState {
                module: &blit_module,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &blit_module,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let accum_buf = Self::make_accum(&device, config.width, config.height);
        fn placeholder(device: &wgpu::Device, label: &str) -> wgpu::Buffer {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: 64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        }
        let tris_buf = placeholder(&device, "tris");
        let nodes_buf = placeholder(&device, "nodes");
        let mats_buf = placeholder(&device, "mats");
        let coats_buf = placeholder(&device, "coats");

        let mut r = Self {
            surface,
            device,
            queue,
            config,
            srgb_surface,
            trace_pipeline,
            blit_pipeline,
            trace_layout,
            blit_layout,
            uniform_buf,
            accum_buf,
            tris_buf,
            nodes_buf,
            mats_buf,
            coats_buf,
            trace_bind: None,
            blit_bind: None,
            frame: 0,
            sample_count: 0,
            need_clear: true,
            has_scene: false,
        };
        r.rebuild_binds();
        Ok(r)
    }

    fn make_accum(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("accum"),
            size: (w as u64) * (h as u64) * 16,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    }

    fn upload(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, data: &[u8]) -> wgpu::Buffer {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (data.len().max(16) as u64).next_multiple_of(16),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&buf, 0, data);
        buf
    }

    pub fn set_scene(&mut self, scene: &GpuScene) {
        self.tris_buf = Self::upload(&self.device, &self.queue, "tris", bytemuck::cast_slice(&scene.tris));
        self.nodes_buf = Self::upload(&self.device, &self.queue, "nodes", bytemuck::cast_slice(&scene.nodes));
        self.mats_buf = Self::upload(&self.device, &self.queue, "mats", bytemuck::cast_slice(&scene.materials));
        self.coats_buf = Self::upload(&self.device, &self.queue, "coats", bytemuck::cast_slice(&scene.coatings));
        self.has_scene = true;
        self.rebuild_binds();
        self.reset();
    }

    fn rebuild_binds(&mut self) {
        let entries = [
            wgpu::BindGroupEntry { binding: 0, resource: self.uniform_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: self.tris_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: self.nodes_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: self.mats_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: self.coats_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: self.accum_buf.as_entire_binding() },
        ];
        self.trace_bind = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("trace bind"),
            layout: &self.trace_layout,
            entries: &entries,
        }));
        self.blit_bind = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit bind"),
            layout: &self.blit_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniform_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.accum_buf.as_entire_binding() },
            ],
        }));
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
        self.accum_buf = Self::make_accum(&self.device, w, h);
        self.rebuild_binds();
        self.reset();
    }

    pub fn reset(&mut self) {
        self.frame = 0;
        self.sample_count = 0;
        self.need_clear = true;
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    fn uniforms(&self, cam: &Camera, opt: &Options) -> Uniforms {
        let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let cross = |a: [f32; 3], b: [f32; 3]| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let norm = |a: [f32; 3]| {
            let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-9);
            [a[0] / l, a[1] / l, a[2] / l]
        };
        let fwd = norm(sub(cam.target, cam.eye));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut flags = 0u32;
        if opt.dispersion {
            flags |= 1;
        }
        if opt.floor {
            flags |= 2;
        }
        if self.srgb_surface {
            flags |= 4;
        }
        Uniforms {
            eye: cam.eye,
            frame: self.frame,
            right,
            bounces: opt.bounces,
            up,
            flags,
            fwd,
            _pad0: 0,
            res: [self.config.width as f32, self.config.height as f32],
            tan_fov: (cam.fov / 2.0).tan(),
            aspect: self.config.width as f32 / self.config.height as f32,
            env_intensity: opt.env_intensity,
            floor_y: opt.floor_y,
            exposure: opt.exposure,
            _pad1: 0.0,
        }
    }

    /// Trace `samples_per_frame` accumulation passes and present.
    pub fn render(&mut self, cam: &Camera, opt: &Options, samples_per_frame: u32) -> Result<(), String> {
        if !self.has_scene {
            return Ok(());
        }
        use wgpu::CurrentSurfaceTexture as Cst;
        let frame_tex = match self.surface.get_current_texture() {
            Cst::Success(t) | Cst::Suboptimal(t) => t,
            Cst::Timeout | Cst::Occluded => return Ok(()), // skip this frame
            Cst::Outdated | Cst::Lost => {
                self.surface.configure(&self.device, &self.config);
                match self.surface.get_current_texture() {
                    Cst::Success(t) | Cst::Suboptimal(t) => t,
                    other => return Err(format!("surface unavailable after reconfigure: {other:?}")),
                }
            }
            Cst::Validation => return Err("surface validation error".into()),
        };
        let view = frame_tex.texture.create_view(&Default::default());

        let mut encoder = self.device.create_command_encoder(&Default::default());
        if self.need_clear {
            encoder.clear_buffer(&self.accum_buf, 0, None);
            self.need_clear = false;
        }

        for _ in 0..samples_per_frame.max(1) {
            self.queue.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&self.uniforms(cam, opt)));
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&self.trace_pipeline);
                pass.set_bind_group(0, self.trace_bind.as_ref().unwrap(), &[]);
                pass.dispatch_workgroups(self.config.width.div_ceil(8), self.config.height.div_ceil(8), 1);
            }
            // Each pass needs its own uniform frame index; submit so the
            // write_buffer for the next pass lands after this dispatch.
            self.queue.submit(Some(std::mem::replace(
                &mut encoder,
                self.device.create_command_encoder(&Default::default()),
            ).finish()));
            self.frame += 1;
            self.sample_count += 1;
        }

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.blit_pipeline);
            pass.set_bind_group(0, self.blit_bind.as_ref().unwrap(), &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
        frame_tex.present();
        Ok(())
    }

    /// Read back the accumulation buffer, tonemap on CPU, return RGB8 rows
    /// (top to bottom) for a screenshot.
    pub fn read_image(&self, exposure: f32) -> (u32, u32, Vec<u8>) {
        let (w, h) = (self.config.width, self.config.height);
        let size = (w as u64) * (h as u64) * 16;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.accum_buf, 0, &staging, 0, size);
        self.queue.submit(Some(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let _ = rx.recv();

        let data = slice.get_mapped_range();
        let floats: &[f32] = bytemuck::cast_slice(&data);
        let mut out = Vec::with_capacity((w * h * 3) as usize);
        let aces = |x: f32| ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0);
        for i in 0..(w * h) as usize {
            let a = floats[i * 4 + 3].max(1.0);
            for c in 0..3 {
                let v = aces(floats[i * 4 + c].max(0.0) / a * exposure);
                out.push((v.powf(1.0 / 2.2) * 255.0).round() as u8);
            }
        }
        drop(data);
        staging.unmap();
        (w, h, out)
    }
}
