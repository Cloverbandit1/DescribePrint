"use client";

import { Center, ContactShadows, GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, BufferAttribute, CanvasTexture, Color, RepeatWrapping, SRGBColorSpace, TOUCH } from "three";
import { nextViewerZoomFactor, viewerTouchMode } from "@/lib/mobile-client";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { heatmapLegendStops, heatmapRgb, previewStrength } from "@/lib/strength-preview";
import type { Mesh } from "@/lib/types";

export type CameraView = "iso" | "top" | "front" | "left";
export type ViewerTheme = "dark" | "light";

/** Plate-space AABB outlines from the packing stub (front-left origin, mm). */
export type PackOutline = {
  id: string;
  x: number;
  y: number;
  widthMm: number;
  depthMm: number;
};

const VIEW_PRESETS: Record<CameraView, { position: [number, number, number]; target: [number, number, number] }> = {
  iso: { position: [200, 155, 220], target: [0, 12, 0] },
  top: { position: [0, 340, 0.02], target: [0, 0, 0] },
  front: { position: [0, 95, 330], target: [0, 24, 0] },
  left: { position: [-330, 95, 0], target: [0, 24, 0] },
};

function meshFromPositions(positions: ArrayLike<number>, index?: ArrayLike<number> | null): Mesh {
  const triangles: Mesh["triangles"] = [];
  const read = (i: number): [number, number, number] => [
    positions[i * 3] ?? 0,
    positions[i * 3 + 1] ?? 0,
    positions[i * 3 + 2] ?? 0,
  ];
  if (index && index.length >= 3) {
    for (let i = 0; i + 2 < index.length; i += 3) {
      triangles.push({
        normal: [0, 0, 1],
        vertices: [read(index[i] ?? 0), read(index[i + 1] ?? 0), read(index[i + 2] ?? 0)],
      });
    }
    return { triangles };
  }
  const count = Math.floor(positions.length / 9);
  for (let i = 0; i < count; i++) {
    triangles.push({
      normal: [0, 0, 1],
      vertices: [read(i * 3), read(i * 3 + 1), read(i * 3 + 2)],
    });
  }
  return { triangles };
}

function LoadedModel({
  url,
  heatmap,
  triangleScores,
  tintHex,
}: {
  url: string;
  heatmap: boolean;
  triangleScores?: number[];
  tintHex?: string | null;
}) {
  const loaded = useLoader(STLLoader, url);
  const geometry = useMemo(() => {
    const geo = loaded.index ? loaded.toNonIndexed() : loaded.clone();
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    if (!heatmap) {
      geo.deleteAttribute("color");
      return geo;
    }
    const pos = geo.getAttribute("position");
    const triCount = Math.floor((pos?.count ?? 0) / 3);
    let scores = triangleScores && triangleScores.length === triCount ? triangleScores : null;
    if (!scores && pos) {
      const mesh = meshFromPositions(pos.array, null);
      scores = previewStrength(mesh).triangleScores;
    }
    if (pos && scores) {
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < triCount; i++) {
        const [r, g, b] = heatmapRgb(scores[i] ?? 0);
        for (let v = 0; v < 3; v++) {
          const o = (i * 3 + v) * 3;
          colors[o] = r;
          colors[o + 1] = g;
          colors[o + 2] = b;
        }
      }
      geo.setAttribute("color", new BufferAttribute(colors, 3));
    }
    return geo;
  }, [loaded, heatmap, triangleScores]);

  return (
    <Center top>
      <mesh geometry={geometry} castShadow receiveShadow>
        {heatmap ? (
          <meshStandardMaterial vertexColors metalness={0.12} roughness={0.46} />
        ) : (
          <meshStandardMaterial color={tintHex || "#c9c9c9"} metalness={0.18} roughness={0.42} />
        )}
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

  ctx.fillStyle = theme === "dark" ? "#6a6a6e" : "#d8d4cc";
  ctx.fillRect(0, 0, res, res);

  const image = ctx.getImageData(0, 0, res, res);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    image.data[i] = clampByte(image.data[i] + n);
    image.data[i + 1] = clampByte(image.data[i + 1] + n * 0.92);
    image.data[i + 2] = clampByte(image.data[i + 2] + n * 0.85);
  }
  ctx.putImageData(image, 0, 0);

  const px = res / sizeMm;
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.1)";
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

  ctx.lineWidth = 1.6;
  ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.32)" : "rgba(0,0,0,0.18)";
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

  ctx.strokeStyle = theme === "dark" ? "rgba(0,179,71,0.55)" : "rgba(0,163,63,0.45)";
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, res - 6, res - 6);

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
  const edge = theme === "dark" ? "#4a4a4e" : "#c4c0b8";
  const cage = theme === "dark" ? "#00b347" : "#008a36";

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.2, 0]} receiveShadow>
        <boxGeometry args={[sizeMm, sizeMm, 2.4]} />
        <meshStandardMaterial color={edge} roughness={0.86} metalness={0.04} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[sizeMm, sizeMm]} />
        <meshStandardMaterial map={texture} color="#ffffff" roughness={0.78} metalness={0.08} />
      </mesh>
      <lineSegments position={[0, heightMm / 2, 0]}>
        <edgesGeometry args={[volumeGeometry]} />
        <lineBasicMaterial color={cage} transparent opacity={theme === "dark" ? 0.42 : 0.38} />
      </lineSegments>
      <PlateAxes plateMm={sizeMm} />
      <mesh position={[-half + 3.2, 0.4, half - 3.2]}>
        <sphereGeometry args={[1.3, 12, 12]} />
        <meshBasicMaterial color="#e24b4b" />
      </mesh>
    </group>
  );
}

