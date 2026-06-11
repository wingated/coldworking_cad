// CPU BVH builder for the GPU path tracer. Median-split over triangle
// centroids; output is a flat array ready for texture upload.
//
// Node layout (2 RGBA32F texels per node):
//   texel0: bboxMin.xyz, a   where a =  left child index   (interior)
//                                    or -(triStart + 1)    (leaf)
//   texel1: bboxMax.xyz, b   where b =  right child index  (interior)
//                                    or triCount           (leaf)

export function buildBVH(positions, triCount) {
  const cent = new Float32Array(triCount * 3);
  const bmin = new Float32Array(triCount * 3);
  const bmax = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = positions[t * 9 + k], b = positions[t * 9 + 3 + k], c = positions[t * 9 + 6 + k];
      bmin[t * 3 + k] = Math.min(a, b, c);
      bmax[t * 3 + k] = Math.max(a, b, c);
      cent[t * 3 + k] = (a + b + c) / 3;
    }
  }

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const nodes = []; // {min, max, a, b}

  function build(start, count) {
    const nodeIndex = nodes.length;
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], a: 0, b: 0 };
    nodes.push(node);
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        node.min[k] = Math.min(node.min[k], bmin[t * 3 + k]);
        node.max[k] = Math.max(node.max[k], bmax[t * 3 + k]);
      }
    }
    if (count <= 4) {
      node.a = -(start + 1);
      node.b = count;
      return nodeIndex;
    }
    // Split along the widest centroid axis at the median.
    let axis = 0, ext = -1;
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        cmin[k] = Math.min(cmin[k], cent[t * 3 + k]);
        cmax[k] = Math.max(cmax[k], cent[t * 3 + k]);
      }
    }
    for (let k = 0; k < 3; k++) {
      if (cmax[k] - cmin[k] > ext) { ext = cmax[k] - cmin[k]; axis = k; }
    }
    if (ext < 1e-12) {
      node.a = -(start + 1);
      node.b = count;
      return nodeIndex;
    }
    const sub = Array.from(order.subarray(start, start + count));
    sub.sort((x, y) => cent[x * 3 + axis] - cent[y * 3 + axis]);
    order.set(sub, start);
    const half = count >> 1;
    node.a = build(start, half);
    node.b = build(start + half, count - half);
    return nodeIndex;
  }

  if (triCount > 0) build(0, triCount);

  // Reorder triangle indices and flatten nodes.
  const data = new Float32Array(Math.max(1, nodes.length) * 8);
  nodes.forEach((n, i) => {
    data.set([...n.min, n.a, ...n.max, n.b], i * 8);
  });
  return { nodes: data, nodeCount: nodes.length, order };
}
