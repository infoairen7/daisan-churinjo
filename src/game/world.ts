// Builds and updates the 3D facility from the pack's GLBs.
// Coordinates follow scene_spec.json: metres, Y up, north = -Z, floor centre at origin, EV at (0,0,5.3).
import { ModelTemplate, ModelInstance } from '../engine/gltf';
import { Mixer } from '../engine/anim';
import {
  Scene, Node, Mesh, Material, Geometry, Texture, Camera, PointLight, boxGeometry, planeGeometry, meshNode, mergeGeometries,
} from '../engine/scene';
import type { Renderer } from '../engine/renderer';
import { type V3, quatAxisAngle, m4, m4Compose, m4Mul, hexLinear, type M4 } from '../engine/math';
import type { FloorPuzzle, Bike } from './puzzle';
import * as C from './canvas';
import { isEn } from './i18n';

export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; occludes?: boolean; enabled?: () => boolean; tag?: string }

export const EV_Z = 5.3;
export const DOOR_HALF = 1.3; // 1F north doorway half-width
export const LANE_ORIGIN_Z = -13.1;
const BIKE_COLORS: Record<string, string> = { red: '#B65B51', blue: '#6B94B5', cream: '#D8CBAC' };
const SLOT_X = { A: -5.4, B: 4.6 };
export const slotZ = (slot: number) => -5.525 + (slot - 1) * 1.35;

export type Lighting = 'normal' | 'dark' | 'emergency' | 'night' | 'off';

export class World {
  scene = new Scene();
  t: Record<string, ModelTemplate>;
  renderer: Renderer;
  floor = 1;

  shell!: ModelInstance;
  shellMesh!: Mesh;
  shellMesh1F!: Mesh;
  ev!: ModelInstance;
  evMixer!: Mixer;
  doorState: 'closed' | 'opening' | 'open' | 'closing' = 'closed';
  evRoot!: Node;
  evAmber!: Material;
  evLampMat!: Material;
  panelDisplayTex!: Texture;
  indicatorInTex!: Texture;
  indicatorOutTex!: Texture;
  terminal!: Node;
  notice!: Node;
  noticeMat!: Material;
  noticeTexRules!: Texture;
  noticeTex1F!: Texture;
  private rulesImage!: HTMLImageElement;
  private facadeMat: Material | null = null;
  private curFloor = 1;

  private makeNoticeTextures() {
    if (isEn()) {
      this.noticeTexRules = C.texFromCanvas(C.rulesBoardEn());
      this.noticeTex1F = C.texFromCanvas(C.textBoard('Bicycle Parking No.3 — Notice', [
        { t: 'Bicycles can go to every floor by elevator' },
        { t: 'Please pay at the machine on each floor' },
        { t: 'Keep your paid receipt until you leave' },
        { t: 'A caretaker patrols at night', c: '#B9B1A5' },
        { t: '1F  Exit   /   2F–5F  Bicycle parking', c: '#E9B96E' },
      ]));
    } else {
      this.noticeTexRules = new Texture(this.rulesImage); this.noticeTexRules.clamp = true;
      this.noticeTex1F = C.texFromCanvas(C.textBoard('第３駐輪場　ご利用案内', [
        { t: '自転車は各階へエレベーターで運べます' },
        { t: '料金は各階の精算機でお支払いください' },
        { t: '精算済票は退場まで保管してください' },
        { t: '夜間は管理人が巡回しています', c: '#B9B1A5' },
        { t: '1F　出入口　／　2F〜5F　駐輪区画', c: '#E9B96E' },
      ]));
    }
  }
  /** Rebuild the signage a player has to read after a language switch. */
  applyLang() {
    this.makeNoticeTextures();
    if (this.noticeMat) this.noticeMat.map = this.curFloor === 1 ? this.noticeTex1F : this.noticeTexRules;
    if (this.facadeMat) this.facadeMat.map = C.texFromCanvas(C.facadeSign(isEn()));
  }
  racks!: Node;
  floorContent = new Node('floorContent');
  floorGeoms: Geometry[] = [];
  bike517!: ModelInstance;
  bike517Mixer!: Mixer;
  bikeMode: 'parked' | 'held' | 'docked' = 'parked';
  cubicle!: Node;
  exterior = new Node('exterior');
  outside = new Node('outside');
  city!: Node;
  street!: Node;
  floorSigns: Node[] = [];
  floorSignMats: Material[] = [];
  floorTex: Texture[] = [];
  door3F = new Node('door3F');
  door3FGap: Node | null = null;
  /** true = something stands behind the door (the light strip has a gap) */
  door3FShadow(present: boolean) { if (this.door3FGap) this.door3FGap.visible = !present; }
  glows: { node: Node; base: number; mat: Material }[] = [];
  readerGlow!: { node: Node; mat: Material };

