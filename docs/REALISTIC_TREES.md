# Realistic Trees: Goal and Approach

**Status:** planned, paused before the bake. See [Current state](#7-current-state) for what already exists.

---

## 1. Goal

Make the forest look realistic. This is the first step toward a more realistic game overall.

The trees are currently low-poly shapes (`apps/game/src/render/track/ForestView.ts`): faceted cones and blobs, each one flat colour, every tree the same shape. They read as a pattern, not a forest. Real trees are made of thousands of small gaps where light and sky show through, and that is what's missing.

**Target:** the trees look like photographs from the driver's point of view (chase camera, at speed). Draw cost is no worse than today, on an integrated GPU (Intel Iris Xe).

**Decided:**
- **Source:** CC0 photo-scanned trees from Poly Haven. Not our own photos, not stylised models.
- **Forest type:** mixed conifer and broadleaf, to match the Eifel-style track.

---

## 2. Approach: baked impostors

The scans are far too heavy to render directly: up to 17 million polygons per file, and the track has tens of thousands of trees. Instead, each tree is rendered **once, offline,** into pictures, and the game draws those pictures.

### 2.1 Offline bake (one-time, results committed)

1. **Download** the chosen scans into `.cache/polyhaven/`. This folder is git-ignored and about 1.5 GB at 2k textures.
2. **Separate the trees.** Each scan file holds up to three separate tree nodes (`…_a/b/c_LOD0`), and each becomes its own variant.
3. **Render** each tree in headless Chrome with Three.js, using the real GPU:
   - an orthographic camera, from **8 angles** around the tree, at eye level,
   - two passes per angle: **colour + alpha**, and **normals** (surface direction in card space), so the game can relight the trees.
4. **Clean up the images.** Bleed colour into the transparent pixels, so shrunk textures don't get dark or white halos around the needles.
5. **Write the outputs** to `public/trees/`:
   - one colour atlas and one normal atlas, every variant and angle packed with gutters,
   - `manifest.json`: per variant, its species, real width and height in metres, and atlas positions.
6. **Commit** the atlases. Nobody else has to download or bake anything.

### 2.2 Runtime (in the game)

- **Each tree is one card (2 triangles)**, turned around its vertical axis to face the camera. Cards are drawn as instances, one draw call per 250 m tile, as today.
- **View selection:** each tree has a random rotation. The shader picks the two nearest of the 8 baked angles for the current viewing direction and **cross-fades** between them, so the tree seems to turn as you drive past instead of popping.
- **Lighting:** baked normals combined with the scene's sun and sky light, plus fog. Trees respond to the lighting preset (dusk, overcast) instead of having fixed baked lighting.
- **Detail:** alpha cut-out with alpha-to-coverage for smooth needle edges, and a gentle wind sway of the upper part of the card.
- **Variety:** random variant, rotation, a little size and colour tint, and mirroring.
- **Placement is unchanged** (`track/forest.ts`). Conifer slots get the fir and pine variants, broadleaf slots get the broadleaf. Heights are scaled from each variant's real size to about 20–34 m for conifers and 12–21 m for broadleaf.

### 2.3 Known limits and later improvements

- **Picture trees look flat within a few metres.** With the current 5 m clearance from the barrier, road-edge trees are usually 10–20 m away, which should hold up. If not, the next step is **real 3D trees for the first row along the road**: trunk and branches carrying photo foliage cards, cross-faded into the impostors at about 40–60 m.
- **They don't cast shadows on the road yet.** A custom depth material could add that.
- **The aerial view would show the cards,** since they stand upright. The chase camera barely sees this.
- **If texture memory is tight,** compress the atlases to KTX2/Basis.

---

## 3. Chosen scans

All CC0, from https://polyhaven.com/license. Poly Haven has **no beech or spruce.** These were the closest fits:

| Game variant | Poly Haven asset | Node | Notes |
|---|---|---|---|
| `fir_a`, `fir_b`, `fir_c` | [`fir_tree_01`](https://polyhaven.com/a/fir_tree_01) | `fir_tree_01_{a,b,c}_LOD0` | 7.9 M polys total; airy, natural firs of different ages. ~490 MB download at 2k. |
| `pine_a`, `pine_b`, `pine_c` | [`pine_tree_01`](https://polyhaven.com/a/pine_tree_01) | `pine_tree_01_{a,b,c}_LOD0` | 17.4 M polys; tall Scots-type pines, typical of Central Europe. ~980 MB. |
| `broadleaf_a` | [`tree_small_02`](https://polyhaven.com/a/tree_small_02) | `tree_small_02_LOD0` | 4.7 M polys; African wild syringa, but reads as a generic deciduous tree. ~115 MB. |

**Rejected:**
- `island_tree_01–03`: gnarled Mediterranean shapes with rock or sand bases.
- `jacaranda_tree`: purple flowers.
- The saplings: too small to be forest trees.

The only broadleaf is a single tree, so variety comes from rotation, mirroring and tint. If a better broadleaf scan appears, add it to `tools/trees/trees.config.mjs`.

---

## 4. Budgets and hardware

| | Value | Reason |
|---|---|---|
| Views per tree | 8 | Smooth turning with cross-fade. |
| Frame size | **256 × 512 px** | Halved from 512×1024 to keep texture memory at about 80 MB (colour + normal atlases with mipmaps). Integrated GPUs share system RAM. |
| Variants | 7 | 3 fir, 3 pine, 1 broadleaf. |
| Cost per tree | 2 triangles | Cheaper than today's low-poly trees, which have 100+ triangles each. |

- **Bake:** needs a GPU in practice. The Intel Iris Xe works: headless Chrome uses it through ANGLE/D3D11, with a maximum texture size of 16384. Without a GPU, Chrome's software renderer still works, but expect tens of minutes per tree and several GB of RAM. The bake runs once.
- **Game:** needs a GPU as it always has (WebGL). The picture trees reduce load compared with today. Real-GPU frame rate has not been measured yet; measure it after the switch.

---

## 5. Why not the alternatives

| Option | Why not (for now) |
|---|---|
| Render the scans directly | 2–17 M polygons per tree × tens of thousands of trees. Impossible in real time. |
| Our own photos as cut-outs | One angle per tree, inconsistent lighting, hard cut-outs around fine needles, needs a photo shoot. Still a valid way to add specific species later through the same atlas pipeline. |
| Stylised CC0 models (Quaternius, Kenney) | Not realistic, which is the goal. |
| Procedural trees (EZ-Tree, our own generator) | Less realistic than scans, and it would still need impostors for the far forest. |
| Commercial (SpeedTree) | Cost and licensing. |

---

## 6. Implementation steps

1. `node tools/trees/download.mjs`: fetch the scans into `.cache/polyhaven/`. Resumable: files already complete are skipped.
2. **Bake tool**, `tools/trees/bake.mjs` plus a bake page:
   - a small static server, headless Chrome on the GPU, Three.js `GLTFLoader`,
   - for each config entry: isolate the node, fit an orthographic camera to its real bounds, render 8 colour and 8 normal views,
   - bleed colours, pack the atlases, write the PNGs (or WebP) and `manifest.json` to `public/trees/`.
3. **`TreeImpostorMaterial`:** a shader with a cylindrical billboard, 2-view cross-fade, normal-mapped sun + hemisphere lighting, Three's fog and tone-mapping chunks, alpha-to-coverage and wind.
4. **`ForestView`:**
   - load the manifest and atlases,
   - build one instanced card mesh per tile, with per-instance variant, rotation, scale and tint,
   - map placement species to variants and scale to real heights,
   - keep the far-forest band.
5. **Data-driven:** a track can choose its tree set, with `forest.trees` in `track.json` naming the manifest. The default is the set above.
6. **Verify:**
   - unit tests for the manifest parse and for view selection and cross-fade weights,
   - screenshots at the start line, a corner and a long view,
   - texture memory and frame rate on the Iris Xe,
   - `npm test`, typecheck and build.
7. **Then decide** whether road-edge 3D trees are needed (2.3).

---

## 7. Current state

- `tools/trees/trees.config.mjs`: scans, nodes, views and frame size, as above.
- `tools/trees/download.mjs`: the download script. It was started and then stopped on purpose. `.cache/polyhaven/` holds about 134 MB of partial data (the fir textures, plus part of the fir mesh). It's git-ignored and can be deleted, or the script rerun to finish.
- `.gitignore`: `.cache/` added.
- No game code has been changed yet. The bake tool and the runtime are not written.
