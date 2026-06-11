//! Loading of `.render.json` scenes exported from the coldworking-cad web app,
//! and packing into GPU-friendly buffers.

use serde::Deserialize;
use std::path::Path;

use crate::bvh;

#[derive(Deserialize)]
pub struct SceneFile {
    pub format: String,
    #[serde(rename = "projectName", default)]
    pub project_name: Option<String>,
    pub materials: Vec<MaterialJson>,
    pub coatings: Vec<CoatingJson>,
    pub triangles: TrianglesJson,
    pub bbox: BBox,
}

#[derive(Deserialize)]
pub struct MaterialJson {
    #[serde(rename = "cauchyA")]
    pub cauchy_a: f32,
    #[serde(rename = "cauchyB")]
    pub cauchy_b: f32,
    pub tint: [f32; 3],
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct CoatingJson {
    pub bins: Vec<f32>,
}

#[derive(Deserialize)]
pub struct TrianglesJson {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    #[serde(rename = "matFront")]
    pub mat_front: Vec<i32>,
    #[serde(rename = "matBack")]
    pub mat_back: Vec<i32>,
    pub coating: Vec<i32>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct BBox {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

pub const COATING_BINS: usize = 32;

/// Scene data packed for the GPU. All arrays are vec4-aligned f32 blocks
/// matching the WGSL struct layouts in trace.wgsl.
pub struct GpuScene {
    pub name: String,
    /// 4 vec4 per triangle: [v0,matF] [v1,matB] [v2,coat] [n,0], in BVH order.
    pub tris: Vec<[f32; 4]>,
    /// 2 vec4 per node: [bmin, a] [bmax, b] (a<0 => leaf: start=-a-1, count=b).
    pub nodes: Vec<[f32; 4]>,
    /// 2 vec4 per material: [cauchyA, cauchyB, 0, 0] [tint.rgb, 0].
    pub materials: Vec<[f32; 4]>,
    /// COATING_BINS reflectance samples per coating (at least one dummy).
    pub coatings: Vec<f32>,
    pub tri_count: u32,
    pub bbox: BBox,
}

#[derive(Debug)]
pub enum SceneError {
    Io(std::io::Error),
    Parse(serde_json::Error),
    Format(String),
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneError::Io(e) => write!(f, "could not read file: {e}"),
            SceneError::Parse(e) => write!(f, "invalid JSON: {e}"),
            SceneError::Format(s) => write!(f, "{s}"),
        }
    }
}

pub fn load(path: &Path) -> Result<GpuScene, SceneError> {
    let text = std::fs::read_to_string(path).map_err(SceneError::Io)?;
    parse(&text)
}

pub fn parse(text: &str) -> Result<GpuScene, SceneError> {
    let file: SceneFile = serde_json::from_str(text).map_err(SceneError::Parse)?;
    if file.format != "coldworking-render-scene" {
        return Err(SceneError::Format(format!(
            "not a coldworking render scene (format = {:?}); export one from the \
             web app's Render tab with \"Export scene\"",
            file.format
        )));
    }
    let t = &file.triangles;
    let tri_count = t.positions.len() / 9;
    if t.normals.len() != tri_count * 3
        || t.mat_front.len() != tri_count
        || t.mat_back.len() != tri_count
        || t.coating.len() != tri_count
    {
        return Err(SceneError::Format("triangle arrays have mismatched lengths".into()));
    }

    let built = bvh::build(&t.positions, tri_count);

    let mut tris = Vec::with_capacity(tri_count * 4);
    for &src in &built.order {
        let p = &t.positions[src * 9..src * 9 + 9];
        let n = &t.normals[src * 3..src * 3 + 3];
        tris.push([p[0], p[1], p[2], t.mat_front[src] as f32]);
        tris.push([p[3], p[4], p[5], t.mat_back[src] as f32]);
        tris.push([p[6], p[7], p[8], t.coating[src] as f32]);
        tris.push([n[0], n[1], n[2], 0.0]);
    }

    let mut materials = Vec::with_capacity(file.materials.len() * 2);
    for m in &file.materials {
        materials.push([m.cauchy_a, m.cauchy_b, 0.0, 0.0]);
        materials.push([m.tint[0], m.tint[1], m.tint[2], 0.0]);
    }
    if materials.is_empty() {
        materials.push([1.0, 0.0, 0.0, 0.0]);
        materials.push([0.0, 0.0, 0.0, 0.0]);
    }

    let mut coatings = Vec::new();
    for c in &file.coatings {
        for i in 0..COATING_BINS {
            coatings.push(c.bins.get(i).copied().unwrap_or(0.0));
        }
    }
    if coatings.is_empty() {
        coatings.resize(COATING_BINS, 0.0); // dummy so the binding is non-empty
    }

    Ok(GpuScene {
        name: file.project_name.unwrap_or_else(|| "sculpture".into()),
        tris,
        nodes: built.nodes,
        materials,
        coatings,
        tri_count: tri_count as u32,
        bbox: file.bbox,
    })
}