  ceiling: PointLight[] = [];
  evLight!: PointLight;
  evOutLight!: PointLight;
  termLight!: PointLight;
  laneLights: PointLight[] = [];
  outsideFill!: PointLight;
  accentLight!: PointLight;
  lighting: Lighting = 'normal';
  lightLevel = 1;
  private flickerT = 0;
  reduceFlash = true;
  strips: { mat: Material; glow: Material; node: Node }[] = [];
  /** per-floor mood (set by the atmosphere director) */
  mood = { night: 0.8, lamps: [1, 1, 1, 1, 1, 1], flicker: [0, 0, 0, 0, 0, 0], fog: 0.04, ambient: 1, tint: [0.86, 0.92, 0.92] as V3 };
  lampNow = [1, 1, 1, 1, 1, 1];
  private dip = [0, 0, 0, 0, 0, 0];
  private readonly emergencyCol: V3 = [1, 0.55, 0.4];
  private readonly evEmergencyCol: V3 = [1, 0.6, 0.45];
  private readonly neutralCol: V3 = hexLinear('#e6edf2');
  /** 0..1 extra darkness for scripted moments (elevator stall) */
  blackout = 0;

  colliders: Collider[] = [];
  exitBarrier: () => boolean = () => false;
  colorMats: Record<string, Material> = {};

  constructor(templates: Record<string, ModelTemplate>, renderer: Renderer, images: Record<string, HTMLImageElement>) {
    this.t = templates;
    this.renderer = renderer;
    const s = this.scene;
    s.root.add(this.exterior, this.outside, this.floorContent);
    this.buildShell();
    this.buildElevator();
    this.buildFixtures(images);
    this.buildRacks();
    this.buildBike517();
    this.buildExterior();
    this.buildLights();
    for (const c of ['red', 'blue', 'cream']) {
      const m = this.t.bicycle_city_plain.materials.find((x) => x.name === 'red')!.clone('bike_' + c);
      const lin = hexLinear(BIKE_COLORS[c]);
      m.color = [lin[0], lin[1], lin[2], 1];
      this.colorMats[c] = m;
    }
  }

  // ------------------------------------------------------------------ construction
  private buildShell() {
    this.shell = this.t.floor_shell.instantiate();
    this.scene.root.add(this.shell.root);
    const shellNode = this.shell.node('floor_shell')!;
    this.shellMesh = shellNode.mesh!;
    // 1F variant: cut a doorway in the north wall (concrete + plum band), rebuild wall pieces around it.
    const prims = this.shellMesh.primitives.map((p) => {
      const name = p.material.name;
      if (name !== 'concrete' && name !== 'plum') return p;
      const g = p.geometry; const keep: number[] = [];
      for (let i = 0; i < g.indices.length; i += 3) {
        let north = true;
        for (let k = 0; k < 3; k++) { const vi = g.indices[i + k]; if (g.positions[vi * 3 + 2] > -6.85 || g.positions[vi * 3 + 1] < -0.05) north = false; }
        if (!north) keep.push(g.indices[i], g.indices[i + 1], g.indices[i + 2]);
      }
      const cut = new Geometry(g.positions, g.normals, g.uvs, new Uint32Array(keep));
      const pieces: { geometry: Geometry; matrix: M4 }[] = [{ geometry: cut, matrix: m4() }];
      const piece = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
        pieces.push({ geometry: boxGeometry(x1 - x0, y1 - y0, z1 - z0), matrix: m4Compose(m4(), [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [0, 0, 0, 1], [1, 1, 1]) });
      };
      if (name === 'concrete') {
        piece(-9, -DOOR_HALF, 0, 2.8, -7.09, -6.91);
        piece(DOOR_HALF, 9, 0, 2.8, -7.09, -6.91);
        piece(-DOOR_HALF, DOOR_HALF, 2.3, 2.8, -7.09, -6.91);
      } else {
        piece(-9, -DOOR_HALF, 0, 1.05, -6.91, -6.88);
        piece(DOOR_HALF, 9, 0, 1.05, -6.91, -6.88);
      }
      return { geometry: mergeGeometries(pieces), material: p.material };
    });
    this.shellMesh1F = new Mesh(prims);
    // Slightly brighten the dark concrete pads so the floor reads at night.
    for (const p of this.shellMesh.primitives) if (p.material.name === 'lamp' || p.material.name === 'neutral_lamp') p.material.emissiveIntensity = 2.2;
  }

  private buildElevator() {
    const amberSrc = this.t.elevator_animated.materials.find((m) => m.name === 'amber')!;
    this.evAmber = amberSrc.clone('ev_amber');
    const lampSrc = this.t.elevator_animated.materials.find((m) => m.name === 'neutral_lamp')!;
    this.evLampMat = lampSrc.clone('ev_lamp');
    this.ev = this.t.elevator_animated.instantiate((m) => (m === amberSrc ? this.evAmber : m === lampSrc ? this.evLampMat : m));
    this.evRoot = this.ev.root;
    this.evRoot.position = [0, 0, EV_Z];
    this.scene.root.add(this.evRoot);
    this.evMixer = new Mixer(this.ev);
    // panel display: replace the static "5" digit with a canvas screen
    const panel = this.ev.node('control_panel')!;
    panel.mesh = new Mesh(panel.mesh!.primitives.filter((p) => p.material !== this.evAmber));
    this.panelDisplayTex = C.texFromCanvas(C.floorIndicator('1'));
    const screenMat = new Material('panel_screen'); screenMat.unlit = true; screenMat.map = this.panelDisplayTex; screenMat.toneMapped = false;
    const screen = meshNode('panel_screen', planeGeometry(0.33, 0.155), screenMat);
    screen.position = [0, 1.57, -0.052]; screen.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    panel.add(screen);
    // floor indicators above the doorway (inside facing +Z, outside facing -Z)
    this.indicatorInTex = C.texFromCanvas(C.floorIndicator('1'));
    this.indicatorOutTex = C.texFromCanvas(C.floorIndicator('1'));
    const mk = (tex: Texture, z: number, rotY: number) => {
      const m = new Material('indicator'); m.unlit = true; m.map = tex; m.toneMapped = false;
      const n = meshNode('indicator', planeGeometry(0.36, 0.18), m);
      n.position = [0, 2.38, z]; n.quaternion = quatAxisAngle([0, 1, 0], rotY);
      this.evRoot.add(n);
    };
    mk(this.indicatorInTex, -1.40, 0);
    mk(this.indicatorOutTex, -1.61, Math.PI);
    // reader attention glow (hint after 60s)
    const gm = new Material('reader_glow'); gm.unlit = true; gm.additive = true; gm.fog = false; gm.map = C.texFromCanvas(C.glowSprite('233,185,110'));
    gm.color = [1, 1, 1, 0];
    const gn = meshNode('reader_glow', planeGeometry(0.7, 0.7), gm);
    gn.position = [-0.18, 1.1, 1.40];
    gn.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    this.evRoot.add(gn);
    this.readerGlow = { node: gn, mat: gm };
  }

