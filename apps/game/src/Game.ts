import type { World } from '@dimforge/rapier3d-compat';
import { type Group, Quaternion, Vector3 } from 'three';
import type { CarSpec } from '@drivee/shared';
import { EngineSound } from './audio/EngineSound';
import { CameraRig } from './camera/CameraRig';
import { GameLoop } from './core/GameLoop';
import { GamepadInput } from './input/GamepadInput';
import { HapticsDirector } from './input/haptics';
import { Button, InputSystem } from './input/InputSystem';
import { KeyboardInput } from './input/KeyboardInput';
import { PhoneInput } from './input/PhoneInput';
import { createWorld, initPhysics, PHYSICS_DT } from './physics/PhysicsWorld';
import { LapTimer } from './race/LapTimer';
import { loadCarModel } from './render/carModel';
import { CarView } from './render/CarView';
import { Renderer } from './render/Renderer';
import { buildTrackScene } from './render/track/buildTrackScene';
import {
  addTrackPhysics,
  generateTrack,
  SURFACE_GRIP,
  type GeneratedTrack,
  type GenerationStep,
} from './track/generateTrack';
import { loadSettings, nextShadowQuality, saveSettings } from './settings';
import { loadCarSpec, loadTrackSpec } from './tracks';
import { Hud } from './ui/Hud';
import { PairingPanel } from './ui/PairingPanel';
import { Vehicle } from './vehicle/Vehicle';

/** Further than this from the centreline, lap progress isn't tracked (the clock still runs). */
const LAP_TRACK_RANGE = 40;
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

export interface GameOptions {
  /** The player's best lap on this track so far, s. */
  best?: number | null;
  /** Called with the time of each completed lap, s. */
  onLap?: (seconds: number) => void;
  onProgress?: (label: string) => void;
}

export class Game {
  private readonly loop: GameLoop;
  private paused = false;
  /** The game paused itself because the phone stopped sending; it resumes when it's back. */
  private pausedForController = false;

  // Poses from the last two physics steps, blended for smooth rendering at any frame rate.
  private readonly prevPosition = new Vector3();
  private readonly currPosition = new Vector3();
  private readonly prevRotation = new Quaternion();
  private readonly currRotation = new Quaternion();
  private readonly renderPosition = new Vector3();
  private readonly renderRotation = new Quaternion();

  // Impact detection for haptics: largest per-step velocity change since the last frame.
  private readonly lastVelocity = new Vector3();
  private readonly velocity = new Vector3();
  private impact = 0;

