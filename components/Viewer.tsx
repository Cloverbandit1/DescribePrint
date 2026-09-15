"use client";

import { Center, ContactShadows, GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useLayoutEffect, useMemo } from "react";
import { BoxGeometry, CanvasTexture, Color, RepeatWrapping, SRGBColorSpace } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export type CameraView = "iso" | "top" | "front" | "left";
export type ViewerTheme = "dark" | "light";

const VIEW_PRESETS: Record<CameraView, { position: [number, number, number]; target: [number, number, number] }> = {
  iso: { position: [200, 155, 220], target: [0, 12, 0] },
  top: { position: [0, 340, 0.02], target: [0, 0, 0] },
  front: { position: [0, 95, 330], target: [0, 24, 0] },
  left: { position: [-330, 95, 0], target: [0, 24, 0] },
};

function LoadedModel({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url);

  useLayoutEffect(() => {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
  }, [geometry]);

  return (
    <Center top>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#c9c9c9" metalness={0.18} roughness={0.42} />
      </mesh>
    </Center>
  );
}

function makePlateTexture(sizeMm: number, theme: ViewerTheme) {
  const res = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = theme === "dark" ? "#3a3a3c" : "#d8d4cc";
  ctx.fillRect(0, 0, res, res);

  const image = ctx.getImageData(0, 0, res, res);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    image.data[i] = clampByte(image.data[i] + n);
    image.data[i + 1] = clampByte(image.data[i + 1] + n);
    image.data[i + 2] = clampByte(image.data[i + 2] + n);
  }
  ctx.putImageData(image, 0, 0);

  const px = res / sizeMm;
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.07)";
  for (let mm = 0; mm <= sizeMm; mm += 10) {
    const p = mm * px;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, res);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(res, p);
    ctx.stroke();
  }

  ctx.lineWidth = 1.4;
  ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.14)";
  for (let mm = 0; mm <= sizeMm; mm += 50) {
    const p = mm * px;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, res);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(res, p);
    ctx.stroke();
  }

  ctx.strokeStyle = theme === "dark" ? "rgba(0,179,71,0.28)" : "rgba(0,163,63,0.3)";
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, res - 4, res - 4);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, value));
}

function PlateAxes({ plateMm }: { plateMm: number }) {
  const half = plateMm / 2;
  const len = 34;
  return (
    <group position={[-half + 4, 0.9, half - 4]}>
      <mesh position={[len / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.55, 0.55, len, 8]} />
        <meshBasicMaterial color="#e24b4b" />
      </mesh>
      <mesh position={[0, 0, -len / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.55, 0.55, len, 8]} />
        <meshBasicMaterial color="#3cb46e" />
      </mesh>
    </group>
  );
}

function BuildPlate({ sizeMm, heightMm, theme }: { sizeMm: number; heightMm: number; theme: ViewerTheme }) {
  const texture = useMemo(() => makePlateTexture(sizeMm, theme), [sizeMm, theme]);
  const volumeGeometry = useMemo(() => new BoxGeometry(sizeMm, heightMm, sizeMm), [sizeMm, heightMm]);
  const half = sizeMm / 2;
  const edge = theme === "dark" ? "#2f2f31" : "#c4c0b8";
  const cage = theme === "dark" ? "#00b347" : "#008a36";

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.2, 0]} receiveShadow>
        <boxGeometry args={[sizeMm, sizeMm, 2.4]} />
        <meshStandardMaterial color={edge} roughness={0.9} metalness={0.04} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[sizeMm, sizeMm]} />
        <meshStandardMaterial
          map={texture}
          color={theme === "dark" ? "#d8d8d8" : "#ffffff"}
          roughness={0.88}
          metalness={0.06}
        />
      </mesh>
      <lineSegments position={[0, heightMm / 2, 0]}>
        <edgesGeometry args={[volumeGeometry]} />
        <lineBasicMaterial color={cage} transparent opacity={theme === "dark" ? 0.2 : 0.28} />
      </lineSegments>
      <PlateAxes plateMm={sizeMm} />
      <mesh position={[-half + 3.2, 0.4, half - 3.2]}>
        <sphereGeometry args={[1.3, 12, 12]} />
        <meshBasicMaterial color="#e24b4b" />
      </mesh>
    </group>
  );
}

function CameraRig({ view }: { view: CameraView }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);

  useLayoutEffect(() => {
    const preset = VIEW_PRESETS[view];
    camera.position.set(...preset.position);
    camera.lookAt(...preset.target);
    camera.updateProjectionMatrix();
    if (controls && "target" in controls && "update" in controls) {
      const orbit = controls as { target: { set: (x: number, y: number, z: number) => void }; update: () => void };
      orbit.target.set(...preset.target);
      orbit.update();
    }
  }, [view, camera, controls]);

  return null;
}

export function Viewer({
  stlUrl,
  view = "iso",
  plateMm = 256,
  heightMm = 256,
  theme = "dark",
}: {
  stlUrl: string | null;
  view?: CameraView;
  plateMm?: number;
  heightMm?: number;
  theme?: ViewerTheme;
}) {
  const background = theme === "dark" ? "#242424" : "#d2d2d2";

  return (
    <div className="relative h-full min-h-[240px] w-full overflow-hidden bg-canvas">
      <Canvas
        shadows
        camera={{ position: VIEW_PRESETS.iso.position, fov: 32, near: 0.1, far: 4000 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={[background]} />
        <fog attach="fog" args={[background, 420, 900]} />
        <ambientLight intensity={theme === "dark" ? 0.42 : 0.62} />
        <directionalLight position={[90, 140, 70]} intensity={theme === "dark" ? 1.25 : 1.05} castShadow />
        <directionalLight
          position={[-70, 50, -40]}
          intensity={0.28}
          color={new Color(theme === "dark" ? "#8eb4ff" : "#ffffff")}
        />
        <Suspense fallback={null}>
          <BuildPlate sizeMm={plateMm} heightMm={heightMm} theme={theme} />
          {stlUrl ? <LoadedModel url={stlUrl} /> : null}
        </Suspense>
        <ContactShadows opacity={theme === "dark" ? 0.32 : 0.2} scale={plateMm} blur={2.1} far={50} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} target={VIEW_PRESETS.iso.target} />
        <CameraRig view={view} />
        <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
          <GizmoViewport
            axisColors={["#e24b4b", "#3cb46e", "#4c8dff"]}
            labelColor={theme === "dark" ? "#f0f0f0" : "#2a2a2a"}
          />
        </GizmoHelper>
      </Canvas>
      {!stlUrl ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
          <p className="rounded-md bg-bg/70 px-3 py-1.5 text-xs text-muted backdrop-blur-sm">
            Empty plate — describe a part, then Print.
          </p>
        </div>
      ) : null}
    </div>
  );
}