  private buildFixtures(images: Record<string, HTMLImageElement>) {
    // payment terminal (display faces -Z)
    this.terminal = this.t.payment_terminal.instantiate().root;
    this.terminal.position = [-4.6, 0, 5.1];
    this.scene.root.add(this.terminal);
    // noticeboard: freestanding board facing -Z at NOTICEBOARD (4.5, 1.4, 5.2)
    this.rulesImage = images.operating_rules;
    this.makeNoticeTextures();
    const board = new Node('noticeboard');
    board.position = [4.5, 0, 5.2];
    const steel = this.t.floor_shell.materials.find((m) => m.name === 'steel_dark')!;
    const frame = meshNode('frame', boxGeometry(1.32, 1.02, 0.06), steel); frame.position = [0, 1.4, 0.02];
    this.noticeMat = new Material('notice'); this.noticeMat.map = this.noticeTexRules; this.noticeMat.roughness = 0.8;
    const face = meshNode('face', planeGeometry(1.2, 0.926), this.noticeMat); face.position = [0, 1.4, -0.015]; face.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    const legL = meshNode('leg', boxGeometry(0.05, 0.9, 0.05), steel); legL.position = [-0.55, 0.45, 0.02];
    const legR = meshNode('leg', boxGeometry(0.05, 0.9, 0.05), steel); legR.position = [0.55, 0.45, 0.02];
    board.add(frame, face, legL, legR);
    this.notice = board;
    this.scene.root.add(board);
    // floor signs (pack signage PNGs) on the south wall either side of the EV and on the north wall
    for (let f = 1; f <= 5; f++) { const t = new Texture(images['floor_' + f]); t.clamp = true; this.floorTex.push(t); }
    const signSpots: [V3, number][] = [[[-2.6, 2.05, 6.84], Math.PI], [[2.6, 2.05, 6.84], Math.PI], [[-5.2, 2.05, -6.86], 0], [[5.2, 2.05, -6.86], 0]];
    for (const [p, ry] of signSpots) {
      const m = new Material('floor_sign'); m.map = this.floorTex[0]; m.transparent = true; m.roughness = 0.9;
      const n = meshNode('floor_sign', planeGeometry(1.0, 0.6), m);
      n.position = p; n.quaternion = quatAxisAngle([0, 1, 0], ry);
      this.floorSigns.push(n); this.floorSignMats.push(m);
      this.scene.root.add(n);
    }
    // 517 private cubicle: low partitions on the south-west corner
    const plum = this.t.floor_shell.materials.find((m) => m.name === 'plum')!;
    this.cubicle = new Node('cubicle517');
    const wallB = meshNode('p', boxGeometry(3.0, 1.2, 0.06), plum); wallB.position = [-7.5, 0.6, 4.6];
    const plateMat = new Material('plate517'); plateMat.map = C.texFromCanvas(C.idPlate('517'));
    const plate = meshNode('plate', planeGeometry(0.4, 0.2), plateMat); plate.position = [-6.6, 1.0, 4.565]; plate.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    const plateBack = meshNode('plate', planeGeometry(0.4, 0.2), plateMat); plateBack.position = [-6.6, 1.0, 4.635];
    this.cubicle.add(wallB, plate, plateBack);
    this.scene.root.add(this.cubicle);
    // 3F only: a locked steel door on the north wall with a light strip underneath and a still shadow
    const dMat = steel;
    const door = meshNode('door', boxGeometry(1.0, 2.1, 0.06), dMat); door.position = [6.6, 1.05, -6.86];
    const lightMat = new Material('door_gap'); lightMat.unlit = true; lightMat.color = [1.2, 0.95, 0.7, 1]; lightMat.toneMapped = false;
    const gapL = meshNode('gap', boxGeometry(0.34, 0.02, 0.02), lightMat); gapL.position = [6.27, 0.012, -6.83];
    const gapR = meshNode('gap', boxGeometry(0.26, 0.02, 0.02), lightMat); gapR.position = [6.97, 0.012, -6.83];
    const handle = meshNode('handle', boxGeometry(0.03, 0.12, 0.05), this.t.floor_shell.materials.find((m) => m.name === 'steel')!); handle.position = [6.2, 1.0, -6.81];
    const gapM = meshNode('gap', boxGeometry(0.42, 0.02, 0.02), lightMat); gapM.position = [6.64, 0.012, -6.83];
    gapM.visible = false;
    this.door3FGap = gapM;
    this.door3F.add(door, gapL, gapR, gapM, handle);
    this.door3F.visible = false;
    this.scene.root.add(this.door3F);
  }

