import type { World } from '@dimforge/rapier3d-compat';
import { type Group, Quaternion, Vector3 } from 'three';
import type { CarSpec } from '@drivee/shared';
import { AudioMixer } from './audio/AudioMixer';
import { DrivingSounds, tyreSlide } from './audio/DrivingSounds';
import { EngineSound } from './audio/EngineSound';
import { cameraMounts, CameraRig } from './camera/CameraRig';
import { GameLoop } from './core/GameLoop';
import { GamepadInput } from './input/GamepadInput';
import { HapticsDirector } from './input/haptics';
import { Button, InputSystem } from './input/InputSystem';
import { KeyboardInput } from './input/KeyboardInput';
import { PhoneInput } from './input/PhoneInput';
import { createWorld, initPhysics, PHYSICS_DT } from './physics/PhysicsWorld';
import { loadBestLap, saveBestLap } from './race/bestLapStore';
import { LapTimer } from './race/LapTimer';
import { WrongWayDetector } from './race/WrongWay';
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
import { loadSettings, nextShadowQuality, saveSettings, SHADOW_QUALITIES, stepVolume } from './settings';
import type { TrackFrame } from './track/TrackSpline';
import { loadCarSpec, loadTrackSpec } from './tracks';
import { Hud } from './ui/Hud';
import { MenuNav, type MenuItem } from './ui/menu';
import { PairingPanel } from './ui/PairingPanel';
import { PauseMenu } from './ui/PauseMenu';
import { Vehicle } from './vehicle/Vehicle';

/** Further than this from the centreline, lap progress isn't tracked (the clock still runs). */
const LAP_TRACK_RANGE = 40;
/** Height above the road surface the car is dropped from on spawn/reset. */
const SPAWN_LIFT = 0.7;
/** Grid slot: metres behind the start line. */
const GRID_OFFSET = 15;
/** Below the terrain by this much means the car has escaped the world: put it back. */
const FELL_THROUGH = 5;
/** Share of the redline where the rev bar lights up with the automatic gearbox. */
const REV_WARNING = 0.92;

const STEP_LABELS: Record<GenerationStep | 'scene', string> = {
  road: 'Building road…',
  terrain: 'Shaping terrain…',
  forest: 'Planting forest…',
  scene: 'Preparing scene…',
};

export interface GameOptions {
  /** The player's best lap on this track so far, s. */
  best?: number | null;
  /** Called with the time of each completed lap that counts, s. */
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

  // Impact detection for haptics and sound: largest per-step velocity change since the last frame.
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
  private readonly wrongWay = new WrongWayDetector();
  private readonly pairing: PairingPanel;
  private readonly pauseMenu: PauseMenu;
  private readonly menuNav = new MenuNav();
  private readonly mixer: AudioMixer | null;
  private readonly engineSound: EngineSound | null;
  private readonly drivingSounds: DrivingSounds | null;
  /** Volume to go back to when unmuting. */
  private unmutedVolume = 1;

  // Scratch objects for the per-step track lookup.
  private readonly trackFrame: TrackFrame;
  private readonly heading = new Vector3();

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
    this.vehicle.manualGears = this.settings.manualGears;

    this.renderer = new Renderer(viewport, this.settings.shadows);
    const env = track.spec.environment;
    this.renderer.setFog(env.fogNear, env.fogFar);
    this.renderer.scene.add(buildTrackScene(track, this.renderer.maxAnisotropy));
    this.carView = new CarView(spec, carModel);
    this.renderer.scene.add(this.carView.root);
    this.cameraRig = new CameraRig(this.renderer.camera, spec.chassis.halfExtents[2], cameraMounts(spec));

    this.phone = new PhoneInput();
    this.phone.connect();
    this.input = new InputSystem([new KeyboardInput(), new GamepadInput(), this.phone]);
    this.hud = new Hud(hudRoot);
    this.trackFrame = track.spline.frameAt(0);
    this.lapTimer = new LapTimer(track.spline.length, track.spec.race.startDistance, best, {
      sectors: track.spec.race.sectors,
      reference: loadBestLap(track.spec.meta.id, spec.id),
    });
    this.pairing = new PairingPanel(hudRoot);
    this.pauseMenu = new PauseMenu(hudRoot, this.menuItems());
    this.mixer = AudioMixer.create();
    this.engineSound = this.mixer && new EngineSound(this.mixer.ctx, this.mixer.output, spec.engine);
    this.drivingSounds = this.mixer && new DrivingSounds(this.mixer.ctx, this.mixer.output);
    if (this.settings.volume > 0) this.unmutedVolume = this.settings.volume;

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

