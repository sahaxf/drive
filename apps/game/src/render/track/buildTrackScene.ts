import { Group } from 'three';
import type { GeneratedTrack } from '../../track/generateTrack';
import { buildForestView } from './ForestView';
import { buildRoadView } from './RoadView';
import { buildMountainView, buildTerrainView } from './TerrainView';

/** All visuals for a generated track: road furniture, near terrain, far mountains, forest. */
export function buildTrackScene(track: GeneratedTrack, anisotropy: number): Group {
  const group = new Group();
  group.name = `track:${track.spec.meta.id}`;
  group.add(
    buildRoadView(track, anisotropy),
    buildTerrainView(track, anisotropy),
    buildMountainView(track, anisotropy),
    buildForestView(track),
  );
  return group;
}