  private buildRacks() {
    const items = new Map<Material, { geometry: Geometry; matrix: M4 }[]>();
    const inst = this.t.bicycle_rack.instantiate();
    for (const row of ['A', 'B'] as const) {
      for (let s = 1; s <= 6; s++) {
        const root = m4Compose(m4(), [SLOT_X[row], 0, slotZ(s)], [0, 0, 0, 1], [1, 1, 1]);
        inst.root.updateWorld(root);
        inst.root.traverse((n) => {
          if (!n.mesh) return;
          for (const p of n.mesh.primitives) {
            if (!items.has(p.material)) items.set(p.material, []);
            items.get(p.material)!.push({ geometry: p.geometry, matrix: new Float32Array(n.world) });
          }
        });
      }
    }
    this.racks = new Node('racks');
    for (const [mat, list] of items) this.racks.add(meshNode('racks', mergeGeometries(list), mat));
    // slot ID plates at the aisle end of each slot
    const steel = this.t.floor_shell.materials.find((m) => m.name === 'steel_dark')!;
    const postGeo = boxGeometry(0.04, 0.62, 0.04);
    const posts: { geometry: Geometry; matrix: M4 }[] = [];
    for (const row of ['A', 'B'] as const) {
      for (let s = 1; s <= 6; s++) {
        const x = row === 'A' ? SLOT_X.A + 1.12 : SLOT_X.B - 1.12;
        const z = slotZ(s);
        posts.push({ geometry: postGeo, matrix: m4Compose(m4(), [x, 0.31, z], [0, 0, 0, 1], [1, 1, 1]) });
        const pm = new Material('id_plate'); pm.map = C.texFromCanvas(C.idPlate(`${row}0${s}`)); pm.roughness = 0.7;
        pm.emissive = [0.07, 0.07, 0.065];
        const plate = meshNode('plate', planeGeometry(0.3, 0.15), pm);
        plate.position = [x, 0.7, z];
        plate.quaternion = quatAxisAngle([0, 1, 0], row === 'A' ? Math.PI / 2 : -Math.PI / 2);
        const back = meshNode('plate', planeGeometry(0.3, 0.15), pm);
        back.position = [x, 0.7, z];
        back.quaternion = quatAxisAngle([0, 1, 0], row === 'A' ? -Math.PI / 2 : Math.PI / 2);
        this.racks.add(plate, back);
      }
    }
    this.racks.add(meshNode('posts', mergeGeometries(posts), steel));
    this.scene.root.add(this.racks);
  }

  private buildBike517() {
    const cream = this.t.bicycle_city_basket.materials.find((m) => m.name === 'red')!.clone('bike_517');
    const lin = hexLinear(BIKE_COLORS.cream); cream.color = [lin[0], lin[1], lin[2], 1];
    const src = this.t.bicycle_city_basket.materials.find((m) => m.name === 'red')!;
    this.bike517 = this.t.bicycle_city_basket.instantiate((m) => (m === src ? cream : m));
    this.bike517.root.extras = { id: '517', countable: false };
    this.bike517Mixer = new Mixer(this.bike517);
    this.scene.root.add(this.bike517.root);
    this.placeBikeParked();
  }

