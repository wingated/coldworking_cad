// Spectral path tracing compute kernel.
//
// A direct port of the web app's GLSL tracer (js/raytracer/pathtracer.js):
// hero-wavelength sampling, CIE 1931 color matching, Cauchy dispersion,
// Fresnel-weighted reflect/refract with TIR, dichroic coating spectra,
// Beer-Lambert absorption, BVH traversal. Triangles carry the materials on
// both sides so glued glass-glass interfaces refract with the correct
// relative IOR.

struct Uniforms {
    eye: vec3f,
    frame: u32,
    right: vec3f,
    bounces: u32,
    up: vec3f,
    flags: u32,            // bit0: dispersion, bit1: floor
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
@group(0) @binding(1) var<storage, read> tris: array<vec4f>;   // 4 vec4 / tri
@group(0) @binding(2) var<storage, read> nodes: array<vec4f>;  // 2 vec4 / node
@group(0) @binding(3) var<storage, read> mats: array<vec4f>;   // 2 vec4 / mat
@group(0) @binding(4) var<storage, read> coats: array<f32>;    // 32 bins / coating
@group(0) @binding(5) var<storage, read_write> accum: array<vec4f>;

const TMIN: f32 = 1.5e-4;
const INF: f32 = 1e30;
const LAMBDA_MIN: f32 = 380.0;
const LAMBDA_RANGE: f32 = 350.0;

var<private> seed: u32;

fn srand(p: vec2u, f: u32) {
    seed = p.x * 1973u + p.y * 9277u + f * 26699u + 1u;
}

fn pcg() -> u32 {
    seed = seed * 747796405u + 2891336453u;
    let w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
    return (w >> 22u) ^ w;
}

fn rnd() -> f32 {
    return f32(pcg()) / 4294967296.0;
}

// Cauchy IOR; lambda in nm. Material i occupies mats[2i..2i+2].
fn ior_of(mat: i32, lambda_in: f32) -> f32 {
    var lambda = lambda_in;
    if ((u.flags & 1u) == 0u) { lambda = 587.56; }
    let c = mats[mat * 2];
    let um = lambda / 1000.0;
    return c.x + c.y / (um * um);
}

// Spectral absorption per inch from the material's RGB absorption triple.
fn sigma_of(mat: i32, lambda: f32) -> f32 {
    let t = mats[mat * 2 + 1].xyz;
    let wb = exp(-0.5 * pow((lambda - 465.0) / 45.0, 2.0));
    let wg = exp(-0.5 * pow((lambda - 550.0) / 45.0, 2.0));
    let wr = exp(-0.5 * pow((lambda - 615.0) / 55.0, 2.0));
    return (t.z * wb + t.y * wg + t.x * wr) / (wb + wg + wr + 1e-5);
}

fn coat_r(coat: i32, lambda: f32) -> f32 {
    let fu = clamp((lambda - LAMBDA_MIN) / LAMBDA_RANGE * 32.0 - 0.5, 0.0, 31.0);
    let i0 = i32(floor(fu));
    let i1 = min(i0 + 1, 31);
    let f = fu - f32(i0);
    return mix(coats[coat * 32 + i0], coats[coat * 32 + i1], f);
}

// CIE 1931 CMF fit (Wyman et al. 2013).
fn gpw(x: f32, mu: f32, s1: f32, s2: f32) -> f32 {
    let t = (x - mu) / select(s2, s1, x < mu);
    return exp(-0.5 * t * t);
}

fn cie(l: f32) -> vec3f {
    let x = 1.056 * gpw(l, 599.8, 37.9, 31.0)
          + 0.362 * gpw(l, 442.0, 16.0, 26.7)
          - 0.065 * gpw(l, 501.1, 20.4, 26.2);
    let y = 0.821 * gpw(l, 568.8, 46.9, 40.5)
          + 0.286 * gpw(l, 530.9, 16.3, 31.1);
    let z = 1.217 * gpw(l, 437.0, 11.8, 36.0)
          + 0.681 * gpw(l, 459.0, 26.0, 13.8);
    return vec3f(x, y, z);
}

fn blob(d: vec3f, c: vec3f, sharp: f32, inten: f32) -> f32 {
    return inten * pow(max(dot(d, normalize(c)), 0.0), sharp);
}

// Studio environment: soft gradient plus a few "softbox" lights.
fn env_light(d: vec3f) -> f32 {
    var v = 0.05 + 0.13 * smoothstep(-0.6, 0.9, d.y);
    v += blob(d, vec3f(0.5, 0.85, 0.25), 90.0, 22.0);
    v += blob(d, vec3f(-0.75, 0.45, -0.35), 45.0, 7.0);
    v += blob(d, vec3f(0.1, 0.25, -1.0), 220.0, 12.0);
    v += blob(d, vec3f(0.0, -1.0, 0.0), 8.0, 0.6);
    return v * u.env_intensity;
}

fn tri_hit(tri: i32, ro: vec3f, rd: vec3f) -> f32 {
    let v0 = tris[tri * 4].xyz;
    let v1 = tris[tri * 4 + 1].xyz;
    let v2 = tris[tri * 4 + 2].xyz;
    let e1 = v1 - v0;
    let e2 = v2 - v0;
    let p = cross(rd, e2);
    let det = dot(e1, p);
    if (abs(det) < 1e-12) { return INF; }
    let inv_det = 1.0 / det;
    let tv = ro - v0;
    let uu = dot(tv, p) * inv_det;
    if (uu < -1e-6 || uu > 1.0 + 1e-6) { return INF; }
    let q = cross(tv, e1);
    let vv = dot(rd, q) * inv_det;
    if (vv < -1e-6 || uu + vv > 1.0 + 1e-6) { return INF; }
    let t = dot(e2, q) * inv_det;
    return select(INF, t, t > TMIN);
}

struct Hit { t: f32, tri: i32 }

fn traverse(ro: vec3f, rd: vec3f) -> Hit {
    var best = Hit(INF, -1);
    if (arrayLength(&nodes) < 2u) { return best; }
    let inv = 1.0 / rd;
    var stack: array<i32, 28>;
    var sp = 0;
    stack[0] = 0;
    sp = 1;
    var guard = 0;
    loop {
        if (sp <= 0 || guard >= 4096) { break; }
        guard++;
        sp--;
        let ni = stack[sp];
        let n0 = nodes[ni * 2];
        let n1 = nodes[ni * 2 + 1];
        // AABB slab test.
        let t0 = (n0.xyz - ro) * inv;
        let t1 = (n1.xyz - ro) * inv;
        let lo = min(t0, t1);
        let hi = max(t0, t1);
        let t_enter = max(max(lo.x, lo.y), lo.z);
        let t_exit = min(min(hi.x, hi.y), hi.z);
        if (t_exit < max(t_enter, 0.0) || t_enter >= best.t) { continue; }
        if (n0.w < 0.0) {
            let start = i32(-n0.w) - 1;
            let count = i32(n1.w);
            for (var k = 0; k < count; k++) {
                let t = tri_hit(start + k, ro, rd);
                if (t < best.t) { best = Hit(t, start + k); }
            }
        } else if (sp < 26) {
            stack[sp] = i32(n0.w);
            stack[sp + 1] = i32(n1.w);
            sp += 2;
        }
    }
    return best;
}

fn cosine_hemisphere(n: vec3f) -> vec3f {
    let r1 = rnd();
    let r2 = rnd();
    let phi = 6.2831853 * r1;
    let sr = sqrt(r2);
    let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.99);
    let t = normalize(cross(a, n));
    let b = cross(n, t);
    return normalize(t * (cos(phi) * sr) + b * (sin(phi) * sr) + n * sqrt(1.0 - r2));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let w = u32(u.res.x);
    let h = u32(u.res.y);
    if (gid.x >= w || gid.y >= h) { return; }
    srand(gid.xy, u.frame);

