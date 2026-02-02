/**
 * Liquid Monochrome 3D Background - Admin Panel
 * Simplified Chrome Liquid Style
 */
(function () {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // Pure Black

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 30;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(ambientLight);

    const light1 = new THREE.DirectionalLight(0xffffff, 1);
    light1.position.set(10, 10, 10);
    scene.add(light1);

    const light2 = new THREE.PointLight(0xffffff, 0.8);
    light2.position.set(-10, -5, 5);
    scene.add(light2);

    // Liquid Chrome Material
    const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(128, {
        format: THREE.RGBFormat,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter
    });
    const cubeCamera = new THREE.CubeCamera(1, 1000, cubeRenderTarget);
    scene.add(cubeCamera);

    const material = new THREE.MeshStandardMaterial({
        color: 0x222222,
        roughness: 0.15,
        metalness: 0.9,
        envMap: cubeRenderTarget.texture,
        envMapIntensity: 1.0
    });

    // Group for Admin Nodes (representing data flow)
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const nodes = [];
    const nodeCount = 8;
    const geometry = new THREE.IcosahedronGeometry(1.5, 1);

    for (let i = 0; i < nodeCount; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        resetNode(mesh);
        nodeGroup.add(mesh);
        nodes.push({
            mesh: mesh,
            speed: 0.002 + Math.random() * 0.005,
            angle: Math.random() * Math.PI * 2,
            radius: 10 + Math.random() * 15,
            yBase: (Math.random() - 0.5) * 15
        });
    }

    function resetNode(mesh) {
        const scale = 0.8 + Math.random() * 1.2;
        mesh.scale.set(scale, scale, scale);
    }

    // Central Hub
    const hubGeo = new THREE.SphereGeometry(3, 32, 32);
    const hub = new THREE.Mesh(hubGeo, material);
    scene.add(hub);

    // Background Starfield
    const starGeo = new THREE.BufferGeometry();
    const starCount = 500;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
        starPos[i] = (Math.random() - 0.5) * 100;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.1,
        transparent: true,
        opacity: 0.5
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);


    let time = 0;
    function animate() {
        requestAnimationFrame(animate);
        time += 0.005;

        // Animate nodes orbiting
        nodes.forEach(node => {
            node.mesh.position.x = Math.cos(time * node.speed * 20 + node.angle) * node.radius;
            node.mesh.position.z = Math.sin(time * node.speed * 20 + node.angle) * node.radius;
            node.mesh.position.y = node.yBase + Math.sin(time * 2 + node.angle) * 2;

            node.mesh.rotation.x += 0.01;
            node.mesh.rotation.y += 0.01;
        });

        // Animate Hub
        hub.rotation.y = time * 0.1;
        hub.rotation.x = time * 0.05;
        hub.position.y = Math.sin(time) * 0.5;

        // Update Environment Map (Reflections)
        hub.visible = false;
        cubeCamera.position.copy(hub.position);
        cubeCamera.update(renderer, scene);
        hub.visible = true;

        renderer.render(scene, camera);
    }

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    animate();
})();