  private buildExterior() {
    // night city panorama on an inward-facing cylinder
    const tex = C.texFromCanvas(C.cityPanorama(11), { clamp: false });
    const seg = 48, R = 46, H = 42;
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.sin(a) * R, z = Math.cos(a) * R;
      P.push(x, 0, z, x, H, z); N.push(-x / R, 0, -z / R, -x / R, 0, -z / R); U.push(i / seg * 2, 1, i / seg * 2, 0);
      if (i < seg) { const b = i * 2; I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    }
    const cm = new Material('city'); cm.unlit = true; cm.fog = false; cm.map = tex; cm.doubleSided = true; cm.renderOrder = -10;
    this.city = meshNode('city', new Geometry(new Float32Array(P), new Float32Array(N), new Float32Array(U), new Uint32Array(I)), cm);
    const top = meshNode('sky', boxGeometry(120, 0.1, 120), Object.assign(new Material('sky'), { unlit: true, fog: false, color: [0.004, 0.005, 0.009, 1], renderOrder: -10 }));
    top.position = [0, 40, 0];
    this.street = meshNode('street', boxGeometry(100, 0.1, 100), Object.assign(new Material('street'), { color: [0.018, 0.018, 0.02, 1], roughness: 0.6, metallic: 0 }));
    this.exterior.add(this.city, top, this.street);

    // outdoor lane (rotated so it leads north from the 1F doorway) + building facade + sign
    const lane = this.t.outdoor_exit.instantiate();
    lane.root.position = [0, 0, LANE_ORIGIN_Z];
    lane.root.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    for (const n of lane.nodes) for (const p of n.mesh?.primitives || []) if (p.material.name === 'lamp') p.material.emissiveIntensity = 2.5;
    this.outside.add(lane.root);
    const concreteDark = this.t.floor_shell.materials.find((m) => m.name === 'concrete_dark')!;
    const facade = meshNode('facade', boxGeometry(18.4, 12.2, 14.2), concreteDark);
    facade.position = [0, 2.98 + 6.1, 0];
    this.outside.add(facade);
    // perforated band lines on the facade (one per floor)
    const steel = this.t.floor_shell.materials.find((m) => m.name === 'steel_dark')!;
    for (let f = 1; f <= 4; f++) {
      const band = meshNode('band', boxGeometry(18.5, 0.25, 0.1), steel);
      band.position = [0, 2.9 + f * 3, -7.15];
      this.outside.add(band);
    }
    const signMat = new Material('facade_sign'); signMat.unlit = true; signMat.toneMapped = false; signMat.map = C.texFromCanvas(C.facadeSign(isEn())); this.facadeMat = signMat;
    signMat.color = [0.85, 0.85, 0.85, 1];
    const sign = meshNode('sign', planeGeometry(4.0, 1.0), signMat);
    sign.position = [0, 3.7, -7.2]; sign.quaternion = quatAxisAngle([0, 1, 0], Math.PI);
    this.outside.add(sign);
    const canopy = meshNode('canopy', boxGeometry(3.4, 0.12, 1.2), steel);
    canopy.position = [0, 2.75, -7.65];
    this.outside.add(canopy);
  }

  private buildLights() {
    const neutral = hexLinear('#e6edf2'), amber = hexLinear('#E9B96E');
    for (const x of [-5.4, 4.6]) for (const z of [-5.5, -1.0, 3.5]) {
      const L: PointLight = { position: [x, 2.45, z], color: neutral, intensity: 4.2, range: 7.5, enabled: true };
      this.ceiling.push(L); this.scene.points.push(L);
    }
    this.evLight = { position: [0, 2.35, EV_Z], color: neutral, intensity: 2.6, range: 4.5, enabled: true };
    this.evOutLight = { position: [0, 2.3, 3.2], color: amber, intensity: 1.4, range: 4.5, enabled: true };
    this.termLight = { position: [-4.6, 1.3, 4.6], color: amber, intensity: 0.6, range: 2.5, enabled: true };
    this.accentLight = { position: [6.6, 0.3, -6.4], color: [1, 0.8, 0.6], intensity: 0, range: 2.2, enabled: true };
    this.outsideFill = { position: [0, 3.2, -8.2], color: amber, intensity: 1.6, range: 7, enabled: true };
    this.laneLights = [
      { position: [0, 2.6, -9.6], color: amber, intensity: 2.2, range: 7, enabled: true },
      { position: [0, 2.6, -14.4], color: amber, intensity: 2.2, range: 7, enabled: true },
    ];
    this.scene.points.push(this.evLight, this.evOutLight, this.termLight, this.accentLight, this.outsideFill, ...this.laneLights);
    // ceiling strips get their own emissive material + halo so a single lamp can fail
    const glowTex = C.texFromCanvas(C.glowSprite('220,228,235'));
    const lampSrc = this.t.floor_shell.materials.find((m) => m.name === 'neutral_lamp')!;
    for (const L of this.ceiling) {
      const sm = lampSrc.clone('strip'); sm.emissiveIntensity = 2.2;
      const strip = meshNode('strip', boxGeometry(1.05, 0.04, 0.12), sm);
      strip.position = [L.position[0] - 0.005, 2.58, L.position[2]];
      this.scene.root.add(strip);
      const gm = new Material('glow'); gm.unlit = true; gm.additive = true; gm.fog = true; gm.map = glowTex;
      gm.color = [0.35, 0.35, 0.35, 1];
      const n = meshNode('glow', planeGeometry(1.8, 1.0), gm);
      n.position = [L.position[0], 2.5, L.position[2]];
      this.scene.root.add(n);
      this.strips.push({ mat: sm, glow: gm, node: n });
      this.glows.push({ node: n, base: 0, mat: gm });
    }
    // hide the shared strip primitive of the GLB (replaced above)
    for (const mesh of [this.shellMesh, this.shellMesh1F]) mesh.primitives = mesh.primitives.filter((p) => p.material.name !== 'neutral_lamp');
    const am = new Material('glow_amber'); am.unlit = true; am.additive = true; am.fog = true; am.map = C.texFromCanvas(C.glowSprite('233,170,90'));
    am.color = [0.4, 0.4, 0.4, 1];
    for (const x of [-3.05, 3.05]) for (const z of [-4.76, -0.36, 3.64]) {
      const n = meshNode('glow', planeGeometry(0.7, 0.9), am);
      n.position = [x + (x < 0 ? 0.0 : 0.0), 1.93, z];
      this.glows.push({ node: n, base: 0.4, mat: am });
      this.scene.root.add(n);
    }
    this.scene.sky = hexLinear('#2a2c35').map((v) => v * 0.55) as V3;
    this.scene.ground = hexLinear('#1d1a1c').map((v) => v * 0.4) as V3;
  }