    // Hero wavelength for this path.
    let lambda = LAMBDA_MIN + rnd() * LAMBDA_RANGE;

    // Camera ray with AA jitter; row 0 is the top of the image.
    let jitter = vec2f(rnd(), rnd()) - 0.5;
    let px = (f32(gid.x) + 0.5 + jitter.x) / u.res.x * 2.0 - 1.0;
    let py = 1.0 - (f32(gid.y) + 0.5 + jitter.y) / u.res.y * 2.0;
    var rd = normalize(u.fwd + u.right * (px * u.tan_fov * u.aspect) + u.up * (py * u.tan_fov));
    var ro = u.eye;

    var radiance = 0.0;
    var throughput = 1.0;
    var medium = 0;

    for (var bounce = 0u; bounce <= u.bounces; bounce++) {
        let hit = traverse(ro, rd);

        // Optional matte floor (analytic plane).
        var t_floor = INF;
        if ((u.flags & 2u) != 0u && rd.y < -1e-6) {
            let t = (u.floor_y - ro.y) / rd.y;
            if (t > TMIN) { t_floor = t; }
        }

        if (t_floor < hit.t) {
            throughput *= exp(-sigma_of(medium, lambda) * t_floor);
            ro = ro + rd * t_floor;
            throughput *= 0.55; // floor albedo
            rd = cosine_hemisphere(vec3f(0.0, 1.0, 0.0));
            ro += rd * 1e-4;
            continue;
        }

        if (hit.tri < 0) {
            radiance += throughput * env_light(rd);
            break;
        }

        throughput *= exp(-sigma_of(medium, lambda) * hit.t);

        let d0 = tris[hit.tri * 4];
        let d1 = tris[hit.tri * 4 + 1];
        let d2 = tris[hit.tri * 4 + 2];
        let n = tris[hit.tri * 4 + 3].xyz;
        let mat_f = i32(d0.w + 0.5);
        let mat_b = i32(d1.w + 0.5);
        var coat = -1;
        if (d2.w > -0.5) { coat = i32(d2.w + 0.5); }

        let hit_p = ro + rd * hit.t;

        var from_mat: i32;
        var to_mat: i32;
        var sn: vec3f;
        if (dot(rd, n) < 0.0) {
            from_mat = mat_f; to_mat = mat_b; sn = n;
        } else {
            from_mat = mat_b; to_mat = mat_f; sn = -n;
        }

        let n1 = ior_of(from_mat, lambda);
        let n2 = ior_of(to_mat, lambda);
        let eta = n1 / n2;
        let ci = clamp(dot(-rd, sn), 0.0, 1.0);
        let st2 = eta * eta * (1.0 - ci * ci);

        var refl: f32;
        var ct = 0.0;
        if (st2 >= 1.0) {
            refl = 1.0; // total internal reflection
        } else {
            ct = sqrt(1.0 - st2);
            let rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
            let rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
            refl = 0.5 * (rs * rs + rp * rp);
        }
        if (coat >= 0) {
            let rc = coat_r(coat, lambda);
            refl = rc + (1.0 - rc) * refl;
        }

        if (rnd() < refl) {
            rd = normalize(reflect(rd, sn));
            medium = from_mat;
        } else {
            rd = normalize(eta * rd + (eta * ci - ct) * sn);
            medium = to_mat;
        }
        ro = hit_p + rd * 1e-4;
    }

    // Spectral radiance -> XYZ -> linear sRGB (white-balanced for an
    // equal-energy spectrum: constants precomputed from the CMF fit).
    let xyz = cie(lambda) * radiance * 3.10;
    var rgb = vec3f(
        3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
        -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
        0.0557 * xyz.x - 0.2040 * xyz.y + 1.0570 * xyz.z,
    ) * vec3f(0.8329, 1.0529, 1.1017);

    let idx = gid.y * w + gid.x;
    accum[idx] += vec4f(rgb, 1.0);
}
