// Which Poly Haven scans become which game trees. All CC0 (https://polyhaven.com/license).
// `node` is the glTF node holding one tree; `species` groups variants for placement.
export const TREES = [
  { id: 'fir_a', asset: 'fir_tree_01', node: 'fir_tree_01_a_LOD0', species: 'conifer' },
  { id: 'fir_b', asset: 'fir_tree_01', node: 'fir_tree_01_b_LOD0', species: 'conifer' },
  { id: 'fir_c', asset: 'fir_tree_01', node: 'fir_tree_01_c_LOD0', species: 'conifer' },
  { id: 'pine_a', asset: 'pine_tree_01', node: 'pine_tree_01_a_LOD0', species: 'conifer' },
  { id: 'pine_b', asset: 'pine_tree_01', node: 'pine_tree_01_b_LOD0', species: 'conifer' },
  { id: 'pine_c', asset: 'pine_tree_01', node: 'pine_tree_01_c_LOD0', species: 'conifer' },
  { id: 'broadleaf_a', asset: 'tree_small_02', node: 'tree_small_02_LOD0', species: 'broadleaf' },
];

/** Views baked around each tree. More = smoother turning, bigger atlas. */
export const VIEWS = 8;
/** Pixel size of one view. Half of 512×1024 to keep texture memory (~80 MB) sane on integrated GPUs. */
export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 512;