  // ------------------------------------------------------------------ floor content
  setFloor(floor: number, puzzle: FloorPuzzle | null) {
    this.floor = floor;
    for (const g of this.floorGeoms) this.renderer.disposeGeometry(g);
    this.floorGeoms = [];
    this.floorContent.clear();
    this.shell.node('floor_shell')!.mesh = floor === 1 ? this.shellMesh1F : this.shellMesh;
    this.outside.visible = floor === 1;
    this.exterior.position = [0, -(floor - 1) * 3.0, 0];
    this.city.position = [0, -2, 0];
    this.street.position = [0, -0.06 - (floor === 1 ? 0 : 0.0), 0];
    this.street.visible = true;
    for (const m of this.floorSignMats) m.map = this.floorTex[floor - 1];
    this.door3F.visible = floor === 3;
    this.door3FShadow(true);
    this.accentLight.intensity = floor === 3 ? 0.9 : 0;
    this.cubicle.visible = floor === 5;
    this.curFloor = floor;
    this.noticeMat.map = floor === 1 ? this.noticeTex1F : this.noticeTexRules;
    this.terminal.visible = floor !== 1;
    this.racks.visible = true;
    if (this.bikeMode === 'parked') this.bike517.root.visible = floor === 5;
    if (puzzle) this.buildBikes(puzzle.bikes);
    this.setIndicator(String(floor));
    this.rebuildColliders();
  }

  private buildBikes(bikes: Bike[]) {
    const groups = new Map<Material, { geometry: Geometry; matrix: M4 }[]>();
    const tags = new Map<string, { geometry: Geometry; matrix: M4 }[]>();
    const tagGeo = boxGeometry(0.11, 0.11, 0.11, 1 / 0.11);
    for (const b of bikes) {
      const key = b.type === 'sport' ? 'bicycle_sport_plain' : `bicycle_${b.type}_${b.basket ? 'basket' : 'plain'}`;
      const tpl = this.t[key];
      const inst = tpl.instantiate();
      const x = SLOT_X[b.row], z = slotZ(b.slot);
      inst.root.updateWorld(m4Compose(m4(), [x, 0, z], [0, 0, 0, 1], [1, 1, 1]));
      inst.root.traverse((n) => {
        if (!n.mesh) return;
        for (const p of n.mesh.primitives) {
          const mat = p.material.name === 'red' ? this.colorMats[b.color] : p.material;
          if (!groups.has(mat)) groups.set(mat, []);
          groups.get(mat)!.push({ geometry: p.geometry, matrix: new Float32Array(n.world) });
        }
      });
      // colour/shape tag hanging at the aisle end of the bike
      const tx = b.row === 'A' ? x + 0.62 : x - 0.78;
      const ty = b.row === 'A' ? 0.82 : 0.72;
      if (!tags.has(b.color)) tags.set(b.color, []);
      tags.get(b.color)!.push({ geometry: tagGeo, matrix: m4Compose(m4(), [tx, ty, z + 0.0], quatAxisAngle([0, 1, 0], b.row === 'A' ? Math.PI / 2 : -Math.PI / 2), [1, 1, 1]) });
    }
    for (const [mat, list] of groups) {
      const g = mergeGeometries(list); this.floorGeoms.push(g);
      this.floorContent.add(meshNode('bikes', g, mat));
    }
    for (const [color, list] of tags) {
      const m = new Material('tag_' + color); m.map = C.texFromCanvas(C.colorTag(color as any)); m.roughness = 0.7;
      const tl = hexLinear(BIKE_COLORS[color]); m.emissive = [tl[0] * 0.22, tl[1] * 0.22, tl[2] * 0.22];
      const g = mergeGeometries(list); this.floorGeoms.push(g);
      this.floorContent.add(meshNode('tags', g, m));
    }
  }

