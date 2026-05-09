/**
 * background.js — Three.js particle background.
 * Pure rendering. No state, no network I/O.
 */

export function initBackground() {
  const c = document.getElementById('bg-canvas');
  if (!c || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 1000);
  cam.position.z = 400;

  const renderer = new THREE.WebGLRenderer({ canvas: c, alpha: true, antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const n = 600;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);

  for (let i = 0; i < n * 3; i += 3) {
    pos[i] = (Math.random() - 0.5) * 1200;
    pos[i + 1] = (Math.random() - 0.5) * 800;
    pos[i + 2] = (Math.random() - 0.5) * 600;
    vel[i] = (Math.random() - 0.5) * 0.15;
    vel[i + 1] = (Math.random() - 0.5) * 0.1;
    vel[i + 2] = (Math.random() - 0.5) * 0.05;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.5, color: 0x58a6ff, transparent: true,
    opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);

  function animate() {
    requestAnimationFrame(animate);
    const p = geo.attributes.position.array;
    for (let i = 0; i < n * 3; i++) {
      p[i] += vel[i];
      if (Math.abs(p[i]) > 600) vel[i] *= -1;
    }
    geo.attributes.position.needsUpdate = true;
    pts.rotation.y += 0.0003;
    pts.rotation.x += 0.0001;
    renderer.render(scene, cam);
  }
  animate();

  addEventListener('resize', () => {
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
