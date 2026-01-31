export interface VisualizationData {
  project: { id: string; name: string };
  environments: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string; builder?: string }>;
  components: Array<{ id: string; type: string; envId: string; envName: string }>;
  connections: Array<{ provider: string; status: string }>;
  recentRuns: Array<{ envId: string; status: string; type: string; completedAt: string | null }>;
}

export function generateVisualizationHtml(data: VisualizationData): string {
  const jsonData = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.project.name} — Infraprint Visualization</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { overflow: hidden; background: #0a0a0f; font-family: 'Share Tech Mono', monospace; }
canvas { display: block; }
#scanlines {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none; z-index: 10;
  background: repeating-linear-gradient(
    0deg, rgba(0,0,0,0.03) 0px, rgba(0,0,0,0.03) 1px, transparent 1px, transparent 3px
  );
}
#tooltip {
  position: fixed; display: none; z-index: 20;
  background: rgba(0,10,20,0.9); border: 1px solid #0ff;
  padding: 10px 14px; border-radius: 4px; pointer-events: none;
  font-family: 'Share Tech Mono', monospace; font-size: 13px; color: #0ff;
  box-shadow: 0 0 15px rgba(0,255,255,0.3);
  max-width: 280px;
}
#tooltip .label { font-family: 'Orbitron', sans-serif; font-size: 11px; color: #fff; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
#tooltip .detail { color: #8af; font-size: 12px; }
#header {
  position: fixed; top: 16px; left: 20px; z-index: 20;
  font-family: 'Orbitron', sans-serif; color: #0ff;
  text-shadow: 0 0 10px #0ff, 0 0 30px rgba(0,255,255,0.4);
}
#header h1 { font-size: 20px; letter-spacing: 3px; }
#header .sub { font-family: 'Share Tech Mono', monospace; font-size: 12px; color: #8af; margin-top: 4px; }
#legend {
  position: fixed; bottom: 16px; left: 20px; z-index: 20;
  font-family: 'Share Tech Mono', monospace; font-size: 11px; color: #aaa;
  display: flex; gap: 16px;
}
#legend span { display: flex; align-items: center; gap: 5px; }
#legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
</style>
</head>
<body>
<div id="scanlines"></div>
<div id="header">
  <h1>${data.project.name}</h1>
  <div class="sub">${data.environments.length} environments · ${data.services.length} services · ${data.components.length} components</div>
</div>
<div id="tooltip"><div class="label"></div><div class="detail"></div></div>
<div id="legend">
  <span><span class="dot" style="background:#ff6eb4"></span> Production</span>
  <span><span class="dot" style="background:#0ff"></span> Staging</span>
  <span><span class="dot" style="background:#ffa500"></span> Local</span>
  <span><span class="dot" style="background:#8a8aff"></span> Other</span>
</div>

<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.162.0/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const DATA = ${jsonData};

// Color mapping
function envColor(name) {
  const n = name.toLowerCase();
  if (n.includes('prod')) return 0xff6eb4;
  if (n.includes('stag')) return 0x00ffff;
  if (n.includes('local') || n.includes('dev')) return 0xffa500;
  return 0x8a8aff;
}

// Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog = new THREE.FogExp2(0x0a0a0f, 0.018);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 18, 28);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 1.5;
document.body.appendChild(renderer.domElement);

// Post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.5, 0.4, 0.1);
composer.addPass(bloom);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 5;
controls.maxDistance = 60;
controls.target.set(0, 2, 0);

// Lights
scene.add(new THREE.AmbientLight(0x222244, 0.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// Grid floor
const gridSize = 80;
const gridDiv = 80;
const gridHelper = new THREE.GridHelper(gridSize, gridDiv, 0x00ffff, 0x00ffff);
gridHelper.material.opacity = 0.12;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// Fade grid edges with a large dark ring
const ringGeo = new THREE.RingGeometry(30, 60, 64);
const ringMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0f, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.01;
scene.add(ring);

// Clickable objects registry
const interactives = [];

// Build environments
const envCount = DATA.environments.length;
const arcRadius = Math.max(10, envCount * 5);
const envPositions = {};

DATA.environments.forEach((env, i) => {
  const angle = (i / Math.max(envCount - 1, 1)) * Math.PI * 0.6 - Math.PI * 0.3;
  const x = envCount === 1 ? 0 : Math.sin(angle) * arcRadius;
  const z = envCount === 1 ? 0 : -Math.cos(angle) * arcRadius + arcRadius * 0.5;
  envPositions[env.id] = { x, z };

  const color = envColor(env.name);

  // Platform
  const platW = Math.max(6, DATA.services.filter(s => true).length * 2.5);
  const platGeo = new THREE.BoxGeometry(platW, 0.3, 5);
  const platMat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.25, emissive: color, emissiveIntensity: 0.3 });
  const platform = new THREE.Mesh(platGeo, platMat);
  platform.position.set(x, 0.15, z);
  scene.add(platform);
  interactives.push({ mesh: platform, type: 'environment', data: env });

  // Edge glow
  const edgeGeo = new THREE.EdgesGeometry(platGeo);
  const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.position.copy(platform.position);
  scene.add(edges);

  // Label (sprite)
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.font = 'bold 28px Orbitron, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(env.name.toUpperCase(), 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(x, 0.8, z + 3);
  sprite.scale.set(4, 1, 1);
  scene.add(sprite);

  // Services as towers
  const envServices = DATA.services;
  const svcCount = envServices.length;
  envServices.forEach((svc, si) => {
    const sx = x + (si - (svcCount - 1) / 2) * 2;
    const height = 2 + Math.random() * 2;
    const geo = new THREE.BoxGeometry(1.2, height, 1.2);
    const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.7 });
    const tower = new THREE.Mesh(geo, mat);
    tower.position.set(sx, height / 2 + 0.3, z);
    scene.add(tower);
    interactives.push({ mesh: tower, type: 'service', data: { ...svc, envName: env.name } });

    // Tower edge glow
    const tEdge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }));
    tEdge.position.copy(tower.position);
    scene.add(tEdge);
  });

  // Components
  const envComps = DATA.components.filter(c => c.envId === env.id);
  envComps.forEach((comp, ci) => {
    const cx = x + (ci - (envComps.length - 1) / 2) * 1.8;
    const cz = z - 2;
    let geo;
    switch (comp.type) {
      case 'postgres': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 16); break;
      case 'redis': geo = new THREE.OctahedronGeometry(0.6); break;
      case 'mysql': geo = new THREE.CylinderGeometry(0.4, 0.6, 1, 8); break;
      case 'mongodb': geo = new THREE.DodecahedronGeometry(0.5); break;
      default: geo = new THREE.SphereGeometry(0.5, 16, 16);
    }
    const mat = new THREE.MeshPhongMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5, transparent: true, opacity: 0.7 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, 0.8, cz);
    scene.add(mesh);
    interactives.push({ mesh, type: 'component', data: comp });
  });
});

