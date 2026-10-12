import { describe, expect, it } from "vitest";
import { compileToMir, encodeBytecode, memoryHost, moduleOf, optimizeMir, readReplay, ReplayDivergence, ReplayError, runExecutable, runProgram, writeArtifact, writeReplay, type MemoryHost, type ProgramResult } from "../../src/v2";
import { column, compileSource, observable } from "./compile-helpers";

// M9 deterministic replay (docs/v2-replay.md): record a run's effects, replay them on any
// host, and refuse a log that does not belong to the program.

const build = (cells: string[]) => {
  const c = compileSource(column(cells));
  if (!c) throw new Error("does not compile");
  const { mir, nodes } = compileToMir(c.program, c.manifest.start);
  const artifact = writeArtifact(encodeBytecode(optimizeMir(mir).mir, nodes, c.program, { module: "main", maxSteps: c.manifest.maxSteps, start: c.manifest.start }));
  const loaded = moduleOf(artifact);
  const engines = {
    hir: (host: MemoryHost, replay?: ProgramResult["events"]) => runProgram(c.program, c.manifest, { host, replay }),
    vm: (host: MemoryHost, replay?: ProgramResult["events"]) => runExecutable(loaded.executable, loaded.program, c.manifest, { host, replay }),
  };
  return { artifact, engines };
};

const PROGRAM = ["l은 표준 줄읽기:", "t는 시계 지금:", 'r은 파일 읽기: "a.txt"', 'w는 파일 쓰기: "b.txt", "기록"', "l을 말한다.", "t를 말한다.", "r을 말한다.", "끝이다."];