  // ------------------------------------------------------------------ colliders
  rebuildColliders() {
    const cs: Collider[] = [];
    const box = (cx: number, cz: number, sx: number, sz: number, extra: Partial<Collider> = {}) =>
      cs.push({ minX: cx - sx / 2, maxX: cx + sx / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2, ...extra });
    // outer walls
    box(-9.05, 0, 0.3, 14.4, { occludes: true });
    box(9.05, 0, 0.3, 14.4, { occludes: true });
    if (this.floor === 1) {
      box(-(9 + DOOR_HALF) / 2, -7.0, 9 - DOOR_HALF, 0.3, { occludes: true });
      box((9 + DOOR_HALF) / 2, -7.0, 9 - DOOR_HALF, 0.3, { occludes: true });
      box(0, -7.0, DOOR_HALF * 2, 0.3, { enabled: () => this.exitBarrier(), tag: 'exitBarrier' });
      // outdoor lane: low walls at x=±2 and the far end
      box(-2.1, -13.2, 0.25, 12.4, { occludes: false });
      box(2.1, -13.2, 0.25, 12.4, { occludes: false });
      box(0, -19.25, 5, 0.3);
    } else {
      box(0, -7.0, 18.2, 0.3, { occludes: true });
    }
    box(-5.0, 6.98, 8.0, 0.3, { occludes: true });
    box(5.0, 6.98, 8.0, 0.3, { occludes: true });
    // pillars
    for (const x of [-3.05, 3.05]) for (const z of [-4.4, 0, 4.0]) box(x, z, 0.46, 0.46, { occludes: true });
    // elevator car walls (front segments + sides + back), doors while not fully open
    box(-1.66, EV_Z, 0.1, 3.1, { occludes: true });
    box(1.66, EV_Z, 0.1, 3.1, { occludes: true });
    box(0, EV_Z + 1.55, 3.3, 0.1, { occludes: true });
    box(-1.28, EV_Z - 1.5, 0.76, 0.18, { occludes: true });
    box(1.28, EV_Z - 1.5, 0.76, 0.18, { occludes: true });
    box(0, EV_Z - 1.5, 1.8, 0.12, { occludes: true, enabled: () => this.doorState !== 'open', tag: 'doors' });
    // racks (always) / bikes are added by the game for the current puzzle (same footprint, slightly wider)
    for (const row of ['A', 'B'] as const) for (let s = 1; s <= 6; s++) box(SLOT_X[row], slotZ(s), 1.95, 0.5);
    if (this.floor !== 1) box(-4.6, 5.1, 0.6, 0.45); // payment terminal
    box(4.5, 5.22, 1.36, 0.12); // noticeboard
    if (this.floor === 5) {
      box(-7.5, 4.6, 3.05, 0.1, { occludes: true });
    }
    // parked 517
    cs.push({ minX: -8.35, maxX: -6.45, minZ: 5.2, maxZ: 5.8, enabled: () => this.bikeMode === 'parked' && this.floor === 5 });
    // docked bike inside the car
    cs.push({ minX: 0.5, maxX: 1.1, minZ: EV_Z + 0.05 - 0.95, maxZ: EV_Z + 0.05 + 0.95, enabled: () => this.bikeMode === 'docked' });
    this.colliders = cs;
  }

  addBikeColliders(bikes: Bike[]) {
    for (const b of bikes) {
      const x = SLOT_X[b.row], z = slotZ(b.slot);
      this.colliders.push({ minX: x - 0.95, maxX: x + 0.95, minZ: z - 0.32, maxZ: z + 0.32 });
    }
  }

  // ------------------------------------------------------------------ elevator
  private playDoor(clip: 'door_open' | 'door_close'): Promise<void> {
    return new Promise((resolve) => {
      this.evMixer.stop('door_open'); this.evMixer.stop('door_close');
      this.evMixer.play(clip, { clamp: true, onFinish: () => resolve() });
    });
  }
  async openDoors() {
    if (this.doorState === 'open') return;
    this.doorState = 'opening';
    await this.playDoor('door_open');
    this.doorState = 'open';
  }
  async closeDoors() {
    if (this.doorState === 'closed') return;
    this.doorState = 'closing';
    await this.playDoor('door_close');
    this.doorState = 'closed';
  }
  setDoorsInstant(open: boolean) {
    this.evMixer.stop('door_open'); this.evMixer.stop('door_close');
    const clip = open ? 'door_open' : 'door_close';
    this.evMixer.pose(clip, this.evMixer.duration(clip));
    this.doorState = open ? 'open' : 'closed';
  }
  pressButtonAnim(d: number) { if (d >= 1 && d <= 5) this.evMixer.play('button_press_' + d); }

  setIndicator(text: string, arrow = '') {
    for (const tex of [this.indicatorInTex, this.indicatorOutTex]) {
      const src = C.floorIndicator(text, arrow);
      (tex.source as HTMLCanvasElement).getContext('2d')!.drawImage(src, 0, 0);
      tex.update();
    }
  }
  setPanelDisplay(text: string, sub = '', color = '#E9B96E') {
    const src = C.floorIndicator(text, sub, color);
    (this.panelDisplayTex.source as HTMLCanvasElement).getContext('2d')!.drawImage(src, 0, 0);
    this.panelDisplayTex.update();
  }
  setPanelPower(mode: 'off' | 'normal' | 'auth') {
    const a = hexLinear('#E9B96E');
    if (mode === 'off') { this.evAmber.emissive = [0, 0, 0]; this.evAmber.color = [0.12, 0.08, 0.03, 1]; this.setPanelDisplay('', '', '#000'); }
    else { this.evAmber.emissive = a.map((v) => v * (mode === 'auth' ? 0.9 : 0.55)) as V3; this.evAmber.color = [a[0], a[1], a[2], 1]; }
  }
  isInsideCar(p: V3 | number[]) { return Math.abs(p[0]) < 1.55 && p[2] > EV_Z - 1.42 && p[2] < EV_Z + 1.45; }