function PackOutlines({
  plateMm,
  outlines,
  theme,
}: {
  plateMm: number;
  outlines: PackOutline[];
  theme: ViewerTheme;
}) {
  if (outlines.length === 0) return null;
  const half = plateMm / 2;
  const fill = theme === "dark" ? "#4c8dff" : "#2f6fd6";

  return (
    <group>
      {outlines.map((outline) => {
        const cx = -half + outline.x + outline.widthMm / 2;
        const cz = half - outline.y - outline.depthMm / 2;
        return (
          <group key={outline.id}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.16, cz]}>
              <planeGeometry args={[outline.widthMm, outline.depthMm]} />
              <meshBasicMaterial color={fill} transparent opacity={0.2} depthWrite={false} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.18, cz]}>
              <planeGeometry args={[outline.widthMm, outline.depthMm]} />
              <meshBasicMaterial color={fill} wireframe />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function CameraRig({ view, zoomFactor }: { view: CameraView; zoomFactor: number }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  const lastView = useRef<CameraView>(view);

  useLayoutEffect(() => {
    const preset = VIEW_PRESETS[view];
    const viewChanged = lastView.current !== view;
    if (viewChanged) lastView.current = view;
    const factor = viewChanged ? 1 : zoomFactor;
    camera.position.set(preset.position[0] * factor, preset.position[1] * factor, preset.position[2] * factor);
    camera.lookAt(...preset.target);
    camera.updateProjectionMatrix();
    if (controls && "target" in controls && "update" in controls) {
      const orbit = controls as { target: { set: (x: number, y: number, z: number) => void }; update: () => void };
      orbit.target.set(...preset.target);
      orbit.update();
    }
  }, [view, zoomFactor, camera, controls]);

  return null;
}

function StrengthLegend({ theme }: { theme: ViewerTheme }) {
  const stops = heatmapLegendStops();
  const gradient = `linear-gradient(90deg, ${stops.map((stop) => stop.hex).join(", ")})`;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-44 rounded-md border border-line bg-panel/90 px-2 py-1.5 shadow-sm backdrop-blur">
      <div className={`text-[10px] font-medium ${theme === "dark" ? "text-ink" : "text-ink"}`}>
        Heuristic strength
      </div>
      <div className="mt-1 h-2 rounded-sm" style={{ background: gradient }} />
      <div className="mt-0.5 flex justify-between text-[9px] text-muted">
        <span>cool</span>
        <span>hot / weak</span>
      </div>
      <p className="mt-1 text-[9px] leading-snug text-muted">Not FEA — thickness, corners, overhangs.</p>
    </div>
  );
}

function RegionColorOverlay({
  regions,
}: {
  regions: Array<{ id: string; name: string; colorName: string; colorHex: string; amsSlot?: number }>;
}) {
  if (regions.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[220px] rounded-md border border-line bg-panel/90 px-2 py-1.5 shadow-sm backdrop-blur">
      <div className="text-[10px] font-medium text-ink">Color regions</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {regions.map((region) => (
          <span
            key={`${region.id}-${region.colorHex}`}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-1.5 py-0.5 text-[10px] text-ink"
          >
            <span className="inline-block h-2 w-2 rounded-full border border-line" style={{ background: region.colorHex }} />
            {region.name}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[9px] leading-snug text-muted">Preview chips — not live AMS. Slicer assigns filaments.</p>
    </div>
  );
}

export function Viewer({
  stlUrl,
  view = "iso",
  plateMm = 256,
  heightMm = 256,
  theme = "dark",
  showGizmo = true,
  packOutlines = [],
  heatmap = false,
  triangleScores,
  previewTint = null,
  colorRegions = [],
  touchFriendly = false,
}: {
  stlUrl: string | null;
  view?: CameraView;
  plateMm?: number;
  heightMm?: number;
  theme?: ViewerTheme;
  showGizmo?: boolean;
  packOutlines?: PackOutline[];
  heatmap?: boolean;
  triangleScores?: number[];
  previewTint?: string | null;
  colorRegions?: Array<{ id: string; name: string; colorName: string; colorHex: string; amsSlot?: number }>;
  touchFriendly?: boolean;
}) {
  const background = theme === "dark" ? "#242424" : "#d2d2d2";
  const [zoomFactor, setZoomFactor] = useState(1);
  const touch = viewerTouchMode(touchFriendly);

  useEffect(() => {
    setZoomFactor(1);
  }, [view]);

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-canvas ${
        touchFriendly ? "viewer-touch min-h-[160px]" : "min-h-[240px]"
      }`}
    >
      <Canvas
        shadows
        camera={{ position: VIEW_PRESETS.iso.position, fov: 32, near: 0.1, far: 4000 }}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          gl.domElement.style.touchAction = "none";
        }}
      >
        <color attach="background" args={[background]} />
        <hemisphereLight
          args={[
            theme === "dark" ? "#c8ccd4" : "#ffffff",
            theme === "dark" ? "#3a3a3a" : "#b8b8b8",
            theme === "dark" ? 0.58 : 0.78,
          ]}
        />
        <ambientLight intensity={theme === "dark" ? 0.48 : 0.68} />
        <directionalLight position={[90, 160, 90]} intensity={theme === "dark" ? 1.2 : 1.05} castShadow />
        <directionalLight
          position={[-80, 60, -50]}
          intensity={0.4}
          color={new Color(theme === "dark" ? "#9ec0ff" : "#ffffff")}
        />
        <Suspense fallback={null}>
          <BuildPlate sizeMm={plateMm} heightMm={heightMm} theme={theme} />
          {stlUrl ? (
            <LoadedModel
              key={`${stlUrl}-${heatmap ? "heat" : previewTint || "plain"}`}
              url={stlUrl}
              heatmap={heatmap}
              triangleScores={triangleScores}
              tintHex={heatmap ? null : previewTint}
            />
          ) : null}
          <PackOutlines plateMm={plateMm} outlines={packOutlines} theme={theme} />
        </Suspense>
        <ContactShadows opacity={theme === "dark" ? 0.32 : 0.2} scale={plateMm} blur={2.1} far={50} />
        <OrbitControls
          makeDefault
          enableDamping={touch.enableDamping}
          dampingFactor={0.08}
          enableRotate={touch.enableRotate}
          enableZoom={touch.enableZoom}
          enablePan={touch.enablePan}
          minDistance={40}
          maxDistance={900}
          touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
          target={VIEW_PRESETS.iso.target}
        />
        <CameraRig view={view} zoomFactor={zoomFactor} />
        {showGizmo ? (
          <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
            <GizmoViewport
              axisColors={["#e24b4b", "#3cb46e", "#4c8dff"]}
              labelColor={theme === "dark" ? "#f0f0f0" : "#2a2a2a"}
            />
          </GizmoHelper>
        ) : null}
      </Canvas>
      {touchFriendly ? (
        <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            type="button"
            className="studio-btn studio-btn-ghost inline-flex h-11 w-11 text-lg"
            aria-label="Zoom in"
            onClick={() => setZoomFactor((current) => nextViewerZoomFactor(current, "in"))}
          >
            +
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-ghost inline-flex h-11 w-11 text-lg"
            aria-label="Zoom out"
            onClick={() => setZoomFactor((current) => nextViewerZoomFactor(current, "out"))}
          >
            −
          </button>
        </div>
      ) : null}
      {stlUrl && heatmap ? <StrengthLegend theme={theme} /> : null}
      {stlUrl && colorRegions.length ? <RegionColorOverlay regions={colorRegions} /> : null}
      {!stlUrl ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
          <p className="rounded-md bg-bg/70 px-3 py-1.5 text-xs text-muted backdrop-blur-sm">
            Empty plate — describe a part or import STL/3MF, then Print.
          </p>
        </div>
      ) : null}
      {touchFriendly && stlUrl ? (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 lg:hidden">
          <p className="rounded-md bg-bg/70 px-2.5 py-1 text-[10px] text-muted backdrop-blur-sm">
            Drag to orbit · pinch to zoom
          </p>
        </div>
      ) : null}
    </div>
  );
}
