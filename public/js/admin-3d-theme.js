/**
 * White Glassmorphism 3D Background - Admin Panel
 * Frosted Glass Orbs & Pastel Data Flow
 */
(function () {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2ff); // Light Lavender
    scene.fog = new THREE.Fog(0xf0f2ff, 20, 70);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 32;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    // Soft multi-color lighting
    const ambientLight = new THREE.AmbientLight(0xe8ecff, 0.9);
    scene.add(ambientLight);

    const light1 = new THREE.DirectionalLight(0xffffff, 0.8);
    light1.position.set(10, 20, 10);
    scene.add(light1);

    const light2 = new THREE.PointLight(0xc4b5fd, 1.2, 100);
    light2.position.set(-15, -10, 15);
    scene.add(light2);

    const light3 = new THREE.PointLight(0xfbbf94, 0.8, 100);
    light3.position.set(15, 5, 5);
    scene.add(light3);

    // Pastel Glass Colors
    const colors = [
        0xc4b5fd, // lavender
        0x93c5fd, // blue
        0x86efac, // green
        0xfbbf94, // orange
        0xfca5a5, // pink
    ];

    // Group for Admin Nodes
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const nodes = [];
    const nodeCount = 12;
    const geometry = new THREE.IcosahedronGeometry(1.6, 2);

    for (let i = 0; i < nodeCount; i++) {
        const color = colors[i % colors.length];
        const material = new THREE.MeshPhysicalMaterial({
            color: color,
            roughness: 0.1,
            metalness: 0.05,
            transmission: 0.9,
            thickness: 2,
            transparent: true,
            opacity: 0.6,
            clearcoat: 1.0,
        });

        const mesh = new THREE.Mesh(geometry, material);
        const scale = 0.6 + Math.random() * 1.4;
        mesh.scale.set(scale, scale, scale);

        nodeGroup.add(mesh);
        nodes.push({
            mesh: mesh,
            speed: 0.001 + Math.random() * 0.003,
            angle: Math.random() * Math.PI * 2,
            radius: 12 + Math.random() * 18,
            yBase: (Math.random() - 0.5) * 20,
            rotSpeed: (Math.random() - 0.5) * 0.02
        });
    }

    // Central Frosted Glass Hub
    const hubGeo = new THREE.IcosahedronGeometry(4.5, 3);
    const hubMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.1,
        metalness: 0.02,
        transmission: 0.95,
        thickness: 4,
        transparent: true,
        opacity: 0.3,
        clearcoat: 1.0,
    });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    scene.add(hub);

    // Background Sparkles
    const sparkleGeo = new THREE.BufferGeometry();
    const sparkleCount = 400;
    const sparklePos = new Float32Array(sparkleCount * 3);
    for (let i = 0; i < sparkleCount * 3; i++) {
        sparklePos[i] = (Math.random() - 0.5) * 120;
    }
    sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePos, 3));
    const sparkleMat = new THREE.PointsMaterial({
        color: 0x93c5fd,
        size: 0.12,
        transparent: true,
        opacity: 0.4
    });
    const sparkles = new THREE.Points(sparkleGeo, sparkleMat);
    scene.add(sparkles);


    let time = 0;

    function animate() {
        requestAnimationFrame(animate);
        time += 0.006;

        // Animate nodes orbiting
        nodes.forEach(node => {
            node.mesh.position.x = Math.cos(time * node.speed * 20 + node.angle) * node.radius;
            node.mesh.position.z = Math.sin(time * node.speed * 20 + node.angle) * node.radius;
            node.mesh.position.y = node.yBase + Math.sin(time * 0.5 + node.angle) * 3;

            node.mesh.rotation.y += node.rotSpeed;
            node.mesh.rotation.z += node.rotSpeed * 0.5;
        });

        // Animate Hub
        hub.rotation.y = time * 0.12;
        hub.rotation.x = time * 0.06;
        hub.position.y = Math.sin(time * 0.8) * 0.8;

        // Animate Sparkles
        sparkles.rotation.y = -time * 0.01;

        // Gentle camera influence
        camera.position.x = Math.sin(time * 0.1) * 2.5;
        camera.position.y = Math.cos(time * 0.1) * 2.5;
        camera.lookAt(scene.position);

        renderer.render(scene, camera);
    }

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    animate();
})();
