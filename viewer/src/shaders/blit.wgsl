// Display pass: average the accumulation buffer, expose, ACES tonemap,
// gamma-encode, draw as a fullscreen triangle.

struct Uniforms {
    eye: vec3f,
    frame: u32,
    right: vec3f,
    bounces: u32,
    up: vec3f,
    flags: u32,
    fwd: vec3f,
    _pad0: u32,
    res: vec2f,
    tan_fov: f32,
    aspect: f32,
    env_intensity: f32,
    floor_y: f32,
    exposure: f32,
    _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    // Fullscreen triangle.
    let x = f32(i32(vi & 1u) * 4 - 1);
    let y = f32(i32(vi >> 1u) * 4 - 1);
    return vec4f(x, y, 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
                 vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let x = u32(pos.x);
    let y = u32(pos.y);
    let w = u32(u.res.x);
    let h = u32(u.res.y);
    if (x >= w || y >= h) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    let a = accum[y * w + x];
    var c = vec3f(0.0);
    if (a.a > 0.0) {
        c = a.rgb / a.a;
    }
    c = aces(max(c, vec3f(0.0)) * u.exposure);
    // Gamma-encode manually unless the surface format is sRGB (flag bit 2),
    // in which case the hardware does the encoding.
    if ((u.flags & 4u) == 0u) {
        c = pow(c, vec3f(1.0 / 2.2));
    }
    return vec4f(c, 1.0);
}