  /** The pause screen's rows. Settings are saved as they change. */
  private menuItems(): MenuItem[] {
    const onOff = (on: boolean) => (on ? 'On' : 'Off');
    const save = () => saveSettings(this.settings);
    return [
      { id: 'resume', label: 'Resume', activate: () => this.setPaused(false) },
      { id: 'restart', label: 'Restart lap', activate: () => this.restart() },
      {
        id: 'gears',
        label: 'Gears',
        value: () => (this.settings.manualGears ? 'Manual' : 'Automatic'),
        adjust: () => {
          this.settings.manualGears = this.vehicle.manualGears = !this.settings.manualGears;
          save();
        },
      },
      {
        id: 'tc',
        label: 'Traction control',
        value: () => onOff(this.vehicle.tractionControl),
        adjust: () => (this.vehicle.tractionControl = !this.vehicle.tractionControl),
      },
      { id: 'abs', label: 'ABS', value: () => onOff(this.vehicle.abs), adjust: () => (this.vehicle.abs = !this.vehicle.abs) },
      {
        id: 'volume',
        label: 'Volume',
        key: 'KeyV',
        value: () => (this.settings.volume === 0 ? 'Off' : `${Math.round(this.settings.volume * 100)}%`),
        // Choosing it mutes or unmutes; stepping it sets the level.
        activate: () => {
          if (this.settings.volume > 0) this.unmutedVolume = this.settings.volume;
          this.settings.volume = this.settings.volume > 0 ? 0 : this.unmutedVolume;
          save();
        },
        adjust: (direction) => {
          this.settings.volume = stepVolume(this.settings.volume, direction);
          save();
        },
      },
      {
        id: 'shadows',
        label: 'Shadows',
        key: 'KeyG',
        value: () => this.settings.shadows,
        adjust: (direction) => {
          // One step back is the whole cycle but one forward.
          const steps = direction > 0 ? 1 : SHADOW_QUALITIES.length - 1;
          for (let k = 0; k < steps; k++) this.settings.shadows = nextShadowQuality(this.settings.shadows);
          this.renderer.setShadowQuality(this.settings.shadows);
          save();
        },
      },
      { id: 'quit', label: 'Quit to menu', key: 'KeyQ', activate: () => (location.search = '?play') },
    ];
  }

  private setPaused(paused: boolean, forController = false): void {
    this.paused = paused;
    this.pausedForController = paused && forController;
    this.pauseMenu.setOpen(paused, this.pausedForController ? 'Controller disconnected' : '');
    // Whatever is held as the menu opens (throttle, steering) isn't a menu action.
    if (paused) this.menuNav.prime(this.input.current);
  }

  /** Back to the grid with the lap clock waiting for the line again. */
  private restart(): void {
    this.lapTimer.reset();
    this.wrongWay.reset();
    this.placeOnTrack(this.track.spec.race.startDistance - GRID_OFFSET);
    this.setPaused(false);
  }

  private beginFrame(dt: number): void {
    this.input.update(dt);
    for (let event = this.phone.takeEvent(); event; event = this.phone.takeEvent()) {
      if (event === 'lost' && !this.paused) this.setPaused(true, true);
      else if (event === 'regained' && this.pausedForController) this.setPaused(false);
    }
    if (this.input.pressed(Button.Pause)) this.setPaused(!this.paused);
    else if (this.paused) {
      for (const action of this.menuNav.update(this.input.current)) this.pauseMenu.handle(action);
    }
    if (this.paused) {
      // Assists can also change from their own buttons while the menu is up.
      this.pauseMenu.refresh();
    } else {
      if (this.input.pressed(Button.ShiftUp)) this.vehicle.requestShift(1);
      if (this.input.pressed(Button.ShiftDown)) this.vehicle.requestShift(-1);
    }
    this.phone.setPaused(this.paused);
    this.phone.setManual(this.vehicle.manualGears);
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
    // From the driver's seat of a closed car, the body has to be drawn from the inside.
    this.carView.setInteriorView(this.cameraRig.mode === 'windshield');
    this.renderer.setShadowFocus(this.renderPosition);
    this.renderer.render();
    this.updateFeedback(frameDt);
    this.pairing.update(this.phone.status);

    this.hud.update(
      {
        telemetry: t,
        redlineRpm: this.spec.engine.redlineRpm,
        shiftAt: this.vehicle.manualGears ? this.spec.gearbox.upshiftAt : REV_WARNING,
        manualGears: this.vehicle.manualGears,
        tractionControl: this.vehicle.tractionControl,
        abs: this.vehicle.abs,
        camera: this.cameraRig.mode,
        inputSource: this.input.activeSource,
        wrongWay: this.wrongWay.active && !this.paused,
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
    if (near) {
      const tangent = this.track.spline.frameAt(near.distance, this.trackFrame).tangent;
      const alignment = this.heading.set(0, 0, 1).applyQuaternion(this.currRotation).dot(tangent);
      this.wrongWay.update(alignment, this.vehicle.telemetry.forwardSpeed, dt);
    } else {
      this.wrongWay.reset();
    }
    // All four wheels on the ground beyond the verge: the car has left the track.
    if (this.vehicle.wheels.every((w) => w.grounded && w.surfaceGrip === SURFACE_GRIP.terrain)) this.lapTimer.invalidate();

    const event = this.lapTimer.update(near?.distance ?? null, dt);
    if (event?.kind !== 'lap') return;
    // The lap just completed is one less than the lap now running.
    this.hud.showLap(this.lapTimer.lap - 1, event.time, event.best, event.valid);
    if (event.reference) saveBestLap(this.track.spec.meta.id, this.spec.id, event.reference);
    if (event.valid) this.onLap(event.time);
  }

  /** What the car is doing, as sound and as vibration on the phone. */
  private updateFeedback(dt: number): void {
    const t = this.vehicle.telemetry;
    const wheels = this.vehicle.wheels;
    const onKerb = wheels.some((w) => w.grounded && w.surfaceGrip === SURFACE_GRIP.kerb);
    const impact = this.paused ? 0 : this.impact;
    this.impact = 0;

    const pattern = this.haptics.update({ onKerb, speed: t.speed, impact, atLimiter: this.atLimiter() }, dt);
    if (pattern) this.phone.buzz(pattern);

    this.mixer?.update(this.settings.volume, !this.paused);
    this.engineSound?.update({ rpm: t.rpm, load: t.load, atLimiter: this.atLimiter() }, dt);
    this.drivingSounds?.update(
      { slide: tyreSlide(wheels, t.speed, this.vehicle.wheelLoad), speed: t.speed, onKerb, impact },
      dt,
    );
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
