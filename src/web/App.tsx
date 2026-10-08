import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import * as THREE from "three";
import { parseProgram, runProgramWithTrace, type Program, type StepTrace } from "../v1/core";

const DEFAULT_SOURCE = `@layer 0
값은 1이다
조건이면 위로
아니다 아래로

@layer 1
출력은 "T"이다

@layer -1
출력은 "F"이다`;

function createThreeScene(canvas: HTMLDivElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0f172a");

  const camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  camera.position.set(6, 8, 10);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  canvas.innerHTML = "";
  canvas.appendChild(renderer.domElement);

  const light = new THREE.DirectionalLight(0xffffff, 1.1);
  light.position.set(8, 12, 8);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const root = new THREE.Group();
  scene.add(root);

  const pointerMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0x22d3ee }),
  );
  scene.add(pointerMesh);

  const trail = new THREE.Group();
  scene.add(trail);

  const animate = () => {
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  animate();

  const onResize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  window.addEventListener("resize", onResize);

  return {
    scene,
    root,
    trail,
    pointerMesh,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      canvas.innerHTML = "";
    },
  };
}

function drawProgramCells(group: THREE.Group, program: Program) {
  group.clear();

  const boxGeometry = new THREE.BoxGeometry(0.85, 0.85, 0.85);
  const material = new THREE.MeshStandardMaterial({ color: 0x334155 });

  for (const cell of program.cells.values()) {
    const cube = new THREE.Mesh(boxGeometry, material.clone());
    cube.position.set(cell.x * 1.2, -cell.y * 1.2, cell.z * 1.2);
    group.add(cube);
  }
}

function addTrailMarker(trail: THREE.Group, trace: StepTrace) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b }),
  );
  marker.position.set(trace.pos.x * 1.2, -trace.pos.y * 1.2, trace.pos.z * 1.2);
  trail.add(marker);

  if (trail.children.length > 30) {
    const first = trail.children[0];
    if (first) {
      trail.remove(first);
    }
  }
}

export function App() {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const sceneRef = useRef<ReturnType<typeof createThreeScene> | null>(null);
  const timerRef = useRef<number | null>(null);

  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [program, setProgram] = useState<Program | null>(null);
  const [trace, setTrace] = useState<StepTrace[]>([]);
  const [traceIndex, setTraceIndex] = useState(0);
  const [errorText, setErrorText] = useState<string>("");

  useEffect(() => {
    if (!editorContainerRef.current) {
      return;
    }

    editorRef.current = monaco.editor.create(editorContainerRef.current, {
      value: DEFAULT_SOURCE,
      language: "plaintext",
      fontSize: 14,
      minimap: { enabled: false },
      automaticLayout: true,
      theme: "vs-dark",
    });

    const disposable = editorRef.current.onDidChangeModelContent(() => {
      const next = editorRef.current?.getValue() ?? "";
      setSource(next);
    });

    return () => {
      disposable.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sceneContainerRef.current) {
      return;
    }

    sceneRef.current = createThreeScene(sceneContainerRef.current);

    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const currentTrace = useMemo(() => trace[traceIndex] ?? null, [trace, traceIndex]);

  useEffect(() => {
    if (!sceneRef.current || !program) {
      return;
    }
    drawProgramCells(sceneRef.current.root, program);
    sceneRef.current.trail.clear();
  }, [program]);

  useEffect(() => {
    if (!sceneRef.current || !currentTrace) {
      return;
    }

    sceneRef.current.pointerMesh.position.set(
      currentTrace.pos.x * 1.2,
      -currentTrace.pos.y * 1.2,
      currentTrace.pos.z * 1.2,
    );
    addTrailMarker(sceneRef.current.trail, currentTrace);
  }, [currentTrace]);

  const stopPlayback = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const parseAndRun = () => {
    stopPlayback();
    setTrace([]);
    setTraceIndex(0);
    setErrorText("");

    try {
      const parsed = parseProgram(source);
      setProgram(parsed);
      const executed = runProgramWithTrace(parsed);
      setTrace(executed.trace);
    } catch (error) {
      setProgram(null);
      if (error instanceof Error) {
        setErrorText(error.message);
      } else {
        setErrorText("Unknown error");
      }
    }
  };

  const startPlayback = () => {
    stopPlayback();
    timerRef.current = window.setInterval(() => {
      setTraceIndex((prev) => {
        if (prev + 1 >= trace.length) {
          stopPlayback();
          return prev;
        }
        return prev + 1;
      });
    }, 500);
  };

  return (
    <div className="layout">
      <section className="editor-panel">
        <header>
          <h1>Y3 Web IDE</h1>
          <p>Monaco + 3D execution view for strict one-line-one-cell Y3 v0.</p>
        </header>
        <div ref={editorContainerRef} className="editor" />
        <div className="controls">
          <button onClick={parseAndRun}>Validate & Run</button>
          <button onClick={startPlayback} disabled={trace.length === 0}>
            Animate
          </button>
          <button
            onClick={() => {
              stopPlayback();
              setTraceIndex(0);
            }}
            disabled={trace.length === 0}
          >
            Reset
          </button>
        </div>
        {errorText ? <pre className="error">{errorText}</pre> : null}
      </section>

      <section className="viewer-panel">
        <div ref={sceneContainerRef} className="scene" />
        <div className="runtime-panel">
          <h2>Runtime State</h2>
          <div>position: {currentTrace ? `(${currentTrace.pos.x},${currentTrace.pos.y},${currentTrace.pos.z})` : "-"}</div>
          <div>direction: {currentTrace ? `(${currentTrace.dir.dx},${currentTrace.dir.dy},${currentTrace.dir.dz})` : "-"}</div>
          <div>stack: {currentTrace ? `[${currentTrace.stack.join(",")}]` : "[]"}</div>
          <div>memory: {currentTrace ? `ptr=${currentTrace.memoryPointer}, val=${currentTrace.memoryValue}` : "ptr=0, val=0"}</div>
          <div>output: {currentTrace ? currentTrace.output : ""}</div>
          <div>step: {currentTrace ? currentTrace.step : 0}</div>
          <div>trail points: {sceneRef.current?.trail.children.length ?? 0}</div>
        </div>
      </section>
    </div>
  );
}