// Connection lines between environments
if (DATA.connections.length > 0 && envCount > 1) {
  const envIds = DATA.environments.map(e => e.id);
  DATA.connections.forEach((conn, ci) => {
    // Draw a line between first and last env as a symbolic connection
    const p1 = envPositions[envIds[0]];
    const p2 = envPositions[envIds[envIds.length - 1]];
    if (!p1 || !p2) return;
    const points = [new THREE.Vector3(p1.x, 0.5, p1.z), new THREE.Vector3(p2.x, 0.5, p2.z)];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineDashedMaterial({ color: 0x00ffff, dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.5 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    scene.add(line);
  });
}

// Particles
const particleCount = 200;
const particleGeo = new THREE.BufferGeometry();
const pPositions = new Float32Array(particleCount * 3);
const pVelocities = new Float32Array(particleCount);
for (let i = 0; i < particleCount; i++) {
  pPositions[i * 3] = (Math.random() - 0.5) * 50;
  pPositions[i * 3 + 1] = Math.random() * 20;
  pPositions[i * 3 + 2] = (Math.random() - 0.5) * 50;
  pVelocities[i] = 0.01 + Math.random() * 0.03;
}
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
const particleMat = new THREE.PointsMaterial({ color: 0x00ffff, size: 0.08, transparent: true, opacity: 0.6 });
const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);

// Raycasting
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
const tooltipLabel = tooltip.querySelector('.label');
const tooltipDetail = tooltip.querySelector('.detail');
let hoveredObj = null;
let focusTarget = null;
let focusProgress = 0;

window.addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  tooltip.style.left = e.clientX + 12 + 'px';
  tooltip.style.top = e.clientY + 12 + 'px';
});

window.addEventListener('click', () => {
  if (hoveredObj) {
    const pos = hoveredObj.mesh.position.clone();
    focusTarget = pos.clone().add(new THREE.Vector3(5, 5, 5));
    focusProgress = 0;
    controls.target.lerp(pos, 1);
  }
});

// Animation
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  // Particles drift upward
  const pos = particleGeo.attributes.position;
  for (let i = 0; i < particleCount; i++) {
    let y = pos.getY(i) + pVelocities[i];
    if (y > 20) { y = 0; pos.setX(i, (Math.random() - 0.5) * 50); pos.setZ(i, (Math.random() - 0.5) * 50); }
    pos.setY(i, y);
  }
  pos.needsUpdate = true;

  // Camera focus animation
  if (focusTarget) {
    focusProgress += dt * 2;
    camera.position.lerp(focusTarget, Math.min(focusProgress, 1) * 0.05);
    if (focusProgress >= 1) focusTarget = null;
  }

  // Raycasting
  raycaster.setFromCamera(mouse, camera);
  const meshes = interactives.map(o => o.mesh);
  const hits = raycaster.intersectObjects(meshes);

  // Reset previous hover
  if (hoveredObj) {
    hoveredObj.mesh.material.emissiveIntensity = hoveredObj.originalIntensity;
    hoveredObj = null;
  }

  if (hits.length > 0) {
    const hit = hits[0].object;
    const obj = interactives.find(o => o.mesh === hit);
    if (obj) {
      hoveredObj = obj;
      hoveredObj.originalIntensity = hit.material.emissiveIntensity;
      hit.material.emissiveIntensity = 1.0;

      tooltip.style.display = 'block';
      if (obj.type === 'environment') {
        tooltipLabel.textContent = 'ENVIRONMENT';
        tooltipDetail.textContent = obj.data.name;
      } else if (obj.type === 'service') {
        tooltipLabel.textContent = 'SERVICE';
        tooltipDetail.textContent = obj.data.name + ' (' + obj.data.envName + ')';
      } else if (obj.type === 'component') {
        tooltipLabel.textContent = 'COMPONENT';
        tooltipDetail.textContent = obj.data.type + ' (' + obj.data.envName + ')';
      }
    }
  } else {
    tooltip.style.display = 'none';
  }

  controls.update();
  composer.render();
}

animate();

// Resize
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
</script>
</body>
</html>`;
}
