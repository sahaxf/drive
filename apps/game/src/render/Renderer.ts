import {
  ACESFilmicToneMapping,
  DirectionalLight,
  Fog,
  HemisphereLight,
  MathUtils,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { SHADOW_MAP_SIZE, type ShadowQuality } from '../settings';

/**
 * Moody dusk: a low, dim sun just above the ridgeline, heavy cloud, cool blue-grey haze
 * and little ambient fill, so shadows and the forest go dark.
 */
const LIGHTING = {
  sunElevationDeg: 7,
  sunAzimuthDeg: 135,
  sunColour: '#ff9b5e',
  sunIntensity: 1.7,
  exposure: 0.5,
  environmentIntensity: 0.35,
  skyTurbidity: 9,
  skyRayleigh: 2.6,
  skyMie: 0.006,
  skyMieG: 0.86,
  cloudCoverage: 0.62,
  cloudDensity: 0.6,
  hemisphereSky: '#5d6d8f',
  hemisphereGround: '#241f16',
  hemisphereIntensity: 0.18,
  fogColour: '#4b5260',
} as const;
const SHADOW_EXTENT = 45;

export class Renderer {
  readonly webgl: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(62, 1, 0.1, 14000);
  private readonly sun = new DirectionalLight(LIGHTING.sunColour, LIGHTING.sunIntensity);
  private readonly sunDirection = new Vector3();
  private sky!: Sky;
  private readonly onResize = () => this.resize();

  constructor(
    private readonly container: HTMLElement,
    shadows: ShadowQuality = 'medium',
  ) {
    this.webgl = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.webgl.toneMapping = ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = LIGHTING.exposure;
    this.webgl.shadowMap.type = PCFShadowMap;
    container.appendChild(this.webgl.domElement);

    this.setupSky();
    this.setupLights();
    this.setShadowQuality(shadows);
    this.scene.fog = new Fog(LIGHTING.fogColour, 500, 7500);

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  get maxAnisotropy(): number {
    return this.webgl.capabilities.getMaxAnisotropy();
  }

  /** Aerial perspective: distant hills and mountains fade into the haze. */
  setFog(near: number, far: number): void {
    this.scene.fog = new Fog(LIGHTING.fogColour, near, far);
  }

  /** Keep the shadow map centred on the player so it stays sharp where it matters. */
  setShadowFocus(target: Vector3): void {
    this.sun.position.copy(target).addScaledVector(this.sunDirection, 200);
    this.sun.target.position.copy(target);
  }

  /** Change shadow quality, including live while driving. */
  setShadowQuality(quality: ShadowQuality): void {
    const size = SHADOW_MAP_SIZE[quality];
    const enabled = size > 0;
    if (enabled !== this.webgl.shadowMap.enabled) {
      this.webgl.shadowMap.enabled = enabled;
      // Shadow receiving is compiled into each material's shader: rebuild them.
      this.scene.traverse((o) => {
        const material = (o as { material?: Material | Material[] }).material;
        for (const m of Array.isArray(material) ? material : material ? [material] : []) m.needsUpdate = true;
      });
    }
    if (enabled && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      // Three only allocates the map once; drop it so it's recreated at the new size.
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /** Free the GPU context and stop following the window size. */
  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.webgl.dispose();
    this.webgl.forceContextLoss();
    this.webgl.domElement.remove();
  }

  render(): void {
    // The sky is a finite box; keep the camera at its centre.
    this.sky.position.copy(this.camera.position);
    this.webgl.render(this.scene, this.camera);
  }

  private setupSky(): void {
    this.sunDirection.setFromSphericalCoords(
      1,
      MathUtils.degToRad(90 - LIGHTING.sunElevationDeg),
      MathUtils.degToRad(LIGHTING.sunAzimuthDeg),
    );

    const sky = (this.sky = new Sky());
    // Box sky: keep its corners inside the camera's far plane.
    sky.scale.setScalar(12000);
    const u = sky.material.uniforms;
    u['turbidity']!.value = LIGHTING.skyTurbidity;
    u['rayleigh']!.value = LIGHTING.skyRayleigh;
    u['mieCoefficient']!.value = LIGHTING.skyMie;
    u['mieDirectionalG']!.value = LIGHTING.skyMieG;
    u['cloudCoverage']!.value = LIGHTING.cloudCoverage;
    u['cloudDensity']!.value = LIGHTING.cloudDensity;
    u['sunPosition']!.value.copy(this.sunDirection);
    this.scene.add(sky);

    // Image-based lighting from the same sky, so reflections and ambient match it.
    const pmrem = new PMREMGenerator(this.webgl);
    const envScene = new Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = LIGHTING.environmentIntensity;
    pmrem.dispose();
  }

  private setupLights(): void {
    this.sun.castShadow = true;
    const shadow = this.sun.shadow;
    shadow.camera.left = -SHADOW_EXTENT;
    shadow.camera.right = SHADOW_EXTENT;
    shadow.camera.top = SHADOW_EXTENT;
    shadow.camera.bottom = -SHADOW_EXTENT;
    shadow.camera.near = 10;
    shadow.camera.far = 400;
    shadow.bias = -0.0004;
    shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(
      new HemisphereLight(LIGHTING.hemisphereSky, LIGHTING.hemisphereGround, LIGHTING.hemisphereIntensity),
    );
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.webgl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