  // ------------------------------------------------------------------ bike 517
  placeBikeParked() {
    this.bikeMode = 'parked';
    this.bike517.root.position = [-7.4, 0, 5.5];
    this.bike517.root.quaternion = [0, 0, 0, 1];
    this.bike517.root.visible = this.floor === 5;
  }
  placeBikeDocked() {
    this.bikeMode = 'docked';
    this.bike517.root.position = [0.8, 0, EV_Z + 0.05];
    this.bike517.root.quaternion = quatAxisAngle([0, 1, 0], Math.PI / 2);
    this.bike517.root.visible = true;
  }
  /** Bike pushed on the player's right, handlebars ahead. */
  placeBikeHeld(pos: V3, yaw: number) {
    this.bikeMode = 'held';
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.bike517.root.position = [pos[0] + fx * 0.45 + rx * 0.42, 0, pos[2] + fz * 0.45 + rz * 0.42];
    this.bike517.root.quaternion = quatAxisAngle([0, 1, 0], yaw + Math.PI / 2);
    this.bike517.root.visible = true;
  }
  rollWheels(distance: number) {
    // wheel radius 0.338 m; rotate about local Z (front = +X so forward roll is negative)
    for (const name of ['bicycle_wheel_front', 'bicycle_wheel_rear']) {
      const w = this.bike517.node(name)!;
      const ang = -distance / 0.338;
      const q = quatAxisAngle([0, 0, 1], ang);
      const cur = w.quaternion;
      // compose
      w.quaternion = [
        cur[3] * q[0] + cur[0] * q[3] + cur[1] * q[2] - cur[2] * q[1],
        cur[3] * q[1] - cur[0] * q[2] + cur[1] * q[3] + cur[2] * q[0],
        cur[3] * q[2] + cur[0] * q[1] - cur[1] * q[0] + cur[2] * q[3],
        cur[3] * q[3] - cur[0] * q[0] - cur[1] * q[1] - cur[2] * q[2],
      ];
    }
  }

  // ------------------------------------------------------------------ lighting
  setLighting(mode: Lighting) {
    this.lighting = mode;
  }

  update(dt: number, time: number, camera: Camera) {
    this.evMixer.update(dt);
    this.bike517Mixer.update(dt);
    // light levels
    const night = this.mood.night;
    const target = { normal: 1, night, emergency: 0.16, dark: 0.05, off: 0 }[this.lighting] * (1 - this.blackout);
    const k = this.lighting === 'off' || this.lighting === 'dark' ? 1 : Math.min(1, dt * 3);
    this.lightLevel += (target - this.lightLevel) * k;
    this.flickerT += dt;
    const t = this.flickerT;
    const emergency = this.lighting === 'emergency';
    const powered = this.lighting === 'night' || this.lighting === 'normal';
    const col = emergency ? this.emergencyCol : this.lighting === 'night' ? this.mood.tint : this.neutralCol;
    for (let i = 0; i < 6; i++) {
      let f = 1;
      const mode = powered ? this.mood.flicker[i] : 0;
      if (mode === 1) {
        // tired tube: slow breathing; without flash reduction it also stutters now and then
        f = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 1.7 + i * 1.3));
        if (!this.reduceFlash && Math.sin(t * 23 + i * 7) > 0.985) f *= 0.35;
      } else if (mode === 2) {
        // dying tube: long dim stretches, slow swells
        const n = 0.5 + 0.5 * Math.sin(t * 0.9 + i) * Math.sin(t * 0.37 + i * 2.1);
        f = 0.12 + 0.55 * n * n;
        if (!this.reduceFlash && Math.sin(t * 31 + i * 5) > 0.97) f = 0.02;
      }
      if (this.dip[i] > 0) { this.dip[i] = Math.max(0, this.dip[i] - dt); f *= 0.05; }
      const goal = (powered ? this.mood.lamps[i] : 1) * f;
      this.lampNow[i] += (goal - this.lampNow[i]) * Math.min(1, dt * (this.reduceFlash ? 4 : 18));
      const L = this.ceiling[i];
      L.intensity = 4.2 * this.lightLevel * this.lampNow[i];
      L.color = col;
      const st = this.strips[i];
      if (st) {
        const e = Math.max(0.03, this.lightLevel * this.lampNow[i]);
        st.mat.emissiveIntensity = 2.2 * e;
        const gl = 0.35 * e; st.glow.color = [gl, gl, gl, 1];
      }
    }
    this.evLight.intensity = (this.lighting === 'off' ? 0 : emergency ? 1.3 : this.lighting === 'dark' ? 0.2 : 2.6) * (1 - this.blackout * 0.9);
    this.evLight.color = emergency ? this.evEmergencyCol : this.neutralCol;
    this.evLampMat.emissiveIntensity = (this.lighting === 'off' ? 0 : emergency ? 0.35 : 1) * (1 - this.blackout * 0.9);
    this.evOutLight.intensity = 1.4 * Math.max(this.lightLevel, emergency ? 0.6 : 0);
    this.termLight.intensity = 0.6 * Math.max(this.lightLevel, 0.4);
    const lampScale = Math.max(0.05, this.lightLevel);
    for (const p of this.shellMesh.primitives) {
      if (p.material.name === 'lamp') p.material.emissiveIntensity = 2.2 * Math.max(lampScale, emergency ? 0.5 : 0);
    }
    for (const g of this.glows) if (g.base > 0) g.mat.color = [g.base * lampScale, g.base * lampScale, g.base * lampScale, 1];
    // billboards face the camera
    for (const g of this.glows) g.node.quaternion = camera.quaternion;
    this.scene.ambient = (0.55 + 0.5 * this.lightLevel) * this.mood.ambient;
    this.scene.fogDensity = this.lighting === 'night' ? this.mood.fog : 0.04;
    this.scene.exposure = 1.15;
  }

  /** a single lamp drops out for a moment (scripted beats) */
  dipLamp(i: number, seconds: number) { if (i >= 0 && i < 6) this.dip[i] = Math.max(this.dip[i], seconds); }

  setReaderHint(v: number) { this.readerGlow.mat.color = [v, v, v, v]; }
}