describe("record and replay", () => {
  for (const engine of ["hir", "vm"] as const) {
    it(`${engine}: replays stdin, clock and file reads on a different host, without acting`, () => {
      const { artifact, engines } = build(PROGRAM);
      const recordHost = memoryHost({ stdin: "안녕\n", now: 1_700_000_000_000n, files: { "a.txt": "비밀" } });
      const recorded = engines[engine](recordHost);
      expect(recorded.output).toEqual(['Some("안녕")', "1700000000000", 'Ok("비밀")']);
      const log = readReplay(writeReplay(artifact, recorded.events), artifact);
      // A different stdin, clock and file system: replay must not consult any of them.
      const replayHost = memoryHost({ stdin: "다른\n", now: 5n, files: {} });
      const replayed = engines[engine](replayHost, log.events);
      expect(observable(replayed)).toEqual(observable(recorded));
      expect(replayHost.stdout.join("")).toBe(recordHost.stdout.join(""));
      expect(replayHost.files.has("b.txt")).toBe(false); // the write is suppressed
    });
  }

  it("a recording made by one engine replays on the other: replay is a runtime-core facility", () => {
    const { artifact, engines } = build(PROGRAM);
    const recorded = engines.vm(memoryHost({ stdin: "x\n", now: 9n, files: { "a.txt": "a" } }));
    const events = readReplay(writeReplay(artifact, recorded.events), artifact).events;
    expect(observable(engines.hir(memoryHost(), events))).toEqual(observable(recorded));
  });

  it("events keep program order across stdout, stdin, clock and files", () => {
    const { engines } = build(["\"가\"를 말한다.", "l은 표준 줄읽기:", "\"나\"를 말한다.", "t는 시계 지금:", 'r은 파일 존재: "a"', "끝이다."]);
    const r = engines.vm(memoryHost({ stdin: "q\n" }));
    expect(r.events.map((e) => [e.source, e.kind])).toEqual([
      ["std.io.stdout", "output"],
      ["std.io.readLine", "input"],
      ["std.io.stdout", "output"],
      ["std.clock.now", "input"],
      ["std.fs.exists", "input"],
    ]);
    expect(r.events.map((e) => e.step)).toEqual([...r.events.map((e) => e.step)].sort((a, b) => a - b));
  });

  it("the debug value of a file read is redacted; the replay payload keeps the bytes", () => {
    const { engines } = build(['r은 파일 읽기: "a.txt"', "끝이다."]);
    const [event] = engines.vm(memoryHost({ files: { "a.txt": "비밀번호" } })).events;
    expect(event?.value).toBe("Ok(<12 bytes>)");
    expect(JSON.stringify(event?.payload)).toContain("비밀번호");
  });

  it("a replay for a different program is refused unless forced", () => {
    const a = build(PROGRAM);
    const b = build([...PROGRAM.slice(0, -1), "l을 말한다.", "끝이다."]);
    const text = writeReplay(a.artifact, a.engines.vm(memoryHost({ stdin: "x\n" })).events);
    expect(() => readReplay(text, b.artifact)).toThrow(/recorded for program .* not for this one/);
    const forced = readReplay(text, b.artifact, { force: true });
    // Forced, the extra output diverges from the recording: replay stops rather than guess.
    expect(() => b.engines.vm(memoryHost(), forced.events)).toThrow(ReplayDivergence);
  });

  it("refuses truncated, tampered, foreign and future logs", () => {
    const { artifact, engines } = build(PROGRAM);
    const text = writeReplay(artifact, engines.vm(memoryHost({ stdin: "x\n" })).events);
    expect(() => readReplay(text.slice(0, text.length / 2), artifact)).toThrow(/truncated/);
    expect(() => readReplay(text.replace('Some(\\"x\\")', 'Some(\\"y\\")'), artifact)).toThrow(/integrity/);
    expect(() => readReplay("Y3BC 1\n{}", artifact)).toThrow(/not a Y3 replay/);
    expect(() => readReplay(text.replace("Y3REPLAY 1", "Y3REPLAY 2"), artifact)).toThrow(/version 2/);
    // Dropping the last event and fixing up the hash still fails at run time.
    const parsed = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const short = writeReplay(artifact, parsed.events.slice(0, -1));
    expect(() => engines.vm(memoryHost(), readReplay(short, artifact).events)).toThrow(ReplayDivergence);
  });

  it("an effect called with different arguments diverges", () => {
    const one = build(['r은 파일 읽기: "a.txt"', "끝이다."]);
    const two = build(['r은 파일 읽기: "b.txt"', "끝이다."]);
    const events = one.engines.vm(memoryHost()).events;
    expect(() => two.engines.vm(memoryHost(), events)).toThrow(/diverged.*"b.txt"/);
  });
});

describe("capabilities", () => {
  it("a denied file system is an ordinary Err(PermissionDenied), never an open", () => {
    const { engines } = build(['r은 파일 읽기: "a.txt"', "r을 말한다.", 'w는 파일 쓰기: "b", "x"', "w를 말한다.", "끝이다."]);
    const host = memoryHost({ files: { "a.txt": "x" }, deny: ["filesystem"] });
    for (const engine of ["hir", "vm"] as const) {
      const r = engines[engine](host);
      expect(r.output).toEqual(['Err(PermissionDenied("the host denies filesystem access"))', 'Err(PermissionDenied("the host denies filesystem access"))']);
    }
    expect(host.files.has("b")).toBe(false);
  });

  it("a denied clock or stdin is a FAULT naming the capability", () => {
    for (const [cell, cap] of [["t는 시계 지금:", "clock"], ["l은 표준 줄읽기:", "stdin"], ['e는 파일 존재: "a"', "filesystem"]] as const) {
      const r = build([cell, "끝이다."]).engines.vm(memoryHost({ deny: [cap] }));
      expect(r.outcome).toMatchObject({ status: "FAULT" });
      expect((r.outcome as { message: string }).message).toContain(`'${cap}' capability`);
    }
  });

  it("the replay log records the host's capabilities", () => {
    const { artifact } = build(PROGRAM);
    expect(readReplay(writeReplay(artifact, [], { clock: false }), artifact).capabilities).toEqual({ stdin: true, filesystem: true, clock: false, ffi: true });
  });
});