  static async create(
    viewport: HTMLElement,
    hudRoot: HTMLElement,
    trackId: string,
    carId: string,
    { best = null, onLap = () => {}, onProgress = () => {} }: GameOptions = {},
  ): Promise<Game> {
    const [, [car, carModel], trackSpec] = await Promise.all([
      initPhysics(),
      loadCarSpec(carId).then(async (spec) => [spec, await loadCarModel(spec)] as const),
      loadTrackSpec(trackId),
    ]);
    const t0 = performance.now();
    const track = await generateTrack(trackSpec, async (step) => {
      onProgress(STEP_LABELS[step]);
      await nextFrame();
    });
    const t1 = performance.now();
    onProgress(STEP_LABELS.scene);
    await nextFrame();
    const t2 = performance.now();
    const game = new Game(viewport, hudRoot, car, carModel, track, best, onLap);
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
  private readonly phone: PhoneInput;
  private readonly haptics = new HapticsDirector();
  private readonly hud: Hud;
  private readonly settings = loadSettings();
  private readonly lapTimer: LapTimer;
  private readonly pairing: PairingPanel;
  private readonly engineSound: EngineSound | null;

  private constructor(
    viewport: HTMLElement,
    hudRoot: HTMLElement,
    private readonly spec: CarSpec,
    carModel: Group | null,
    private readonly track: GeneratedTrack,
    best: number | null,
    private readonly onLap: (seconds: number) => void,
  ) {
    this.world = createWorld();
    this.vehicle = new Vehicle(this.world, spec, new Vector3());
    this.vehicle.surfaceGrip = addTrackPhysics(this.world, track);

    this.renderer = new Renderer(viewport, this.settings.shadows);
    const env = track.spec.environment;
    this.renderer.setFog(env.fogNear, env.fogFar);
    this.renderer.scene.add(buildTrackScene(track, this.renderer.maxAnisotropy));
    this.carView = new CarView(spec, carModel);
    this.renderer.scene.add(this.carView.root);
    this.cameraRig = new CameraRig(this.renderer.camera, spec.chassis.halfExtents[2]);

    this.phone = new PhoneInput();
    this.phone.connect();
    this.input = new InputSystem([new KeyboardInput(), new GamepadInput(), this.phone]);
    this.hud = new Hud(hudRoot);
    // Back to track selection, only from the pause screen so it can't happen by accident.
    window.addEventListener('keydown', (e) => {
      if (!this.paused || e.repeat) return;
      if (e.code === 'KeyQ') location.search = '?play';
      if (e.code === 'KeyG') {
        this.settings.shadows = nextShadowQuality(this.settings.shadows);
        this.renderer.setShadowQuality(this.settings.shadows);
        saveSettings(this.settings);
      }
      if (e.code === 'KeyV') {
        this.settings.sound = !this.settings.sound;
        saveSettings(this.settings);
      }
    });
    this.lapTimer = new LapTimer(track.spline.length, track.spec.race.startDistance, best);
    this.pairing = new PairingPanel(hudRoot);
    this.engineSound = EngineSound.create(spec.engine);

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
    for (let event = this.phone.takeEvent(); event; event = this.phone.takeEvent()) {
      if (event === 'lost' && !this.paused) {
        this.paused = true;
        this.pausedForController = true;
      } else if (event === 'regained' && this.pausedForController) {
        this.paused = false;
        this.pausedForController = false;
      }
    }
    if (this.input.pressed(Button.Pause)) {
      this.paused = !this.paused;
      this.pausedForController = false;
    }
    this.phone.setPaused(this.paused);
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
    const v = this.vehicle.body.linvel();
    this.velocity.set(v.x, v.y, v.z);
    this.impact = Math.max(this.impact, this.velocity.distanceTo(this.lastVelocity));
    this.lastVelocity.copy(this.velocity);
    this.updateLap(dt);
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
    this.updateHaptics(frameDt);
    this.engineSound?.update(
      { rpm: t.rpm, load: t.load, atLimiter: this.atLimiter() },
      frameDt,
      this.settings.sound && !this.paused,
    );
    this.pairing.update(this.phone.status);

    this.hud.update(
      {
        telemetry: t,
        redlineRpm: this.spec.engine.redlineRpm,
        tractionControl: this.vehicle.tractionControl,
        abs: this.vehicle.abs,
        camera: this.cameraRig.mode,
        inputSource: this.input.activeSource,
        paused: this.paused,
        pauseReason: this.pausedForController ? 'Controller disconnected' : '',
        shadows: this.settings.shadows,
        sound: this.settings.sound,
        lap: this.lapTimer,
        inputDetail:
          this.input.activeSource === 'phone' && this.phone.status.rttMs !== null
            ? ` (${Math.round(this.phone.status.rttMs)} ms)`
            : '',
      },
      frameDt,
    );
  }

  private updateLap(dt: number): void {
    const near = this.track.spline.nearest(this.currPosition.x, this.currPosition.z, LAP_TRACK_RANGE);
    const event = this.lapTimer.update(near?.distance ?? null, dt);
    if (event?.kind !== 'lap') return;
    // The lap just completed is one less than the lap now running.
    this.hud.showLap(this.lapTimer.lap - 1, event.time, event.best);
    this.onLap(event.time);
  }

  private updateHaptics(dt: number): void {
    const t = this.vehicle.telemetry;
    const pattern = this.haptics.update(
      {
        onKerb: this.vehicle.wheels.some((w) => w.grounded && w.surfaceGrip === SURFACE_GRIP.kerb),
        speed: t.speed,
        impact: this.paused ? 0 : this.impact,
        atLimiter: this.atLimiter(),
      },
      dt,
    );
    this.impact = 0;
    if (pattern) this.phone.buzz(pattern);
  }

  private atLimiter(): boolean {
    const t = this.vehicle.telemetry;
    return t.throttle > 0.5 && t.rpm >= this.spec.engine.redlineRpm * 0.99;
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
    // A reset teleports the car: not an impact.
    this.lastVelocity.set(0, 0, 0);
    this.impact = 0;
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
