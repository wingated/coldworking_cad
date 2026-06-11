//! BVH builder — a direct port of js/raytracer/bvh.js so the native viewer
//! and the web tracer traverse identical structures.
//!
//! Node layout (2 vec4 per node):
//!   [bmin.xyz, a]  a =  left child index (interior) or -(tri_start+1) (leaf)
//!   [bmax.xyz, b]  b =  right child index (interior) or tri_count (leaf)

pub struct Built {
    pub nodes: Vec<[f32; 4]>,
    pub order: Vec<usize>,
}

pub fn build(positions: &[f32], tri_count: usize) -> Built {
    let mut cent = vec![0.0f32; tri_count * 3];
    let mut bmin = vec![0.0f32; tri_count * 3];
    let mut bmax = vec![0.0f32; tri_count * 3];
    for t in 0..tri_count {
        for k in 0..3 {
            let a = positions[t * 9 + k];
            let b = positions[t * 9 + 3 + k];
            let c = positions[t * 9 + 6 + k];
            bmin[t * 3 + k] = a.min(b).min(c);
            bmax[t * 3 + k] = a.max(b).max(c);
            cent[t * 3 + k] = (a + b + c) / 3.0;
        }
    }

    let mut order: Vec<usize> = (0..tri_count).collect();
    let mut nodes: Vec<[f64; 8]> = Vec::new();

    // Iterative build with an explicit work stack (start, count, node_index).
    if tri_count > 0 {
        nodes.push([0.0; 8]);
        let mut work = vec![(0usize, tri_count, 0usize)];
        while let Some((start, count, node_index)) = work.pop() {
            let mut nmin = [f32::INFINITY; 3];
            let mut nmax = [f32::NEG_INFINITY; 3];
            for &t in &order[start..start + count] {
                for k in 0..3 {
                    nmin[k] = nmin[k].min(bmin[t * 3 + k]);
                    nmax[k] = nmax[k].max(bmax[t * 3 + k]);
                }
            }

            let mut leaf = count <= 4;
            let mut axis = 0;
            if !leaf {
                let mut cmin = [f32::INFINITY; 3];
                let mut cmax = [f32::NEG_INFINITY; 3];
                for &t in &order[start..start + count] {
                    for k in 0..3 {
                        cmin[k] = cmin[k].min(cent[t * 3 + k]);
                        cmax[k] = cmax[k].max(cent[t * 3 + k]);
                    }
                }
                let mut ext = -1.0f32;
                for k in 0..3 {
                    if cmax[k] - cmin[k] > ext {
                        ext = cmax[k] - cmin[k];
                        axis = k;
                    }
                }
                if ext < 1e-12 {
                    leaf = true;
                }
            }

            if leaf {
                nodes[node_index] = [
                    nmin[0] as f64, nmin[1] as f64, nmin[2] as f64,
                    -((start + 1) as f64),
                    nmax[0] as f64, nmax[1] as f64, nmax[2] as f64,
                    count as f64,
                ];
                continue;
            }

            order[start..start + count]
                .sort_by(|&x, &y| cent[x * 3 + axis].total_cmp(&cent[y * 3 + axis]));
            let half = count / 2;
            let left = nodes.len();
            nodes.push([0.0; 8]);
            let right = nodes.len();
            nodes.push([0.0; 8]);
            nodes[node_index] = [
                nmin[0] as f64, nmin[1] as f64, nmin[2] as f64,
                left as f64,
                nmax[0] as f64, nmax[1] as f64, nmax[2] as f64,
                right as f64,
            ];
            work.push((start, half, left));
            work.push((start + half, count - half, right));
        }
    }

    let mut out = Vec::with_capacity(nodes.len().max(1) * 2);
    if nodes.is_empty() {
        out.push([0.0; 4]);
        out.push([0.0; 4]);
    }
    for n in &nodes {
        out.push([n[0] as f32, n[1] as f32, n[2] as f32, n[3] as f32]);
        out.push([n[4] as f32, n[5] as f32, n[6] as f32, n[7] as f32]);
    }
    Built { nodes: out, order }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_triangle() {
        let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let b = build(&pos, 1);
        assert_eq!(b.order, vec![0]);
        assert_eq!(b.nodes.len(), 2);
        assert!(b.nodes[0][3] < 0.0, "root must be a leaf");
        assert_eq!(b.nodes[1][3], 1.0, "leaf count 1");
    }

    #[test]
    fn many_triangles_partition() {
        // A row of small triangles along x.
        let mut pos = Vec::new();
        let n = 64;
        for i in 0..n {
            let x = i as f32;
            pos.extend_from_slice(&[x, 0.0, 0.0, x + 0.5, 0.0, 0.0, x, 0.5, 0.0]);
        }
        let b = build(&pos, n);
        assert_eq!(b.order.len(), n);
        // Every triangle appears exactly once.
        let mut seen = vec![false; n];
        for &t in &b.order {
            assert!(!seen[t]);
            seen[t] = true;
        }
        // Root bbox covers everything.
        assert_eq!(b.nodes[0][0], 0.0);
        assert!((b.nodes[1][0] - (n as f32 - 0.5)).abs() < 1e-5);
        // Leaves' (start, count) ranges tile 0..n without overlap.
        let mut covered = vec![false; n];
        for i in 0..b.nodes.len() / 2 {
            let a = b.nodes[i * 2][3];
            let c = b.nodes[i * 2 + 1][3];
            if a < 0.0 {
                let start = (-a) as usize - 1;
                for j in start..start + c as usize {
                    assert!(!covered[j], "leaf ranges overlap");
                    covered[j] = true;
                }
            }
        }
        assert!(covered.iter().all(|&c| c), "leaf ranges must cover all tris");
    }
}
