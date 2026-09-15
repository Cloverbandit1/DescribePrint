"use client";

import { Center, ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader } from "@react-three/fiber";
import { Suspense, useLayoutEffect } from "react";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

function LoadedModel({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url);

  useLayoutEffect(() => {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
  }, [geometry]);

  return (
    <Center>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#d8d4cc" metalness={0.22} roughness={0.38} />
      </mesh>
    </Center>
  );
}

export function Viewer({ stlUrl }: { stlUrl: string | null }) {
  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden bg-[#0e1015]">
      <Canvas
        shadows
        camera={{ position: [90, 70, 110], fov: 35, near: 0.1, far: 4000 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0e1015"]} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[80, 120, 60]} intensity={1.35} castShadow />
        <directionalLight position={[-60, 40, -40]} intensity={0.35} color="#6ec8d4" />
        <Suspense fallback={null}>
          {stlUrl ? <LoadedModel url={stlUrl} /> : null}
        </Suspense>
        <Grid
          infiniteGrid
          fadeDistance={240}
          fadeStrength={3}
          sectionColor="#3a3d48"
          cellColor="#232632"
          cellSize={10}
          sectionSize={50}
          position={[0, 0, 0]}
        />
        <ContactShadows opacity={0.28} scale={180} blur={2.2} far={40} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
      </Canvas>
      {!stlUrl ? (
        <div className="pointer-events-none absolute inset-0 flex items-end justify-between p-5 text-sm text-muted">
          <p>Empty build plate — generate a part to preview.</p>
          <p className="font-mono text-xs">units: mm</p>
        </div>
      ) : null}
    </div>
  );
}
