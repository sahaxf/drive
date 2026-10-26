import type { World } from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { parseCarSpec, parseTrackSpec, type CarSpec, type TrackSpec } from '@drivee/shared';
import { CameraRig } from './camera/CameraRig';
import { GameLoop } from './core/GameLoop';
import { GamepadInput } from './input/GamepadInput';
import { Button, InputSystem } from './input/InputSystem';
import { KeyboardInput } from './input/KeyboardInput';
import { createWorld, initPhysics, PHYSICS_DT } from './physics/PhysicsWorld';
import { CarView } from './render/CarView';
import { Renderer } from './render/Renderer';
import { buildTrackScene } from './render/track/buildTrackScene';
import { addTrackPhysics, generateTrack, type GeneratedTrack, type GenerationStep } from './track/generateTrack';
import { Hud } from './ui/Hud';
import { Vehicle } from './vehicle/Vehicle';

const CAR_ID = 'strada-gt';
const TRACK_ID = 'eifel-ring';
/** Height above the road surface the car is dropped from on spawn/reset. */
const SPAWN_LIFT = 0.7;
/** Grid slot: metres behind the start line. */
const GRID_OFFSET = 15;
/** Below the terrain by this much means the car has escaped the world: put it back. */
const FELL_THROUGH = 5;

const STEP_LABELS: Record<GenerationStep | 'scene', string> = {
  road: 'Building road…',
  terrain: 'Shaping terrain…',
  forest: 'Planting forest…',
  scene: 'Preparing scene…',
};

export class Game {
  private readonly loop: GameLoop;
  private paused = false;

  // Poses from the last two physics steps, blended for smooth rendering at any frame rate.
  private readonly prevPosition = new Vector3();
  private readonly currPosition = new Vector3();
  private readonly prevRotation = new Quaternion();
  private readonly currRotation = new Quaternion();
  private readonly renderPosition = new Vector3();
  private readonly renderRotation = new Quaternion();

  static async create(
    viewport: HTMLElement,
    hudRoot: HTMLElement,
    onProgress: (label: string) => void = () => {},
  ): Promise<Game> {
    const [, car, trackSpec] = await Promise.all([initPhysics(), loadCar(CAR_ID), loadTrack(TRACK_ID)]);
    const t0 = performance.now();
    const track = await generateTrack(trackSpec, async (step) => {
      onProgress(STEP_LABELS[step]);
      await nextFrame();
    });
    const t1 = performance.now();
    onProgress(STEP_LABELS.scene);
    await nextFrame();
    const t2 = performance.now();
    const game = new Game(viewport, hudRoot, car, track);
    console.info(
      `[drivee] ${track.spec.meta.name}: ${(track.spline.length / 1000).toFixed(2)} km, ${track.forest.count} trees; ` +
        `generated in ${(t1 - t0).toFixed(0)} ms, scene built in ${(performance.now() - t2).toFixed(0)} ms`,
    );
    return game;
  }

  private readonly world: World;
  private readonly vehicle: Vehicle;
  private readonly renderer: Renderer;
  private readonly carView: CarView;
  private readonly cameraRig: CameraRig;
  private readonly input: InputSystem;
  private readonly hud: Hud;

  private constructor(
    viewport: HTMLElement,
    hudRoot: HTMLElement,
    private readonly spec: CarSpec,
    private readonly track: GeneratedTrack,
  ) {
    this.world = createWorld();
    this.vehicle = new Vehicle(this.world, spec, new Vector3());
    this.vehicle.surfaceGrip = addTrackPhysics(this.world, track);

    this.renderer = new Renderer(viewport);
    const env = track.spec.environment;
    this.renderer.setFog(env.fogNear, env.fogFar);
    this.renderer.scene.add(buildTrackScene(track, this.renderer.maxAnisotropy));
    this.carView = new CarView(spec);
    this.renderer.scene.add(this.carView.root);
    this.cameraRig = new CameraRig(this.renderer.camera);

    this.input = new InputSystem([new KeyboardInput(), new GamepadInput()]);
    this.hud = new Hud(hudRoot);

    this.placeOnTrack(track.spec.race.startDistance - GRID_OFFSET);
    this.loop = new GameLoop(
      {
        beginFrame: (dt) => this.beginFrame(dt),
        step: (dt) => this.step(dt),
        render: (alpha, dt) => this.render(alpha, dt),
      },
      PHYSICS_DT,
    );
  }

  start(): void {
    this.loop.start();
  }

  private beginFrame(dt: number): void {
    this.input.update(dt);
    if (this.input.pressed(Button.Pause)) this.paused = !this.paused;
    if (this.input.pressed(Button.Camera)) this.cameraRig.cycle();
    if (this.input.pressed(Button.ToggleTractionControl)) this.vehicle.tractionControl = !this.vehicle.tractionControl;
    if (this.input.pressed(Button.ToggleAbs)) this.vehicle.abs = !this.vehicle.abs;
    if (this.input.pressed(Button.Reset)) this.resetToTrack();
  }

  private step(dt: number): void {
    if (this.paused) return;
    this.vehicle.step(this.input.current, dt);
    this.world.step();
    this.capturePose();
    const ground = this.track.terrain.heightAt(this.currPosition.x, this.currPosition.z);
    if (this.currPosition.y < ground - FELL_THROUGH) this.resetToTrack();
  }

  private render(alpha: number, frameDt: number): void {
    this.renderPosition.lerpVectors(this.prevPosition, this.currPosition, alpha);
    this.renderRotation.slerpQuaternions(this.prevRotation, this.currRotation, alpha);

    const t = this.vehicle.telemetry;
    this.carView.update(this.renderPosition, this.renderRotation, this.vehicle.wheels, t.brake > 0.05, t.gear < 0);
    this.cameraRig.update(frameDt, this.renderPosition, this.renderRotation, t.speed);
    this.renderer.setShadowFocus(this.renderPosition);
    this.renderer.render();

    this.hud.update(
      {
        telemetry: t,
        redlineRpm: this.spec.engine.redlineRpm,
        tractionControl: this.vehicle.tractionControl,
        abs: this.vehicle.abs,
        camera: this.cameraRig.mode,
        inputSource: this.input.activeSource,
        paused: this.paused,
      },
      frameDt,
    );
  }

  /** Back onto the centreline at the nearest point, facing the racing direction. */
  private resetToTrack(): void {
    const near = this.track.spline.nearest(this.currPosition.x, this.currPosition.z);
    this.placeOnTrack(near?.distance ?? this.track.spec.race.startDistance);
  }

  private placeOnTrack(distance: number): void {
    const frame = this.track.spline.frameAt(distance);
    const position = frame.position.clone().addScaledVector(frame.up, SPAWN_LIFT);
    this.vehicle.reset(position, Math.atan2(frame.tangent.x, frame.tangent.z));
    this.capturePose();
    this.capturePose();
    this.cameraRig.snap();
  }

  private capturePose(): void {
    this.prevPosition.copy(this.currPosition);
    this.prevRotation.copy(this.currRotation);
    const t = this.vehicle.body.translation();
    const r = this.vehicle.body.rotation();
    this.currPosition.set(t.x, t.y, t.z);
    this.currRotation.set(r.x, r.y, r.z, r.w);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function loadJson(url: string, what: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${what} (${response.status})`);
  return response.json();
}

async function loadCar(id: string): Promise<CarSpec> {
  return parseCarSpec(await loadJson(`/cars/${id}/car.json`, `car "${id}"`));
}

async function loadTrack(id: string): Promise<TrackSpec> {
  return parseTrackSpec(await loadJson(`/tracks/${id}/track.json`, `track "${id}"`));
}
