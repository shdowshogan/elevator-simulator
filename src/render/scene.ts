import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingSim, Car, Passenger, Simulation } from '../sim/engine';
import { CORE_PAD, CORRIDOR_D, ENTRANCE_Z, FLAT_D, FLAT_W, SHAFT_D, SHAFT_W, type Layout } from '../sim/layout';
import { mulberry32 } from '../sim/rng';
import { CAR_COLORS, carName, floorLabel } from '../sim/types';

export type Selection =
  | { type: 'passenger'; id: number }
  | { type: 'car'; b: number; car: number }
  | { type: 'floor'; b: number; floor: number }
  | null;

const MAX_PEOPLE = 8000;
const CAR_W = SHAFT_W - 0.5;
const CAR_D = SHAFT_D - 0.5;
const CAR_H = 2.35;
const CAR_Z = -CAR_D / 2 - 0.15;
const BUILDING_GAP = 28;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();

/** Collects boxes and turns them into one instanced mesh. */
class Batch {
  private data: number[] = [];
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    this.data.push(x, y, z, sx, sy, sz);
    return this.data.length / 6 - 1;
  }
  get count() {
    return this.data.length / 6;
  }
  build(geo: THREE.BufferGeometry, mat: THREE.Material, shadows = false): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.count));
    mesh.count = this.count;
    for (let i = 0; i < this.count; i++) {
      const d = this.data;
      const o = i * 6;
      _m.compose(_p.set(d[o], d[o + 1], d[o + 2]), _q.identity(), _s.set(d[o + 3], d[o + 4], d[o + 5]));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

interface CarVisual {
  group: THREE.Group;
  doorL: THREE.Mesh;
  doorR: THREE.Mesh;
  cable: THREE.Mesh;
  weight: THREE.Mesh;
  label: HTMLDivElement;
  labelObj: CSS2DObject;
  text: string;
}

interface BuildingVisual {
  sim: BuildingSim;
  layout: Layout;
  offsetX: number;
  group: THREE.Group;
  cars: CarVisual[];
  lamps: THREE.InstancedMesh;
  lampState: Uint8Array;
  windows: THREE.InstancedMesh;
  windowSeed: Float32Array;
  highlight: THREE.Mesh;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const LIT_CURVE: [number, number][] = [
  [0, 0.12], [5, 0.06], [6.5, 0.45], [8, 0.2], [9.5, 0.05], [16.5, 0.05], [18.5, 0.6], [21, 0.8], [23, 0.45], [24, 0.12],
];
function litFraction(hour: number): number {
  for (let i = 1; i < LIT_CURVE.length; i++) {
    const [h1, v1] = LIT_CURVE[i];
    if (hour <= h1) {
      const [h0, v0] = LIT_CURVE[i - 1];
      return v0 + ((v1 - v0) * (hour - h0)) / (h1 - h0);
    }
  }
  return 0.12;
}

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  onSelect: (s: Selection) => void = () => {};
  selection: Selection = null;
  showLabels = true;

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private container: HTMLElement;
  private root = new THREE.Group();
  private buildings: BuildingVisual[] = [];
  private disposables: { dispose(): void }[] = [];

  private sun = new THREE.DirectionalLight(0xffffff, 2);
  private hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3f36, 1);
  private sky: THREE.Mesh;
  private skyUniforms = {
    top: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color() },
  };
  private stars: THREE.Points;
  private night = -1;
  private windowStamp = -1;

  private people: THREE.InstancedMesh;
  private peopleIds = new Int32Array(MAX_PEOPLE);
  private peoplePos = new Float32Array(MAX_PEOPLE * 3);
  private peopleCount = 0;
  private marker: THREE.Mesh;

  private mats = {
    slab: new THREE.MeshStandardMaterial({ color: 0xc4c7cd, roughness: 0.92, emissive: 0xffc98f, emissiveIntensity: 0 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe9e4d9, roughness: 0.95 }),
    front: new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.9, emissive: 0xffc98f, emissiveIntensity: 0 }),
    core: new THREE.MeshStandardMaterial({ color: 0x3d4452, roughness: 0.7, metalness: 0.2, emissive: 0x8fa6c9, emissiveIntensity: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa1ad, roughness: 0.35, metalness: 0.8 }),
    door: new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xa9d6ff, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.14, depthWrite: false }),
    carGlass: new THREE.MeshStandardMaterial({ color: 0xcfe6ff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
    carDoor: new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.3, metalness: 0.85 }),
    carFloor: new THREE.MeshStandardMaterial({ color: 0x3b4150, roughness: 0.6 }),
    carLight: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.4, 1.2) }),
    cable: new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.5, metalness: 0.6 }),
    weight: new THREE.MeshStandardMaterial({ color: 0x4a4f5a, roughness: 0.6, metalness: 0.5 }),
    window: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    strip: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    ground: new THREE.MeshStandardMaterial({ color: 0x55694f, roughness: 1 }),
    plaza: new THREE.MeshStandardMaterial({ color: 0x8b8e96, roughness: 0.95 }),
    path: new THREE.MeshStandardMaterial({ color: 0xb9b3a6, roughness: 0.9 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5b4634, roughness: 1 }),
    leaves: new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 1, flatShading: true }),
    highlight: new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.16, depthWrite: false }),
    marker: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.2), transparent: true, opacity: 0.9, depthTest: false }),
  };
  private box = new THREE.BoxGeometry(1, 1, 1);

  private pointerDown = { x: 0, y: 0, t: 0 };
  private camGoal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private ro: ResizeObserver;
  private campus = { width: 60, height: 90 };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
    this.camera.position.set(60, 60, 170);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 1200;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', () => (this.camGoal = null));

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.2, 0.45, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Environment
    this.scene.fog = new THREE.Fog(0x9fb8d8, 400, 1800);
    this.scene.add(this.hemi, new THREE.AmbientLight(0xffffff, 0.12));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.sun, this.sun.target);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.skyUniforms,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; varying vec3 vDir;
          void main(){
            vec3 d = normalize(vDir);
            float t = pow(clamp(d.y * 1.15 + 0.04, 0.0, 1.0), 0.5);
            vec3 c = mix(horizon, top, t);
            float s = max(dot(d, sunDir), 0.0);
            c += sunColor * (pow(s, 600.0) * 6.0 + pow(s, 10.0) * 0.22);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const starGeo = new THREE.BufferGeometry();
    const r = mulberry32(99);
    const starPos: number[] = [];
    for (let i = 0; i < 900; i++) {
      const a = r() * Math.PI * 2;
      const e = Math.asin(0.08 + r() * 0.92);
      starPos.push(Math.cos(a) * Math.cos(e) * 2500, Math.sin(e) * 2500, Math.sin(a) * Math.cos(e) * 2500);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // People: one instanced mesh for everybody, lit a little from within so they read at night.
    const body = new THREE.CapsuleGeometry(0.2, 0.75, 3, 8);
    body.translate(0, 0.78, 0);
    const head = new THREE.SphereGeometry(0.16, 10, 8);
    head.translate(0, 1.56, 0);
    const personGeo = mergeGeometries([body, head])!;
    const personMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
    personMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.38;',
      );
    };
    this.people = new THREE.InstancedMesh(personGeo, personMat, MAX_PEOPLE);
    this.people.count = 0;
    this.people.frustumCulled = false;
    this.people.setColorAt(0, _c.set(0xffffff));
    this.scene.add(this.people);

    this.marker = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 28), this.mats.marker);
    this.marker.rotation.x = Math.PI / 2;
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.scene.add(this.root);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() }));
    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      if (moved < 5 && performance.now() - this.pointerDown.t < 500 && e.button === 0) this.pick(e.clientX, e.clientY);
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.ro.disconnect();
    this.clearRoot();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }

  // ------------------------------------------------------------------ building the world

  private clearRoot() {
    this.root.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    this.root.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.buildings = [];
  }

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Rebuild all geometry for a new simulation. `keepCamera` avoids a jump on small edits. */
  build(sim: Simulation, keepCamera = false) {
    const before = `${this.campus.width}|${this.campus.height}`;
    this.clearRoot();
    this.selection = null;
    this.windowStamp = -1;

    const layouts = sim.buildings.map((b) => b.layout);
    const total = layouts.reduce((a, l) => a + l.width, 0) + BUILDING_GAP * (layouts.length - 1);
    let x = -total / 2;
    let maxH = 0;
    sim.buildings.forEach((b, i) => {
      const l = layouts[i];
      const offsetX = x + l.width / 2;
      x += l.width + BUILDING_GAP;
      maxH = Math.max(maxH, l.height);
      this.buildings.push(this.buildBuilding(b, offsetX));
    });
    this.campus = { width: total, height: maxH };
    this.buildGrounds(total, sim);

    const reach = Math.max(total, maxH) * 0.9 + 40;
    const sc = this.sun.shadow.camera;
    sc.left = -reach; sc.right = reach; sc.top = reach; sc.bottom = -reach;
    sc.near = 10; sc.far = reach * 5;
    sc.updateProjectionMatrix();

    if (!keepCamera || before !== `${total}|${maxH}`) this.focus('overview', true);
  }

  private buildGrounds(total: number, sim: Simulation) {
    const ground = new THREE.Mesh(this.track(new THREE.CircleGeometry(2600, 48)), this.mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.3;
    ground.receiveShadow = true;
    this.root.add(ground);

    const plaza = new THREE.Mesh(this.box, this.mats.plaza);
    plaza.scale.set(total + 30, 0.3, FLAT_D + ENTRANCE_Z + 18);
    plaza.position.set(0, -0.16, (ENTRANCE_Z - FLAT_D) / 2 + 3);
    plaza.receiveShadow = true;
    this.root.add(plaza);

    // Trees scattered around the plaza, clear of the entrance paths.
    const r = mulberry32(sim.cfg.seed + 5);
    const trunks = new Batch();
    const crowns: number[][] = [];
    // Keep the ground in front of each tower clear so nothing blocks the view into the corridors.
    const blocked = (tx: number, tz: number) =>
      tz > -FLAT_D - 5 && tz < 64 && this.buildings.some((bv) => Math.abs(tx - bv.offsetX) < bv.layout.width / 2 + 5);
    for (let i = 0; i < 400 && crowns.length < 70; i++) {
      const tx = (r() - 0.5) * (total + 190);
      const tz = -FLAT_D - 42 + r() * 135;
      if (blocked(tx, tz)) continue;
      const s = 0.8 + r() * 0.9;
      trunks.add(tx, 1.1 * s, tz, 0.3 * s, 2.2 * s, 0.3 * s);
      crowns.push([tx, 3.4 * s, tz, 2.2 * s]);
    }
    this.root.add(trunks.build(this.box, this.mats.trunk, true));
    const crownGeo = this.track(new THREE.IcosahedronGeometry(1, 1));
    const crownMesh = new THREE.InstancedMesh(crownGeo, this.mats.leaves, crowns.length);
    crowns.forEach(([cx, cy, cz, s], i) => {
      _m.compose(_p.set(cx, cy, cz), _q.identity(), _s.set(s, s * 1.15, s));
      crownMesh.setMatrixAt(i, _m);
    });
    crownMesh.castShadow = true;
    this.root.add(crownMesh);
  }

  private buildBuilding(b: BuildingSim, offsetX: number): BuildingVisual {
    const l = b.layout;
    const h = b.h;
    const levels = b.levels;
    const H = l.height;
    const W = l.width;
    const zBack = -FLAT_D;
    const zFront = CORRIDOR_D;
    const n = b.cfg.flatsPerFloor;
    const group = new THREE.Group();
    group.position.x = offsetX;
    group.userData.building = b.index;
    this.root.add(group);

    const slabs = new Batch();
    const walls = new Batch();
    const fronts = new Batch();
    const doors = new Batch();
    const coreB = new Batch();
    const metal = new Batch();
    const glass = new Batch();
    const strips = new Batch();
    const windows = new Batch();
    const seeds: number[] = [];
    const r = mulberry32(1234 + b.index * 77);
    const addWindow = (x: number, y: number, z: number, sx: number, sy: number, sz: number, seed: number) => {
      windows.add(x, y, z, sx, sy, sz);
      seeds.push(seed);
    };

    for (let f = 0; f <= levels; f++) {
      slabs.add(0, f * h - 0.14, (zFront + zBack) / 2, W + 0.8, 0.28, zFront - zBack + 0.8);
    }
    walls.add(0, H / 2, zBack, W, H, 0.3);
    walls.add(-W / 2, H / 2, zBack / 2, 0.3, H, FLAT_D);
    walls.add(W / 2, H / 2, zBack / 2, 0.3, H, FLAT_D);
    // roof parapet and plant room
    walls.add(0, H + 0.5, zFront + 0.3, W + 0.8, 1, 0.2);
    walls.add(0, H + 0.5, zBack - 0.3, W + 0.8, 1, 0.2);
    walls.add(-W / 2 - 0.3, H + 0.5, (zFront + zBack) / 2, 0.2, 1, zFront - zBack + 0.8);
    walls.add(W / 2 + 0.3, H + 0.5, (zFront + zBack) / 2, 0.2, 1, zFront - zBack + 0.8);
    coreB.add(l.coreCenter, H + 1.7, zBack / 2, l.coreX1 - l.coreX0 + 1, 3.4, FLAT_D - 1.5);

    // elevator core: solid block behind the shafts, pads either side, dividers between shafts
    coreB.add(l.coreCenter, H / 2, -SHAFT_D - (FLAT_D - SHAFT_D) / 2, l.coreX1 - l.coreX0, H, FLAT_D - SHAFT_D);
    coreB.add(l.coreX0 + CORE_PAD / 2, H / 2, -SHAFT_D / 2, CORE_PAD, H, SHAFT_D);
    coreB.add(l.coreX1 - CORE_PAD / 2, H / 2, -SHAFT_D / 2, CORE_PAD, H, SHAFT_D);
    for (let i = 1; i < b.cars.length; i++) {
      metal.add(l.coreX0 + CORE_PAD + i * SHAFT_W, H / 2, -SHAFT_D / 2, 0.12, H, SHAFT_D);
    }

    for (let f = 0; f < levels; f++) {
      const y0 = f * h;
      const clear = h - 0.28;
      // lintel above the elevator doors
      coreB.add(l.coreCenter, y0 + (CAR_H + 0.12 + clear) / 2, -0.08, b.cars.length * SHAFT_W, clear - CAR_H - 0.12, 0.16);
      strips.add(0, y0 + clear - 0.05, CORRIDOR_D * 0.55, W - 1.2, 0.04, 0.1);
      if (f === 0) {
        // lobby: columns, glazed front either side of the entrance
        for (let i = 0; i <= n; i++) {
          const cx = i <= l.flatsLeft ? l.x0 + i * FLAT_W : l.coreX1 + (i - l.flatsLeft) * FLAT_W;
          metal.add(cx, clear / 2, zFront - 0.2, 0.4, clear, 0.4);
        }
        const door = 3.2;
        const leftW = l.coreCenter - door - l.x0;
        const rightW = l.x0 + W - (l.coreCenter + door);
        if (leftW > 0.5) glass.add(l.x0 + leftW / 2, clear / 2, zFront, leftW, clear, 0.05);
        if (rightW > 0.5) glass.add(l.coreCenter + door + rightW / 2, clear / 2, zFront, rightW, clear, 0.05);
        continue;
      }
      glass.add(0, y0 + 0.53, zFront, W, 1.06, 0.04);
      metal.add(0, y0 + 1.09, zFront, W, 0.05, 0.08);
      for (let i = 0; i < n; i++) {
        const fx = l.flatX0(i) + FLAT_W / 2;
        const seed = r();
        fronts.add(fx, y0 + clear / 2, 0, FLAT_W - 0.1, clear, 0.14);
        doors.add(fx, y0 + 1.05, 0.09, 0.95, 2.1, 0.05);
        addWindow(fx - 2.1, y0 + 1.55, 0.09, 1.7, 1.0, 0.04, seed);
        addWindow(fx + 2.1, y0 + 1.55, 0.09, 1.7, 1.0, 0.04, seed);
        addWindow(fx - 1.7, y0 + 1.5, zBack - 0.17, 2.0, 1.45, 0.05, seed);
        addWindow(fx + 1.7, y0 + 1.5, zBack - 0.17, 2.0, 1.45, 0.05, (seed + 0.37) % 1);
      }
      for (const side of [-1, 1]) {
        addWindow((side * W) / 2 + side * 0.17, y0 + 1.5, zBack * 0.3, 0.05, 1.45, 1.8, r());
        addWindow((side * W) / 2 + side * 0.17, y0 + 1.5, zBack * 0.72, 0.05, 1.45, 1.8, r());
      }
    }

    // entrance canopy and path
    glass.add(l.coreCenter, h - 0.35, zFront + 2.2, 8.5, 0.12, 4.4);
    metal.add(l.coreCenter - 3.9, (h - 0.35) / 2, zFront + 4.1, 0.18, h - 0.35, 0.18);
    metal.add(l.coreCenter + 3.9, (h - 0.35) / 2, zFront + 4.1, 0.18, h - 0.35, 0.18);
    const path = new THREE.Mesh(this.box, this.mats.path);
    path.scale.set(4.6, 0.06, ENTRANCE_Z + 4);
    path.position.set(l.coreCenter, 0.02, zFront + (ENTRANCE_Z + 4) / 2 - 1);
    path.receiveShadow = true;
    group.add(path);

    group.add(slabs.build(this.box, this.mats.slab, true));
    group.add(walls.build(this.box, this.mats.wall, true));
    group.add(fronts.build(this.box, this.mats.front));
    group.add(doors.build(this.box, this.mats.door));
    group.add(coreB.build(this.box, this.mats.core, true));
    group.add(metal.build(this.box, this.mats.metal));
    group.add(strips.build(this.box, this.mats.strip));
    const glassMesh = glass.build(this.box, this.mats.glass);
    glassMesh.renderOrder = 2;
    group.add(glassMesh);
    const windowMesh = windows.build(this.box, this.mats.window);
    for (let i = 0; i < windows.count; i++) windowMesh.setColorAt(i, _c.setRGB(0.1, 0.12, 0.16));
    group.add(windowMesh);

    // hall call lamps: an up and a down arrow per floor on the left core pad
    const lampGeo = this.track(new THREE.ConeGeometry(0.17, 0.3, 3));
    lampGeo.rotateY(Math.PI / 6);
    const lamps = new THREE.InstancedMesh(lampGeo, this.mats.lamp, levels * 2);
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    for (let f = 0; f < levels; f++) {
      _m.compose(_p.set(l.coreX0 + CORE_PAD / 2, f * h + 1.62, 0.06), _q.identity(), _s.set(1, 1, 0.3));
      lamps.setMatrixAt(f * 2, _m);
      _m.compose(_p.set(l.coreX0 + CORE_PAD / 2, f * h + 1.2, 0.06), flip, _s.set(1, 1, 0.3));
      lamps.setMatrixAt(f * 2 + 1, _m);
      lamps.setColorAt(f * 2, _c.setRGB(0.06, 0.08, 0.1));
      lamps.setColorAt(f * 2 + 1, _c.setRGB(0.06, 0.08, 0.1));
    }
    group.add(lamps);

    // elevator cars
    const cars = b.cars.map((c) => this.buildCar(b, c, group, H));

    const highlight = new THREE.Mesh(this.box, this.mats.highlight);
    highlight.scale.set(W, h - 0.3, CORRIDOR_D);
    highlight.visible = false;
    highlight.renderOrder = 3;
    group.add(highlight);

    // name tag on the roof
    const tag = document.createElement('div');
    tag.className = 'building-tag';
    tag.textContent = b.cfg.name;
    const tagObj = new CSS2DObject(tag);
    tagObj.position.set(0, H + 6.5, 0);
    group.add(tagObj);

    return {
      sim: b,
      layout: l,
      offsetX,
      group,
      cars,
      lamps,
      lampState: new Uint8Array(levels * 2),
      windows: windowMesh,
      windowSeed: Float32Array.from(seeds),
      highlight,
    };
  }

  private buildCar(b: BuildingSim, c: Car, parent: THREE.Group, H: number): CarVisual {
    const l = b.layout;
    const color = new THREE.Color(CAR_COLORS[c.index % CAR_COLORS.length]);
    const accent = this.track(new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.5) }));
    const group = new THREE.Group();
    group.position.set(l.shaftX(c.index), 0, 0);
    group.userData.car = c.index;
    const add = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      const m = new THREE.Mesh(this.box, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      group.add(m);
      return m;
    };
    add(this.mats.carFloor, 0, 0.06, CAR_Z, CAR_W, 0.12, CAR_D);
    add(this.mats.carFloor, 0, CAR_H, CAR_Z, CAR_W, 0.12, CAR_D);
    add(this.mats.carLight, 0, CAR_H - 0.08, CAR_Z, CAR_W - 0.5, 0.03, CAR_D - 0.5);
    add(this.mats.carDoor, 0, CAR_H / 2, CAR_Z - CAR_D / 2, CAR_W, CAR_H, 0.05);
    add(this.mats.carGlass, -CAR_W / 2, CAR_H / 2, CAR_Z, 0.04, CAR_H, CAR_D).renderOrder = 4;
    add(this.mats.carGlass, CAR_W / 2, CAR_H / 2, CAR_Z, 0.04, CAR_H, CAR_D).renderOrder = 4;
    add(accent, 0, CAR_H + 0.14, CAR_Z, CAR_W + 0.08, 0.14, CAR_D + 0.08);
    add(accent, 0, 0.02, CAR_Z + CAR_D / 2 + 0.03, CAR_W, 0.05, 0.05);
    const doorL = add(this.mats.carDoor, -CAR_W / 4, CAR_H / 2, CAR_Z + CAR_D / 2, CAR_W / 2, CAR_H - 0.1, 0.05);
    const doorR = add(this.mats.carDoor, CAR_W / 4, CAR_H / 2, CAR_Z + CAR_D / 2, CAR_W / 2, CAR_H - 0.1, 0.05);
    parent.add(group);

    const cable = new THREE.Mesh(this.box, this.mats.cable);
    cable.position.set(l.shaftX(c.index), 0, CAR_Z);
    parent.add(cable);
    const weight = new THREE.Mesh(this.box, this.mats.weight);
    weight.scale.set(1.3, 2.4, 0.22);
    weight.position.set(l.shaftX(c.index), 0, -SHAFT_D + 0.16);
    parent.add(weight);

    const label = document.createElement('div');
    label.className = 'car-label';
    label.style.setProperty('--car', CAR_COLORS[c.index % CAR_COLORS.length]);
    const labelObj = new CSS2DObject(label);
    labelObj.position.set(0, CAR_H + 1.0, CAR_Z + CAR_D / 2);
    group.add(labelObj);
    void H;
    return { group, doorL, doorR, cable, weight, label, labelObj, text: '' };
  }

  // ------------------------------------------------------------------ camera

  focus(preset: 'overview' | 'lobby' | 'top' | 'side', instant = false) {
    const { width, height } = this.campus;
    const fov = (this.camera.fov * Math.PI) / 180;
    let pos: THREE.Vector3;
    let target: THREE.Vector3;
    if (preset === 'lobby') {
      target = new THREE.Vector3(0, 2.6, 0);
      pos = new THREE.Vector3(5, 4.2, 30);
    } else if (preset === 'top') {
      target = new THREE.Vector3(0, height - 8, 0);
      pos = new THREE.Vector3(-12, height + 4, 52);
    } else if (preset === 'side') {
      const dist = Math.max(height * 0.74, (width * 1.1) / this.camera.aspect) / Math.tan(fov / 2);
      target = new THREE.Vector3(0, height * 0.42, 0);
      pos = new THREE.Vector3(0, height * 0.45, dist);
    } else {
      // leave room for the top bar and the timeline, which cover the edges of the view
      const fit = Math.max(height * 0.78, (width * 1.1) / this.camera.aspect);
      const dist = fit / Math.tan(fov / 2);
      target = new THREE.Vector3(0, height * 0.4, 0);
      pos = new THREE.Vector3(dist * 0.4, height * 0.58, dist * 0.92);
    }
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camGoal = null;
    } else {
      this.camGoal = { pos, target };
    }
  }

  /** Move the camera to look at a floor of a building. */
  focusFloor(bi: number, floor: number) {
    const bv = this.buildings[bi];
    if (!bv) return;
    const y = floor * bv.sim.h + 1.5;
    const target = new THREE.Vector3(bv.offsetX + bv.layout.coreCenter, y, 0);
    this.camGoal = { target, pos: new THREE.Vector3(target.x + 9, y + 7, 40) };
  }

  // ------------------------------------------------------------------ picking

  private pick(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    // People are tiny, so pick the nearest one on screen instead of ray-testing the mesh.
    let best = -1;
    let bestD = 16 * 16;
    for (let i = 0; i < this.peopleCount; i++) {
      _v.set(this.peoplePos[i * 3], this.peoplePos[i * 3 + 1] + 0.9, this.peoplePos[i * 3 + 2]).project(this.camera);
      if (_v.z > 1) continue;
      const sx = (_v.x * 0.5 + 0.5) * rect.width;
      const sy = (-_v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      this.setSelection({ type: 'passenger', id: this.peopleIds[best] });
      return;
    }

    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1), this.camera);
    for (const bv of this.buildings) {
      const hits = ray.intersectObject(bv.group, true);
      const hit = hits.find((h) => h.object !== bv.highlight);
      if (!hit) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && o !== bv.group) {
        if (o.userData.car !== undefined) {
          this.setSelection({ type: 'car', b: bv.sim.index, car: o.userData.car });
          return;
        }
        o = o.parent;
      }
      const floor = Math.min(bv.sim.levels - 1, Math.max(0, Math.floor((hit.point.y + 0.2) / bv.sim.h)));
      this.setSelection({ type: 'floor', b: bv.sim.index, floor });
      return;
    }
    this.setSelection(null);
  }

  setSelection(s: Selection, notify = true) {
    this.selection = s;
    if (notify) this.onSelect(s);
  }

  // ------------------------------------------------------------------ per-frame update

  private updateEnvironment(sim: Simulation) {
    const hour = (sim.clock % 86400) / 3600;
    const angle = (Math.PI * (hour - 6)) / 12;
    const elev = Math.sin(angle);
    const day = smooth(-0.12, 0.22, elev);
    const night = 1 - day;
    const dusk = (1 - smooth(0, 0.45, Math.abs(elev))) * smooth(-0.35, 0.05, elev);

    const sunDir = _v.set(Math.cos(angle) * 0.85, Math.max(elev, 0.12), 0.75).normalize();
    this.skyUniforms.sunDir.value.set(Math.cos(angle) * 0.85, elev, 0.75).normalize();
    const reach = Math.max(this.campus.width, this.campus.height) * 1.6 + 80;
    this.sun.position.copy(sunDir).multiplyScalar(reach);
    this.sun.target.position.set(0, this.campus.height * 0.3, 0);
    this.sun.intensity = 0.08 + 1.9 * day;
    this.sun.color.setRGB(1, 0.96 - 0.3 * dusk, 0.9 - 0.5 * dusk);
    if (night > 0.9) this.sun.color.setRGB(0.6, 0.72, 1);
    this.hemi.intensity = 0.32 + 0.6 * day;
    this.hemi.color.setRGB(0.45 + 0.3 * day, 0.55 + 0.3 * day, 0.85 + 0.15 * day);

    const top = this.skyUniforms.top.value.setRGB(0.012, 0.02, 0.05).lerp(_c.setRGB(0.16, 0.36, 0.72), day);
    const horizon = this.skyUniforms.horizon.value.setRGB(0.04, 0.06, 0.12).lerp(_c.setRGB(0.62, 0.76, 0.92), day);
    horizon.lerp(_c.setRGB(1.0, 0.52, 0.28), dusk * 0.75);
    top.lerp(_c.setRGB(0.3, 0.25, 0.5), dusk * 0.35);
    this.skyUniforms.sunColor.value.setRGB(1, 0.9 - 0.3 * dusk, 0.75 - 0.4 * dusk).multiplyScalar(day * 0.9 + dusk * 0.6);
    (this.scene.fog as THREE.Fog).color.copy(horizon);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.3) * 1.2;

    if (Math.abs(night - this.night) > 0.01) {
      this.night = night;
      this.mats.slab.emissiveIntensity = 0.1 * night;
      this.mats.front.emissiveIntensity = 0.16 * night;
      this.mats.core.emissiveIntensity = 0.1 * night;
      this.mats.strip.color.setRGB(1, 0.94, 0.82).multiplyScalar(0.95 + 0.45 * night);
      this.bloom.strength = 0.1 + 0.2 * night;
      this.renderer.toneMappingExposure = 0.92 + 0.12 * night;
    }

    const stamp = Math.floor(hour * 4);
    if (stamp !== this.windowStamp) {
      this.windowStamp = stamp;
      const lit = litFraction(hour);
      for (const bv of this.buildings) {
        for (let i = 0; i < bv.windowSeed.length; i++) {
          const seed = bv.windowSeed[i];
          if (seed < lit) {
            const warm = (seed * 7.3) % 1;
            _c.setRGB(1.0, 0.76 + 0.16 * warm, 0.42 + 0.35 * warm).multiplyScalar(0.85 + 0.5 * night);
          } else {
            _c.setRGB(0.03, 0.04, 0.06).lerp(new THREE.Color(0.3, 0.44, 0.6), day);
          }
          bv.windows.setColorAt(i, _c);
        }
        bv.windows.instanceColor!.needsUpdate = true;
      }
    }
  }

  private placePerson(i: number, id: number, x: number, y: number, z: number, scale: number, color: THREE.Color) {
    if (i >= MAX_PEOPLE) return;
    _m.compose(_p.set(x, y, z), _q.identity(), _s.set(scale, scale, scale));
    this.people.setMatrixAt(i, _m);
    this.people.setColorAt(i, color);
    this.peopleIds[i] = id;
    this.peoplePos[i * 3] = x;
    this.peoplePos[i * 3 + 1] = y;
    this.peoplePos[i * 3 + 2] = z;
  }

  private updatePeople(sim: Simulation) {
    const t = sim.time;
    const selected = this.selection?.type === 'passenger' ? this.selection.id : -1;
    let n = 0;
    let markerSet = false;
    const color = new THREE.Color();
    const jitter = (id: number) => (((id * 2654435761) >>> 0) / 4294967296 - 0.5) * 2.4;
    const mark = (id: number, x: number, y: number, z: number) => {
      if (id !== selected) return;
      this.marker.position.set(x, y + 2.05, z);
      markerSet = true;
    };

    for (const bv of this.buildings) {
      const b = bv.sim;
      const l = bv.layout;
      const h = b.h;
      const ox = bv.offsetX;
      const queueCols = Math.max(4, Math.min(9, b.cars.length * 2 + 1));
      const perCar = new Int32Array(b.cars.length);

      // waiting in the elevator lobby
      for (let f = 0; f < b.levels; f++) {
        const ws = b.waiting[f];
        if (!ws.length) continue;
        perCar.fill(0);
        let k = 0;
        for (const p of ws) {
          let x: number;
          let row: number;
          if (p.assignedCar >= 0) {
            const i = perCar[p.assignedCar]++;
            x = l.shaftX(p.assignedCar) + ((i % 3) - 1) * 0.5;
            row = Math.floor(i / 3);
          } else {
            const i = k++;
            x = l.coreCenter + ((i % queueCols) - (queueCols - 1) / 2) * 0.52;
            row = Math.floor(i / queueCols);
          }
          const z = 0.6 + (row % 4) * 0.5 + (row >= 4 ? 0.22 : 0);
          const age = t - p.tCall;
          if (p.id === selected) color.setRGB(1.6, 1.6, 1.6);
          else if (age < 45) color.setRGB(0.08, 0.62, 0.26).lerp(_c.setRGB(0.9, 0.58, 0.04), age / 45);
          else color.setRGB(0.9, 0.58, 0.04).lerp(_c.setRGB(0.88, 0.08, 0.08), Math.min(1, (age - 45) / 45));
          this.placePerson(n, p.id, ox + x, f * h, z, 1, color);
          mark(p.id, ox + x, f * h, z);
          n++;
        }
      }

      // riding
      for (const c of b.cars) {
        const cols = Math.max(2, Math.ceil(Math.sqrt(c.cfg.capacity)));
        const rows = Math.ceil(c.cfg.capacity / cols);
        const sx = Math.min(0.5, (CAR_W - 0.5) / cols);
        const sz = Math.min(0.5, (CAR_D - 0.5) / rows);
        const cx = l.shaftX(c.index);
        for (const p of c.riders) {
          const col = p.slot % cols;
          const row = Math.floor(p.slot / cols) % rows;
          let x = cx + (col - (cols - 1) / 2) * sx;
          let z = CAR_Z + (row - (rows - 1) / 2) * sz;
          const k = Math.min(1, (t - p.stateT) / 0.8);
          if (k < 1) {
            x = cx + (x - cx) * k;
            z = 0.5 + (z - 0.5) * k;
          }
          if (p.id === selected) color.setRGB(1.6, 1.6, 1.6);
          else color.set(CAR_COLORS[c.index % CAR_COLORS.length]).multiplyScalar(0.8);
          this.placePerson(n, p.id, ox + x, c.pos + 0.12, z, 0.95, color);
          mark(p.id, ox + x, c.pos + 0.12, z);
          n++;
        }
      }

      // walking between a flat (or the street) and the elevators
      for (const p of b.walkers) {
        const k = p.stateDur > 0 ? Math.min(1, Math.max(0, (t - p.stateT) / p.stateDur)) : 1;
        const coming = p.state === 'walkIn';
        const flat = coming ? p.flat : p.floor === 0 ? -1 : Math.max(0, p.destFlat);
        const hubX = coming ? l.coreCenter + jitter(p.id) * 0.5 : l.shaftX(Math.max(0, p.lastCar));
        const hubZ = coming ? 1.3 : 0.5;
        let fx: number;
        let fz: number;
        if (flat >= 0) { fx = l.flatDoorX(flat); fz = 0.35; }
        else if (flat === -1) { fx = l.coreCenter + jitter(p.id); fz = ENTRANCE_Z; }
        else { fx = hubX + jitter(p.id) * 0.3; fz = 2.0; }
        const u = coming ? 1 - k : k; // 0 at the elevators, 1 at the far end
        let x: number;
        let z: number;
        if (flat >= 0) {
          // along the corridor centre line, stepping to the door at the end
          const along = Math.min(1, u / 0.9);
          x = hubX + (fx - hubX) * along;
          z = u > 0.9 ? 1.4 + (fz - 1.4) * ((u - 0.9) / 0.1) : hubZ + (1.4 - hubZ) * Math.min(1, u / 0.1);
        } else {
          x = hubX + (fx - hubX) * u;
          z = hubZ + (fz - hubZ) * u;
        }
        const scale = flat === -2 ? 1 : Math.min(1, (1 - u) / 0.06 + 0.15);
        const y = p.floor * h + Math.abs(Math.sin(t * 7 + p.id)) * 0.05;
        if (p.id === selected) color.setRGB(1.6, 1.6, 1.6);
        else if (coming) color.setRGB(0.2, 0.4, 0.85);
        else color.setRGB(0.36, 0.38, 0.44);
        this.placePerson(n, p.id, ox + x, y, z, scale, color);
        mark(p.id, ox + x, y, z);
        n++;
      }
    }

    this.peopleCount = Math.min(n, MAX_PEOPLE);
    this.people.count = this.peopleCount;
    this.people.instanceMatrix.needsUpdate = true;
    if (this.people.instanceColor) this.people.instanceColor.needsUpdate = true;
    this.marker.visible = markerSet;
  }

  private updateBuildings(sim: Simulation) {
    for (const bv of this.buildings) {
      const b = bv.sim;
      const H = bv.layout.height;
      b.cars.forEach((c, i) => {
        const cv = bv.cars[i];
        cv.group.position.y = c.pos;
        const slide = (CAR_W / 2) * 0.96 * c.door;
        cv.doorL.position.x = -CAR_W / 4 - slide;
        cv.doorR.position.x = CAR_W / 4 + slide;
        const top = c.pos + CAR_H + 0.1;
        const len = Math.max(0.1, H + 2 - top);
        cv.cable.scale.set(0.07, len, 0.07);
        cv.cable.position.y = top + len / 2;
        cv.weight.position.y = Math.max(1.4, H - c.pos - 1.4);

        cv.labelObj.visible = this.showLabels;
        if (this.showLabels) {
          const arrow = c.state === 'moving' ? (c.vel >= 0 ? '▲' : '▼') : c.state === 'idle' ? '' : c.indicator > 0 ? '△' : c.indicator < 0 ? '▽' : '◇';
          const text = `${carName(c.index)}|${floorLabel(sim.floorOf(b, c))}|${arrow}|${c.riders.length}`;
          if (text !== cv.text) {
            cv.text = text;
            cv.label.innerHTML = `<b>${carName(c.index)}</b><span>${floorLabel(sim.floorOf(b, c))}</span><i>${arrow}</i><em>${c.riders.length}/${c.cfg.capacity}</em>`;
          }
        }
      });

      // hall call lamps
      let dirty = false;
      for (let i = 0; i < bv.lampState.length; i++) {
        const on = b.calls[i] ? 1 : 0;
        if (on === bv.lampState[i]) continue;
        bv.lampState[i] = on;
        dirty = true;
        if (!on) _c.setRGB(0.06, 0.08, 0.1);
        else if (i % 2 === 0) _c.setRGB(0.5, 2.6, 1.2);
        else _c.setRGB(2.8, 1.1, 0.4);
        bv.lamps.setColorAt(i, _c);
      }
      if (dirty) bv.lamps.instanceColor!.needsUpdate = true;

      const sel = this.selection;
      const showFloor = sel?.type === 'floor' && sel.b === b.index;
      bv.highlight.visible = showFloor;
      if (showFloor) bv.highlight.position.set(0, sel.floor * b.h + (b.h - 0.3) / 2, CORRIDOR_D / 2);
      if (sel?.type === 'car' && sel.b === b.index && b.cars[sel.car]) {
        const c = b.cars[sel.car];
        this.marker.visible = true;
        this.marker.position.set(bv.offsetX + bv.layout.shaftX(sel.car), c.pos + CAR_H + 0.55, CAR_Z + CAR_D / 2);
      }
    }
  }

  update(sim: Simulation) {
    if (this.camGoal) {
      this.camera.position.lerp(this.camGoal.pos, 0.1);
      this.controls.target.lerp(this.camGoal.target, 0.1);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.2) this.camGoal = null;
    }
    this.controls.update();
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.updateEnvironment(sim);
    this.updatePeople(sim);
    this.updateBuildings(sim);
    const s = 1 + 0.12 * Math.sin(performance.now() / 180);
    this.marker.scale.set(s, s, s);
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }
}
