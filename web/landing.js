// Hero scene: a sealed quote (glossy blob) behind glass (a transmissive cube), and a
// rival's quote in its own smaller cube. The SVG fallback stays unless a frame renders.
const visual = document.querySelector('.visual');
const canvas = document.getElementById('gl');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reduced && canvas) start().catch((e) => console.warn('3D hero off:', e.message));

async function start() {
  const THREE = await import('three');
  const { RoundedBoxGeometry } = await import('three/addons/geometries/RoundedBoxGeometry.js');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 14);

  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 6, 8); scene.add(key);
  const rim = new THREE.PointLight(0xa070ff, 30, 20); rim.position.set(-4, -2, 3); scene.add(rim);

  // A sphere pushed out along a dozen directions: rounded lobes, like the reference's object.
  function blob(detail, lobes, amp) {
    let g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
    const dirs = new THREE.DodecahedronGeometry(1, 0).attributes.position;
    const L = [];
    for (let i = 0; i < dirs.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(dirs, i).normalize();
      if (!L.some((u) => u.distanceTo(v) < 0.1)) L.push(v);
    }
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      let d = 0;
      for (const u of L) d += Math.pow(Math.max(0, v.dot(u)), 18);
      d = amp * Math.min(d, 1.2) + 0.03 * Math.sin(v.x * 9) * Math.sin(v.y * 9) * Math.sin(v.z * 9);
      v.multiplyScalar(0.72 + d); p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  }

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xf6f2ff, metalness: 0, roughness: 0.06, transmission: 1, thickness: 0.9, ior: 1.42,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4, iridescence: 0.35, iridescenceIOR: 1.3,
    attenuationColor: new THREE.Color(0xe7dcff), attenuationDistance: 6, transparent: true,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });

  function sealed(color, sheen, label) {
    const group = new THREE.Group();
    const box = new THREE.Mesh(new RoundedBoxGeometry(2.4, 2.4, 2.4, 6, 0.1), glass);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.36, 2.36, 2.36)), edgeMat);
    const core = new THREE.Mesh(blob(48, true, 0.5), new THREE.MeshPhysicalMaterial({
      color, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18, sheen: 1, sheenColor: new THREE.Color(sheen), sheenRoughness: 0.4,
    }));
    core.scale.setScalar(1.12);
    group.add(core, box, edges);
    if (label) group.add(face(label));
    scene.add(group);
    return { group, core };
  }

  // Text etched on the inside of the front face, like a spec sheet behind glass.
  function face([a, b]) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 512;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,.85)';
    x.font = '500 46px Geist, system-ui, sans-serif'; x.fillText(a, 40, 90);
    x.font = '400 26px "Geist Mono", ui-monospace, monospace'; x.fillStyle = 'rgba(255,255,255,.7)'; x.fillText(b, 40, 470);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
    m.position.z = 1.21;
    return m;
  }

  await document.fonts.ready;
  const main = sealed(0x5b1ff0, 0xb48cff, ['SEALED QUOTE', 'signatory lender, borrower']);
  const rival = sealed(0xd6f53a, 0xf6ffb0, ['RIVAL', 'never on your node']);

  // Place both cubes in pixel space relative to .visual so the HTML chips line up.
  let W = 0, H = 0;
  function layout() {
    const r = canvas.getBoundingClientRect(), v = visual.getBoundingClientRect();
    W = r.width; H = r.height;
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const upp = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H;
    const at = (fx, fy, size, obj) => {
      obj.position.set((v.left - r.left + v.width * fx - W / 2) * upp, -(v.top - r.top + v.height * fy - H / 2) * upp, 0);
      obj.scale.setScalar((v.width * size * upp) / 2.4);
    };
    at(0.56, 0.5, 0.5, main.group);
    at(-0.36, 0.92, 0.2, rival.group);
  }
  layout();
  addEventListener('resize', layout);

  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => { ptr.tx = e.clientX / innerWidth - 0.5; ptr.ty = e.clientY / innerHeight - 0.5; }, { passive: true });

  let raf = 0, visible = true, first = true;
  function frame() {
    const t = performance.now() / 1000;
    ptr.x += (ptr.tx - ptr.x) * 0.05; ptr.y += (ptr.ty - ptr.y) * 0.05;
    main.group.rotation.set(0.42 + ptr.y * 0.25 + Math.sin(t * 0.4) * 0.03, -0.62 + ptr.x * 0.45 + Math.sin(t * 0.25) * 0.12, 0.04);
    main.core.rotation.set(t * 0.12, t * 0.18, 0);
    rival.group.rotation.set(0.5 + ptr.y * 0.2, 0.7 + t * 0.08 + ptr.x * 0.3, -0.2);
    rival.core.rotation.set(-t * 0.15, t * 0.1, 0);
    main.core.scale.setScalar(1.12 + Math.sin(t * 1.1) * 0.012);
    renderer.render(scene, camera);
    if (first) { first = false; document.documentElement.classList.add('gl'); }
    raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()));
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? run() : stop(); }).observe(canvas);
  run();
}
